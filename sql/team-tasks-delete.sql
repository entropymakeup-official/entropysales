-- Team task list (업무 목록) deletion by list admins. Run after sql/team-tasks.sql.
-- Only members with is_admin = true can delete. A trigger records each deletion in team_task_history,
-- which no longer cascades with the task so the trail survives the row.
begin;

alter table public.team_task_members add column if not exists is_admin boolean not null default false;

alter table public.team_task_history drop constraint if exists team_task_history_task_id_fkey;
alter table public.team_task_history drop constraint if exists team_task_history_field_code_check;
alter table public.team_task_history add constraint team_task_history_field_code_check
 check (field_code in ('created','title','assignee','due','status','archived','deleted'));

create or replace function approval_private.is_team_task_admin() returns boolean
language sql stable security definer set search_path='' as $$
 select (select approval_private.is_company_member()) and exists(
  select 1 from public.team_task_members m
  where m.email = (select approval_private.current_email()) and m.is_active and m.is_admin
 );
$$;
revoke all on function approval_private.is_team_task_admin() from public,anon,authenticated;
grant execute on function approval_private.is_team_task_admin() to authenticated;

create or replace function approval_private.team_tasks_deleted() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 insert into public.team_task_history(task_id, field_code, from_text, to_text, changed_by_text)
 values (old.id, 'deleted', old.title_text, '', coalesce((select approval_private.current_email()), '알 수 없음'));
 return old;
end;
$$;
revoke all on function approval_private.team_tasks_deleted() from public,anon,authenticated;

drop trigger if exists team_tasks_deleted on public.team_tasks;
create trigger team_tasks_deleted after delete on public.team_tasks
 for each row execute function approval_private.team_tasks_deleted();

grant delete on public.team_tasks to authenticated;
drop policy if exists team_tasks_admin_delete on public.team_tasks;
create policy team_tasks_admin_delete on public.team_tasks
 for delete to authenticated using ((select approval_private.is_team_task_admin()));

notify pgrst, 'reload schema';
commit;
