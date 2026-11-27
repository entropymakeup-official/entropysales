-- 경영지원 요청 슬랙 알림. 트리거가 넣은 support_slack_outbox를 pg_cron이 매분 pg_net으로 보낸다.
-- 봇 토큰은 물류와 같은 Vault 비밀(logistics_slack_bot_token), 채널은 support_slack_channel. 채널이 없으면 아무것도 보내지 않는다.
-- logistics-slack.sql 다음에 설치한다(이름 표시는 logistics_slack_who·logistics_slack_escape를 같이 쓴다).
begin;

create or replace function approval_private.support_slack_who(p_email text) returns text
language sql stable security definer set search_path='' as $$
 select coalesce(
  (select '<@'||p.slack_user_id||'>' from public.logistics_people p where p.email=lower(p_email) and p.slack_user_id is not null),
  (select approval_private.logistics_slack_escape(p.display_name) from public.logistics_people p where p.email=lower(p_email)),
  (select approval_private.logistics_slack_escape(h.display_name) from public.support_handlers h where h.email=lower(p_email)),
  approval_private.logistics_slack_escape(split_part(coalesce(p_email,''),'@',1)));
$$;

create or replace function approval_private.support_slack_text(p_request uuid, p_event text, p_payload jsonb) returns text
language plpgsql stable security definer set search_path='' as $$
declare
 v_type text := case p_payload->>'type_code' when 'tax_invoice' then '세금계산서 발행' when 'purchase_confirm' then '구매확인서'
  when 'certificate' then '수출·은행 증명서' when 'business_doc' then '사업자 서류' else '기타' end;
 v_due text := coalesce(to_char((p_payload->>'due_date')::date,'FMMM/FMDD'),'미정');
 v_title text := approval_private.logistics_slack_escape(p_payload->>'title_text');
 v_cp text := approval_private.logistics_slack_escape(p_payload->>'counterparty_text');
 v_req text := approval_private.support_slack_who(p_payload->>'requester_email');
 v_link text := '<https://entropymakeup-official.github.io/entropysales/support.html?id='||p_request::text||'|요청 상세 보기>';
 v_handlers text;
begin
 if p_event = 'created' then
  select string_agg(approval_private.support_slack_who(h.email), ' ' order by h.email) into v_handlers from public.support_handlers h where h.is_active and h.mention_on_new;
  return format(E'*[%s] %s*\n%s · 기한 %s\n요청 %s → %s\n%s', v_type, v_title, v_cp, v_due, v_req, coalesce(v_handlers,'경영지원 담당'), v_link);
 elsif p_event = 'done' then
  return format(E'완료%s · 발급본은 상세에서 확인해 주세요\n%s\n%s',
   case when coalesce(p_payload->>'result_text','')<>'' then ' · '||approval_private.logistics_slack_escape(p_payload->>'result_text') else '' end, v_req, v_link);
 elsif p_event = 'on_hold' then
  return format(E'보류: %s\n%s', approval_private.logistics_slack_escape(p_payload->>'status_note_text'), v_req);
 elsif p_event = 'canceled' then
  return format(E'취소: *[%s] %s*%s\n%s', v_type, v_title,
   case when coalesce(p_payload->>'status_note_text','')<>'' then ' · '||approval_private.logistics_slack_escape(p_payload->>'status_note_text') else '' end, v_req);
 else
  return format(E'완료를 되돌려 처리중으로 바꿈: %s\n%s', approval_private.logistics_slack_escape(p_payload->>'status_note_text'), v_req);
 end if;
end $$;

create or replace function approval_private.support_slack_flush() returns void
language plpgsql security definer set search_path='' as $$
declare
 v_token text; v_channel text; r record; resp record; v_ok boolean; v_body jsonb; v_err text;
begin
 select decrypted_secret into v_token from vault.decrypted_secrets where name='logistics_slack_bot_token';
 select decrypted_secret into v_channel from vault.decrypted_secrets where name='support_slack_channel';
 if coalesce(v_token,'')='' or coalesce(v_channel,'')='' then return; end if;

 -- 1) 보낸 건의 응답 확인. 한 행이 오류를 내도 나머지 알림은 계속 처리한다.
 for r in select * from public.support_slack_outbox where state_code='sending' order by id for update skip locked loop
  begin
   select * into resp from net._http_response where id=r.net_request_id;
   if not found then
    if r.sent_at > now() - interval '10 minutes' then continue; end if;
    v_ok := false; v_err := 'no response';
   else
    begin v_ok := resp.status_code = 200 and coalesce((resp.content::jsonb->>'ok')::boolean,false);
    exception when others then v_ok := false; end;
    v_err := left(coalesce(nullif(resp.error_msg,''), resp.content, ''), 300);
   end if;
   if v_ok then
    update public.support_slack_outbox set state_code='sent', last_error_text='' where id=r.id;
    if r.event_code='created' then
     update public.support_requests set slack_ts=resp.content::jsonb->>'ts', slack_state_code='sent' where id=r.request_id;
    end if;
   else
    update public.support_slack_outbox set state_code=case when r.attempts>=5 then 'failed' else 'pending' end, last_error_text=v_err where id=r.id;
    if r.attempts>=5 then
     update public.support_requests set slack_state_code='failed' where id=r.request_id;
    end if;
   end if;
  exception when others then
   update public.support_slack_outbox set state_code=case when r.attempts>=5 then 'failed' else 'pending' end, last_error_text=left(SQLERRM,300) where id=r.id;
   if r.attempts>=5 then update public.support_requests set slack_state_code='failed' where id=r.request_id; end if;
  end;
 end loop;

 -- 2) 대기 중인 건 보내기
 for r in select o.*, q.slack_ts as parent_ts from public.support_slack_outbox o join public.support_requests q on q.id=o.request_id
          where o.state_code='pending' order by o.id limit 20 for update of o skip locked loop
  begin
   if r.event_code<>'created' and r.parent_ts is null and exists(
      select 1 from public.support_slack_outbox p where p.request_id=r.request_id and p.event_code='created' and p.state_code in ('pending','sending')) then
    continue; -- 원글이 끝나기를 기다린다
   end if;
   v_body := jsonb_build_object('channel',v_channel,'text',approval_private.support_slack_text(r.request_id,r.event_code,r.payload),'unfurl_links',false,'unfurl_media',false);
   if r.event_code<>'created' and r.parent_ts is not null then v_body := v_body || jsonb_build_object('thread_ts',r.parent_ts); end if;
   update public.support_slack_outbox set state_code='sending', attempts=attempts+1, sent_at=now(),
    net_request_id=net.http_post(url:='https://slack.com/api/chat.postMessage', body:=v_body,
     headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||v_token), timeout_milliseconds:=10000)
    where id=r.id;
  exception when others then
   update public.support_slack_outbox set attempts=attempts+1, last_error_text=left(SQLERRM,300),
    state_code=case when r.attempts+1>=5 then 'failed' else 'pending' end where id=r.id;
   if r.attempts+1>=5 then update public.support_requests set slack_state_code='failed' where id=r.request_id; end if;
  end;
 end loop;
end $$;

revoke all on function approval_private.support_slack_who(text),approval_private.support_slack_text(uuid,text,jsonb),
 approval_private.support_slack_flush() from public,anon,authenticated;

do $$ begin
 perform cron.unschedule(jobid) from cron.job where jobname='support-slack-send';
 perform cron.schedule('support-slack-send','* * * * *','select approval_private.support_slack_flush()');
end $$;
commit;
