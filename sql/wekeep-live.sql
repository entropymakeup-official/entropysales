-- Separate whole snapshots. Existing orders, products and planned stock are untouched.
begin;
create schema if not exists wekeep_inventory_private;
revoke all on schema wekeep_inventory_private from public,anon,authenticated;
create table if not exists wekeep_inventory_private.snapshot(
 singleton boolean primary key default true check(singleton),
 payload jsonb not null,
 collected_at timestamptz not null,
 saved_at timestamptz not null default now(),
 saved_by uuid not null
);
alter table wekeep_inventory_private.snapshot enable row level security;
revoke all on wekeep_inventory_private.snapshot from public,anon,authenticated;

create or replace function public.get_wekeep_inventory()
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null or not coalesce(
  split_part(auth.jwt()->>'email','@',2)='entropymakeup.com'
  or auth.jwt()->>'email'='entropyadmin@entropy.internal',false
 ) then raise exception 'Unauthorized dashboard user' using errcode='42501'; end if;
 return jsonb_build_object('snapshot',(select payload from wekeep_inventory_private.snapshot where singleton),'checked_at',now());
end $$;

create or replace function public.save_wekeep_inventory(p_snapshot jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 collected timestamptz; previous_time timestamptz; previous_payload jsonb;
 item jsonb; quantity text; total integer;
begin
 if auth.uid() is null or not coalesce(
  split_part(auth.jwt()->>'email','@',2)='entropymakeup.com'
  or auth.jwt()->>'email'='entropyadmin@entropy.internal',false
 ) then raise exception 'Unauthorized dashboard user' using errcode='42501'; end if;
 if p_snapshot is null or jsonb_typeof(p_snapshot) is distinct from 'object'
  or octet_length(p_snapshot::text)>4194304 then raise exception 'INVALID_SNAPSHOT'; end if;
 if (p_snapshot - array['version','source','collected_at','expected_count','rows']::text[])<>'{}'::jsonb
  or p_snapshot->'version' is distinct from '1'::jsonb
  or p_snapshot->'source' is distinct from '"wekeep"'::jsonb
  or jsonb_typeof(p_snapshot->'collected_at') is distinct from 'string'
  or jsonb_typeof(p_snapshot->'expected_count') is distinct from 'number'
  or jsonb_typeof(p_snapshot->'rows') is distinct from 'array'
 then raise exception 'INVALID_SNAPSHOT'; end if;
 if (p_snapshot->>'expected_count') !~ '^[0-9]+$'
  or length(p_snapshot->>'expected_count')>5 then raise exception 'INVALID_COUNT'; end if;
 total:=(p_snapshot->>'expected_count')::integer;
 if total<1 or total>10000 or jsonb_array_length(p_snapshot->'rows')<>total then raise exception 'INCOMPLETE_SNAPSHOT'; end if;
 if (p_snapshot->>'collected_at') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$' then raise exception 'INVALID_TIME'; end if;
 collected:=(p_snapshot->>'collected_at')::timestamptz;
 if collected>now()+interval '5 minutes' or collected<now()-interval '24 hours' then raise exception 'INVALID_TIME'; end if;
 for item in select value from jsonb_array_elements(p_snapshot->'rows') loop
  if jsonb_typeof(item) is distinct from 'object'
   or (item-array['name','code','supplier','available','safety','held','defective']::text[])<>'{}'::jsonb
   or jsonb_typeof(item->'name') is distinct from 'string'
   or jsonb_typeof(item->'code') is distinct from 'string'
   or jsonb_typeof(item->'supplier') is distinct from 'string'
   or (item->>'name') !~ '[^[:space:]]' or length(item->>'name')>1000
   or length(item->>'code')>300 or length(item->>'supplier')>500
  then raise exception 'INVALID_ROW'; end if;
  foreach quantity in array array['available','safety','held','defective'] loop
   if jsonb_typeof(item->quantity) is distinct from 'number'
    or (item->>quantity) !~ '^-?[0-9]+$'
    or length(item->>quantity)>11 then raise exception 'INVALID_QUANTITY'; end if;
   if (item->>quantity)::numeric not between -2147483648 and 2147483647 then raise exception 'INVALID_QUANTITY'; end if;
  end loop;
 end loop;
 -- Serialize even the initial insert; old or conflicting retries cannot overwrite newer data.
 perform pg_catalog.pg_advisory_xact_lock(894217,1);
 select collected_at,payload into previous_time,previous_payload from wekeep_inventory_private.snapshot where singleton;
 if previous_time is not null and collected<=previous_time then
  if collected=previous_time and p_snapshot=previous_payload then
   return jsonb_build_object('saved',true,'collected_at',p_snapshot->>'collected_at','row_count',total);
  end if;
  raise exception 'STALE_SNAPSHOT';
 end if;
 insert into wekeep_inventory_private.snapshot(singleton,payload,collected_at,saved_at,saved_by)
 values(true,p_snapshot,collected,now(),auth.uid())
 on conflict(singleton) do update set payload=excluded.payload,collected_at=excluded.collected_at,saved_at=excluded.saved_at,saved_by=excluded.saved_by;
 return jsonb_build_object('saved',true,'collected_at',p_snapshot->>'collected_at','row_count',total);
end $$;
revoke all on function public.get_wekeep_inventory() from public,anon,authenticated;
revoke all on function public.save_wekeep_inventory(jsonb) from public,anon,authenticated;
grant execute on function public.get_wekeep_inventory() to authenticated;
grant execute on function public.save_wekeep_inventory(jsonb) to authenticated;
commit;
