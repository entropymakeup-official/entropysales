-- Team task list (업무 목록) completion review. Run after sql/team-tasks.sql and sql/team-tasks-delete.sql.
-- A logged-in member who is not a list admin cannot mark a task done directly: the change becomes
-- 'review' (완료 검토) and a list admin approves it (review -> done) or sends it back.
begin;

alter table public.team_tasks drop constraint if exists team_tasks_status_code_check;
alter table public.team_tasks add constraint team_tasks_status_code_check
 check (status_code in ('todo','in_progress','review','done','on_hold','canceled'));

-- Fires before team_tasks_stamp (trigger names run in alphabetical order), so the stamp sees the final status.
create or replace function approval_private.team_tasks_review() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if new.status_code = 'done'
  and (tg_op = 'INSERT' or old.status_code <> 'done')
  and (select approval_private.current_email()) is not null
  and not (select approval_private.is_team_task_admin()) then
  new.status_code := 'review';
 end if;
 return new;
end;
$$;
revoke all on function approval_private.team_tasks_review() from public,anon,authenticated;

drop trigger if exists team_tasks_review on public.team_tasks;
create trigger team_tasks_review before insert or update on public.team_tasks
 for each row execute function approval_private.team_tasks_review();

notify pgrst, 'reload schema';
commit;
