-- Additive contract register. Install after change-approvals.sql.
-- Existing business rows and request history are preserved.
begin;
create table public.contracts (
 id uuid primary key default gen_random_uuid(),
 customer_id uuid not null references public.customers(id) on delete restrict,
 name text not null check(length(btrim(name)) between 1 and 4000),
 contract_type text not null default '공급' check(contract_type in ('공급','총판','독점','기타')),
 status text not null default '초안' check(status in ('초안','협의중','서명대기','유효','만료','해지')),
 manager text not null default '', counterparty_contact text not null default '',
 start_date date, end_date date, notice_date date,
 auto_renewal text not null default '미확정' check(auto_renewal in ('미확정','있음','없음')),
 renewal_terms text not null default '',
 previous_contract_id uuid references public.contracts(id) on delete restrict,
 territory text not null default '', channels text not null default '',
 exclusive text not null default '미확정' check(exclusive in ('미확정','있음','없음')),
 price_terms text not null default '', minimum_order text not null default '', incoterms text not null default '',
 annual_commitment text not null default '', exclusivity_terms text not null default '',
 payment_type text not null default '미확정' check(payment_type in ('미확정','전액 선입금','분할','후불','기타')),
 currency text not null default '', payment_method text not null default '',
 deposit_pct numeric(5,2) check(deposit_pct between 0 and 100), balance_pct numeric(5,2) check(balance_pct between 0 and 100),
 deposit_due text not null default '', balance_due text not null default '', bank_fee text not null default '', payment_terms text not null default '',
 foc_status text not null default '미확정' check(foc_status in ('미확정','있음','없음')),
 foc_terms text not null default '', foc_products text not null default '', foc_limit text not null default '',
 document_id uuid references public.documents(id) on delete restrict,
 amendment_document_id uuid references public.documents(id) on delete restrict,
 special_terms text not null default '', created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 constraint contract_period check(end_date is null or start_date is null or end_date>=start_date),
 constraint contract_valid_period check(status<>'유효' or (start_date is not null and end_date is not null)),
 constraint contract_notice check(notice_date is null or end_date is null or notice_date<=end_date),
 constraint contract_dates check((start_date is null or start_date between date '1900-01-01' and date '9999-12-31') and (end_date is null or end_date between date '1900-01-01' and date '9999-12-31') and (notice_date is null or notice_date between date '1900-01-01' and date '9999-12-31')),
 constraint contract_split check(payment_type<>'분할' or (deposit_pct is not null and balance_pct is not null and deposit_pct+balance_pct=100 and btrim(deposit_due)<>'' and btrim(balance_due)<>'')),
 constraint contract_payment_due check((payment_type<>'후불' or btrim(balance_due)<>'') and (payment_type<>'전액 선입금' or btrim(deposit_due)<>'')),
 constraint contract_foc check(foc_status<>'있음' or btrim(foc_terms)<>''),
 constraint contract_previous check(previous_contract_id is distinct from id)
);
create index contracts_customer on public.contracts(customer_id);
create index contracts_documents on public.contracts(document_id);
create index contracts_amendments on public.contracts(amendment_document_id);
create index contracts_previous on public.contracts(previous_contract_id);
create index contracts_created on public.contracts(created_at desc,id);
alter table public.contracts enable row level security;
revoke all on public.contracts from public,anon,authenticated;
grant select on public.contracts to authenticated;
-- identity uses verified auth.users email and server-managed app metadata.
create function approval_private.can_read_contracts() returns boolean language plpgsql security definer set search_path='' as $$
begin perform approval_private.identity();return true;end $$;
revoke all on function approval_private.can_read_contracts() from public,anon,authenticated;
grant execute on function approval_private.can_read_contracts() to authenticated;
create policy contracts_company_read on public.contracts for select to authenticated using ((select approval_private.can_read_contracts()));
create trigger require_change_approval before insert or update or delete on public.contracts for each row execute function approval_private.require_approval();
create trigger require_approval_truncate before truncate on public.contracts for each statement execute function approval_private.require_approval();

create function approval_private.validate_contract() returns trigger language plpgsql security definer set search_path='' as $$
declare document uuid; k text; v jsonb;
begin
 for k,v in select * from jsonb_each(to_jsonb(new)) loop
  if jsonb_typeof(v)='string' and length(v#>>'{}')>4000 then raise exception '계약 항목은 4000자 이하로 입력하세요: %',k;end if;
 end loop;
 if new.previous_contract_id is not null then
  if not exists(select 1 from public.contracts where id=new.previous_contract_id and customer_id=new.customer_id) then raise exception '이전 계약은 같은 거래처에서 선택하세요.';end if;
  if exists(with recursive chain as (
   select id,previous_contract_id from public.contracts where id=new.previous_contract_id
   union select c.id,c.previous_contract_id from public.contracts c join chain p on c.id=p.previous_contract_id
  ) select 1 from chain where id=new.id) then raise exception '이전 계약 연결이 순환합니다.';end if;
 end if;
 if TG_OP='UPDATE' and new.customer_id is distinct from old.customer_id and exists(select 1 from public.contracts where previous_contract_id=old.id) then raise exception '갱신 계약이 연결된 거래처는 변경할 수 없습니다.';end if;
 -- Existing links are stable IDs. A customer rename must not invalidate them.
 foreach k in array array['document_id','amendment_document_id'] loop
  document:=(to_jsonb(new)->>k)::uuid;
  if TG_OP='INSERT' or new.customer_id is distinct from old.customer_id or (to_jsonb(new)->k) is distinct from (to_jsonb(old)->k) then
   if document is not null and not exists(select 1 from public.documents d join public.customers c on c.id=new.customer_id where d.id=document and d.type='계약서' and d.customer=c.name) then raise exception '해당 거래처의 승인된 계약서 서류를 선택하세요.';end if;
  end if;
 end loop;
 new.updated_at:=clock_timestamp();return new;
end $$;
revoke all on function approval_private.validate_contract() from public,anon,authenticated;
create trigger validate_contract before insert or update on public.contracts for each row execute function approval_private.validate_contract();

create function approval_private.guard_contract_document() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if (new.customer is distinct from old.customer or new.type is distinct from old.type) and exists(
  select 1 from public.contracts ct join public.customers c on c.id=ct.customer_id
  where (ct.document_id=old.id or ct.amendment_document_id=old.id) and (new.type is distinct from '계약서' or new.customer is distinct from c.name)
 ) then raise exception '계약에 연결된 서류의 거래처·종류는 연결 해제 후 변경하세요.';end if;
 return new;
end $$;
revoke all on function approval_private.guard_contract_document() from public,anon,authenticated;
create trigger validate_contract_document before update on public.documents for each row execute function approval_private.guard_contract_document();

-- Extend exactly the installed allowlist; never overwrite other deployed fixes.
do $patch$
declare definition text; marker text := '''product_details'',''invoice_drive_documents'') or a is null';
begin
 definition:=pg_get_functiondef('approval_private.apply_operations(jsonb)'::regprocedure);
 if position(marker in definition)=0 then raise exception 'Approval allowlist changed; review installed definition before applying contracts.';end if;
 execute replace(definition,marker,'''product_details'',''invoice_drive_documents'',''contracts'') or a is null');
end $patch$;
notify pgrst,'reload schema';
commit;
