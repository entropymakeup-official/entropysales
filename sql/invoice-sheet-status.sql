-- Read-only status for the existing dashboard audience. No worker credentials are returned.
begin;
create or replace function public.get_invoice_sheet_status()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 if auth.uid() is null or not coalesce(
  split_part(auth.jwt()->>'email','@',2)='entropymakeup.com'
  or auth.jwt()->>'email'='entropyadmin@entropy.internal',false
 ) then raise exception 'Unauthorized dashboard user' using errcode='42501'; end if;

 with jobs as (
  select q.invoice_id,q.queued_at,q.synced_at,
   case when q.revision<=q.synced_revision then 'synced'
    when q.last_error is not null then 'error'
    when q.queued_at<now()-interval '15 minutes' then 'delayed'
    when q.lease_until>now() then 'processing'
    else 'pending' end as state,
   case when q.last_error in ('DESTINATION_READ_FAILED','DESTINATION_WRITE_FAILED','INVALID_SNAPSHOT','ACK_UNCERTAIN')
    then q.last_error else null end as error_code
  from invoice_sheet_private.queue q
  union all
  select i.id,null::timestamptz,null::timestamptz,'missing',null::text
  from public.invoices i where not exists(select 1 from invoice_sheet_private.queue q where q.invoice_id=i.id)
 ), problems as (
  select i.no as invoice_no,i.customer,j.state,j.error_code
  from jobs j left join public.invoices i on i.id=j.invoice_id
  where j.state in ('error','delayed','missing')
  order by case j.state when 'error' then 0 when 'missing' then 1 else 2 end,j.queued_at nulls first,j.invoice_id
  limit 10
 )
 select jsonb_build_object(
  'enabled',coalesce((select enabled from invoice_sheet_private.config where singleton),false),
  'pending_count',count(*) filter(where state<>'synced'),
  'failed_count',count(*) filter(where state='error'),
  'delayed_count',count(*) filter(where state='delayed'),
  'missing_count',count(*) filter(where state='missing'),
  'last_synced_at',max(synced_at),'checked_at',now(),
  'problems',coalesce((select jsonb_agg(to_jsonb(p)) from problems p),'[]'::jsonb)
 ) into result from jobs;
 return result;
end $$;
revoke all on function public.get_invoice_sheet_status() from public,anon,authenticated;
grant execute on function public.get_invoice_sheet_status() to authenticated;
commit;
