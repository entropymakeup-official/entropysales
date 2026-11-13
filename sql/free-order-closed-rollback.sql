-- free-order-closed.sql 되돌리기. 무상 종결(Closed) 규칙을 없애고 2026-11-09 이전 검증 함수로 돌린다.
-- 먼저 Closed 주문을 모두 다른 상태로 되돌린 뒤 실행한다(데이터 롤백 요청은 진행현황 폴더에 준비).
-- Closed 주문이 남아 있으면 중단한다: 옛 규칙은 Closed를 입금완료로 취급해 무상 주문이 입금증빙 없이 남게 된다.
begin;

do $$
begin
  if to_regprocedure('approval_private.invoice_paid_amount(uuid)') is null
     or position('FREE_CLOSE' in pg_get_functiondef('approval_private.settlement_guard()'::regprocedure))=0 then
    raise exception 'free-order-closed is not installed';
  end if;
  if exists(select 1 from public.invoices where status='Closed') then
    raise exception 'Closed invoices remain; move them back before rolling back free-order-closed';
  end if;
end $$;

drop trigger free_close_items_guard on public.invoice_items;
drop function approval_private.free_close_items_guard();

-- sql/invoice-settlement-evidence.sql의 정의와 같다 (운영 md5 ba2b3bd3cf1b457239ea7680d8f31c9b).
CREATE OR REPLACE FUNCTION approval_private.settlement_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare actor_email text; was_paid boolean; is_paid boolean;
begin
  select u.email into actor_email from approval_private.apply_context c join auth.users u on u.id=c.actor_id
   where c.transaction_id=txid_current();
  if TG_OP='INSERT' then
    if new.status in ('Paid','Closed') or new.ship_status='출고완료' then
      raise exception 'EVIDENCE_REQUIRED: 주문을 먼저 등록한 뒤 증빙과 함께 입금완료·출고완료를 요청해 주세요.';
    end if;
    new.pay_verified_by:=null; new.pay_verified_at:=null; new.ship_verified_by:=null; new.ship_verified_at:=null;
    return new;
  end if;
  new.pay_verified_by:=old.pay_verified_by; new.pay_verified_at:=old.pay_verified_at;
  new.ship_verified_by:=old.ship_verified_by; new.ship_verified_at:=old.ship_verified_at;
  was_paid:=coalesce(old.status in ('Paid','Closed'),false); is_paid:=coalesce(new.status in ('Paid','Closed'),false);
  if is_paid and not was_paid then
    if not exists(select 1 from public.invoice_drive_documents where invoice_id=new.id and type='입금증빙') then
      raise exception 'EVIDENCE_REQUIRED: 입금증빙(Drive 링크)과 함께 입금완료를 요청해 주세요.';
    end if;
    new.pay_verified_by:=actor_email; new.pay_verified_at:=now();
  elsif was_paid and not is_paid then
    new.pay_verified_by:=null; new.pay_verified_at:=null;
  end if;
  if new.ship_status='출고완료' and old.ship_status is distinct from '출고완료' then
    if not exists(select 1 from public.invoice_drive_documents where invoice_id=new.id and type='선적서류') then
      raise exception 'EVIDENCE_REQUIRED: 선적서류(Drive 링크)와 함께 출고완료를 요청해 주세요.';
    end if;
    new.ship_verified_by:=actor_email; new.ship_verified_at:=now();
  elsif old.ship_status='출고완료' and new.ship_status is distinct from '출고완료' then
    new.ship_verified_by:=null; new.ship_verified_at:=null;
  end if;
  return new;
end $function$;
revoke all on function approval_private.settlement_guard() from public,anon,authenticated;

drop function approval_private.invoice_paid_amount(uuid);

do $$
begin
  if md5(pg_get_functiondef('approval_private.settlement_guard()'::regprocedure))<>'ba2b3bd3cf1b457239ea7680d8f31c9b' then
    raise exception 'Restored settlement_guard differs from the recorded production definition';
  end if;
end $$;

commit;
