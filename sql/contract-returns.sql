-- Additive clause review fields; preserve approval/RLS and business values.
begin;
-- Keep pending before-snapshots valid; block new submissions during this short migration.
lock table approval_private.requests in share row exclusive mode;
do $$ begin
 if exists(select 1 from approval_private.requests r cross join lateral jsonb_array_elements(r.operations) op where r.status='pending' and op->>'table'='contracts') then
  raise exception 'Pending contract requests must be reviewed before installing clause fields';
 end if;
end $$;
alter table public.contracts add column returns_status text not null default '미확인' check (returns_status in ('미확인','명시','일부명시','미기재','해당없음')), add column returns_terms text not null default '', add constraint contracts_returns_evidence check (returns_status='미확인' or length(btrim(returns_terms))>0);
alter table public.contracts add column defect_liability_status text not null default '미확인' check (defect_liability_status in ('미확인','명시','일부명시','미기재','해당없음')), add column defect_liability_terms text not null default '', add constraint contracts_defect_liability_evidence check (defect_liability_status='미확인' or length(btrim(defect_liability_terms))>0);
alter table public.contracts add column unclear_cause_status text not null default '미확인' check (unclear_cause_status in ('미확인','명시','일부명시','미기재','해당없음')), add column unclear_cause_terms text not null default '', add constraint contracts_unclear_cause_evidence check (unclear_cause_status='미확인' or length(btrim(unclear_cause_terms))>0);
notify pgrst,'reload schema';
commit;
