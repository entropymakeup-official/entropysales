# 물류 요청

회사 전체의 출고·샘플·퀵·시딩·CS·회송 요청을 받는 별도 페이지(`logistics.html`)입니다. 설계: `docs/superpowers/specs/2026-11-19-logistics-dashboard-design.md`

## 동작 기준

- 회사 계정이면 누구나 요청을 올리고 볼 수 있습니다. 상태 변경과 결과 입력은 `logistics_handlers` 명단에 있는 사람만 할 수 있습니다.
- 요청자는 자기 요청이 "요청" 상태일 때만 수정하거나 취소할 수 있습니다.
- 출고완료에는 송장·배차·BL과 출고일이, 보류와 출고완료 되돌리기에는 사유가 반드시 필요합니다. DB 트리거가 판정합니다.
- 승인 절차(APPROVALS.md)는 쓰지 않고 바로 저장합니다. 영업 주문의 출고 상태는 바꾸지 않고 연결만 합니다.
- 변경 이력(`logistics_request_history`)과 슬랙 대기열(`logistics_slack_outbox`)은 트리거만 씁니다.
- 결과 칸(송장·배차·BL)은 출고완료 알림에 그대로 실려 슬랙 채널에 보입니다. 송장번호·차량번호만 적고 기사 연락처나 주소는 적지 않습니다.

## 설치 순서 (운영 DB, 사용자 승인 후)

1. `sql/logistics.sql`
2. `sql/logistics-storage.sql`
3. `sql/logistics-slack.sql` (pg_net, pg_cron, Vault가 이미 설치돼 있어야 합니다. 2026-11-19 확인)
   - 설치 후 확인: anon·authenticated 역할이 net.http_request_queue와 net._http_response를 읽을 수 없는지(봇 토큰이 요청 헤더에 잠시 남음), postgres가 vault.decrypted_secrets와 cron을 쓸 수 있는지 확인합니다.
4. 명단 넣기(실제 값은 저장소에 넣지 않습니다)

```sql
insert into public.logistics_handlers(email, display_name) values ('name@entropymakeup.com', '이름');
insert into public.logistics_people(email, display_name, slack_user_id) values ('name@entropymakeup.com', '이름', 'U0123456789');
update public.logistics_handlers set is_active = false where email = 'name@entropymakeup.com';
```

5. 정적 파일 배포

## 슬랙 앱 등록 (사용자 또는 슬랙 관리자)

1. api.slack.com/apps에서 새 앱을 만들고 Bot Token Scopes에 `chat:write`를 추가합니다.
2. 워크스페이스에 설치하고 Bot User OAuth Token(`xoxb-`로 시작)을 복사합니다.
3. #업무-배송요청 채널에서 `/invite @앱이름`으로 앱을 초대합니다.
4. Supabase SQL 편집기에서 직접 넣습니다. 토큰은 채팅이나 저장소에 붙이지 않습니다.

```sql
select vault.create_secret('xoxb-...', 'logistics_slack_bot_token');
select vault.create_secret('C08MUA6K4D6', 'logistics_slack_channel');
```

토큰이나 채널이 없으면 알림은 보내지 않고 대기열에 쌓입니다. 나중에 넣으면 다음 1분 안에 차례로 보냅니다.

## 알림 확인과 정리

알림은 최소 한 번 전달 방식이라 pg_net 응답이 10분 넘게 없으면 다시 보내며, 드물게 같은 글이 두 번 올라갈 수 있습니다.

```sql
-- 실패하거나 밀린 알림
select id, request_id, event_code, state_code, attempts, last_error_text, created_at
from public.logistics_slack_outbox where state_code in ('pending','sending','failed') order by id;
-- 실패한 알림 다시 보내기
update public.logistics_slack_outbox set state_code = 'pending', attempts = 0 where id = <id>;
-- 예약 작업 확인
select jobname, schedule from cron.job where jobname = 'logistics-slack-send';
-- 행이 없는 첨부 파일(올린 직후 저장 실패) 찾기
select o.name from storage.objects o where o.bucket_id = 'logistics-docs'
 and not exists (select 1 from public.logistics_request_files f where f.storage_path = o.name);
```
