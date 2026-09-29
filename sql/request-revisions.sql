-- Apply after change-approvals.sql and invoice-number-allocation.sql.
begin;
alter table approval_private.requests add column if not exists revision integer not null default 1;
alter table approval_private.requests add column if not exists updated_at timestamptz;
create table if not exists approval_private.request_revisions (
 request_id uuid not null references approval_private.requests(id),
 revision integer not null, reason text not null, operations jsonb not null,
 changed_at timestamptz not null default now(), changed_by uuid not null,
 primary key(request_id,revision)
);
alter table approval_private.request_revisions enable row level security;
revoke all on approval_private.request_revisions from public,anon,authenticated;

create or replace function approval_private.revise(p_id uuid,p_revision integer,p_operations jsonb,p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare who jsonb; req approval_private.requests%rowtype; assigned jsonb; op jsonb; oldop jsonb; i integer;
begin
 who:=approval_private.identity();
 perform pg_catalog.pg_advisory_xact_lock(72411903001);
 select * into req from approval_private.requests where id=p_id for update;
 if not found then raise exception 'REQUEST_NOT_FOUND';end if;
 if req.requester_id<>(who->>'id')::uuid then raise exception 'OWNER_REQUIRED' using errcode='42501';end if;
 if req.status<>'pending' then raise exception 'ALREADY_REVIEWED';end if;
 if p_revision is distinct from req.revision then raise exception 'REQUEST_UPDATED: 요청이 수정됐습니다. 다시 열어 확인해 주세요.';end if;
 if coalesce(length(btrim(p_reason)),0) not between 1 and 2000 then raise exception 'REASON_REQUIRED';end if;
 if p_operations is null or jsonb_typeof(p_operations)<>'array' or jsonb_array_length(p_operations)<>jsonb_array_length(req.operations) then raise exception 'REQUEST_SCOPE';end if;
 -- A revision changes proposed values, never its target, baseline or action.
 for i in 0..jsonb_array_length(req.operations)-1 loop
  op:=p_operations->i;oldop:=req.operations->i;
  if oldop->>'table'='invoices' and oldop->>'action'='update' and op->>'action'='invoice' then
   if op->>'id' is distinct from oldop->'key'->>'id' or op->'before'->'invoice' is distinct from oldop->'before' then raise exception 'REQUEST_SCOPE';end if;
  elsif (op-array['values','invoice','items']) is distinct from (oldop-array['values','invoice','items']) then raise exception 'REQUEST_SCOPE';end if;
 end loop;
 assigned:=approval_private.allocate_invoice_numbers(p_operations,p_id);
 begin
  insert into approval_private.apply_context values(txid_current(),(who->>'id')::uuid);
  perform approval_private.apply_operations(assigned);
  raise exception using errcode='Z0001',message='validation rollback';
 exception when sqlstate 'Z0001' then null;
 end;
 insert into approval_private.request_revisions(request_id,revision,reason,operations,changed_by)
 values(req.id,req.revision,req.reason,req.operations,(who->>'id')::uuid);
 update approval_private.requests set operations=assigned,reason=btrim(p_reason),revision=revision+1,updated_at=now() where id=p_id;
 return jsonb_build_object('id',p_id,'status','pending','revision',req.revision+1);
end $$;

create or replace function approval_private.review_versioned(p_id uuid,p_approve boolean,p_note text,p_revision integer)
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
 if p_revision is distinct from req.revision then raise exception 'REQUEST_UPDATED: 요청이 수정됐습니다. 새로고침 후 변경 내용을 다시 검토해 주세요.';end if;
 if p_approve then
  insert into approval_private.apply_context values(txid_current(),(who->>'id')::uuid);
  perform approval_private.apply_operations(req.operations);
  delete from approval_private.apply_context where transaction_id=txid_current();
 end if;
 newstatus:=case when p_approve then 'approved' else 'rejected' end;
 update approval_private.requests set status=newstatus,reviewer_id=(who->>'id')::uuid,reviewer_email=who->>'email',reviewed_at=now(),review_note=btrim(coalesce(p_note,'')) where id=p_id;
 return jsonb_build_object('id',p_id,'status',newstatus,'revision',req.revision);
end $$;
-- Old browser tabs may review original requests, but cannot approve revisions unseen.
create or replace function approval_private.review(p_id uuid,p_approve boolean,p_note text)
returns jsonb language sql security definer set search_path='' as $$select approval_private.review_versioned(p_id,p_approve,p_note,1)$$;

create or replace function approval_private.list_requests(p_limit integer,p_offset integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare who jsonb; result jsonb;
begin
 who:=approval_private.identity();
 if p_limit is null or p_limit not between 1 and 100 or p_offset is null or p_offset<0 then raise exception 'INVALID_PAGE';end if;
 select coalesce(jsonb_agg(to_jsonb(r) order by created_at desc,id desc),'[]') into result from (
  select id,requester_id,requester_email,created_at,reason,operations,status,reviewer_email,reviewed_at,review_note,revision,updated_at,
   (requester_id=(who->>'id')::uuid and status='pending') can_edit,
   (select coalesce(jsonb_agg(jsonb_build_object('revision',h.revision,'reason',h.reason,'operations',h.operations,'changed_at',h.changed_at) order by h.revision desc),'[]') from approval_private.request_revisions h where h.request_id=q.id) history
  from approval_private.requests q where (who->>'is_admin')::boolean or requester_id=(who->>'id')::uuid
  order by created_at desc,id desc limit p_limit offset p_offset
 ) r;
 return jsonb_build_object('is_admin',(who->>'is_admin')::boolean,'requests',result);
end $$;

create or replace function approval_private.find_my_invoice_requests(p_invoice_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare who jsonb; result jsonb;
begin
 who:=approval_private.identity();
 select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'revision',r.revision,'reason',r.reason,'operations',r.operations,'status',r.status,'can_edit',true) order by r.created_at desc),'[]') into result
 from approval_private.requests r where requester_id=(who->>'id')::uuid and status='pending'
 and exists(select 1 from jsonb_array_elements(r.operations) op where
  (op->>'action'='invoice' and op->>'id'=p_invoice_id::text) or
  (op->>'table'='invoices' and op->'key'->>'id'=p_invoice_id::text));
 return result;
end $$;
create or replace function public.revise_change_request(p_id uuid,p_revision integer,p_operations jsonb,p_reason text)
returns jsonb language sql security invoker set search_path='' as $$select approval_private.revise(p_id,p_revision,p_operations,p_reason)$$;
create or replace function public.review_change_request_versioned(p_id uuid,p_approve boolean,p_note text,p_revision integer)
returns jsonb language sql security invoker set search_path='' as $$select approval_private.review_versioned(p_id,p_approve,p_note,p_revision)$$;
create or replace function public.find_my_invoice_requests(p_invoice_id uuid)
returns jsonb language sql security invoker set search_path='' as $$select approval_private.find_my_invoice_requests(p_invoice_id)$$;
revoke all on function approval_private.revise(uuid,integer,jsonb,text),approval_private.review_versioned(uuid,boolean,text,integer),approval_private.find_my_invoice_requests(uuid),public.revise_change_request(uuid,integer,jsonb,text),public.review_change_request_versioned(uuid,boolean,text,integer),public.find_my_invoice_requests(uuid) from public,anon;
grant execute on function approval_private.revise(uuid,integer,jsonb,text),approval_private.review_versioned(uuid,boolean,text,integer),approval_private.find_my_invoice_requests(uuid),public.revise_change_request(uuid,integer,jsonb,text),public.review_change_request_versioned(uuid,boolean,text,integer),public.find_my_invoice_requests(uuid) to authenticated;
commit;
