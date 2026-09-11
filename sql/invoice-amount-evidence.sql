-- Optional approved evidence totals. This migration performs no business DML.
begin;

-- Replace installed RPCs in place so their owners and execution ACLs survive.
-- Fail closed on a database that has not installed the existing approval/worker flow.
do $$
begin
  if to_regprocedure('public.save_invoice_atomic(text,jsonb,jsonb)') is null
     or to_regprocedure('public.claim_invoice_sheet_jobs(text,integer)') is null
     or to_regprocedure('approval_private.require_approval()') is null then
    raise exception 'Install the existing invoice save, sheet worker and change approval functions first';
  end if;
end $$;

alter table public.invoice_items
  add column if not exists amount_override numeric(18,2),
  add column if not exists amount_reference text;

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid='public.invoice_items'::regclass
      and conname='invoice_items_amount_evidence_check'
  ) then
    alter table public.invoice_items add constraint invoice_items_amount_evidence_check check (
      (amount_override is null and amount_reference is null)
      or (
        amount_override is not null and amount_reference is not null
        and sales_type is not distinct from 'Paid'::text
        and amount_override not in ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric)
        and char_length(amount_reference) between 1 and 1000
        and amount_reference ~ '[^[:space:]]'
      )
    );
  end if;
end $$;

create or replace function public.guard_invoice_amount_evidence()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if old.amount_override is not null
     and not (new.amount_override is null and new.amount_reference is null)
     and row(new.invoice_id,new.name,new.barcode,new.sales_type,new.qty,new.price)
         is distinct from row(old.invoice_id,old.name,old.barcode,old.sales_type,old.qty,old.price) then
    raise exception '증빙 금액이 있는 품목은 변경할 수 없습니다. 먼저 증빙 금액과 근거를 해제한 뒤 다시 저장해 주세요.'
      using errcode='23514';
  end if;
  return new;
end $$;
revoke all on function public.guard_invoice_amount_evidence() from public,anon,authenticated;
drop trigger if exists guard_invoice_amount_evidence on public.invoice_items;
create trigger guard_invoice_amount_evidence before update on public.invoice_items
  for each row execute function public.guard_invoice_amount_evidence();

CREATE OR REPLACE FUNCTION public.save_invoice_atomic(p_id text, p_invoice jsonb, p_items jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
v_input public.invoices%ROWTYPE;
v_saved public.invoices%ROWTYPE;
v_items jsonb;
v_old_items jsonb := '[]'::jsonb;
v_proof public.invoice_items%ROWTYPE;
v_old_matches bigint;
v_new_matches bigint;
BEGIN
IF p_invoice IS NULL OR jsonb_typeof(p_invoice) <> 'object' OR p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN RAISE EXCEPTION 'Invoice must be an object and items must be an array'; END IF;
IF nullif(btrim(p_invoice->>'no'), '') IS NULL OR nullif(btrim(p_invoice->>'customer'), '') IS NULL THEN RAISE EXCEPTION 'Invoice number and customer are required'; END IF;
IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_items) AS x(value) WHERE jsonb_typeof(value) <> 'object' OR nullif(btrim(value->>'name'), '') IS NULL) THEN RAISE EXCEPTION 'Each item must be an object with a name'; END IF;
-- Proof is edited only through the existing generic approved item update.
-- Never trust proof values (even nulls) in a full invoice replacement payload.
IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_items) AS x(value) WHERE value ?| ARRAY['amount_override','amount_reference']) THEN
  RAISE EXCEPTION 'INVALID_ITEM_FIELD: 증빙 금액과 근거는 품목 증빙 변경 요청으로 수정해 주세요.';
END IF;
SELECT * INTO v_input FROM jsonb_populate_record(NULL::public.invoices, p_invoice);
IF p_id IS NULL THEN
INSERT INTO public.invoices (no,customer,mgr,order_date,pay_date,ship_date,status,ship_status,foc,note) VALUES (v_input.no,v_input.customer,v_input.mgr,v_input.order_date,v_input.pay_date,v_input.ship_date,v_input.status,v_input.ship_status,v_input.foc,v_input.note) RETURNING * INTO STRICT v_saved;
ELSE
SELECT * INTO STRICT v_saved FROM public.invoices WHERE id::text=p_id FOR UPDATE;
-- Lock and snapshot before the existing DELETE + INSERT. IDs, line order and
-- invoice_no are not proof signatures; compare the five typed values NULL-safely.
PERFORM 1 FROM public.invoice_items WHERE invoice_id=v_saved.id ORDER BY id FOR UPDATE;
SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY i.id),'[]'::jsonb)
  INTO v_old_items FROM public.invoice_items i WHERE i.invoice_id=v_saved.id;
FOR v_proof IN SELECT * FROM jsonb_populate_recordset(NULL::public.invoice_items,v_old_items) p
  WHERE p.amount_override IS NOT NULL
LOOP
  SELECT count(*) INTO v_old_matches
    FROM jsonb_populate_recordset(NULL::public.invoice_items,v_old_items) o
    WHERE row(o.name,o.barcode,o.sales_type,o.qty,o.price)
      IS NOT DISTINCT FROM row(v_proof.name,v_proof.barcode,v_proof.sales_type,v_proof.qty,v_proof.price);
  SELECT count(*) INTO v_new_matches
    FROM jsonb_populate_recordset(NULL::public.invoice_items,p_items) n
    WHERE row(n.name,n.barcode,n.sales_type,n.qty,n.price)
      IS NOT DISTINCT FROM row(v_proof.name,v_proof.barcode,v_proof.sales_type,v_proof.qty,v_proof.price);
  IF v_old_matches <> 1 OR v_new_matches <> 1 THEN
    RAISE EXCEPTION '증빙 금액이 있는 품목(%)이 삭제·변경되었거나 중복되어 저장할 수 없습니다. 먼저 해당 품목의 증빙 금액과 근거를 해제한 뒤 다시 저장해 주세요.',v_proof.name
      USING ERRCODE='23514';
  END IF;
END LOOP;
UPDATE public.invoices SET no=v_input.no,customer=v_input.customer,mgr=v_input.mgr,order_date=v_input.order_date,pay_date=v_input.pay_date,ship_date=v_input.ship_date,status=v_input.status,ship_status=v_input.ship_status,foc=v_input.foc,note=v_input.note WHERE id=v_saved.id RETURNING * INTO STRICT v_saved;
DELETE FROM public.invoice_items WHERE invoice_id=v_saved.id;
END IF;
INSERT INTO public.invoice_items (invoice_id,invoice_no,name,barcode,sales_type,qty,price,amount_override,amount_reference)
  SELECT v_saved.id,v_saved.no,r.name,r.barcode,r.sales_type,r.qty,r.price,p.amount_override,p.amount_reference
  FROM jsonb_populate_recordset(NULL::public.invoice_items,p_items) AS r
  LEFT JOIN jsonb_populate_recordset(NULL::public.invoice_items,v_old_items) AS p
    ON p.amount_override IS NOT NULL
    AND row(r.name,r.barcode,r.sales_type,r.qty,r.price)
      IS NOT DISTINCT FROM row(p.name,p.barcode,p.sales_type,p.qty,p.price);
SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY i.id),'[]'::jsonb) INTO v_items FROM public.invoice_items AS i WHERE i.invoice_id=v_saved.id;
IF jsonb_array_length(v_items) <> jsonb_array_length(p_items) THEN RAISE EXCEPTION 'Saved item count mismatch; check SELECT/DELETE/INSERT policies'; END IF;
RETURN jsonb_build_object('invoice',to_jsonb(v_saved),'items',v_items);
END;
$function$;

CREATE OR REPLACE FUNCTION public.claim_invoice_sheet_jobs(p_secret text, p_limit integer DEFAULT 20)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare q invoice_sheet_private.queue%rowtype; token uuid; inv jsonb; items jsonb; result jsonb:='[]'::jsonb;
begin
 perform invoice_sheet_private.authorize(p_secret);
 for q in select * from invoice_sheet_private.queue
 where revision>synced_revision and next_attempt_at<=now() and (lease_until is null or lease_until<now())
 order by queued_at limit greatest(1,least(coalesce(p_limit,20),50)) for update skip locked
 loop
  token:=gen_random_uuid();
  update invoice_sheet_private.queue set lease_token=token,claimed_revision=q.revision,
   lease_until=now()+interval '10 minutes',attempts=attempts+1 where invoice_id=q.invoice_id;
  select jsonb_build_object('id',i.id,'no',i.no,'customer',i.customer,
   'mgr',to_jsonb(i)->'mgr','order_date',to_jsonb(i)->'order_date',
   'pay_date',to_jsonb(i)->'pay_date','ship_date',to_jsonb(i)->'ship_date',
   'status',to_jsonb(i)->'status','ship_status',to_jsonb(i)->'ship_status',
   'note',to_jsonb(i)->'note') into inv from public.invoices i where i.id=q.invoice_id;
  select coalesce(jsonb_agg(jsonb_build_object('id',i.id,'name',to_jsonb(i)->'name',
   'barcode',to_jsonb(i)->'barcode','sales_type',to_jsonb(i)->'sales_type',
   'qty',i.qty,'price',i.price,'amount_override',i.amount_override) order by i.id),'[]'::jsonb) into items
   from public.invoice_items i where i.invoice_id=q.invoice_id;
  result:=result||jsonb_build_array(jsonb_build_object('invoice_id',q.invoice_id,'revision',q.revision::text,
    'lease_token',token,'deleted',inv is null,'invoice',inv,'items',items));
 end loop;
 return result;
end $function$;

commit;
