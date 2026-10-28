-- Optional link from one invoice to another invoice it refers to (re-shipment,
-- correction or offset of an original order). This migration performs no
-- business DML: every existing invoice keeps NULL until a person requests a link.
--
-- Compatibility with pending change requests: both columns are nullable and have
-- no default. apply_operations rebuilds the stored `before` snapshot through
-- jsonb_populate_record(null::public.invoices, before), so a snapshot taken before
-- this migration reads the new columns as NULL, exactly like the current rows.
-- Pending update/delete/full-invoice requests therefore stay approvable.
--
-- No approval function changes: links are saved with the generic
-- {table:'invoices',action:'update',values:{ref_invoice_id,ref_kind}} operation,
-- which apply_operations/check_values already allow for any existing column.
-- save_invoice_atomic updates only its fixed header columns, so a full invoice
-- save keeps an existing link. Apply after change-approvals.sql.
begin;

do $$
begin
  if to_regprocedure('approval_private.apply_operations(jsonb)') is null
     or to_regprocedure('approval_private.check_values(text,jsonb,boolean)') is null then
    raise exception 'Install sql/change-approvals.sql first';
  end if;
  if (select format_type(atttypid,atttypmod) from pg_catalog.pg_attribute
      where attrelid='public.invoices'::regclass and attname='id' and not attisdropped) is distinct from 'uuid' then
    raise exception 'public.invoices.id must be uuid before adding ref_invoice_id';
  end if;
end $$;

alter table public.invoices add column if not exists ref_invoice_id uuid;
alter table public.invoices add column if not exists ref_kind text;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_constraint
                 where conrelid='public.invoices'::regclass and conname='invoices_ref_invoice_id_fkey') then
    -- Deleting the referenced invoice (an approved delete) clears the link on the
    -- referring invoice instead of blocking the delete.
    alter table public.invoices add constraint invoices_ref_invoice_id_fkey
      foreign key (ref_invoice_id) references public.invoices(id) on delete set null;
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint
                 where conrelid='public.invoices'::regclass and conname='invoices_ref_invoice_not_self') then
    alter table public.invoices add constraint invoices_ref_invoice_not_self
      check (ref_invoice_id is null or ref_invoice_id<>id);
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint
                 where conrelid='public.invoices'::regclass and conname='invoices_ref_kind_check') then
    alter table public.invoices add constraint invoices_ref_kind_check
      check (ref_kind is null or ref_kind in ('재출고','정정','상계','기타'));
  end if;
end $$;

create index if not exists invoices_ref_invoice_id_idx on public.invoices(ref_invoice_id) where ref_invoice_id is not null;

comment on column public.invoices.ref_invoice_id is '참고 인보이스(재출고·정정·상계 원주문 등). 변경 요청 승인으로만 저장';
comment on column public.invoices.ref_kind is '참고 유형: 재출고/정정/상계/기타';

notify pgrst,'reload schema';
commit;
