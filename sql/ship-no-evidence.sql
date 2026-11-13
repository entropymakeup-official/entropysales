-- 2026-11-13 사용자 결정: 실제로 나갔지만 선적서류가 없는 주문을 '준비중'과 구분해 표시한다.
-- 새 출고 상태 '출고완료(증빙없음)'를 추가한다.
--   - 기존 주문에서만 변경 요청·승인으로 바꾼다. 선적서류는 요구하지 않는다(사유는 요청에 적는다).
--   - 새 주문을 처음부터 이 상태로 만들 수 없다(출고완료와 같은 규칙).
--   - '출고완료'의 선적서류 규칙, 무상 종결(Closed)의 '출고완료 + 선적서류' 규칙은 그대로다.
--   - 출고 상태 값은 '준비중'·'출고완료'·'출고완료(증빙없음)'만 허용한다.
-- Apply after free-order-closed.sql.
begin;

do $$
declare def text; marker text:=$m$if new.status in ('Paid','Closed') or new.ship_status='출고완료' then$m$;
begin
  if to_regprocedure('approval_private.settlement_guard()') is null then
    raise exception 'Install sql/invoice-settlement-evidence.sql first';
  end if;
  def:=pg_get_functiondef('approval_private.settlement_guard()'::regprocedure);
  if position('FREE_CLOSE' in def)=0 then raise exception 'Install sql/free-order-closed.sql first'; end if;
  if position('출고완료(증빙없음)' in def)>0 then raise exception 'ship-no-evidence is already installed'; end if;
  if (length(def)-length(replace(def,marker,'')))/length(marker)<>1 then
    raise exception 'Installed settlement_guard changed; review before applying ship-no-evidence';
  end if;
  execute replace(def,marker,$m$if new.status in ('Paid','Closed') or new.ship_status in ('출고완료','출고완료(증빙없음)') then$m$);
end $$;
revoke all on function approval_private.settlement_guard() from public,anon,authenticated;

alter table public.invoices add constraint invoices_ship_status_check
  check (ship_status is null or ship_status in ('준비중','출고완료','출고완료(증빙없음)'));

commit;
