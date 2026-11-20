-- 물류 요청 첨부 버킷. 기존 허용 정책(authenticated storage)과 교차하는 제한 정책으로 logistics-docs만 좁힌다.
begin;
insert into storage.buckets(id,name,public,file_size_limit) values ('logistics-docs','logistics-docs',false,20971520)
 on conflict (id) do update set public=false, file_size_limit=20971520;

drop policy if exists logistics_docs_insert on storage.objects;
create policy logistics_docs_insert on storage.objects as restrictive for insert to authenticated
 with check (bucket_id <> 'logistics-docs' or (
  (select approval_private.is_company_member())
  and name ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}-[^/]{1,120}$'
  and exists(select 1 from public.logistics_requests r where r.id::text=split_part(name,'/',1) and r.status_code not in ('shipped','canceled'))));

drop policy if exists logistics_docs_update on storage.objects;
create policy logistics_docs_update on storage.objects as restrictive for update to authenticated
 using (bucket_id <> 'logistics-docs') with check (bucket_id <> 'logistics-docs');

drop policy if exists logistics_docs_delete on storage.objects;
create policy logistics_docs_delete on storage.objects as restrictive for delete to authenticated
 using (bucket_id <> 'logistics-docs' or (select approval_private.logistics_is_handler())
  -- 올린 사람: 아직 열린 요청의 첨부만
  or exists(select 1 from public.logistics_request_files f join public.logistics_requests q on q.id=f.request_id
   where f.storage_path=name and f.created_by=(select approval_private.current_email()) and q.status_code not in ('shipped','canceled'))
  -- 올린 사람: 행 저장이 실패해 되돌리는 객체(행이 아직 없음)
  or (owner_id=(select auth.uid())::text and not exists(select 1 from public.logistics_request_files f where f.storage_path=name)));
commit;
