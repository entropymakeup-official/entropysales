-- Install after change-approvals.sql. Existing clients need no new parameters.
-- No confirmed invoices or pending request payloads are changed by installation.
begin;
alter table approval_private.requests add column if not exists submitted_operations jsonb;

create or replace function approval_private.allocate_invoice_numbers(p_operations jsonb,p_exclude_id uuid default null)
returns jsonb language plpgsql set search_path='' as $$
declare op jsonb; result jsonb:='[]'; used text[]; candidate text; base text; code text; suffix text; n bigint; unchanged boolean;
begin
 if p_operations is null or jsonb_typeof(p_operations)<>'array' or jsonb_array_length(p_operations) not between 1 and 1000 or octet_length(p_operations::text)>5242880 then raise exception 'INVALID_OPERATIONS';end if;
 -- Same lock as submit/review: the reservation and its request commit together.
 perform pg_catalog.pg_advisory_xact_lock(72411903001);
 select coalesce(array_agg(no),array[]::text[]) into used from (
  select i.no from public.invoices i
  union
  select case when o->>'action'='invoice' then o->'invoice'->>'no' else o->'values'->>'no' end
  from approval_private.requests r cross join lateral jsonb_array_elements(r.operations) o
  where r.status='pending' and (p_exclude_id is null or r.id<>p_exclude_id)
   and (o->>'action'='invoice' or (o->>'table'='invoices' and o->>'action' in ('insert','update')))
 ) reserved where no is not null;
 -- Reserve fixed references first, so batch order cannot let auto allocation
 -- consume a later edit/import's number. Reject edits stealing pending numbers.
 for op in select value from jsonb_array_elements(p_operations) loop
  candidate:=null;unchanged:=false;
  if op->>'action'='invoice' and not coalesce((nullif(op->>'id','') is null and op->'auto_number'='true'::jsonb),false) then
   candidate:=op->'invoice'->>'no';
   unchanged:=nullif(op->>'id','') is not null and candidate=op->'before'->'invoice'->>'no';
  elsif op->>'table'='invoices' and op->>'action' in ('insert','update') then
   candidate:=op->'values'->>'no';
   unchanged:=op->>'action'='update' and candidate=op->'before'->>'no';
  end if;
  if candidate is not null and not coalesce(unchanged,false) then
   if candidate=any(used) then
    raise exception 'INVOICE_NUMBER_CONFLICT: 이미 사용 중이거나 승인 대기 중인 인보이스 번호입니다: %',candidate using errcode='23505';
   end if;
   used:=array_append(used,candidate);
  end if;
 end loop;
 for op in select value from jsonb_array_elements(p_operations) loop
  if op->>'action'='invoice' and nullif(op->>'id','') is null and op->'auto_number'='true'::jsonb then
   candidate:=op->'invoice'->>'no';
   -- Only the existing automatic RAW format is eligible for renumbering.
   -- Explicit/custom document references and edits must never be silently renamed.
   select c.code into code from public.customers c where c.name=op->'invoice'->>'customer' order by c.id limit 1;
   base:=coalesce(nullif(code,''),'UNK')||'_'||replace(op->'invoice'->>'order_date','-','');
   suffix:=case when left(candidate,length(base)+1)=base||'_' then substring(candidate from length(base)+2) end;
   if candidate=any(used) then
    if op->'invoice'->>'order_date' ~ '^\d{4}-\d{2}-\d{2}$'
     and (candidate=base or (suffix ~ '^[1-9][0-9]{0,8}$' and suffix::bigint>=2)) then
     n:=case when candidate=base then 2 else suffix::bigint+1 end;
     loop
      candidate:=base||'_'||n::text;
      exit when not (candidate=any(used));
      n:=n+1;
     end loop;
     op:=jsonb_set(op,'{invoice,no}',to_jsonb(candidate));
    else
     raise exception 'INVOICE_NUMBER_CONFLICT: 이미 사용 중이거나 승인 대기 중인 인보이스 번호입니다: %',candidate using errcode='23505';
    end if;
   end if;
   if candidate is not null then used:=array_append(used,candidate);end if;
  end if;
  result:=result||jsonb_build_array(op);
 end loop;
 return result;
end $$;
revoke all on function approval_private.allocate_invoice_numbers(jsonb,uuid) from public,anon,authenticated;

create or replace function approval_private.submit(p_operations jsonb,p_reason text,p_client_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare who jsonb; existing approval_private.requests%rowtype; newid uuid; assigned jsonb; numbers jsonb;
begin
 who:=approval_private.identity();
 if p_client_id is null or coalesce(length(btrim(p_reason)),0) not between 1 and 2000 then raise exception 'REASON_REQUIRED';end if;
 perform pg_catalog.pg_advisory_xact_lock(72411903001);
 select * into existing from approval_private.requests where requester_id=(who->>'id')::uuid and client_id=p_client_id;
 if found then
  if coalesce(existing.submitted_operations,existing.operations) is distinct from p_operations or existing.reason<>btrim(p_reason) then raise exception 'CLIENT_ID_REUSED';end if;
  select coalesce(jsonb_agg(o->'invoice'->>'no'),'[]') into numbers from jsonb_array_elements(existing.operations) o where o->>'action'='invoice' and nullif(o->>'id','') is null;
  return jsonb_build_object('id',existing.id,'status',existing.status,'invoice_numbers',numbers);
 end if;
 assigned:=approval_private.allocate_invoice_numbers(p_operations);
 -- Preserve the original dry-run validation and rollback of outbox side effects.
 begin
  insert into approval_private.apply_context values(txid_current(),(who->>'id')::uuid);
  perform approval_private.apply_operations(assigned);
  raise exception using errcode='Z0001',message='validation rollback';
 exception when sqlstate 'Z0001' then null;
 end;
 insert into approval_private.requests(requester_id,requester_email,client_id,reason,operations,submitted_operations)
 values((who->>'id')::uuid,who->>'email',p_client_id,btrim(p_reason),assigned,p_operations) returning id into newid;
 select coalesce(jsonb_agg(o->'invoice'->>'no'),'[]') into numbers from jsonb_array_elements(assigned) o where o->>'action'='invoice' and nullif(o->>'id','') is null;
 return jsonb_build_object('id',newid,'status','pending','invoice_numbers',numbers);
end $$;
-- Preserve the authenticated wrapper path; no new public RPC or direct writes.
revoke all on function approval_private.submit(jsonb,text,uuid) from public,anon;
grant execute on function approval_private.submit(jsonb,text,uuid) to authenticated;
commit;
