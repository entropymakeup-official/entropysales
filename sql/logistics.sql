-- 물류 요청 대시보드(logistics.html). 새 표만 만들고 기존 주문·재고·승인 표는 바꾸지 않는다.
-- 상태 규칙은 logistics-model.js와 같고 최종 판정은 이 트리거가 한다. 명단 실제 값은 저장소에 넣지 않는다.
begin;

create table if not exists public.logistics_handlers (
 email text primary key check (email ~ '^[a-z0-9._%+-]+@entropymakeup\.com$'),
 display_name text not null check (length(btrim(display_name)) between 1 and 40),
 is_active boolean not null default true
);
create table if not exists public.logistics_people (
 email text primary key check (email ~ '^[a-z0-9._%+-]+@entropymakeup\.com$'),
 display_name text not null check (length(btrim(display_name)) between 1 and 40),
 slack_user_id text check (slack_user_id is null or slack_user_id ~ '^U[A-Z0-9]{6,20}$')
);

create table if not exists public.logistics_requests (
 id uuid primary key default gen_random_uuid(),
 type_code text not null check (type_code in ('b2b','sample','quick','seeding','cs','return','etc')),
 title_text text not null check (length(btrim(title_text)) between 1 and 80),
 team_code text not null check (team_code in ('global','domestic','marketing','cs','etc')),
 requester_email text not null,
 counterparty_text text not null check (length(btrim(counterparty_text)) between 1 and 120),
 want_date date,
 ship_mode_code text not null check (ship_mode_code in ('parcel','quick','air','ocean','direct','express','etc')),
 qty_summary_text text not null default '' check (length(qty_summary_text) <= 300),
 note_text text not null default '' check (length(note_text) <= 1000),
 invoice_id uuid references public.invoices(id) on delete set null,
 status_code text not null default 'requested' check (status_code in ('requested','accepted','preparing','shipped','on_hold','canceled')),
 status_note_text text not null default '' check (length(status_note_text) <= 300),
 result_text text not null default '' check (length(result_text) <= 500),
 shipped_on date,
 quick_fee_krw integer check (quick_fee_krw is null or quick_fee_krw >= 0),
 packing_code text check (packing_code is null or packing_code in ('waiting','done','replied')),
 etd_on date,
 forwarder_text text not null default '' check (length(forwarder_text) <= 120),
 slack_ts text,
 slack_state_code text not null default 'pending' check (slack_state_code in ('pending','sent','failed','none')),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 updated_by_text text not null default '',
 check (status_code <> 'shipped' or (length(btrim(result_text)) > 0 and shipped_on is not null))
);
create index if not exists logistics_requests_status_idx on public.logistics_requests(status_code, want_date);
create index if not exists logistics_requests_requester_idx on public.logistics_requests(requester_email);

create table if not exists public.logistics_request_files (
 id uuid primary key default gen_random_uuid(),
 request_id uuid not null references public.logistics_requests(id) on delete cascade,
 kind_code text not null check (kind_code in ('request','packing','receipt','etc')),
 storage_path text not null unique check (storage_path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}-[^/]{1,120}$'),
 name_text text not null check (length(name_text) between 1 and 200),
 size_bytes bigint not null check (size_bytes between 0 and 20971520),
 created_by text not null default '',
 created_at timestamptz not null default now()
);
create index if not exists logistics_request_files_req_idx on public.logistics_request_files(request_id);

create table if not exists public.logistics_request_comments (
 id uuid primary key default gen_random_uuid(),
 request_id uuid not null references public.logistics_requests(id) on delete cascade,
 body_text text not null check (length(btrim(body_text)) between 1 and 1000),
 author_email text not null default '',
 created_at timestamptz not null default now()
);
create index if not exists logistics_request_comments_req_idx on public.logistics_request_comments(request_id, created_at);

create table if not exists public.logistics_request_history (
 id bigint generated always as identity primary key,
 request_id uuid not null references public.logistics_requests(id) on delete cascade,
 field_code text not null check (field_code in ('created','status','want_date','result','packing','invoice')),
 from_text text not null default '',
 to_text text not null default '',
 changed_by_text text not null default '',
 changed_at timestamptz not null default now()
);
create index if not exists logistics_request_history_req_idx on public.logistics_request_history(request_id, changed_at);

create table if not exists public.logistics_slack_outbox (
 id bigint generated always as identity primary key,
 request_id uuid not null references public.logistics_requests(id) on delete cascade,
 event_code text not null check (event_code in ('created','shipped','on_hold','canceled','reopened')),
 payload jsonb not null default '{}'::jsonb,
 state_code text not null default 'pending' check (state_code in ('pending','sending','sent','failed')),
 attempts integer not null default 0,
 net_request_id bigint,
 last_error_text text not null default '',
 created_at timestamptz not null default now(),
 sent_at timestamptz
);
create index if not exists logistics_slack_outbox_state_idx on public.logistics_slack_outbox(state_code, id);

create or replace function approval_private.logistics_is_handler() returns boolean
language sql stable security definer set search_path='' as $$
 select (select approval_private.is_company_member()) and exists(
  select 1 from public.logistics_handlers h where h.email=(select approval_private.current_email()) and h.is_active);
$$;

create or replace function approval_private.logistics_transition_ok(f text, t text) returns boolean
language sql immutable set search_path='' as $$
 select (f,t) in (values
  ('requested','accepted'),('requested','preparing'),('requested','shipped'),('accepted','preparing'),('accepted','shipped'),('preparing','shipped'),
  ('requested','on_hold'),('accepted','on_hold'),('preparing','on_hold'),
  ('on_hold','requested'),('on_hold','accepted'),('on_hold','preparing'),
  ('requested','canceled'),('accepted','canceled'),('preparing','canceled'),('on_hold','canceled'),
  ('shipped','preparing'));
$$;

-- 등록·수정 규칙. auth.uid()가 없으면(예약 작업·SQL 편집기) 시스템으로 보고 권한 검사를 건너뛰지만 상태 규칙은 지킨다.
create or replace function approval_private.logistics_requests_stamp() returns trigger
language plpgsql security definer set search_path='' as $$
declare
 actor text := (select approval_private.current_email());
 is_system boolean := (select auth.uid()) is null;
 is_h boolean := (select approval_private.logistics_is_handler());
 summary_changed boolean; result_changed boolean; status_changed boolean;
begin
 new.title_text := btrim(new.title_text);
 new.counterparty_text := btrim(new.counterparty_text);
 new.qty_summary_text := btrim(new.qty_summary_text);
 new.note_text := btrim(new.note_text);
 new.status_note_text := btrim(new.status_note_text);
 new.result_text := btrim(new.result_text);
 new.forwarder_text := btrim(new.forwarder_text);
 new.updated_at := clock_timestamp();
 new.updated_by_text := coalesce(actor, 'system');
 if tg_op = 'INSERT' then
  if not is_system then
   if actor is null then raise exception 'LOGISTICS_LOGIN_REQUIRED'; end if;
   new.requester_email := actor;
  else
   new.requester_email := lower(btrim(coalesce(new.requester_email, '')));
   if new.requester_email = '' then raise exception 'LOGISTICS_LOGIN_REQUIRED'; end if;
  end if;
  new.status_code := 'requested'; new.status_note_text := ''; new.result_text := ''; new.shipped_on := null;
  new.slack_ts := null; new.slack_state_code := 'pending'; new.created_at := now();
  return new;
 end if;

 new.id := old.id; new.requester_email := old.requester_email; new.created_at := old.created_at;
 -- 주문 삭제 시 FK(on delete set null)가 invoice_id만 비우는 경우. 권한·닫힘 검사 없이 통과시킨다.
 if pg_trigger_depth() > 1 then return new; end if;
 if not is_system then new.slack_ts := old.slack_ts; new.slack_state_code := old.slack_state_code; end if;
 -- 사유는 그 전환에 딸린 값이다. 상태가 바뀌는데 사유를 새로 적지 않았으면 비운다.
 if new.status_code is distinct from old.status_code and new.status_note_text = old.status_note_text then new.status_note_text := ''; end if;
 summary_changed := (new.type_code,new.title_text,new.team_code,new.counterparty_text,new.want_date,new.ship_mode_code,new.qty_summary_text,new.note_text,new.invoice_id)
  is distinct from (old.type_code,old.title_text,old.team_code,old.counterparty_text,old.want_date,old.ship_mode_code,old.qty_summary_text,old.note_text,old.invoice_id);
 result_changed := (new.result_text,new.shipped_on,new.quick_fee_krw,new.packing_code,new.etd_on,new.forwarder_text)
  is distinct from (old.result_text,old.shipped_on,old.quick_fee_krw,old.packing_code,old.etd_on,old.forwarder_text);
 status_changed := new.status_code is distinct from old.status_code;

 if old.status_code = 'canceled' and (summary_changed or result_changed or status_changed) then
  raise exception 'LOGISTICS_CLOSED';
 end if;
 if not is_system and not is_h then
  if actor is distinct from old.requester_email or old.status_code <> 'requested' or result_changed
     or (status_changed and new.status_code <> 'canceled') then
   raise exception 'LOGISTICS_FORBIDDEN';
  end if;
 end if;
 if old.status_code = 'shipped' and summary_changed then raise exception 'LOGISTICS_CLOSED'; end if;
 if status_changed then
  if not approval_private.logistics_transition_ok(old.status_code, new.status_code) then raise exception 'LOGISTICS_BAD_TRANSITION'; end if;
  if (new.status_code = 'on_hold' or (old.status_code = 'shipped' and new.status_code = 'preparing')) and new.status_note_text = '' then
   raise exception 'LOGISTICS_NOTE_REQUIRED';
  end if;
 end if;
 if new.status_code = 'shipped' and (new.result_text = '' or new.shipped_on is null) then raise exception 'LOGISTICS_RESULT_REQUIRED'; end if;
 return new;
end $$;

create or replace function approval_private.logistics_requests_log() returns trigger
language plpgsql security definer set search_path='' as $$
declare actor text := coalesce((select approval_private.current_email()), 'system'); ev text;
begin
 if tg_op = 'INSERT' then
  insert into public.logistics_request_history(request_id,field_code,to_text,changed_by_text) values (new.id,'created',new.title_text,actor);
  ev := 'created';
 else
  if new.status_code is distinct from old.status_code then
   insert into public.logistics_request_history(request_id,field_code,from_text,to_text,changed_by_text) values (new.id,'status',old.status_code,new.status_code,actor);
   ev := case when new.status_code='shipped' then 'shipped' when new.status_code='on_hold' then 'on_hold' when new.status_code='canceled' then 'canceled'
              when old.status_code='shipped' then 'reopened' end;
  end if;
  if new.want_date is distinct from old.want_date then
   insert into public.logistics_request_history(request_id,field_code,from_text,to_text,changed_by_text) values (new.id,'want_date',coalesce(old.want_date::text,''),coalesce(new.want_date::text,''),actor);
  end if;
  if (new.result_text,new.shipped_on) is distinct from (old.result_text,old.shipped_on) then
   insert into public.logistics_request_history(request_id,field_code,from_text,to_text,changed_by_text)
    values (new.id,'result',btrim(old.result_text||' '||coalesce(old.shipped_on::text,'')),btrim(new.result_text||' '||coalesce(new.shipped_on::text,'')),actor);
  end if;
  if new.packing_code is distinct from old.packing_code then
   insert into public.logistics_request_history(request_id,field_code,from_text,to_text,changed_by_text) values (new.id,'packing',coalesce(old.packing_code,''),coalesce(new.packing_code,''),actor);
  end if;
  if new.invoice_id is distinct from old.invoice_id then
   insert into public.logistics_request_history(request_id,field_code,from_text,to_text,changed_by_text) values (new.id,'invoice',coalesce(old.invoice_id::text,''),coalesce(new.invoice_id::text,''),actor);
  end if;
 end if;
 if ev is not null then
  insert into public.logistics_slack_outbox(request_id,event_code,payload) values (new.id, ev, jsonb_build_object(
   'title_text',new.title_text,'type_code',new.type_code,'ship_mode_code',new.ship_mode_code,'want_date',new.want_date,
   'requester_email',new.requester_email,'status_note_text',new.status_note_text,'result_text',new.result_text,'shipped_on',new.shipped_on,'actor',actor));
 end if;
 return null;
end $$;

drop trigger if exists logistics_requests_stamp on public.logistics_requests;
create trigger logistics_requests_stamp before insert or update on public.logistics_requests for each row execute function approval_private.logistics_requests_stamp();
drop trigger if exists logistics_requests_log on public.logistics_requests;
create trigger logistics_requests_log after insert or update on public.logistics_requests for each row execute function approval_private.logistics_requests_log();

create or replace function approval_private.logistics_files_stamp() returns trigger
language plpgsql security definer set search_path='' as $$
declare st text;
begin
 select status_code into st from public.logistics_requests where id=new.request_id for update;
 if st in ('shipped','canceled') then raise exception 'LOGISTICS_CLOSED'; end if;
 if split_part(new.storage_path,'/',1) <> new.request_id::text then raise exception 'LOGISTICS_FORBIDDEN'; end if;
 if (select count(*) from public.logistics_request_files where request_id=new.request_id) >= 10 then raise exception 'LOGISTICS_FILE_LIMIT'; end if;
 new.created_by := coalesce((select approval_private.current_email()), nullif(new.created_by,''), 'system');
 new.created_at := now();
 return new;
end $$;
drop trigger if exists logistics_files_stamp on public.logistics_request_files;
create trigger logistics_files_stamp before insert on public.logistics_request_files for each row execute function approval_private.logistics_files_stamp();

create or replace function approval_private.logistics_comments_stamp() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 new.body_text := btrim(new.body_text);
 new.author_email := coalesce((select approval_private.current_email()), nullif(new.author_email,''), 'system');
 new.created_at := now();
 return new;
end $$;
drop trigger if exists logistics_comments_stamp on public.logistics_request_comments;
create trigger logistics_comments_stamp before insert on public.logistics_request_comments for each row execute function approval_private.logistics_comments_stamp();

revoke all on function approval_private.logistics_is_handler() from public,anon;
grant execute on function approval_private.logistics_is_handler() to authenticated;
revoke all on function approval_private.logistics_requests_stamp(),approval_private.logistics_requests_log(),approval_private.logistics_files_stamp(),approval_private.logistics_comments_stamp() from public,anon,authenticated;

alter table public.logistics_handlers enable row level security;
alter table public.logistics_people enable row level security;
alter table public.logistics_requests enable row level security;
alter table public.logistics_request_files enable row level security;
alter table public.logistics_request_comments enable row level security;
alter table public.logistics_request_history enable row level security;
alter table public.logistics_slack_outbox enable row level security;

revoke all on public.logistics_handlers,public.logistics_people,public.logistics_requests,public.logistics_request_files,
 public.logistics_request_comments,public.logistics_request_history,public.logistics_slack_outbox from public,anon,authenticated;
grant select on public.logistics_handlers,public.logistics_people,public.logistics_request_history to authenticated;
grant select,insert,update on public.logistics_requests to authenticated;
grant select,insert,delete on public.logistics_request_files,public.logistics_request_comments to authenticated;

drop policy if exists logistics_handlers_read on public.logistics_handlers;
create policy logistics_handlers_read on public.logistics_handlers for select to authenticated using ((select approval_private.is_company_member()));
drop policy if exists logistics_people_read on public.logistics_people;
create policy logistics_people_read on public.logistics_people for select to authenticated using ((select approval_private.is_company_member()));
drop policy if exists logistics_requests_read on public.logistics_requests;
create policy logistics_requests_read on public.logistics_requests for select to authenticated using ((select approval_private.is_company_member()));
drop policy if exists logistics_requests_insert on public.logistics_requests;
create policy logistics_requests_insert on public.logistics_requests for insert to authenticated with check ((select approval_private.is_company_member()));
drop policy if exists logistics_requests_update on public.logistics_requests;
create policy logistics_requests_update on public.logistics_requests for update to authenticated
 using ((select approval_private.is_company_member())) with check ((select approval_private.is_company_member()));
drop policy if exists logistics_files_read on public.logistics_request_files;
create policy logistics_files_read on public.logistics_request_files for select to authenticated using ((select approval_private.is_company_member()));
drop policy if exists logistics_files_insert on public.logistics_request_files;
create policy logistics_files_insert on public.logistics_request_files for insert to authenticated with check ((select approval_private.is_company_member()));
drop policy if exists logistics_files_delete on public.logistics_request_files;
create policy logistics_files_delete on public.logistics_request_files for delete to authenticated
 using ((select approval_private.is_company_member()) and (created_by=(select approval_private.current_email()) or (select approval_private.logistics_is_handler())));
drop policy if exists logistics_comments_read on public.logistics_request_comments;
create policy logistics_comments_read on public.logistics_request_comments for select to authenticated using ((select approval_private.is_company_member()));
drop policy if exists logistics_comments_insert on public.logistics_request_comments;
create policy logistics_comments_insert on public.logistics_request_comments for insert to authenticated with check ((select approval_private.is_company_member()));
drop policy if exists logistics_comments_delete on public.logistics_request_comments;
create policy logistics_comments_delete on public.logistics_request_comments for delete to authenticated
 using ((select approval_private.is_company_member()) and author_email=(select approval_private.current_email()) and created_at > now() - interval '24 hours');
drop policy if exists logistics_history_read on public.logistics_request_history;
create policy logistics_history_read on public.logistics_request_history for select to authenticated using ((select approval_private.is_company_member()));
commit;
