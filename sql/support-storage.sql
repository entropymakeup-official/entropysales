-- 경영지원 요청 첨부 버킷. 기존 허용 정책(authenticated storage)과 교차하는 제한 정책으로 support-docs만 좁힌다.
-- 물류와 달리 읽기도 요청자·담당자로 좁힌다(잔액증명 등 민감 서류). 행 규칙(종류·상태)은 support_request_files 트리거가 판정한다.
begin;
insert into storage.buckets(id,name,public,file_size_limit) values ('support-docs','support-docs',false,20971520)
 on conflict (id) do update set public=false, file_size_limit=20971520;

-- 경로 첫 칸을 uuid로 바꾸지 않고 글자로 비교한다(이상한 이름이 형 변환 오류로 다른 버킷 조회까지 막지 않게).
create or replace function approval_private.support_can_see_path(p_name text) returns boolean
language sql stable security definer set search_path='' as $$
 select (select approval_private.is_company_member()) and ((select approval_private.support_is_handler()) or exists(
  select 1 from public.support_requests r where r.id::text=split_part(p_name,'/',1) and r.requester_email=(select approval_private.current_email())));
$$;
revoke all on function approval_private.support_can_see_path(text) from public,anon;
grant execute on function approval_private.support_can_see_path(text) to authenticated;

drop policy if exists support_docs_select on storage.objects;
create policy support_docs_select on storage.objects as restrictive for select to authenticated
 using (bucket_id <> 'support-docs' or approval_private.support_can_see_path(name));

drop policy if exists support_docs_insert on storage.objects;
create policy support_docs_insert on storage.objects as restrictive for insert to authenticated
 with check (bucket_id <> 'support-docs' or (
  (select approval_private.is_company_member())
  and name ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}-[^/]{1,120}$'
  and exists(select 1 from public.support_requests r where r.id::text=split_part(name,'/',1)
   and ((select approval_private.support_is_handler()) and r.status_code <> 'canceled'
    or r.requester_email=(select approval_private.current_email()) and r.status_code not in ('done','canceled')))));

drop policy if exists support_docs_update on storage.objects;
create policy support_docs_update on storage.objects as restrictive for update to authenticated
 using (bucket_id <> 'support-docs') with check (bucket_id <> 'support-docs');

drop policy if exists support_docs_delete on storage.objects;
create policy support_docs_delete on storage.objects as restrictive for delete to authenticated
 using (bucket_id <> 'support-docs' or (select approval_private.support_is_handler())
  -- 올린 사람: 아직 열린 요청의 첨부만
  or exists(select 1 from public.support_request_files f join public.support_requests q on q.id=f.request_id
   where f.storage_path=name and f.created_by=(select approval_private.current_email()) and q.status_code not in ('done','canceled'))
  -- 올린 사람: 행 저장이 실패해 되돌리는 객체(행이 아직 없음)
  or (owner_id=(select auth.uid())::text and not exists(select 1 from public.support_request_files f where f.storage_path=name)));
commit;
