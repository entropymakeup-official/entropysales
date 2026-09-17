-- Additive clause review fields; preserve approval/RLS and business values.
begin;
-- Keep pending before-snapshots valid; block new submissions during this short migration.
lock table approval_private.requests in share row exclusive mode;
do $$ begin
 if exists(select 1 from approval_private.requests r cross join lateral jsonb_array_elements(r.operations) op where r.status='pending' and op->>'table'='contracts') then
  raise exception 'Pending contract requests must be reviewed before installing clause fields';
 end if;
end $$;
alter table public.contracts add column kol_support_status text not null default '미확인' check (kol_support_status in ('미확인','명시','일부명시','미기재','해당없음')), add column kol_support_terms text not null default '', add constraint contracts_kol_support_evidence check (kol_support_status='미확인' or length(btrim(kol_support_terms))>0);
alter table public.contracts add column vmd_support_status text not null default '미확인' check (vmd_support_status in ('미확인','명시','일부명시','미기재','해당없음')), add column vmd_support_terms text not null default '', add constraint contracts_vmd_support_evidence check (vmd_support_status='미확인' or length(btrim(vmd_support_terms))>0);
alter table public.contracts add column logistics_status text not null default '미확인' check (logistics_status in ('미확인','명시','일부명시','미기재','해당없음')), add column logistics_terms text not null default '', add constraint contracts_logistics_evidence check (logistics_status='미확인' or length(btrim(logistics_terms))>0);
alter table public.contracts add column certification_status text not null default '미확인' check (certification_status in ('미확인','명시','일부명시','미기재','해당없음')), add column certification_terms text not null default '', add constraint contracts_certification_evidence check (certification_status='미확인' or length(btrim(certification_terms))>0);
alter table public.contracts add column document_handover_status text not null default '미확인' check (document_handover_status in ('미확인','명시','일부명시','미기재','해당없음')), add column document_handover_terms text not null default '', add constraint contracts_document_handover_evidence check (document_handover_status='미확인' or length(btrim(document_handover_terms))>0);
alter table public.contracts add column sns_handover_status text not null default '미확인' check (sns_handover_status in ('미확인','명시','일부명시','미기재','해당없음')), add column sns_handover_terms text not null default '', add constraint contracts_sns_handover_evidence check (sns_handover_status='미확인' or length(btrim(sns_handover_terms))>0);
notify pgrst,'reload schema';
commit;
