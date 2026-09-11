-- Install only with the matching frontend. Business writes fail closed after installation.
-- No existing data is changed by this script. Source inventory acquisition is separate.
begin;
create schema if not exists approval_private;
revoke all on schema approval_private from public, anon;
grant usage on schema approval_private to authenticated;

create table if not exists approval_private.requests (
 id uuid primary key default gen_random_uuid(),
 requester_id uuid not null, requester_email text not null,
 client_id uuid not null, reason text not null,
 operations jsonb not null, created_at timestamptz not null default now(),
 status text not null default 'pending' check(status in ('pending','approved','rejected')),
 reviewer_id uuid, reviewer_email text, reviewed_at timestamptz, review_note text,
 unique(requester_id,client_id)
);
create index if not exists requests_created on approval_private.requests(created_at desc,id desc);
create index if not exists requests_owner on approval_private.requests(requester_id,created_at desc);
-- This is a database-owned capability, not a spoofable session setting.
create table if not exists approval_private.apply_context (
 transaction_id bigint primary key, actor_id uuid not null
);
alter table approval_private.requests enable row level security;
alter table approval_private.apply_context enable row level security;
revoke all on all tables in schema approval_private from public,anon,authenticated;

create or replace function approval_private.identity()
returns jsonb language plpgsql security definer set search_path='' as $$
declare u auth.users%rowtype;
begin
 select * into u from auth.users where id=auth.uid();
 if u.id is null or u.email_confirmed_at is null or
  not coalesce((split_part(lower(u.email),'@',2)='entropymakeup.com' or lower(u.email)='entropyadmin@entropy.internal'),false) then
  raise exception 'UNAUTHORIZED: 회사 로그인 후 다시 시도해 주세요.' using errcode='42501';
 end if;
 return jsonb_build_object('id',u.id,'email',u.email,'is_admin',
  lower(u.email)='entropyadmin@entropy.internal' or coalesce(u.raw_app_meta_data->'dashboard_admin'='true'::jsonb,false));
end $$;

create or replace function approval_private.require_approval()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if TG_OP='TRUNCATE' then raise exception 'APPROVAL_REQUIRED: 일괄 비우기는 허용되지 않습니다.' using errcode='42501';end if;
 if not exists(select 1 from approval_private.apply_context where transaction_id=txid_current() and actor_id=auth.uid()) then
  raise exception 'APPROVAL_REQUIRED: 변경 요청 후 관리자 페이지에서 승인해 주세요.' using errcode='42501';
 end if;
 if TG_OP='DELETE' then return old; else return new; end if;
end $$;

create or replace function approval_private.check_values(p_table text,p_values jsonb,p_insert boolean default false)
returns void language plpgsql set search_path='' as $$
declare k text; v jsonb; required text;
begin
 if p_values is null or jsonb_typeof(p_values)<>'object' then raise exception 'INVALID_VALUES'; end if;
 for k,v in select * from jsonb_each(p_values) loop
  if not exists(select 1 from pg_catalog.pg_attribute where attrelid=to_regclass(format('public.%I',p_table)) and attname=k and attnum>0 and not attisdropped and attgenerated='')
   or k in ('created_at','updated_at') then raise exception 'INVALID_FIELD: %',k; end if;
  if v<>'null'::jsonb and exists(select 1 from information_schema.columns where table_schema='public' and table_name=p_table and column_name=k and data_type in ('numeric','integer','bigint','double precision','real','smallint')) then
   if jsonb_typeof(v)<>'number' then raise exception 'INVALID_NUMBER: %',k; end if;
  end if;
 end loop;
 required:=case when p_table in ('products','customers','stocks','documents','invoice_drive_documents','invoice_items') then 'name'
 when p_table='invoices' then 'no' when p_table='schedules' then 'title' when p_table='product_details' then 'barcode' end;
 if required is not null and (p_insert or p_values ? required) and coalesce(btrim(p_values->>required),'')='' then raise exception 'INVALID_REQUIRED: %',required; end if;
 if p_table='invoices' and (p_insert or p_values ? 'customer') and coalesce(btrim(p_values->>'customer'),'')='' then raise exception 'INVALID_CUSTOMER';end if;
 if p_table='invoice_items' then
  if p_insert and not (p_values ?& array['invoice_id','name','qty','price','sales_type']) then raise exception 'INVALID_ITEM_REQUIRED';end if;
  if p_values ? 'invoice_id' and p_values->'invoice_id'='null'::jsonb then raise exception 'INVALID_INVOICE_ID';end if;
  if (p_values ? 'qty' and (p_values->'qty'='null'::jsonb or jsonb_typeof(p_values->'qty')<>'number')) or
     (p_values ? 'price' and (p_values->'price'='null'::jsonb or jsonb_typeof(p_values->'price')<>'number')) then raise exception 'INVALID_ITEM_NUMBER';end if;
  if p_values ? 'sales_type' and coalesce(p_values->>'sales_type','') not in ('Paid','FOC','GWP','Sample','Replacement','Lost') then raise exception 'INVALID_SALES_TYPE';end if;
 end if;
 if p_table='invoices' and p_values ? 'status' and coalesce(p_values->>'status','') not in ('Ordered','Paid','Closed','Cancelled') then raise exception 'INVALID_STATUS';end if;
 if p_table='tax_records' and p_values ? 'month' and coalesce(p_values->>'month','') !~ '^\d{4}-(0[1-9]|1[0-2])$' then raise exception 'INVALID_MONTH';end if;
end $$;

create or replace function approval_private.apply_operations(p_operations jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare op jsonb; t text; a text; pk text[]; supplied text[]; vals jsonb; oldrow jsonb; expected jsonb;
 cols text; selections text; assignments text; rowcount bigint; item jsonb; current_items jsonb; current_docs jsonb;
begin
 if not exists(select 1 from approval_private.apply_context where transaction_id=txid_current() and actor_id=auth.uid()) then raise exception 'APPROVAL_REQUIRED';end if;
 if p_operations is null or jsonb_typeof(p_operations)<>'array' or jsonb_array_length(p_operations) not between 1 and 1000 or octet_length(p_operations::text)>5242880 then raise exception 'INVALID_OPERATIONS';end if;
 -- Serialize requests and validation with a fixed transaction lock. It also prevents inverse-order batch deadlocks.
 perform pg_catalog.pg_advisory_xact_lock(72411903001);
 for op in select value from jsonb_array_elements(p_operations) loop
  a:=op->>'action'; t:=op->>'table';
  if a='invoice' then
   if jsonb_typeof(op->'invoice') is distinct from 'object' or jsonb_typeof(op->'items') is distinct from 'array' or jsonb_array_length(op->'items')=0 then raise exception 'INVALID_INVOICE';end if;
   perform approval_private.check_values('invoices',op->'invoice');
   if coalesce(btrim(op->'invoice'->>'no'),'')='' or coalesce(btrim(op->'invoice'->>'customer'),'')='' then raise exception 'INVALID_INVOICE_REQUIRED';end if;
   if exists(select 1 from jsonb_object_keys(op->'invoice') k where k not in ('no','customer','mgr','order_date','pay_date','ship_date','status','ship_status','foc','note')) then raise exception 'INVALID_INVOICE_FIELD';end if;
   for item in select value from jsonb_array_elements(op->'items') loop
    perform approval_private.check_values('invoice_items',item);
    if not (item ?& array['name','qty','price','sales_type']) or coalesce(btrim(item->>'name'),'')='' then raise exception 'INVALID_ITEM';end if;
    if exists(select 1 from jsonb_object_keys(item) k where k not in ('name','barcode','sales_type','qty','price')) then raise exception 'INVALID_ITEM_FIELD';end if;
   end loop;
   if nullif(op->>'id','') is not null then
    select to_jsonb(i) into oldrow from public.invoices i where id=(op->>'id')::uuid for update;
    if oldrow is null or jsonb_typeof(op->'before'->'invoice') is distinct from 'object' then raise exception 'STALE_DATA: 주문을 다시 조회해 주세요.';end if;
    select to_jsonb(r) into expected from jsonb_populate_record(null::public.invoices,op->'before'->'invoice') r;
    if oldrow is distinct from expected then raise exception 'STALE_DATA: 주문이 변경됐습니다.';end if;
    perform 1 from public.invoice_items where invoice_id=(op->>'id')::uuid order by id for update;
    select coalesce(jsonb_agg(to_jsonb(i) order by id),'[]') into current_items from public.invoice_items i where invoice_id=(op->>'id')::uuid;
    if jsonb_typeof(op->'before'->'items') is distinct from 'array' then raise exception 'INVALID_BEFORE_ITEMS';end if;
    select coalesce(jsonb_agg(to_jsonb(i) order by id),'[]') into expected from jsonb_populate_recordset(null::public.invoice_items,op->'before'->'items') i;
    if current_items is distinct from expected then raise exception 'STALE_DATA: 품목이 변경됐습니다.';end if;
   elsif op->'before' is not null and op->'before'<>'null'::jsonb then raise exception 'INVALID_BEFORE';end if;
   perform public.save_invoice_atomic(nullif(op->>'id',''),op->'invoice',op->'items');
   continue;
  end if;
  if t is null or t not in ('invoices','invoice_items','customers','products','stocks','documents','schedules','tax_records','app_settings','product_details','invoice_drive_documents') or a is null or a not in ('insert','update','delete') then raise exception 'INVALID_OPERATION';end if;
  select array_agg(att.attname::text order by att.attname) into pk from pg_catalog.pg_index idx
   join pg_catalog.pg_attribute att on att.attrelid=idx.indrelid and att.attnum=any(idx.indkey)
   where idx.indrelid=to_regclass(format('public.%I',t)) and idx.indisprimary;
  if pk is null then raise exception 'INVALID_TABLE_KEY';end if;
  if a in ('update','delete') then
   if jsonb_typeof(op->'key') is distinct from 'object' or jsonb_typeof(op->'before') is distinct from 'object' then raise exception 'INVALID_BEFORE';end if;
   select array_agg(k order by k) into supplied from jsonb_object_keys(op->'key') k;
   if supplied is distinct from pk or exists(select 1 from jsonb_each(op->'key') e where e.value='null'::jsonb) then raise exception 'INVALID_KEY';end if;
   execute format('select to_jsonb(r) from public.%I r where to_jsonb(r) @> $1 for update',t) into oldrow using op->'key';
   execute format('select to_jsonb(r) from jsonb_populate_record(null::public.%I,$1) r',t) into expected using op->'before';
   if oldrow is null or oldrow is distinct from expected then raise exception 'STALE_DATA: % 자료가 변경됐습니다. 다시 조회해 주세요.',t;end if;
   if t='invoices' and a='delete' then
    if jsonb_typeof(op->'before_items') is distinct from 'array' or jsonb_typeof(op->'before_drive_documents') is distinct from 'array' then raise exception 'INVALID_BEFORE_CHILDREN';end if;
    perform 1 from public.invoice_items where invoice_id=(oldrow->>'id')::uuid order by id for update;
    perform 1 from public.invoice_drive_documents where invoice_id=(oldrow->>'id')::uuid order by id for update;
    select coalesce(jsonb_agg(to_jsonb(i) order by id),'[]') into current_items from public.invoice_items i where invoice_id=(oldrow->>'id')::uuid;
    select coalesce(jsonb_agg(to_jsonb(i) order by id),'[]') into expected from jsonb_populate_recordset(null::public.invoice_items,op->'before_items') i;
    if current_items is distinct from expected then raise exception 'STALE_DATA: 삭제 대상 품목이 변경됐습니다.';end if;
    select coalesce(jsonb_agg(to_jsonb(i) order by id),'[]') into current_docs from public.invoice_drive_documents i where invoice_id=(oldrow->>'id')::uuid;
    select coalesce(jsonb_agg(to_jsonb(i) order by id),'[]') into expected from jsonb_populate_recordset(null::public.invoice_drive_documents,op->'before_drive_documents') i;
    if current_docs is distinct from expected then raise exception 'STALE_DATA: 삭제 대상 증빙이 변경됐습니다.';end if;
   end if;
  elsif op->'before' is not null and op->'before'<>'null'::jsonb then raise exception 'INVALID_BEFORE';end if;
  if a='delete' then
   execute format('delete from public.%I r where to_jsonb(r) @> $1',t) using op->'key';
  else
   vals:=op->'values';perform approval_private.check_values(t,vals,a='insert');
   if vals='{}'::jsonb then raise exception 'INVALID_EMPTY_VALUES';end if;
   if a='update' and vals ?| pk then raise exception 'IMMUTABLE_KEY';end if;
   select string_agg(format('%I',k),',' order by k),string_agg(format('v.%I',k),',' order by k),string_agg(format('%I=v.%I',k,k),',' order by k)
    into cols,selections,assignments from jsonb_object_keys(vals) k;
   if a='insert' then
    execute format('insert into public.%I(%s) select %s from jsonb_populate_record(null::public.%I,$1) v',t,cols,selections,t) using vals;
   else
    execute format('update public.%I r set %s from jsonb_populate_record(null::public.%I,$1) v where to_jsonb(r) @> $2',t,assignments,t) using vals,op->'key';
   end if;
  end if;
  get diagnostics rowcount=row_count;
  if rowcount<>1 then raise exception 'INVALID_ROW_COUNT';end if;
 end loop;
end $$;

create or replace function approval_private.submit(p_operations jsonb,p_reason text,p_client_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare who jsonb; existing approval_private.requests%rowtype; newid uuid;
begin
 who:=approval_private.identity();
 if p_client_id is null or coalesce(length(btrim(p_reason)),0) not between 1 and 2000 then raise exception 'REASON_REQUIRED';end if;
 perform pg_catalog.pg_advisory_xact_lock(72411903001);
 select * into existing from approval_private.requests where requester_id=(who->>'id')::uuid and client_id=p_client_id;
 if found then
  if existing.operations is distinct from p_operations or existing.reason<>btrim(p_reason) then raise exception 'CLIENT_ID_REUSED';end if;
  return jsonb_build_object('id',existing.id,'status',existing.status);
 end if;
 -- Any failure rolls back the entire test, including synchronization outbox records.
 begin
  insert into approval_private.apply_context values(txid_current(),(who->>'id')::uuid);
  perform approval_private.apply_operations(p_operations);
  raise exception using errcode='Z0001',message='validation rollback';
 exception when sqlstate 'Z0001' then null;
 end;
 insert into approval_private.requests(requester_id,requester_email,client_id,reason,operations)
 values((who->>'id')::uuid,who->>'email',p_client_id,btrim(p_reason),p_operations) returning id into newid;
 return jsonb_build_object('id',newid,'status','pending');
end $$;

create or replace function approval_private.review(p_id uuid,p_approve boolean,p_note text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare who jsonb; req approval_private.requests%rowtype; newstatus text;
begin
 who:=approval_private.identity();
 if not (who->>'is_admin')::boolean then raise exception 'ADMIN_REQUIRED' using errcode='42501';end if;
 if p_approve is null then raise exception 'INVALID_DECISION';end if;
 if length(coalesce(p_note,''))>2000 then raise exception 'INVALID_NOTE';end if;
 if not p_approve and coalesce(length(btrim(p_note)),0)=0 then raise exception 'REJECTION_REASON_REQUIRED';end if;
 perform pg_catalog.pg_advisory_xact_lock(72411903001);
 select * into req from approval_private.requests where id=p_id for update;
 if not found then raise exception 'REQUEST_NOT_FOUND';end if;
 if req.status<>'pending' then raise exception 'ALREADY_REVIEWED';end if;
 if p_approve then
  insert into approval_private.apply_context values(txid_current(),(who->>'id')::uuid);
  perform approval_private.apply_operations(req.operations);
  delete from approval_private.apply_context where transaction_id=txid_current();
 end if;
 newstatus:=case when p_approve then 'approved' else 'rejected' end;
 update approval_private.requests set status=newstatus,reviewer_id=(who->>'id')::uuid,reviewer_email=who->>'email',reviewed_at=now(),review_note=btrim(coalesce(p_note,'')) where id=p_id;
 return jsonb_build_object('id',p_id,'status',newstatus);
end $$;

create or replace function approval_private.list_requests(p_limit integer,p_offset integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare who jsonb; result jsonb;
begin
 who:=approval_private.identity();
 if p_limit is null or p_limit not between 1 and 100 or p_offset is null or p_offset<0 then raise exception 'INVALID_PAGE';end if;
 select coalesce(jsonb_agg(to_jsonb(r) order by created_at desc,id desc),'[]') into result from (
  select id,requester_id,requester_email,created_at,reason,operations,status,reviewer_email,reviewed_at,review_note
  from approval_private.requests where (who->>'is_admin')::boolean or requester_id=(who->>'id')::uuid
  order by created_at desc,id desc limit p_limit offset p_offset
 ) r;
 return jsonb_build_object('is_admin',(who->>'is_admin')::boolean,'requests',result);
end $$;

create or replace function public.submit_change_request(p_operations jsonb,p_reason text,p_client_id uuid)
returns jsonb language sql security invoker set search_path='' as $$select approval_private.submit(p_operations,p_reason,p_client_id)$$;
create or replace function public.review_change_request(p_id uuid,p_approve boolean,p_note text)
returns jsonb language sql security invoker set search_path='' as $$select approval_private.review(p_id,p_approve,p_note)$$;
create or replace function public.list_change_requests(p_limit integer default 100,p_offset integer default 0)
returns jsonb language sql security invoker set search_path='' as $$select approval_private.list_requests(p_limit,p_offset)$$;

revoke all on all functions in schema approval_private from public,anon,authenticated;
grant execute on function approval_private.submit(jsonb,text,uuid),approval_private.review(uuid,boolean,text),approval_private.list_requests(integer,integer) to authenticated;
revoke all on function public.submit_change_request(jsonb,text,uuid),public.review_change_request(uuid,boolean,text),public.list_change_requests(integer,integer) from public,anon;
grant execute on function public.submit_change_request(jsonb,text,uuid),public.review_change_request(uuid,boolean,text),public.list_change_requests(integer,integer) to authenticated;

do $$declare t text;begin
 foreach t in array array['invoices','invoice_items','customers','products','stocks','documents','schedules','tax_records','app_settings','product_details','invoice_drive_documents','tax_invoice_amounts'] loop
  if to_regclass(format('public.%I',t)) is null then raise exception 'Required business table missing: %',t;end if;
  execute format('drop trigger if exists require_change_approval on public.%I',t);
  execute format('create trigger require_change_approval before insert or update or delete on public.%I for each row execute function approval_private.require_approval()',t);
  execute format('drop trigger if exists require_approval_truncate on public.%I',t);
  execute format('create trigger require_approval_truncate before truncate on public.%I for each statement execute function approval_private.require_approval()',t);
  execute format('revoke truncate on public.%I from anon,authenticated',t);
end loop;
end $$;
-- Immutable evidence: staging creates a new object; approval changes the document pointer.
-- Restrictive policies intersect with the existing company access policy.
drop policy if exists approval_storage_insert on storage.objects;
create policy approval_storage_insert on storage.objects as restrictive for insert to authenticated
 with check (bucket_id not in ('documents','invoice-docs') or
  (bucket_id='documents' and name ~ '^pending/[0-9a-fA-F-]{36}/[^/]+$'));
drop policy if exists approval_storage_update on storage.objects;
create policy approval_storage_update on storage.objects as restrictive for update to authenticated
 using (bucket_id not in ('documents','invoice-docs')) with check (bucket_id not in ('documents','invoice-docs'));
drop policy if exists approval_storage_delete on storage.objects;
create policy approval_storage_delete on storage.objects as restrictive for delete to authenticated
 using (bucket_id not in ('documents','invoice-docs'));
commit;
