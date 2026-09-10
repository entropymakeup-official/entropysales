-- Install after wekeep-history.sql. This extension leaves existing RPC contracts intact.
begin;
-- Match save_wekeep_history's serialization lock during seed and installation.
select pg_catalog.pg_advisory_xact_lock(894217,2);
create table if not exists wekeep_history_private.archive_catalog(
 sku text primary key,
 name text not null,
 code text not null,
 supplier text not null,
 collected_at timestamptz not null
);
create table if not exists wekeep_history_private.archive_day(
 sku text not null references wekeep_history_private.archive_catalog(sku),
 date date not null,
 has_record boolean not null,
 inbound integer,
 returned integer,
 faulty integer,
 damaged integer,
 outbound integer,
 balance integer,
 collected_at timestamptz not null,
 primary key(sku,date),
 check((has_record and inbound is not null and returned is not null and faulty is not null
  and damaged is not null and outbound is not null and balance is not null)
  or (not has_record and inbound is null and returned is null and faulty is null
  and damaged is null and outbound is null and balance is null))
);
alter table wekeep_history_private.archive_catalog enable row level security;
alter table wekeep_history_private.archive_day enable row level security;
revoke all on wekeep_history_private.archive_catalog,wekeep_history_private.archive_day from public,anon,authenticated;

-- One ingestion path for the trigger and idempotent installation seed.
create or replace function wekeep_history_private.archive_window(w wekeep_history_private.product_window)
returns void language plpgsql security definer set search_path='' as $$
declare
 observed record;
 existing wekeep_history_private.archive_day%rowtype;
begin
 perform pg_catalog.pg_advisory_xact_lock(894217,2);
 insert into wekeep_history_private.archive_catalog(sku,name,code,supplier,collected_at)
 select sku,name,code,supplier,collected_at from wekeep_history_private.catalog where sku=w.sku
 on conflict(sku) do update set name=excluded.name,code=excluded.code,
 supplier=excluded.supplier,collected_at=excluded.collected_at
 where excluded.collected_at>wekeep_history_private.archive_catalog.collected_at;

 for observed in
  select w.from_date+n as date, d.value is not null as has_record,
   (d.value->>'inbound')::integer as inbound,(d.value->>'returned')::integer as returned,
   (d.value->>'faulty')::integer as faulty,(d.value->>'damaged')::integer as damaged,
   (d.value->>'outbound')::integer as outbound,(d.value->>'balance')::integer as balance
  from pg_catalog.generate_series(0,w.to_date-w.from_date) n
  left join lateral (select value from pg_catalog.jsonb_array_elements(w.days)
   where (value->>'date')::date=w.from_date+n) d on true
 loop
  select * into existing from wekeep_history_private.archive_day where sku=w.sku and date=observed.date;
  if found and existing.collected_at=w.collected_at and
   row(existing.has_record,existing.inbound,existing.returned,existing.faulty,existing.damaged,existing.outbound,existing.balance)
   is distinct from row(observed.has_record,observed.inbound,observed.returned,observed.faulty,observed.damaged,observed.outbound,observed.balance)
  then raise exception 'CONFLICTING_HISTORY'; end if;
  insert into wekeep_history_private.archive_day(sku,date,has_record,inbound,returned,faulty,damaged,outbound,balance,collected_at)
  values(w.sku,observed.date,observed.has_record,observed.inbound,observed.returned,observed.faulty,observed.damaged,observed.outbound,observed.balance,w.collected_at)
  on conflict(sku,date) do update set has_record=excluded.has_record,inbound=excluded.inbound,
   returned=excluded.returned,faulty=excluded.faulty,damaged=excluded.damaged,
   outbound=excluded.outbound,balance=excluded.balance,collected_at=excluded.collected_at
  where excluded.collected_at>wekeep_history_private.archive_day.collected_at;
 end loop;
end $$;
create or replace function wekeep_history_private.archive_window_trigger()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 perform wekeep_history_private.archive_window(new);
 return new;
end $$;
revoke all on function wekeep_history_private.archive_window(wekeep_history_private.product_window) from public,anon,authenticated;
revoke all on function wekeep_history_private.archive_window_trigger() from public,anon,authenticated;
drop trigger if exists archive_window on wekeep_history_private.product_window;
create trigger archive_window after insert or update on wekeep_history_private.product_window
 for each row execute function wekeep_history_private.archive_window_trigger();
select wekeep_history_private.archive_window(w) from wekeep_history_private.product_window w;

create or replace function public.get_wekeep_history_year(p_year integer)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare
 today date:=(now() at time zone 'Asia/Seoul')::date;
 year_start date;
 result_catalog jsonb;
 result_months jsonb;
begin
 if auth.uid() is null or not coalesce(
  split_part(auth.jwt()->>'email','@',2)='entropymakeup.com'
  or auth.jwt()->>'email'='entropyadmin@entropy.internal',false
 ) then raise exception 'Unauthorized dashboard user' using errcode='42501'; end if;
 if p_year is null or p_year<2000 or p_year>extract(year from today)::integer
 then raise exception 'INVALID_HISTORY_YEAR'; end if;
 year_start:=make_date(p_year,1,1);
 select coalesce(jsonb_agg(jsonb_build_object('sku',sku,'name',name,'code',code,'supplier',supplier)
  order by sku collate "C"),'[]'::jsonb) into result_catalog from wekeep_history_private.archive_catalog;
 with periods as (
  select m as month,(year_start+make_interval(months=>m-1))::date as starts,
   least((year_start+make_interval(months=>m)-interval '1 day')::date,today) as ends
  from generate_series(1,12) m
 ), summaries as (
  select c.sku,p.month,count(d.date) as covered_days,count(d.date) filter(where d.has_record) as record_days,
   sum(d.inbound) as inbound,sum(d.returned) as returned,sum(d.faulty) as faulty,
   sum(d.damaged) as damaged,sum(d.outbound) as outbound,
   max(d.balance) filter(where d.date=p.ends and d.has_record) as balance,
   max(d.date) filter(where d.date=p.ends and d.has_record) as balance_date,
   max(d.collected_at) as last_collected_at,min(d.collected_at) as oldest_collected_at
  from wekeep_history_private.archive_catalog c cross join periods p
  left join wekeep_history_private.archive_day d on d.sku=c.sku and d.date between p.starts and p.ends
  group by c.sku,p.month
 ) select coalesce(jsonb_agg(to_jsonb(s) order by s.sku collate "C",s.month),'[]'::jsonb)
 into result_months from summaries s;
 return jsonb_build_object('year',p_year,'today',today,'catalog',result_catalog,'months',result_months,'checked_at',now());
end $$;
revoke all on function public.get_wekeep_history_year(integer) from public,anon,authenticated;
grant execute on function public.get_wekeep_history_year(integer) to authenticated;
commit;
