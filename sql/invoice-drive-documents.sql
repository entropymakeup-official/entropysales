-- Additive Drive evidence links. No file sharing, storage, invoice value or sync changes.
begin;
create table if not exists public.invoice_drive_documents (
 id uuid primary key default gen_random_uuid(),
 invoice_id uuid not null references public.invoices(id) on delete cascade,
 drive_file_id text not null check (drive_file_id ~ '^[A-Za-z0-9_-]{10,200}$'),
 resource_key text check (resource_key is null or resource_key ~ '^[A-Za-z0-9_-]{1,200}$'),
 name text not null check (length(btrim(name)) between 1 and 250),
 type text not null check (type in ('거래명세서','구매확인서','세금계산서','기타')),
 created_at timestamptz not null default now(),
 unique (invoice_id,drive_file_id)
);
alter table public.invoice_drive_documents enable row level security;
-- Reuse the invoice's current RLS audience; do not duplicate or widen that policy.
drop policy if exists invoice_access on public.invoice_drive_documents;
create policy invoice_access on public.invoice_drive_documents to authenticated
 using (exists(select 1 from public.invoices i where i.id=invoice_id))
 with check (exists(select 1 from public.invoices i where i.id=invoice_id));
revoke all on public.invoice_drive_documents from public,anon,authenticated;
grant select,insert,delete on public.invoice_drive_documents to authenticated;
comment on table public.invoice_drive_documents is 'Google Drive evidence links only. Deleting a link or its invoice does not delete or share the Drive file.';
notify pgrst, 'reload schema';
commit;
