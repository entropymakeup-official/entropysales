-- 2026-10-27 사용자 결정: 입금완료·출고완료는 Drive 증빙(입금증빙·선적서류)과 함께 요청하고,
-- 요청자가 아닌 관리자가 승인한다. 승인자·승인시각을 주문에 남긴다.
-- 기존 주문 상태·증빙은 바꾸지 않는다. 이미 완료된 주문은 검증 기록이 비어 있는 채로 남는다.
-- Apply after change-approvals.sql and invoice-drive-documents.sql (and request-revisions.sql if installed).
begin;

do $$
begin
  if to_regprocedure('approval_private.apply_operations(jsonb)') is null
     or to_regprocedure('approval_private.review(uuid,boolean,text)') is null
     or to_regclass('public.invoice_drive_documents') is null then
    raise exception 'Install sql/change-approvals.sql and sql/invoice-drive-documents.sql first';
  end if;
  if to_regprocedure('approval_private.settlement_guard()') is not null then
    raise exception 'invoice-settlement-evidence is already installed';
  end if;
end $$;

alter table public.invoice_drive_documents drop constraint invoice_drive_documents_type_check;
alter table public.invoice_drive_documents add constraint invoice_drive_documents_type_check
  check (type in ('거래명세서','구매확인서','세금계산서','입금증빙','선적서류','기타'));

alter table public.invoices
  add column pay_verified_by text,
  add column pay_verified_at timestamptz,
  add column ship_verified_by text,
  add column ship_verified_at timestamptz;

-- 승인 반영(또는 제출 시 검증) 중에만 주문이 바뀐다. 이때 증빙을 확인하고 승인자를 기록한다.
-- 검증 열은 이 트리거만 쓴다. 요청에 값이 들어와도 무시한다.
create or replace function approval_private.settlement_guard()
returns trigger language plpgsql security definer set search_path='' as $$
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
end $$;
revoke all on function approval_private.settlement_guard() from public,anon,authenticated;
create trigger settlement_guard before insert or update on public.invoices
for each row execute function approval_private.settlement_guard();

-- 요청 안에 입금완료·출고완료로 바꾸는 작업이 있는지. 승인 단계의 본인 승인 차단에 쓴다.
create or replace function approval_private.has_settlement_change(p_operations jsonb)
returns boolean language sql immutable set search_path='' as $$
  select exists(
    select 1 from jsonb_array_elements(coalesce(p_operations,'[]'::jsonb)) e(op)
    cross join lateral (select
      case when op->>'action'='invoice' then op->'invoice' when op->>'table'='invoices' and op->>'action' in ('update','insert') then op->'values' end as next,
      case when op->>'action'='invoice' then op->'before'->'invoice' else op->'before' end as prev) x
    where x.next is not null and (
      (x.next->>'status' in ('Paid','Closed') and coalesce(x.prev->>'status','') not in ('Paid','Closed'))
      or (x.next->>'ship_status'='출고완료' and coalesce(x.prev->>'ship_status','')<>'출고완료')))
$$;
revoke all on function approval_private.has_settlement_change(jsonb) from public,anon,authenticated;

-- Patch exactly the inspected approval definition. If the marker count differs, stop.
create or replace function pg_temp.patch_function(p_signature text,p_marker text,p_replacement text)
returns void language plpgsql as $patch$
declare definition text; occurrences integer;
begin
  definition:=pg_get_functiondef(p_signature::regprocedure);
  occurrences:=(length(definition)-length(replace(definition,p_marker,'')))/length(p_marker);
  if occurrences<>1 then
    raise exception 'Installed % changed (marker found % times); review before applying settlement evidence.',p_signature,occurrences;
  end if;
  execute replace(definition,p_marker,p_replacement);
end $patch$;

-- request-revisions.sql moves the review body into review_versioned; patch whichever holds it.
select pg_temp.patch_function(
  case when to_regprocedure('approval_private.review_versioned(uuid,boolean,text,integer)') is not null
       then 'approval_private.review_versioned(uuid,boolean,text,integer)' else 'approval_private.review(uuid,boolean,text)' end,
  $m$ if req.status<>'pending' then raise exception 'ALREADY_REVIEWED';end if;$m$,
  $m$ if req.status<>'pending' then raise exception 'ALREADY_REVIEWED';end if;
 if p_approve and req.requester_id=(who->>'id')::uuid and approval_private.has_settlement_change(req.operations) then
  raise exception 'SELF_APPROVAL_BLOCKED: 입금완료·출고완료 요청은 요청자가 아닌 다른 관리자가 승인해야 합니다.' using errcode='42501';end if;$m$);

commit;
