-- Team task list (업무 목록) triage fields. Run after sql/team-tasks-review.sql.
-- is_important: 중요 표시. status_note_text: 최근 완료 근거 또는 반려 사유(검토 화면에 보인다).
-- handoff_team_text: 타팀업무로 넘긴 팀 이름.
begin;

alter table public.team_tasks add column if not exists is_important boolean not null default false;
alter table public.team_tasks add column if not exists status_note_text text not null default '';
alter table public.team_tasks add column if not exists handoff_team_text text not null default '';

alter table public.team_tasks drop constraint if exists team_tasks_status_note_text_check;
alter table public.team_tasks add constraint team_tasks_status_note_text_check check (length(status_note_text) <= 300);
alter table public.team_tasks drop constraint if exists team_tasks_handoff_team_text_check;
alter table public.team_tasks add constraint team_tasks_handoff_team_text_check check (length(handoff_team_text) <= 40);

notify pgrst, 'reload schema';
commit;
