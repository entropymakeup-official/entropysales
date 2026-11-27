-- 경영지원 요청(support.html, 대시보드 "경영지원" 탭). 세금계산서·구매확인서 등 공인인증서가 필요한 서류를 경영지원 담당자에게 요청한다.
-- 물류 요청(sql/logistics*.sql)과 같은 구조. logistics.sql 다음에 설치한다(슬랙 ID는 logistics_people을 같이 쓴다).
-- 상태 규칙은 support-model.js와 같고 최종 판정은 이 트리거가 한다. 명단·채널 실제 값은 저장소에 넣지 않는다.
-- 다시 실행해도 안전하다.
begin;

create table if not exists public.support_handlers (
 email text primary key check (email ~ '^[a-z0-9._%+-]+@entropymakeup\.com$'),
 display_name text not null check (length(btrim(display_name)) between 1 and 40),
 is_active boolean not null default true,
 mention_on_new boolean not null default true
);

create table if not exists public.support_requests (
 id uuid primary key default gen_random_uuid(),
 type_code text not null check (type_code in ('tax_invoice','purchase_confirm','certificate','business_doc','etc')),
 title_text text not null check (length(btrim(title_text)) between 1 and 80),
 requester_email text not null,
 counterparty_text text not null check (length(btrim(counterparty_text)) between 1 and 120),
 due_date date,
 amount_text text not null default '' check (length(amount_text) <= 100),
 issue_date date,
 note_text text not null default '' check (length(note_text) <= 1000),
 invoice_id uuid references public.invoices(id) on delete set null,
 status_code text not null default 'requested' check (status_code in ('requested','in_progress','done','on_hold','canceled')),
 status_note_text text not null default '' check (length(status_note_text) <= 300),
 result_text text not null default '' check (length(result_text) <= 300),
 done_at timestamptz,
 slack_ts text,
 slack_state_code text not null default 'pending' check (slack_state_code in ('pending','sent','failed','none')),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 updated_by_text text not null default ''
);
create index if not exists support_requests_status_idx on public.support_requests(status_code, due_date);
create index if not exists support_requests_requester_idx on public.support_requests(requester_email);

create table if not exists public.support_request_files (
 id uuid primary key default gen_random_uuid(),
 request_id uuid not null references public.support_requests(id) on delete cascade,
 kind_code text not null check (kind_code in ('request','result','etc')),
 storage_path text not null unique check (storage_path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}-[^/]{1,120}$'),
 name_text text not null check (length(name_text) between 1 and 200),
 size_bytes bigint not null check (size_bytes between 0 and 20971520),
 created_by text not null default '',
 created_at timestamptz not null default now()
);
create index if not exists support_request_files_req_idx on public.support_request_files(request_id);

create table if not exists public.support_request_comments (
 id uuid primary key default gen_random_uuid(),
 request_id uuid not null references public.support_requests(id) on delete cascade,
 body_text text not null check (length(btrim(body_text)) between 1 and 1000),
 author_email text not null default '',
 created_at timestamptz not null default now()
);
create index if not exists support_request_comments_req_idx on public.support_request_comments(request_id, created_at);

create table if not exists public.support_request_history (
 id bigint generated always as identity primary key,
 request_id uuid not null references public.support_requests(id) on delete cascade,
 field_code text not null check (field_code in ('created','status','due_date','result','invoice')),
 from_text text not null default '',
 to_text text not null default '',
 changed_by_text text not null default '',
 changed_at timestamptz not null default now()
);
create index if not exists support_request_history_req_idx on public.support_request_history(request_id, changed_at);

create table if not exists public.support_slack_outbox (
 id bigint generated always as identity primary key,
 request_id uuid not null references public.support_requests(id) on delete cascade,
 event_code text not null check (event_code in ('created','done','on_hold','canceled','reopened')),
 payload jsonb not null default '{}'::jsonb,
 state_code text not null default 'pending' check (state_code in ('pending','sending','sent','failed')),
 attempts integer not null default 0,
 net_request_id bigint,
 last_error_text text not null default '',
 created_at timestamptz not null default now(),
 sent_at timestamptz
);
create index if not exists support_slack_outbox_state_idx on public.support_slack_outbox(state_code, id);

create or replace function approval_private.support_is_handler() returns boolean
language sql stable security definer set search_path='' as $$
 select (select approval_private.is_company_member()) and exists(
  select 1 from public.support_handlers h where h.email=(select approval_private.current_email()) and h.is_active);
$$;

-- 첨부를 볼 수 있는 사람: 담당자와 그 요청의 요청자
create or replace function approval_private.support_can_see_files(p_request uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select (select approval_private.is_company_member()) and ((select approval_private.support_is_handler()) or exists(
  select 1 from public.support_requests r where r.id=p_request and r.requester_email=(select approval_private.current_email())));
$$;

create or replace function approval_private.support_transition_ok(f text, t text) returns boolean
language sql immutable set search_path='' as $$
 select (f,t) in (values
  ('requested','in_progress'),('requested','done'),('in_progress','done'),
  ('requested','on_hold'),('in_progress','on_hold'),
  ('on_hold','requested'),('on_hold','in_progress'),
  ('requested','canceled'),('in_progress','canceled'),('on_hold','canceled'),
  ('done','in_progress'));
$$;

-- 등록·수정 규칙. auth.uid()가 없으면(SQL 편집기·예약 작업) 시스템으로 보고 권한 검사를 건너뛰지만 상태 규칙은 지킨다.
create or replace function approval_private.support_requests_stamp() returns trigger
language plpgsql security definer set search_path='' as $$
declare
 actor text := (select approval_private.current_email());
 is_system boolean := (select auth.uid()) is null;
 is_h boolean := (select approval_private.support_is_handler());
 summary_changed boolean; result_changed boolean; status_changed boolean;
begin
 new.title_text := btrim(new.title_text);
 new.counterparty_text := btrim(new.counterparty_text);
 new.amount_text := btrim(new.amount_text);
 new.note_text := btrim(new.note_text);
 new.status_note_text := btrim(new.status_note_text);
 new.result_text := btrim(new.result_text);
 new.updated_at := clock_timestamp();
 new.updated_by_text := coalesce(actor, 'system');
 if tg_op = 'INSERT' then
  if not is_system then
   if actor is null then raise exception 'SUPPORT_LOGIN_REQUIRED'; end if;
   new.requester_email := actor;
  else
   new.requester_email := lower(btrim(coalesce(new.requester_email, '')));
   if new.requester_email = '' then raise exception 'SUPPORT_LOGIN_REQUIRED'; end if;
  end if;
  new.status_code := 'requested'; new.status_note_text := ''; new.result_text := ''; new.done_at := null;
  new.slack_ts := null; new.slack_state_code := 'pending'; new.created_at := now();
  return new;
 end if;

 new.id := old.id; new.requester_email := old.requester_email; new.created_at := old.created_at;
 -- 주문 삭제 시 FK(on delete set null)가 invoice_id만 비우는 경우. 권한·닫힘 검사 없이 통과시킨다.
 if pg_trigger_depth() > 1 then return new; end if;
 if not is_system then new.slack_ts := old.slack_ts; new.slack_state_code := old.slack_state_code; end if;
 if new.status_code is distinct from old.status_code and new.status_note_text = old.status_note_text then new.status_note_text := ''; end if;
 summary_changed := (new.type_code,new.title_text,new.counterparty_text,new.due_date,new.amount_text,new.issue_date,new.note_text,new.invoice_id)
  is distinct from (old.type_code,old.title_text,old.counterparty_text,old.due_date,old.amount_text,old.issue_date,old.note_text,old.invoice_id);
 result_changed := new.result_text is distinct from old.result_text;
 status_changed := new.status_code is distinct from old.status_code;

 if old.status_code = 'canceled' and (summary_changed or result_changed or status_changed) then
  raise exception 'SUPPORT_CLOSED';
 end if;
 if not is_system and not is_h then
  if actor is distinct from old.requester_email or old.status_code <> 'requested' or result_changed
     or (status_changed and new.status_code <> 'canceled') then
   raise exception 'SUPPORT_FORBIDDEN';
  end if;
 end if;
 if old.status_code = 'done' and summary_changed then raise exception 'SUPPORT_CLOSED'; end if;
 if status_changed then
  if not approval_private.support_transition_ok(old.status_code, new.status_code) then raise exception 'SUPPORT_BAD_TRANSITION'; end if;
  if (new.status_code = 'on_hold' or (old.status_code = 'done' and new.status_code = 'in_progress')) and new.status_note_text = '' then
   raise exception 'SUPPORT_NOTE_REQUIRED';
  end if;
  if new.status_code = 'done' then
   if not exists(select 1 from public.support_request_files f where f.request_id=new.id and f.kind_code='result') then
    raise exception 'SUPPORT_RESULT_FILE_REQUIRED';
   end if;
   new.done_at := now();
  else
   new.done_at := null;
  end if;
 else
  new.done_at := old.done_at;
 end if;
 return new;
end $$;

create or replace function approval_private.support_requests_log() returns trigger
language plpgsql security definer set search_path='' as $$
declare actor text := coalesce((select approval_private.current_email()), 'system'); ev text;
begin
 if tg_op = 'INSERT' then
  insert into public.support_request_history(request_id,field_code,to_text,changed_by_text) values (new.id,'created',new.title_text,actor);
  ev := 'created';
 else
  if new.status_code is distinct from old.status_code then
   insert into public.support_request_history(request_id,field_code,from_text,to_text,changed_by_text) values (new.id,'status',old.status_code,new.status_code,actor);
   ev := case when new.status_code='done' then 'done' when new.status_code='on_hold' then 'on_hold' when new.status_code='canceled' then 'canceled'
              when old.status_code='done' then 'reopened' end;
  end if;
  if new.due_date is distinct from old.due_date then
   insert into public.support_request_history(request_id,field_code,from_text,to_text,changed_by_text) values (new.id,'due_date',coalesce(old.due_date::text,''),coalesce(new.due_date::text,''),actor);
  end if;
  if new.result_text is distinct from old.result_text then
   insert into public.support_request_history(request_id,field_code,from_text,to_text,changed_by_text) values (new.id,'result',old.result_text,new.result_text,actor);
  end if;
  if new.invoice_id is distinct from old.invoice_id then
   insert into public.support_request_history(request_id,field_code,from_text,to_text,changed_by_text) values (new.id,'invoice',coalesce(old.invoice_id::text,''),coalesce(new.invoice_id::text,''),actor);
  end if;
 end if;
 if ev is not null then
  insert into public.support_slack_outbox(request_id,event_code,payload) values (new.id, ev, jsonb_build_object(
   'title_text',new.title_text,'type_code',new.type_code,'counterparty_text',new.counterparty_text,'due_date',new.due_date,
   'requester_email',new.requester_email,'status_note_text',new.status_note_text,'result_text',new.result_text,'actor',actor));
 end if;
 return null;
end $$;

drop trigger if exists support_requests_stamp on public.support_requests;
create trigger support_requests_stamp before insert or update on public.support_requests for each row execute function approval_private.support_requests_stamp();
drop trigger if exists support_requests_log on public.support_requests;
create trigger support_requests_log after insert or update on public.support_requests for each row execute function approval_private.support_requests_log();

-- 첨부: 요청자는 열린 요청에 request·etc만, 담당자는 취소 전이면 아무 종류나(완료 뒤 정정본 포함).
create or replace function approval_private.support_files_stamp() returns trigger
language plpgsql security definer set search_path='' as $$
declare st text; req text; actor text := (select approval_private.current_email()); is_system boolean := (select auth.uid()) is null;
begin
 select status_code, requester_email into st, req from public.support_requests where id=new.request_id for update;
 if st is null then raise exception 'SUPPORT_FORBIDDEN'; end if;
 if st = 'canceled' then raise exception 'SUPPORT_CLOSED'; end if;
 if split_part(new.storage_path,'/',1) <> new.request_id::text then raise exception 'SUPPORT_FORBIDDEN'; end if;
 if not is_system and not (select approval_private.support_is_handler()) then
  if actor is distinct from req then raise exception 'SUPPORT_FORBIDDEN'; end if;
  if st = 'done' then raise exception 'SUPPORT_CLOSED'; end if;
  if new.kind_code = 'result' then raise exception 'SUPPORT_HANDLER_ONLY'; end if;
 end if;
 if (select count(*) from public.support_request_files where request_id=new.request_id) >= 10 then raise exception 'SUPPORT_FILE_LIMIT'; end if;
 new.created_by := coalesce(actor, nullif(new.created_by,''), 'system');
 new.created_at := now();
 return new;
end $$;
drop trigger if exists support_files_stamp on public.support_request_files;
create trigger support_files_stamp before insert on public.support_request_files for each row execute function approval_private.support_files_stamp();

-- 완료 상태에서 마지막 발급본은 지우지 못한다(처리중으로 되돌린 뒤 지운다). 요청 자체가 지워지는 연쇄 삭제는 통과.
create or replace function approval_private.support_files_guard() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if pg_trigger_depth() > 1 then return old; end if;
 if old.kind_code = 'result' and exists(select 1 from public.support_requests r where r.id=old.request_id and r.status_code='done')
    and (select count(*) from public.support_request_files f where f.request_id=old.request_id and f.kind_code='result') <= 1 then
  raise exception 'SUPPORT_RESULT_FILE_REQUIRED';
 end if;
 return old;
end $$;
drop trigger if exists support_files_guard on public.support_request_files;
create trigger support_files_guard before delete on public.support_request_files for each row execute function approval_private.support_files_guard();

create or replace function approval_private.support_comments_stamp() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 new.body_text := btrim(new.body_text);
 new.author_email := coalesce((select approval_private.current_email()), nullif(new.author_email,''), 'system');
 new.created_at := now();
 return new;
end $$;
drop trigger if exists support_comments_stamp on public.support_request_comments;
create trigger support_comments_stamp before insert on public.support_request_comments for each row execute function approval_private.support_comments_stamp();

revoke all on function approval_private.support_is_handler(),approval_private.support_can_see_files(uuid) from public,anon;
grant execute on function approval_private.support_is_handler(),approval_private.support_can_see_files(uuid) to authenticated;
revoke all on function approval_private.support_requests_stamp(),approval_private.support_requests_log(),approval_private.support_files_stamp(),
 approval_private.support_files_guard(),approval_private.support_comments_stamp() from public,anon,authenticated;

alter table public.support_handlers enable row level security;
alter table public.support_requests enable row level security;
alter table public.support_request_files enable row level security;
alter table public.support_request_comments enable row level security;
alter table public.support_request_history enable row level security;
alter table public.support_slack_outbox enable row level security;

revoke all on public.support_handlers,public.support_requests,public.support_request_files,
 public.support_request_comments,public.support_request_history,public.support_slack_outbox from public,anon,authenticated;
grant select on public.support_handlers,public.support_request_history to authenticated;
grant select,insert,update on public.support_requests to authenticated;
grant select,insert,delete on public.support_request_files,public.support_request_comments to authenticated;

drop policy if exists support_handlers_read on public.support_handlers;
create policy support_handlers_read on public.support_handlers for select to authenticated using ((select approval_private.is_company_member()));
drop policy if exists support_requests_read on public.support_requests;
create policy support_requests_read on public.support_requests for select to authenticated using ((select approval_private.is_company_member()));
drop policy if exists support_requests_insert on public.support_requests;
create policy support_requests_insert on public.support_requests for insert to authenticated with check ((select approval_private.is_company_member()));
drop policy if exists support_requests_update on public.support_requests;
create policy support_requests_update on public.support_requests for update to authenticated
 using ((select approval_private.is_company_member())) with check ((select approval_private.is_company_member()));
drop policy if exists support_files_read on public.support_request_files;
create policy support_files_read on public.support_request_files for select to authenticated using ((select approval_private.support_can_see_files(request_id)));
drop policy if exists support_files_insert on public.support_request_files;
create policy support_files_insert on public.support_request_files for insert to authenticated with check ((select approval_private.support_can_see_files(request_id)));
drop policy if exists support_files_delete on public.support_request_files;
create policy support_files_delete on public.support_request_files for delete to authenticated
 using ((select approval_private.is_company_member()) and ((select approval_private.support_is_handler()) or (created_by=(select approval_private.current_email())
  and exists(select 1 from public.support_requests q where q.id=request_id and q.status_code not in ('done','canceled')))));
drop policy if exists support_comments_read on public.support_request_comments;
create policy support_comments_read on public.support_request_comments for select to authenticated using ((select approval_private.is_company_member()));
drop policy if exists support_comments_insert on public.support_request_comments;
create policy support_comments_insert on public.support_request_comments for insert to authenticated with check ((select approval_private.is_company_member()));
drop policy if exists support_comments_delete on public.support_request_comments;
create policy support_comments_delete on public.support_request_comments for delete to authenticated
 using ((select approval_private.is_company_member()) and author_email=(select approval_private.current_email()) and created_at > now() - interval '24 hours');
drop policy if exists support_history_read on public.support_request_history;
create policy support_history_read on public.support_request_history for select to authenticated using ((select approval_private.is_company_member()));
commit;
