-- 2026-11-04 구조 개선 #1: 주문 메모(invoices.note)는 덧붙이기만 허용한다.
-- 다른 요청이 남긴 증빙 메모가 메모 칸 전체 교체로 지워지는 일이 있었다(11/03 기존 메모를 지운 요청 50건).
-- 기존 메모가 있으면 새 메모는 기존 메모로 시작해야 한다(앞뒤 공백 제외). 아니면 NOTE_APPEND_ONLY로 거절한다.
-- 주문 수정(action 'invoice')과 일반 행 수정(table 'invoices', action 'update') 둘 다 막는다.
-- 주문 수정은 note 키가 빠져도 save_invoice_atomic이 메모를 비우므로 빠진 경우도 거절된다.
-- 제출(dry-run)과 승인 모두 apply_operations를 거치므로 두 시점 모두 검사된다.
-- Apply after change-approvals.sql. Static files (app.js) can be deployed in either order.
begin;

do $$
begin
  if to_regprocedure('approval_private.apply_operations(jsonb)') is null then
    raise exception 'Install sql/change-approvals.sql first';
  end if;
  if pg_get_functiondef('approval_private.apply_operations(jsonb)'::regprocedure) like '%NOTE_APPEND_ONLY%' then
    raise exception 'invoice-note-append-only is already installed';
  end if;
end $$;

create or replace function pg_temp.patch_function(p_signature text,p_pairs text[][])
returns void language plpgsql as $patch$
declare definition text; i integer; occurrences integer;
begin
  definition:=pg_get_functiondef(p_signature::regprocedure);
  for i in 1..array_length(p_pairs,1) loop
    occurrences:=(length(definition)-length(replace(definition,p_pairs[i][1],'')))/length(p_pairs[i][1]);
    if occurrences<>p_pairs[i][3]::integer then
      raise exception 'Installed % changed (marker % found % times); review before applying note append-only.',p_signature,i,occurrences;
    end if;
    definition:=replace(definition,p_pairs[i][1],p_pairs[i][2]);
  end loop;
  execute definition;
end $patch$;

select pg_temp.patch_function('approval_private.apply_operations(jsonb)',array[
  array[$m$    if oldrow is distinct from expected then raise exception 'STALE_DATA: 주문이 변경됐습니다.';end if;$m$,
        $m$    if oldrow is distinct from expected then raise exception 'STALE_DATA: 주문이 변경됐습니다.';end if;
    if btrim(coalesce(oldrow->>'note',''))<>'' and not starts_with(ltrim(coalesce(op->'invoice'->>'note','')),btrim(oldrow->>'note')) then raise exception 'NOTE_APPEND_ONLY: 기존 메모는 지우거나 고칠 수 없습니다. 기존 메모 뒤에 덧붙여 주세요.';end if;$m$,'1'],
  array[$m$   if a='update' and vals ?| pk then raise exception 'IMMUTABLE_KEY';end if;$m$,
        $m$   if a='update' and vals ?| pk then raise exception 'IMMUTABLE_KEY';end if;
   if t='invoices' and a='update' and vals ? 'note' and btrim(coalesce(oldrow->>'note',''))<>'' and not starts_with(ltrim(coalesce(vals->>'note','')),btrim(oldrow->>'note')) then raise exception 'NOTE_APPEND_ONLY: 기존 메모는 지우거나 고칠 수 없습니다. 기존 메모 뒤에 덧붙여 주세요.';end if;$m$,'1']
]);
commit;
