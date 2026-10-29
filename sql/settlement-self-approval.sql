-- Apply after invoice-settlement-evidence.sql. Admins may approve their own
-- paid/shipped request, but only with a review note explaining the evidence check.
begin;

-- Patch exactly the inspected approval definition. If the marker count differs, stop.
create or replace function pg_temp.patch_function(p_signature text,p_marker text,p_replacement text)
returns void language plpgsql as $patch$
declare definition text; occurrences integer;
begin
  definition:=pg_get_functiondef(p_signature::regprocedure);
  occurrences:=(length(definition)-length(replace(definition,p_marker,'')))/length(p_marker);
  if occurrences<>1 then
    raise exception 'Installed % changed (marker found % times); review before allowing settlement self approval.',p_signature,occurrences;
  end if;
  execute replace(definition,p_marker,p_replacement);
end $patch$;

select pg_temp.patch_function(
  case when to_regprocedure('approval_private.review_versioned(uuid,boolean,text,integer)') is not null
       then 'approval_private.review_versioned(uuid,boolean,text,integer)' else 'approval_private.review(uuid,boolean,text)' end,
  $m$ if p_approve and req.requester_id=(who->>'id')::uuid and approval_private.has_settlement_change(req.operations) then
  raise exception 'SELF_APPROVAL_BLOCKED: 입금완료·출고완료 요청은 요청자가 아닌 다른 관리자가 승인해야 합니다.' using errcode='42501';end if;$m$,
  $m$ if p_approve and req.requester_id=(who->>'id')::uuid and approval_private.has_settlement_change(req.operations) and coalesce(length(btrim(p_note)),0)=0 then
  raise exception 'SELF_APPROVAL_NOTE_REQUIRED: 본인이 요청한 입금완료·출고완료를 승인하려면 검토 메모에 확인한 증빙을 적어 주세요.';end if;$m$);

commit;
