-- 2026-11-09 사용자 결정: 받을 돈이 없는 무상 주문(유상 품목 금액 0원)은 입금증빙 없이
-- Closed(정산 대상 아님)로 닫는다. 조건은 서버가 직접 확인한다.
--   - 유상(Paid) 품목 금액 합계 = 0 (amount_override 우선)
--   - 출고완료이고 선적서류가 연결돼 있음
--   - 입금일 없음
-- 입금완료(Paid)는 Closed에서 넘어오는 경우를 포함해 항상 입금증빙이 필요하다.
-- Closed 주문에 유상 금액이 생기거나 출고완료가 풀리면 거절한다.
-- Apply after invoice-settlement-evidence.sql and invoice-amount-evidence.sql.
begin;

do $$
declare def text;
begin
  if to_regprocedure('approval_private.settlement_guard()') is null then
    raise exception 'Install sql/invoice-settlement-evidence.sql first';
  end if;
  if not exists(select 1 from information_schema.columns
                where table_schema='public' and table_name='invoice_items' and column_name='amount_override') then
    raise exception 'Install sql/invoice-amount-evidence.sql first';
  end if;
  def:=pg_get_functiondef('approval_private.settlement_guard()'::regprocedure);
  if position('FREE_CLOSE' in def)>0 then raise exception 'free-order-closed is already installed'; end if;
  if position($m$was_paid:=coalesce(old.status in ('Paid','Closed'),false); is_paid:=coalesce(new.status in ('Paid','Closed'),false);$m$ in def)=0 then
    raise exception 'Installed settlement_guard changed; review before applying free-order-closed';
  end if;
end $$;

create or replace function approval_private.invoice_paid_amount(p_invoice uuid)
returns numeric language sql stable security definer set search_path='' as $$
  select coalesce(sum(coalesce(i.amount_override,i.qty*i.price)),0)
  from public.invoice_items i where i.invoice_id=p_invoice and i.sales_type='Paid'
$$;
revoke all on function approval_private.invoice_paid_amount(uuid) from public,anon,authenticated;

create or replace function approval_private.settlement_guard()
returns trigger language plpgsql security definer set search_path='' as $$
declare actor_email text; was_settled boolean; is_settled boolean;
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
  was_settled:=coalesce(old.status in ('Paid','Closed'),false); is_settled:=coalesce(new.status in ('Paid','Closed'),false);
  if new.status='Paid' and old.status is distinct from 'Paid' then
    if not exists(select 1 from public.invoice_drive_documents where invoice_id=new.id and type='입금증빙') then
      raise exception 'EVIDENCE_REQUIRED: 입금증빙(Drive 링크)과 함께 입금완료를 요청해 주세요.';
    end if;
    new.pay_verified_by:=actor_email; new.pay_verified_at:=now();
  elsif new.status='Closed' and old.status is distinct from 'Closed' then
    if approval_private.invoice_paid_amount(new.id)<>0 then
      raise exception 'FREE_CLOSE_PAID_AMOUNT: 유상 금액이 있는 주문은 무상 종결(Closed)할 수 없습니다. 입금증빙과 함께 입금완료로 요청해 주세요.';
    end if;
    if new.pay_date is not null then
      raise exception 'FREE_CLOSE_PAY_DATE: 무상 종결(Closed) 주문에는 입금일을 넣지 않습니다.';
    end if;
    if new.ship_status is distinct from '출고완료'
       or not exists(select 1 from public.invoice_drive_documents where invoice_id=new.id and type='선적서류') then
      raise exception 'FREE_CLOSE_SHIPPING_REQUIRED: 무상 종결(Closed)은 선적서류가 연결된 출고완료 주문만 가능합니다.';
    end if;
    new.pay_verified_by:=actor_email; new.pay_verified_at:=now();
  elsif was_settled and not is_settled then
    new.pay_verified_by:=null; new.pay_verified_at:=null;
  end if;
  if new.status='Closed' and old.status='Closed' then
    if new.pay_date is not null then
      raise exception 'FREE_CLOSE_PAY_DATE: 무상 종결(Closed) 주문에는 입금일을 넣지 않습니다.';
    end if;
    if new.ship_status is distinct from '출고완료' then
      raise exception 'FREE_CLOSE_SHIPPING_REQUIRED: 무상 종결(Closed) 주문은 출고완료를 풀 수 없습니다. 먼저 미입금으로 되돌려 주세요.';
    end if;
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
end $$;
revoke all on function approval_private.settlement_guard() from public,anon,authenticated;

-- Closed 주문의 품목이 바뀌어 유상 금액이 생기면 거절한다.
create or replace function approval_private.free_close_items_guard()
returns trigger language plpgsql security definer set search_path='' as $$
declare target uuid;
begin
  for target in select distinct x from unnest(array[
      case when TG_OP<>'INSERT' then old.invoice_id end,
      case when TG_OP<>'DELETE' then new.invoice_id end]) x where x is not null loop
    if exists(select 1 from public.invoices where id=target and status='Closed')
       and approval_private.invoice_paid_amount(target)<>0 then
      raise exception 'FREE_CLOSE_PAID_AMOUNT: 무상 종결(Closed) 주문에는 유상 금액을 넣을 수 없습니다. 먼저 미입금으로 되돌려 주세요.';
    end if;
  end loop;
  return null;
end $$;
revoke all on function approval_private.free_close_items_guard() from public,anon,authenticated;
create trigger free_close_items_guard after insert or update or delete on public.invoice_items
for each row execute function approval_private.free_close_items_guard();

commit;
