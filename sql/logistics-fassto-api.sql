-- 파스토 OpenAPI 동기화(설계: docs/superpowers/specs/2026-11-27-fassto-api-sync-design.md).
-- logistics.sql → logistics-storage.sql → logistics-slack.sql → logistics-fassto.sql 다음에 설치한다. 다시 실행해도 안전하다.
-- 동기화는 사무실 PC가 anon으로 public.logistics_fassto_ingest를 부른다. 로그인 없는 호출이라 기존 트리거의 "시스템" 경로를 탄다.
begin;

-- 1) 요청의 파스토 연결 칸. 로그인한 회사 구성원은 넣거나 바꿀 수 없다.
alter table public.logistics_requests add column if not exists fassto_slip_no text;
alter table public.logistics_requests add column if not exists fassto_status_code text;
alter table public.logistics_requests add column if not exists fassto_synced_at timestamptz;
alter table public.logistics_requests drop constraint if exists logistics_requests_fassto_slip_no_check;
alter table public.logistics_requests add constraint logistics_requests_fassto_slip_no_check
 check (fassto_slip_no is null or fassto_slip_no ~ '^[A-Za-z0-9_-]{1,40}$');
alter table public.logistics_requests drop constraint if exists logistics_requests_fassto_status_code_check;
alter table public.logistics_requests add constraint logistics_requests_fassto_status_code_check
 check (fassto_status_code is null or fassto_status_code in ('ORDER','WORKING','DONE','CANCEL','SHORTAGE'));
create unique index if not exists logistics_requests_fassto_slip_no_idx on public.logistics_requests(fassto_slip_no) where fassto_slip_no is not null;

create or replace function approval_private.logistics_requests_fassto_guard() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if (select auth.uid()) is null then return new; end if;
 if tg_op = 'INSERT' then
  new.fassto_slip_no := null; new.fassto_status_code := null; new.fassto_synced_at := null;
 else
  new.fassto_slip_no := old.fassto_slip_no; new.fassto_status_code := old.fassto_status_code; new.fassto_synced_at := old.fassto_synced_at;
 end if;
 return new;
end $$;
drop trigger if exists logistics_requests_fassto_guard on public.logistics_requests;
create trigger logistics_requests_fassto_guard before insert or update on public.logistics_requests
 for each row execute function approval_private.logistics_requests_fassto_guard();

-- 2) 차량 기사 정보(요청당 0~1행). 슬랙에 실리지 않는다. 읽기는 요청자·활성 담당자, 쓰기는 활성 담당자. 취소된 요청에는 못 쓴다.
create table if not exists public.logistics_request_drivers (
 request_id uuid primary key references public.logistics_requests(id) on delete cascade,
 driver_name_text text not null default '' check (length(driver_name_text) <= 40),
 driver_phone_text text not null default '' check (length(driver_phone_text) <= 40),
 vehicle_no_text text not null default '' check (length(vehicle_no_text) <= 20),
 updated_at timestamptz not null default now(),
 updated_by_text text not null default ''
);

create or replace function approval_private.logistics_drivers_stamp() returns trigger
language plpgsql security definer set search_path='' as $$
declare st text;
begin
 if tg_op = 'UPDATE' then new.request_id := old.request_id; end if;
 select status_code into st from public.logistics_requests where id = new.request_id for update;
 if not found then raise exception 'LOGISTICS_FORBIDDEN'; end if;
 if st = 'canceled' then raise exception 'LOGISTICS_CLOSED'; end if;
 if (select auth.uid()) is not null and not (select approval_private.logistics_is_handler()) then raise exception 'LOGISTICS_HANDLER_ONLY'; end if;
 new.driver_name_text := btrim(new.driver_name_text); new.driver_phone_text := btrim(new.driver_phone_text);
 new.vehicle_no_text := btrim(new.vehicle_no_text);
 new.updated_at := clock_timestamp();
 new.updated_by_text := coalesce((select approval_private.current_email()), 'system');
 return new;
end $$;
drop trigger if exists logistics_drivers_stamp on public.logistics_request_drivers;
create trigger logistics_drivers_stamp before insert or update on public.logistics_request_drivers
 for each row execute function approval_private.logistics_drivers_stamp();

-- 3) 동기화 기록: 재고(stock)와 출고(delivery)를 나누고, 실패 실행은 error_text에 남긴다.
alter table public.logistics_fassto_sync add column if not exists kind_code text not null default 'stock';
alter table public.logistics_fassto_sync drop constraint if exists logistics_fassto_sync_kind_code_check;
alter table public.logistics_fassto_sync add constraint logistics_fassto_sync_kind_code_check check (kind_code in ('stock','delivery'));
alter table public.logistics_fassto_sync add column if not exists error_text text not null default '';
alter table public.logistics_fassto_sync drop constraint if exists logistics_fassto_sync_error_text_check;
alter table public.logistics_fassto_sync add constraint logistics_fassto_sync_error_text_check check (length(error_text) <= 300);
create index if not exists logistics_fassto_sync_kind_idx on public.logistics_fassto_sync(kind_code, synced_at desc);

-- 4) 전용 열쇠(sha256 hex만)와 동기화 설정. approval_private라 anon·authenticated는 못 읽는다.
create table if not exists approval_private.logistics_fassto_keys (
 key_hash text primary key check (key_hash ~ '^[0-9a-f]{64}$'),
 label_text text not null default '' check (length(label_text) <= 60),
 is_active boolean not null default true,
 created_at timestamptz not null default now()
);
create table if not exists approval_private.logistics_fassto_settings (
 id integer primary key check (id = 1),
 default_requester_email text not null check (default_requester_email ~ '^[a-z0-9._%+-]+@entropymakeup\.com$')
);

-- 5) 권한
revoke all on function approval_private.logistics_requests_fassto_guard(),approval_private.logistics_drivers_stamp() from public,anon,authenticated;
revoke all on approval_private.logistics_fassto_keys,approval_private.logistics_fassto_settings from public,anon,authenticated;

alter table public.logistics_request_drivers enable row level security;
revoke all on public.logistics_request_drivers from public,anon,authenticated;
grant select,insert,update on public.logistics_request_drivers to authenticated;
drop policy if exists logistics_drivers_read on public.logistics_request_drivers;
create policy logistics_drivers_read on public.logistics_request_drivers for select to authenticated
 using ((select approval_private.logistics_can_see_recipient(request_id)));
drop policy if exists logistics_drivers_insert on public.logistics_request_drivers;
create policy logistics_drivers_insert on public.logistics_request_drivers for insert to authenticated
 with check ((select approval_private.logistics_is_handler()));
drop policy if exists logistics_drivers_update on public.logistics_request_drivers;
create policy logistics_drivers_update on public.logistics_request_drivers for update to authenticated
 using ((select approval_private.logistics_is_handler())) with check ((select approval_private.logistics_is_handler()));

commit;
