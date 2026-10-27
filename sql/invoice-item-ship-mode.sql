-- Optional per-line shipping mode (Air/Sea). This migration performs no business DML:
-- existing lines stay NULL until a person confirms the source and requests a change.
-- Apply after change-approvals.sql and invoice-amount-evidence.sql.
begin;

do $$
begin
  if to_regprocedure('public.save_invoice_atomic(text,jsonb,jsonb)') is null
     or to_regprocedure('approval_private.apply_operations(jsonb)') is null
     or to_regprocedure('approval_private.check_values(text,jsonb,boolean)') is null
     or to_regprocedure('approval_private.require_approval()') is null then
    raise exception 'Install the existing invoice save and change approval functions first';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_attribute
    where attrelid='public.invoice_items'::regclass and attname='amount_override' and not attisdropped
  ) then
    raise exception 'Install sql/invoice-amount-evidence.sql first';
  end if;
end $$;

alter table public.invoice_items add column if not exists ship_mode text;

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid='public.invoice_items'::regclass and conname='invoice_items_ship_mode_check'
  ) then
    alter table public.invoice_items add constraint invoice_items_ship_mode_check
      check (ship_mode is null or ship_mode in ('Air','Sea'));
  end if;
end $$;

-- Patch exactly the inspected installed definitions. Every marker must occur the
-- expected number of times, otherwise the deployed logic changed and we stop.
create or replace function pg_temp.patch_function(p_signature text,p_pairs text[][])
returns void language plpgsql as $patch$
declare definition text; i integer; occurrences integer;
begin
  definition:=pg_get_functiondef(p_signature::regprocedure);
  for i in 1..array_length(p_pairs,1) loop
    occurrences:=(length(definition)-length(replace(definition,p_pairs[i][1],'')))/length(p_pairs[i][1]);
    if occurrences<>p_pairs[i][3]::integer then
      raise exception 'Installed % changed (marker % found % times); review before applying ship_mode.',p_signature,i,occurrences;
    end if;
    definition:=replace(definition,p_pairs[i][1],p_pairs[i][2]);
  end loop;
  execute definition;
end $patch$;

-- Full invoice saves may carry ship_mode; every other item key stays rejected.
select pg_temp.patch_function('approval_private.apply_operations(jsonb)',array[
  array[$m$k not in ('name','barcode','sales_type','qty','price')$m$,
        $m$k not in ('name','barcode','sales_type','qty','price','ship_mode')$m$,'1']
]);

-- Readable rejection for both generic item updates and full invoice saves.
select pg_temp.patch_function('approval_private.check_values(text,jsonb,boolean)',array[
  array[$m$then raise exception 'INVALID_SALES_TYPE';end if;$m$,
        $m$then raise exception 'INVALID_SALES_TYPE';end if;
  if p_values ? 'ship_mode' and p_values->'ship_mode'<>'null'::jsonb and coalesce(p_values->>'ship_mode','') not in ('Air','Sea') then raise exception 'INVALID_SHIP_MODE: 운송 방식은 Air, Sea 또는 빈값만 허용됩니다.';end if;$m$,'1']
]);

-- Store ship_mode on full saves. It joins the proof signature so an Air line and a
-- Sea line of the same product can each keep their own evidence amount.
-- A payload without ship_mode keys (a browser tab opened before this release)
-- must not silently erase a stored mode.
select pg_temp.patch_function('public.save_invoice_atomic(text,jsonb,jsonb)',array[
  array['row(o.name,o.barcode,o.sales_type,o.qty,o.price)','row(o.name,o.barcode,o.sales_type,o.qty,o.price,o.ship_mode)','1'],
  array['row(n.name,n.barcode,n.sales_type,n.qty,n.price)','row(n.name,n.barcode,n.sales_type,n.qty,n.price,n.ship_mode)','1'],
  array['row(r.name,r.barcode,r.sales_type,r.qty,r.price)','row(r.name,r.barcode,r.sales_type,r.qty,r.price,r.ship_mode)','1'],
  array['row(p.name,p.barcode,p.sales_type,p.qty,p.price)','row(p.name,p.barcode,p.sales_type,p.qty,p.price,p.ship_mode)','1'],
  array['row(v_proof.name,v_proof.barcode,v_proof.sales_type,v_proof.qty,v_proof.price)','row(v_proof.name,v_proof.barcode,v_proof.sales_type,v_proof.qty,v_proof.price,v_proof.ship_mode)','2'],
  array['INSERT INTO public.invoice_items (invoice_id,invoice_no,name,barcode,sales_type,qty,price,amount_override,amount_reference)',
        'INSERT INTO public.invoice_items (invoice_id,invoice_no,name,barcode,sales_type,qty,price,ship_mode,amount_override,amount_reference)','1'],
  array['SELECT v_saved.id,v_saved.no,r.name,r.barcode,r.sales_type,r.qty,r.price,p.amount_override,p.amount_reference',
        'SELECT v_saved.id,v_saved.no,r.name,r.barcode,r.sales_type,r.qty,r.price,r.ship_mode,p.amount_override,p.amount_reference','1'],
  array['UPDATE public.invoices SET no=v_input.no',
        $m$IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_old_items) AS o(value) WHERE o.value->>'ship_mode' IS NOT NULL)
   AND EXISTS (SELECT 1 FROM jsonb_array_elements(p_items) AS x(value) WHERE NOT value ? 'ship_mode') THEN
  RAISE EXCEPTION 'STALE_CLIENT: 운송 방식이 저장된 주문입니다. 화면을 새로고침한 뒤 다시 저장해 주세요.' USING ERRCODE='23514';
END IF;
UPDATE public.invoices SET no=v_input.no$m$,'1']
]);

drop function pg_temp.patch_function(text,text[]);
notify pgrst,'reload schema';
commit;
