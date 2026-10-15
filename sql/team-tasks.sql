-- Team task list (업무 목록). Additive tables only; no order, invoice or approval data changes.
-- Edits are direct (no change-approval trigger). History rows are written by a trigger, never by clients.
-- Member names/emails are seeded separately in the database, not committed to this repository.
begin;

create or replace function approval_private.is_company_member() returns boolean
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

create or replace function approval_private.current_email() returns text
language sql stable security definer set search_path='' as $$
 select lower(u.email) from auth.users u where u.id=(select auth.uid());
$$;

revoke all on function approval_private.is_company_member() from public,anon,authenticated;
revoke all on function approval_private.current_email() from public,anon,authenticated;
grant usage on schema approval_private to authenticated;
grant execute on function approval_private.is_company_member() to authenticated;
grant execute on function approval_private.current_email() to authenticated;

create table if not exists public.team_task_members (
 email text primary key check (email ~ '^[a-z0-9._%+-]+@entropymakeup\.com$'),
 display_name text not null check (length(btrim(display_name)) between 1 and 40),
 is_active boolean not null default true,
 sort_order integer not null default 0
);

create table if not exists public.team_tasks (
 id uuid primary key default gen_random_uuid(),
 title_text text not null check (length(btrim(title_text)) between 1 and 80),
 summary_text text not null default '' check (length(summary_text) <= 300),
 assignee_email text references public.team_task_members(email),
 suggested_assignee_text text not null default '' check (length(suggested_assignee_text) <= 40),
 due_on date,
 status_code text not null default 'todo' check (status_code in ('todo','in_progress','done','on_hold','canceled')),
 source_kind_code text not null default 'manual' check (source_kind_code in ('slack','gmail','drive','manual')),
 source_key text unique check (source_key is null or source_key ~ '^[A-Za-z0-9_.~:@+-]{1,190}$'),
 source_url text not null default '' check (source_url = '' or source_url ~ '^https://'),
 requester_text text not null default '' check (length(requester_text) <= 80),
 created_by_text text not null default '' check (length(created_by_text) <= 120),
 created_at timestamptz not null default now(),
 done_by_text text,
 done_at timestamptz,
 note_text text not null default '' check (length(note_text) <= 1000),
 is_archived boolean not null default false,
 updated_at timestamptz not null default now(),
 updated_by_text text not null default ''
);
create index if not exists team_tasks_assignee_idx on public.team_tasks(assignee_email);
create index if not exists team_tasks_status_due_idx on public.team_tasks(status_code, due_on);

create table if not exists public.team_task_history (
 id bigint generated always as identity primary key,
 task_id uuid not null references public.team_tasks(id) on delete cascade,
 field_code text not null check (field_code in ('created','title','assignee','due','status','archived')),
 from_text text not null default '',
 to_text text not null default '',
 changed_by_text text not null default '',
 changed_at timestamptz not null default now()
);
create index if not exists team_task_history_task_idx on public.team_task_history(task_id, changed_at);

-- Stamp who/when, keep creation fields fixed, and keep completion fields consistent with status.
create or replace function approval_private.team_tasks_stamp() returns trigger
language plpgsql security definer set search_path='' as $$
declare actor text := coalesce((select approval_private.current_email()), nullif(btrim(new.updated_by_text), ''), '수집 중계');
begin
 new.title_text := btrim(new.title_text);
 new.summary_text := btrim(new.summary_text);
 new.note_text := btrim(new.note_text);
 new.updated_at := clock_timestamp();
 new.updated_by_text := actor;
 if tg_op = 'INSERT' then
  new.created_at := clock_timestamp();
  new.created_by_text := coalesce((select approval_private.current_email()), nullif(btrim(new.created_by_text), ''), '수집 중계');
 else
  new.id := old.id;
  new.created_at := old.created_at;
  new.created_by_text := old.created_by_text;
  new.source_key := old.source_key;
  new.source_kind_code := old.source_kind_code;
 end if;
 if new.status_code = 'done' then
  if tg_op = 'INSERT' or old.status_code <> 'done' then
   new.done_at := clock_timestamp();
   new.done_by_text := actor;
  else
   new.done_at := old.done_at;
   new.done_by_text := old.done_by_text;
  end if;
 else
  new.done_at := null;
  new.done_by_text := null;
 end if;
 return new;
end;
$$;

create or replace function approval_private.team_tasks_history() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if tg_op = 'INSERT' then
  insert into public.team_task_history(task_id, field_code, to_text, changed_by_text)
  values (new.id, 'created', new.title_text, new.created_by_text);
  return new;
 end if;
 if new.title_text is distinct from old.title_text then
  insert into public.team_task_history(task_id, field_code, from_text, to_text, changed_by_text)
  values (new.id, 'title', old.title_text, new.title_text, new.updated_by_text);
 end if;
 if new.assignee_email is distinct from old.assignee_email then
  insert into public.team_task_history(task_id, field_code, from_text, to_text, changed_by_text)
  values (new.id, 'assignee', coalesce(old.assignee_email, ''), coalesce(new.assignee_email, ''), new.updated_by_text);
 end if;
 if new.due_on is distinct from old.due_on then
  insert into public.team_task_history(task_id, field_code, from_text, to_text, changed_by_text)
  values (new.id, 'due', coalesce(old.due_on::text, ''), coalesce(new.due_on::text, ''), new.updated_by_text);
 end if;
 if new.status_code is distinct from old.status_code then
  insert into public.team_task_history(task_id, field_code, from_text, to_text, changed_by_text)
  values (new.id, 'status', old.status_code, new.status_code, new.updated_by_text);
 end if;
 if new.is_archived is distinct from old.is_archived then
  insert into public.team_task_history(task_id, field_code, from_text, to_text, changed_by_text)
  values (new.id, 'archived', old.is_archived::text, new.is_archived::text, new.updated_by_text);
 end if;
 return new;
end;
$$;

revoke all on function approval_private.team_tasks_stamp() from public,anon,authenticated;
revoke all on function approval_private.team_tasks_history() from public,anon,authenticated;

drop trigger if exists team_tasks_stamp on public.team_tasks;
create trigger team_tasks_stamp before insert or update on public.team_tasks
 for each row execute function approval_private.team_tasks_stamp();
drop trigger if exists team_tasks_history on public.team_tasks;
create trigger team_tasks_history after insert or update on public.team_tasks
 for each row execute function approval_private.team_tasks_history();

alter table public.team_task_members enable row level security;
alter table public.team_tasks enable row level security;
alter table public.team_task_history enable row level security;
revoke all on public.team_task_members from public,anon,authenticated;
revoke all on public.team_tasks from public,anon,authenticated;
revoke all on public.team_task_history from public,anon,authenticated;
grant select on public.team_task_members to authenticated;
grant select, insert, update on public.team_tasks to authenticated;
grant select on public.team_task_history to authenticated;

drop policy if exists team_task_members_company_read on public.team_task_members;
create policy team_task_members_company_read on public.team_task_members
 for select to authenticated using ((select approval_private.is_company_member()));
drop policy if exists team_tasks_company_read on public.team_tasks;
create policy team_tasks_company_read on public.team_tasks
 for select to authenticated using ((select approval_private.is_company_member()));
drop policy if exists team_tasks_company_insert on public.team_tasks;
create policy team_tasks_company_insert on public.team_tasks
 for insert to authenticated with check ((select approval_private.is_company_member()));
drop policy if exists team_tasks_company_update on public.team_tasks;
create policy team_tasks_company_update on public.team_tasks
 for update to authenticated using ((select approval_private.is_company_member()))
 with check ((select approval_private.is_company_member()));
drop policy if exists team_task_history_company_read on public.team_task_history;
create policy team_task_history_company_read on public.team_task_history
 for select to authenticated using ((select approval_private.is_company_member()));

comment on table public.team_tasks is '글로벌 영업팀 업무 목록. 승인 없이 바로 수정하며 변경 이력은 트리거가 남긴다. 원문 전체·금액·연락처는 저장하지 않는다.';
notify pgrst, 'reload schema';
commit;
