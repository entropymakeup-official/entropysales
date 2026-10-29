-- Apply after request-revisions.sql. Reviewers ask the requester to revise a
-- pending request without rejecting it; the request stays pending and unchanged.
begin;
alter table approval_private.requests add column if not exists change_request_note text;
alter table approval_private.requests add column if not exists change_requested_by_email text;
alter table approval_private.requests add column if not exists change_requested_at timestamptz;
-- The revision the note refers to; a later owner revision answers it.
alter table approval_private.requests add column if not exists change_requested_revision integer;

create or replace function approval_private.request_changes(p_id uuid,p_note text,p_revision integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare who jsonb; req approval_private.requests%rowtype;
begin
 who:=approval_private.identity();
 if not (who->>'is_admin')::boolean then raise exception 'ADMIN_REQUIRED' using errcode='42501';end if;
 if coalesce(length(btrim(p_note)),0) not between 1 and 2000 then raise exception 'CHANGE_NOTE_REQUIRED';end if;
 perform pg_catalog.pg_advisory_xact_lock(72411903001);
 select * into req from approval_private.requests where id=p_id for update;
 if not found then raise exception 'REQUEST_NOT_FOUND';end if;
 if req.status<>'pending' then raise exception 'ALREADY_REVIEWED';end if;
 if p_revision is distinct from req.revision then raise exception 'REQUEST_UPDATED: 요청이 수정됐습니다. 새로고침 후 변경 내용을 다시 검토해 주세요.';end if;
 update approval_private.requests set change_request_note=btrim(p_note),change_requested_by_email=who->>'email',change_requested_at=now(),change_requested_revision=req.revision where id=p_id;
 return jsonb_build_object('id',p_id,'status','pending','revision',req.revision);
end $$;

create or replace function approval_private.list_requests(p_limit integer,p_offset integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare who jsonb; result jsonb;
begin
 who:=approval_private.identity();
 if p_limit is null or p_limit not between 1 and 100 or p_offset is null or p_offset<0 then raise exception 'INVALID_PAGE';end if;
 select coalesce(jsonb_agg(to_jsonb(r) order by created_at desc,id desc),'[]') into result from (
  select id,requester_id,requester_email,created_at,reason,operations,status,reviewer_email,reviewed_at,review_note,revision,updated_at,
   change_request_note,change_requested_by_email,change_requested_at,change_requested_revision,
   (requester_id=(who->>'id')::uuid and status='pending') can_edit,
   (select coalesce(jsonb_agg(jsonb_build_object('revision',h.revision,'reason',h.reason,'operations',h.operations,'changed_at',h.changed_at) order by h.revision desc),'[]') from approval_private.request_revisions h where h.request_id=q.id) history
  from approval_private.requests q where (who->>'is_admin')::boolean or requester_id=(who->>'id')::uuid
  order by created_at desc,id desc limit p_limit offset p_offset
 ) r;
 return jsonb_build_object('is_admin',(who->>'is_admin')::boolean,'requests',result);
end $$;

create or replace function public.request_change_request_revision(p_id uuid,p_note text,p_revision integer)
returns jsonb language sql security invoker set search_path='' as $$select approval_private.request_changes(p_id,p_note,p_revision)$$;
revoke all on function approval_private.request_changes(uuid,text,integer),public.request_change_request_revision(uuid,text,integer) from public,anon;
grant execute on function approval_private.request_changes(uuid,text,integer),public.request_change_request_revision(uuid,text,integer) to authenticated;
commit;
