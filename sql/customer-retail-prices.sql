-- Additive per-customer base retail prices ("수정 국내 소비자가" in a customer's contract).
-- Supply price = customer_retail_prices.retail_price x customers.supply_rate when a row exists,
-- otherwise products.price x customers.supply_rate (unchanged behaviour for every other customer).
-- Install after change-approvals.sql, contracts.sql, contacts.sql and tax-invoice-amount-customer.sql.
-- Does not modify existing business data or pending approval requests. Writes go through change requests only.
begin;
create table public.customer_retail_prices (
 id uuid primary key default gen_random_uuid(),
 customer_id uuid not null references public.customers(id) on delete restrict,
 barcode text not null,
 retail_price numeric not null,
 note text not null default '',
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 constraint customer_retail_prices_barcode check(barcode=btrim(barcode) and barcode<>'' and length(barcode)<=64),
 constraint customer_retail_prices_price check(retail_price>0 and retail_price<1000000000),
 constraint customer_retail_prices_note check(length(note)<=500),
 constraint customer_retail_prices_unique unique(customer_id,barcode)
);
alter table public.customer_retail_prices enable row level security;
revoke all on public.customer_retail_prices from public,anon,authenticated;
grant select on public.customer_retail_prices to authenticated;

create function approval_private.can_read_customer_retail_prices() returns boolean language plpgsql security definer set search_path='' as $$
begin perform approval_private.identity();return true;end $$;
revoke all on function approval_private.can_read_customer_retail_prices() from public,anon,authenticated;
grant execute on function approval_private.can_read_customer_retail_prices() to authenticated;
create policy customer_retail_prices_company_read on public.customer_retail_prices for select to authenticated
 using ((select approval_private.can_read_customer_retail_prices()));
create trigger require_change_approval before insert or update or delete on public.customer_retail_prices for each row execute function approval_private.require_approval();
create trigger require_approval_truncate before truncate on public.customer_retail_prices for each statement execute function approval_private.require_approval();

create function approval_private.touch_customer_retail_price() returns trigger language plpgsql set search_path='' as $$
begin new.note:=btrim(coalesce(new.note,''));new.updated_at:=clock_timestamp();return new;end $$;
revoke all on function approval_private.touch_customer_retail_price() from public,anon,authenticated;
create trigger touch_customer_retail_price before insert or update on public.customer_retail_prices for each row execute function approval_private.touch_customer_retail_price();

-- Extend exactly the inspected installed allowlist. Preserve all deployed function logic.
do $patch$
declare definition text; marker text := $m$'contacts','tax_invoice_amounts') or a is null$m$;
begin
 definition:=pg_get_functiondef('approval_private.apply_operations(jsonb)'::regprocedure);
 if position(marker in definition)=0 or length(definition)-length(replace(definition,marker,''))<>length(marker) then
  raise exception 'Approval allowlist changed; review installed definition before applying customer_retail_prices.';
 end if;
 execute replace(definition,marker,$m$'contacts','tax_invoice_amounts','customer_retail_prices') or a is null$m$);
end $patch$;
notify pgrst,'reload schema';
commit;
