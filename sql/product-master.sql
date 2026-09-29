-- Additive read-only snapshot. Never changes operational products or orders.
begin;
create table public.product_master_snapshots (
 id boolean primary key default true check(id),
 source_name text not null,
 source_date date not null,
 source_sha256 text not null check(source_sha256 ~ '^[a-f0-9]{64}$'),
 headers jsonb not null check(jsonb_typeof(headers)='array' and jsonb_array_length(headers)=52),
 products jsonb not null check(jsonb_typeof(products)='array'),
 loaded_at timestamptz not null default now()
);
alter table public.product_master_snapshots enable row level security;
revoke all on public.product_master_snapshots from public,anon,authenticated;
grant select on public.product_master_snapshots to authenticated;
-- Private helper must read protected auth rows; client metadata is never trusted.
create function approval_private.can_read_product_master() returns boolean
language sql stable security definer set search_path='' as $$
 select exists(
  select 1 from auth.users u join auth.sessions s on s.user_id=u.id
  where u.id=(select auth.uid()) and u.email_confirmed_at is not null
   and (u.banned_until is null or u.banned_until<=now())
   and (split_part(lower(u.email),'@',2)='entropymakeup.com' or lower(u.email)='entropyadmin@entropy.internal')
   and s.id::text=(select auth.jwt()->>'session_id')
   and (s.not_after is null or s.not_after>now())
 );
$$;
revoke all on function approval_private.can_read_product_master() from public,anon,authenticated;
grant usage on schema approval_private to authenticated;
grant execute on function approval_private.can_read_product_master() to authenticated;
create policy product_master_company_read on public.product_master_snapshots
 for select to authenticated using ((select approval_private.can_read_product_master()));
commit;
