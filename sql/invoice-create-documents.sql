-- 2026-11-03 사용자 결정: 새 주문을 등록하는 요청에 Drive 증빙을 함께 붙일 수 있게 한다.
-- 새 주문 작업({action:'invoice', id:null})에 documents 배열을 받아, 승인 때 주문을 만든 직후
-- 확정된 주문 ID로 invoice_drive_documents를 넣는다. 주문과 증빙은 같은 승인으로 함께 반영된다.
-- 상태 규칙은 그대로다: 새 주문은 미입금·준비중으로만 만들 수 있고(settlement_guard),
-- 입금완료·출고완료는 기존처럼 따로 요청한다. 미리 붙인 입금증빙·선적서류는 그때 증빙으로 인정된다.
-- 기존 주문·증빙·대기 요청은 바꾸지 않는다.
-- Apply after change-approvals.sql and invoice-drive-documents.sql. Deploy before the static files:
-- older databases ignore the documents key, so the links would be dropped silently.
begin;

do $$
begin
  if to_regprocedure('approval_private.apply_operations(jsonb)') is null
     or to_regclass('public.invoice_drive_documents') is null then
    raise exception 'Install sql/change-approvals.sql and sql/invoice-drive-documents.sql first';
  end if;
  if pg_get_functiondef('approval_private.apply_operations(jsonb)'::regprocedure) like '%INVALID_DOCUMENTS%' then
    raise exception 'invoice-create-documents is already installed';
  end if;
end $$;

-- Patch exactly the inspected installed definition. Every marker must occur the
-- expected number of times, otherwise the deployed logic changed and we stop.
create or replace function pg_temp.patch_function(p_signature text,p_pairs text[][])
returns void language plpgsql as $patch$
declare definition text; i integer; occurrences integer;
begin
  definition:=pg_get_functiondef(p_signature::regprocedure);
  for i in 1..array_length(p_pairs,1) loop
    occurrences:=(length(definition)-length(replace(definition,p_pairs[i][1],'')))/length(p_pairs[i][1]);
    if occurrences<>p_pairs[i][3]::integer then
      raise exception 'Installed % changed (marker % found % times); review before applying invoice documents.',p_signature,i,occurrences;
    end if;
    definition:=replace(definition,p_pairs[i][1],p_pairs[i][2]);
  end loop;
  execute definition;
end $patch$;

select pg_temp.patch_function('approval_private.apply_operations(jsonb)',array[
  array[$m$current_items jsonb; current_docs jsonb;$m$,
        $m$current_items jsonb; current_docs jsonb; saved jsonb;$m$,'1'],
  array[$m$   perform public.save_invoice_atomic(nullif(op->>'id',''),op->'invoice',op->'items');$m$,
        $m$   saved:=public.save_invoice_atomic(nullif(op->>'id',''),op->'invoice',op->'items');
   -- 새 주문에만 증빙을 함께 받는다. 기존 주문은 일반 invoice_drive_documents 요청을 쓴다.
   if op ? 'documents' then
    if nullif(op->>'id','') is not null or jsonb_typeof(op->'documents') is distinct from 'array' or jsonb_array_length(op->'documents') not between 1 and 20 then raise exception 'INVALID_DOCUMENTS';end if;
    for item in select value from jsonb_array_elements(op->'documents') loop
     if jsonb_typeof(item) is distinct from 'object' or exists(select 1 from jsonb_object_keys(item) k where k not in ('drive_file_id','resource_key','name','type')) then raise exception 'INVALID_DOCUMENT_FIELD';end if;
     perform approval_private.check_values('invoice_drive_documents',item,true);
     insert into public.invoice_drive_documents(invoice_id,drive_file_id,resource_key,name,type)
      select (saved->'invoice'->>'id')::uuid,v.drive_file_id,v.resource_key,v.name,v.type from jsonb_populate_record(null::public.invoice_drive_documents,item) v;
    end loop;
   end if;$m$,'1']
]);
commit;
