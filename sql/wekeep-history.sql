-- Separate daily history windows. Existing inventory snapshots, orders and stocks are untouched.
begin;
create schema if not exists wekeep_history_private;
revoke all on schema wekeep_history_private from public,anon,authenticated;

create table if not exists wekeep_history_private.catalog_state(
 singleton boolean primary key default true check(singleton),
 collected_at timestamptz not null,
 collected_at_text text not null,
 catalog jsonb not null,
 saved_at timestamptz not null default now(),
 saved_by uuid not null
);

create table if not exists wekeep_history_private.catalog(
 sku text primary key,
 ordinal integer not null check(ordinal>0),
 name text not null,
 code text not null,
 supplier text not null,
 collected_at timestamptz not null,
 saved_at timestamptz not null default now(),
 saved_by uuid not null
);

create table if not exists wekeep_history_private.product_window(
 sku text primary key references wekeep_history_private.catalog(sku) on delete cascade,
 from_date date not null,
 to_date date not null,
 from_text text not null,
 to_text text not null,
 collected_at timestamptz not null,
 collected_at_text text not null,
 days jsonb not null,
 saved_at timestamptz not null default now(),
 saved_by uuid not null
);

alter table wekeep_history_private.catalog_state enable row level security;
alter table wekeep_history_private.catalog enable row level security;
alter table wekeep_history_private.product_window enable row level security;
revoke all on all tables in schema wekeep_history_private from public,anon,authenticated;

create or replace function public.get_wekeep_history()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare
 result_catalog jsonb;
 result_products jsonb;
begin
 if auth.uid() is null or not coalesce(
  split_part(auth.jwt()->>'email','@',2)='entropymakeup.com'
  or auth.jwt()->>'email'='entropyadmin@entropy.internal',false
 ) then raise exception 'Unauthorized dashboard user' using errcode='42501'; end if;

 select coalesce(jsonb_agg(jsonb_build_object(
  'sku',sku,'name',name,'code',code,'supplier',supplier
 ) order by ordinal),'[]'::jsonb)
 into result_catalog
 from wekeep_history_private.catalog;

 select coalesce(jsonb_agg(jsonb_build_object(
  'sku',sku,'from',from_text,'to',to_text,
  'collected_at',collected_at_text,'days',days
 ) order by sku collate "C"),'[]'::jsonb)
 into result_products
 from wekeep_history_private.product_window;

 return jsonb_build_object(
  'catalog',result_catalog,
  'products',result_products,
  'checked_at',now()
 );
end $$;

create or replace function public.save_wekeep_history(p_batch jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 collected timestamptz;
 range_from date;
 range_to date;
 catalog_item jsonb;
 product_item jsonb;
 day_item jsonb;
 normalized_catalog jsonb;
 normalized_products jsonb:='[]'::jsonb;
 normalized_days jsonb;
 catalog_seen jsonb:='{}'::jsonb;
 product_seen jsonb:='{}'::jsonb;
 day_seen jsonb;
 sku_value text;
 date_value text;
 quantity_key text;
 catalog_count integer;
 product_count integer;
 day_count integer:=0;
 catalog_ordinal bigint;
 previous_catalog_time timestamptz;
 previous_catalog_text text;
 previous_catalog jsonb;
 previous_product_time timestamptz;
 previous_product_text text;
 previous_from date;
 previous_to date;
 previous_days jsonb;
 has_catalog boolean;
 has_product boolean;
 should_replace_catalog boolean:=false;
begin
 if auth.uid() is null or not coalesce(
  split_part(auth.jwt()->>'email','@',2)='entropymakeup.com'
  or auth.jwt()->>'email'='entropyadmin@entropy.internal',false
 ) then raise exception 'Unauthorized dashboard user' using errcode='42501'; end if;

 -- This block deliberately maps every structural, type, calendar and range error
 -- to one public error. It performs no writes.
 begin
  if p_batch is null or jsonb_typeof(p_batch) is distinct from 'object'
   or octet_length(p_batch::text)>4194304
   or (select count(*) from jsonb_object_keys(p_batch))<>7
   or (p_batch-array['version','source','collected_at','from','to','catalog','products']::text[])<>'{}'::jsonb
   or p_batch->'version' is distinct from '1'::jsonb
   or p_batch->'source' is distinct from '"wekeep"'::jsonb
   or jsonb_typeof(p_batch->'collected_at') is distinct from 'string'
   or jsonb_typeof(p_batch->'from') is distinct from 'string'
   or jsonb_typeof(p_batch->'to') is distinct from 'string'
   or jsonb_typeof(p_batch->'catalog') is distinct from 'array'
   or jsonb_typeof(p_batch->'products') is distinct from 'array'
  then raise exception 'INVALID_HISTORY'; end if;

  if (p_batch->>'collected_at') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
   or (p_batch->>'from') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
   or (p_batch->>'to') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
  then raise exception 'INVALID_HISTORY'; end if;
  collected:=(p_batch->>'collected_at')::timestamptz;
  range_from:=(p_batch->>'from')::date;
  range_to:=(p_batch->>'to')::date;
  if to_char(range_from,'YYYY-MM-DD')<>p_batch->>'from'
   or to_char(range_to,'YYYY-MM-DD')<>p_batch->>'to'
   or range_to-range_from not between 0 and 30
   or collected>now()+interval '5 minutes'
   or collected<now()-interval '24 hours'
  then raise exception 'INVALID_HISTORY'; end if;

  catalog_count:=jsonb_array_length(p_batch->'catalog');
  product_count:=jsonb_array_length(p_batch->'products');
  if catalog_count not between 1 and 10000 or product_count not between 1 and 200
  then raise exception 'INVALID_HISTORY'; end if;

  for catalog_item,catalog_ordinal in
   select value,ordinality from jsonb_array_elements(p_batch->'catalog') with ordinality
  loop
   if jsonb_typeof(catalog_item) is distinct from 'object'
    or (select count(*) from jsonb_object_keys(catalog_item))<>4
    or (catalog_item-array['sku','name','code','supplier']::text[])<>'{}'::jsonb
    or jsonb_typeof(catalog_item->'sku') is distinct from 'string'
    or jsonb_typeof(catalog_item->'name') is distinct from 'string'
    or jsonb_typeof(catalog_item->'code') is distinct from 'string'
    or jsonb_typeof(catalog_item->'supplier') is distinct from 'string'
    or (catalog_item->>'sku') !~ '^[0-9]{1,40}$'
    or (catalog_item->>'name') !~ '[^[:space:]]'
    or length(catalog_item->>'name')>1000
    or length(catalog_item->>'code')>300
    or length(catalog_item->>'supplier')>500
   then raise exception 'INVALID_HISTORY'; end if;
   sku_value:=catalog_item->>'sku';
   if catalog_seen?sku_value then raise exception 'INVALID_HISTORY'; end if;
   catalog_seen:=catalog_seen||jsonb_build_object(sku_value,true);
  end loop;

  select jsonb_agg(jsonb_build_object(
   'sku',value->>'sku','name',value->>'name','code',value->>'code','supplier',value->>'supplier'
  ) order by value->>'sku' collate "C")
  into normalized_catalog
  from jsonb_array_elements(p_batch->'catalog');

  for product_item in select value from jsonb_array_elements(p_batch->'products') loop
   if jsonb_typeof(product_item) is distinct from 'object'
    or (select count(*) from jsonb_object_keys(product_item))<>2
    or (product_item-array['sku','days']::text[])<>'{}'::jsonb
    or jsonb_typeof(product_item->'sku') is distinct from 'string'
    or jsonb_typeof(product_item->'days') is distinct from 'array'
    or (product_item->>'sku') !~ '^[0-9]{1,40}$'
   then raise exception 'INVALID_HISTORY'; end if;
   sku_value:=product_item->>'sku';
   if not catalog_seen?sku_value or product_seen?sku_value then raise exception 'INVALID_HISTORY'; end if;
   product_seen:=product_seen||jsonb_build_object(sku_value,true);
   day_seen:='{}'::jsonb;

   for day_item in select value from jsonb_array_elements(product_item->'days') loop
    if jsonb_typeof(day_item) is distinct from 'object'
     or (select count(*) from jsonb_object_keys(day_item))<>7
     or (day_item-array['date','inbound','returned','faulty','damaged','outbound','balance']::text[])<>'{}'::jsonb
     or jsonb_typeof(day_item->'date') is distinct from 'string'
     or (day_item->>'date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    then raise exception 'INVALID_HISTORY'; end if;
    date_value:=day_item->>'date';
    if to_char(date_value::date,'YYYY-MM-DD')<>date_value
     or date_value::date not between range_from and range_to
     or day_seen?date_value
    then raise exception 'INVALID_HISTORY'; end if;
    day_seen:=day_seen||jsonb_build_object(date_value,true);
    foreach quantity_key in array array['inbound','returned','faulty','damaged','outbound','balance'] loop
     if jsonb_typeof(day_item->quantity_key) is distinct from 'number'
      or (day_item->>quantity_key) !~ '^-?[0-9]+$'
      or length(day_item->>quantity_key)>11
      or (day_item->>quantity_key)::numeric not between -2147483648 and 2147483647
     then raise exception 'INVALID_HISTORY'; end if;
    end loop;
   end loop;

   select coalesce(jsonb_agg(jsonb_build_object(
    'date',value->>'date',
    'inbound',(value->>'inbound')::integer,
    'returned',(value->>'returned')::integer,
    'faulty',(value->>'faulty')::integer,
    'damaged',(value->>'damaged')::integer,
    'outbound',(value->>'outbound')::integer,
    'balance',(value->>'balance')::integer
   ) order by value->>'date'),'[]'::jsonb)
   into normalized_days
   from jsonb_array_elements(product_item->'days');
   day_count:=day_count+jsonb_array_length(normalized_days);
   normalized_products:=normalized_products||jsonb_build_array(jsonb_build_object(
    'sku',sku_value,'from',p_batch->>'from','to',p_batch->>'to','days',normalized_days
   ));
  end loop;
 exception when others then
  raise exception 'INVALID_HISTORY';
 end;

 -- Serialize the monotonicity decision and every write in the transaction.
 perform pg_catalog.pg_advisory_xact_lock(894217,2);

 select collected_at,collected_at_text,catalog
 into previous_catalog_time,previous_catalog_text,previous_catalog
 from wekeep_history_private.catalog_state where singleton;
 has_catalog:=found;
 if not has_catalog then
  should_replace_catalog:=true;
 elsif collected<previous_catalog_time then
  raise exception 'STALE_HISTORY';
 elsif collected=previous_catalog_time then
  if p_batch->>'collected_at'<>previous_catalog_text or normalized_catalog<>previous_catalog then
   raise exception 'CONFLICTING_HISTORY';
  end if;
 else
  should_replace_catalog:=true;
 end if;

 -- Preflight every product before changing the catalog or any window, so one
 -- stale/conflicting member rejects the whole batch without partial effects.
 for product_item in select value from jsonb_array_elements(normalized_products) loop
  select collected_at,collected_at_text,from_date,to_date,days
  into previous_product_time,previous_product_text,previous_from,previous_to,previous_days
  from wekeep_history_private.product_window where sku=product_item->>'sku';
  has_product:=found;
  if has_product and collected<previous_product_time then
   raise exception 'STALE_HISTORY';
  elsif has_product and collected=previous_product_time and (
   p_batch->>'collected_at'<>previous_product_text
   or range_from<>previous_from or range_to<>previous_to
   or product_item->'days'<>previous_days
  ) then
   raise exception 'CONFLICTING_HISTORY';
  end if;
 end loop;

 if should_replace_catalog then
  insert into wekeep_history_private.catalog(
   sku,ordinal,name,code,supplier,collected_at,saved_at,saved_by
  )
  select value->>'sku',ordinality::integer,value->>'name',value->>'code',value->>'supplier',
   collected,now(),auth.uid()
  from jsonb_array_elements(p_batch->'catalog') with ordinality
  on conflict(sku) do update set
   ordinal=excluded.ordinal,name=excluded.name,code=excluded.code,supplier=excluded.supplier,
   collected_at=excluded.collected_at,saved_at=excluded.saved_at,saved_by=excluded.saved_by;

  delete from wekeep_history_private.catalog current_item
  where not catalog_seen?current_item.sku;

  insert into wekeep_history_private.catalog_state(
   singleton,collected_at,collected_at_text,catalog,saved_at,saved_by
  ) values(true,collected,p_batch->>'collected_at',normalized_catalog,now(),auth.uid())
  on conflict(singleton) do update set
   collected_at=excluded.collected_at,collected_at_text=excluded.collected_at_text,
   catalog=excluded.catalog,saved_at=excluded.saved_at,saved_by=excluded.saved_by;
 end if;

 for product_item in select value from jsonb_array_elements(normalized_products) loop
  insert into wekeep_history_private.product_window(
   sku,from_date,to_date,from_text,to_text,collected_at,collected_at_text,days,saved_at,saved_by
  ) values(
   product_item->>'sku',range_from,range_to,p_batch->>'from',p_batch->>'to',
   collected,p_batch->>'collected_at',product_item->'days',now(),auth.uid()
  )
  on conflict(sku) do update set
   from_date=excluded.from_date,to_date=excluded.to_date,
   from_text=excluded.from_text,to_text=excluded.to_text,
   collected_at=excluded.collected_at,collected_at_text=excluded.collected_at_text,
   days=excluded.days,saved_at=excluded.saved_at,saved_by=excluded.saved_by;
 end loop;

 return jsonb_build_object(
  'saved',true,'collected_at',p_batch->>'collected_at',
  'product_count',product_count,'day_count',day_count
 );
end $$;

revoke all on function public.get_wekeep_history() from public,anon,authenticated;
revoke all on function public.save_wekeep_history(jsonb) from public,anon,authenticated;
grant execute on function public.get_wekeep_history() to authenticated;
grant execute on function public.save_wekeep_history(jsonb) to authenticated;
commit;
