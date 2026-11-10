-- 면세점 판매 대시보드 스냅샷(신세계 온라인·오프라인, 롯데 온라인). 기존 주문·제품·재고 자료는 변경하지 않는다.
-- 읽기: 회사 계정(@entropymakeup.com, 내부 관리자)의 유효한 세션만 get_dutyfree_dashboard()로 조회.
-- 쓰기: 자동 갱신 전용 계정(dutyfree-sync@entropy.internal) 하나만 save_dutyfree_dashboard()로 스냅샷 전체를 교체.
-- 실제 매출·정산 자료와 계약 조건(수수료율·고정비)은 이 비공개 스냅샷에만 저장하고 공개 저장소에는 넣지 않는다.
begin;

do $$
begin
  if to_regclass('dutyfree_private.snapshot') is not null then
    raise exception 'dutyfree-dashboard is already installed';
  end if;
end $$;

create schema dutyfree_private;
revoke all on schema dutyfree_private from public, anon, authenticated;

create table dutyfree_private.snapshot (
  singleton boolean primary key default true check (singleton),
  payload jsonb not null,
  generated_at timestamptz not null,
  saved_at timestamptz not null default now(),
  saved_by uuid not null
);
alter table dutyfree_private.snapshot enable row level security;
revoke all on dutyfree_private.snapshot from public, anon, authenticated;

-- 세션 확인은 product-master.sql과 같은 기준: 확인된 이메일, 정지되지 않은 계정, 만료되지 않은 현재 세션.
create function approval_private.dutyfree_session_email() returns text
language sql stable security definer set search_path = '' as $$
  select lower(u.email) from auth.users u join auth.sessions s on s.user_id = u.id
  where u.id = (select auth.uid()) and u.email_confirmed_at is not null
    and (u.banned_until is null or u.banned_until <= now())
    and s.id::text = (select auth.jwt() ->> 'session_id')
    and (s.not_after is null or s.not_after > now())
  limit 1;
$$;
revoke all on function approval_private.dutyfree_session_email() from public, anon, authenticated;

create function public.get_dutyfree_dashboard() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  email text := approval_private.dutyfree_session_email();
  row_ dutyfree_private.snapshot;
begin
  if email is null or not (split_part(email, '@', 2) = 'entropymakeup.com' or email = 'entropyadmin@entropy.internal') then
    raise exception 'Unauthorized dashboard user' using errcode = '42501';
  end if;
  select * into row_ from dutyfree_private.snapshot where singleton;
  return jsonb_build_object('snapshot', row_.payload, 'generated_at', row_.generated_at, 'saved_at', row_.saved_at, 'checked_at', now());
end $$;

create function public.save_dutyfree_dashboard(p_snapshot jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  email text := approval_private.dutyfree_session_email();
  generated timestamptz;
  previous timestamptz;
  name text;
  tbl jsonb;
  ncols integer;
  counts jsonb := '{}'::jsonb;
begin
  if email is distinct from 'dutyfree-sync@entropy.internal' then
    raise exception 'Unauthorized snapshot writer' using errcode = '42501';
  end if;
  if p_snapshot is null or jsonb_typeof(p_snapshot) is distinct from 'object'
     or octet_length(p_snapshot::text) > 8388608 then
    raise exception 'INVALID_SNAPSHOT';
  end if;
  if (p_snapshot - array['version', 'source', 'generated_at', 'data_through', 'config', 'tables']::text[]) <> '{}'::jsonb
     or p_snapshot -> 'version' is distinct from '1'::jsonb
     or p_snapshot -> 'source' is distinct from '"dutyfree"'::jsonb
     or jsonb_typeof(p_snapshot -> 'generated_at') is distinct from 'string'
     or jsonb_typeof(p_snapshot -> 'data_through') is distinct from 'object'
     or jsonb_typeof(p_snapshot -> 'config') is distinct from 'object'
     or jsonb_typeof(p_snapshot -> 'tables') is distinct from 'object' then
    raise exception 'INVALID_SNAPSHOT';
  end if;
  if jsonb_typeof(p_snapshot -> 'config' -> 'agency_rate') is distinct from 'number'
     or jsonb_typeof(p_snapshot -> 'config' -> 'vat') is distinct from 'number'
     or jsonb_typeof(p_snapshot -> 'config' -> 'contract_fee_rate') is distinct from 'number'
     or jsonb_typeof(p_snapshot -> 'config' -> 'fixed') is distinct from 'array' then
    raise exception 'INVALID_CONFIG';
  end if;
  begin
    generated := (p_snapshot ->> 'generated_at')::timestamptz;
  exception when others then
    raise exception 'INVALID_GENERATED_AT';
  end;
  if generated > now() + interval '5 minutes' or generated < now() - interval '7 days' then
    raise exception 'STALE_OR_FUTURE_SNAPSHOT';
  end if;
  if ((p_snapshot -> 'tables') - array['daily', 'sales', 'settle', 'fx', 'purchase']::text[]) <> '{}'::jsonb then
    raise exception 'INVALID_TABLES';
  end if;
  foreach name in array array['daily', 'sales', 'settle', 'fx', 'purchase'] loop
    tbl := p_snapshot -> 'tables' -> name;
    if jsonb_typeof(tbl) is distinct from 'object' or (tbl - array['cols', 'rows']::text[]) <> '{}'::jsonb
       or jsonb_typeof(tbl -> 'cols') is distinct from 'array' or jsonb_typeof(tbl -> 'rows') is distinct from 'array' then
      raise exception 'INVALID_TABLE %', name;
    end if;
    ncols := jsonb_array_length(tbl -> 'cols');
    if ncols < 1 or ncols > 40 or jsonb_array_length(tbl -> 'rows') > 200000
       or exists (select 1 from jsonb_array_elements(tbl -> 'cols') c where jsonb_typeof(c) is distinct from 'string')
       or exists (select 1 from jsonb_array_elements(tbl -> 'rows') r where jsonb_typeof(r) is distinct from 'array' or jsonb_array_length(r) <> ncols) then
      raise exception 'INVALID_TABLE %', name;
    end if;
    counts := counts || jsonb_build_object(name, jsonb_array_length(tbl -> 'rows'));
  end loop;
  if (counts ->> 'daily')::integer < 1 or (counts ->> 'sales')::integer < 1 then
    raise exception 'EMPTY_SNAPSHOT';
  end if;

  perform pg_advisory_xact_lock(hashtext('dutyfree_private.snapshot'));
  select s.generated_at into previous from dutyfree_private.snapshot s where singleton;
  if previous is not null and generated < previous then
    raise exception 'OLDER_SNAPSHOT';
  end if;
  insert into dutyfree_private.snapshot(singleton, payload, generated_at, saved_at, saved_by)
  values (true, p_snapshot, generated, now(), (select auth.uid()))
  on conflict (singleton) do update set payload = excluded.payload, generated_at = excluded.generated_at,
    saved_at = excluded.saved_at, saved_by = excluded.saved_by;
  return jsonb_build_object('saved', true, 'generated_at', generated, 'counts', counts);
end $$;

revoke all on function public.get_dutyfree_dashboard() from public, anon;
revoke all on function public.save_dutyfree_dashboard(jsonb) from public, anon;
grant execute on function public.get_dutyfree_dashboard() to authenticated;
grant execute on function public.save_dutyfree_dashboard(jsonb) to authenticated;

commit;
