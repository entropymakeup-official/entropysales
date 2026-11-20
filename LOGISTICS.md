# 물류 요청

회사 전체의 출고·샘플·퀵·시딩·CS·회송 요청을 받는 화면입니다. 2026-11-20부터 영업 대시보드(`index.html`)의 "물류 요청" 탭으로 옮겼습니다(`logistics.js`의 `mountTab`, `logistics.css`). `logistics.html`은 이미 보낸 슬랙 링크(`logistics.html?id=<요청 id>`)를 `index.html?logistics=<요청 id>`로 넘겨 주는 이동 페이지일 뿐이며, 대시보드는 로그인 뒤 그 값을 읽어 물류 요청 탭과 해당 요청 상세를 열고 주소에서 지웁니다. 설계: `docs/superpowers/specs/2026-11-19-logistics-dashboard-design.md`

## 동작 기준

- 회사 계정이면 누구나 요청을 올리고 볼 수 있습니다. 상태 변경과 결과 입력은 `logistics_handlers` 명단에 있는 사람만 할 수 있습니다.
- 요청자는 자기 요청이 "요청" 상태일 때만 수정하거나 취소할 수 있고(상세의 "요약 수정"), 담당자는 출고완료·취소 전까지 요약을 고칠 수 있습니다. 첨부 삭제도 요청자는 열린 요청에서만, 담당자는 언제든 할 수 있습니다.
- 출고완료에는 송장·배차·BL과 출고일이, 보류와 출고완료 되돌리기에는 사유가 반드시 필요합니다. DB 트리거가 판정합니다.
- 승인 절차(APPROVALS.md)는 쓰지 않고 바로 저장합니다. 영업 주문의 출고 상태는 바꾸지 않고 연결만 합니다.
- 변경 이력(`logistics_request_history`)과 슬랙 대기열(`logistics_slack_outbox`)은 트리거만 씁니다.
- 결과 칸(송장·배차·BL)은 출고완료 알림에 그대로 실려 슬랙 채널에 보입니다. 송장번호·차량번호만 적고 기사 연락처나 주소는 적지 않습니다.

## 설치 순서 (운영 DB, 사용자 승인 후)

1. `sql/logistics.sql`
2. `sql/logistics-storage.sql`
3. `sql/logistics-slack.sql` (pg_net, pg_cron, Vault가 이미 설치돼 있어야 합니다. 2026-11-19 확인)
   - 설치 후 확인: anon·authenticated 역할이 net.http_request_queue와 net._http_response를 읽을 수 없는지(봇 토큰이 요청 헤더에 잠시 남음), postgres가 vault.decrypted_secrets와 cron을 쓸 수 있는지 확인합니다.
4. `sql/logistics-fassto.sql` (파스토 양식: 상품 목록·받는 곳·품목·주문번호. 앞의 세 파일 다음에 설치합니다. 설치 전 요청에도 주문번호를 채웁니다)
   - 기존 요청의 주문번호를 채우면서 그 요청의 `updated_at`이 바뀌고 `updated_by_text`가 `system`이 됩니다(변경 이력 행과 슬랙 알림은 생기지 않습니다).
5. 명단 넣기(실제 값은 저장소에 넣지 않습니다)

```sql
insert into public.logistics_handlers(email, display_name) values ('name@entropymakeup.com', '이름');
insert into public.logistics_people(email, display_name, slack_user_id) values ('name@entropymakeup.com', '이름', 'U0123456789');
```

새 요청 알림 멘션만 빼기(담당자 권한은 그대로):

```sql
update public.logistics_handlers set mention_on_new = false where email = 'name@entropymakeup.com';
```

퇴사·담당 변경 시에만 실행:

```sql
update public.logistics_handlers set is_active = false where email = 'name@entropymakeup.com';
```

6. 첫 파스토 목록 갱신(아래 "파스토 목록 갱신" 절차)
7. 정적 파일 배포: index.html, app.js, logistics.js, logistics-model.js, fassto-forms.js, logistics.css, logistics.html(이동 페이지). 바꾼 파일은 index.html의 버전 쿼리도 함께 올립니다.
8. 예약 작업 등록(평일 08:30 KST, 지시문은 `tools/fassto-sync-routine.txt`)

## 파스토 양식 (2026-11-20)

설계: `docs/superpowers/specs/2026-11-20-logistics-fassto-forms-design.md`

- 운송 방식으로 양식을 정합니다: 택배 → 택배신청, 해외특송 → 해외택배신청, 직납·Air·Ocean → 차량배송신청(상품), 퀵·기타 → 양식 없음.
- 요청자가 새 요청 창에서 받는 곳과 품목을 넣습니다. 품목은 파스토 상품 목록(`logistics_fassto_stock`)에서만 고르고, 출고 가능 수량보다 많으면 노란 경고만 합니다.
- 받는 곳(`logistics_request_recipients`)은 요청자와 활성 물류 담당자만 봅니다. 운송사·Incoterms·발송인은 담당자만 "요약 수정"에서 정합니다(DB 트리거가 `LOGISTICS_HANDLER_ONLY`로 막습니다).
- 품목(`logistics_request_items`)은 회사 구성원 누구나 보고, 쓰기는 요약 수정과 같은 규칙입니다(요청자는 요청 상태에서만, 담당자는 출고완료·취소 전까지). 요청당 50줄까지이며 `public.logistics_replace_items`로 통째로 바꿉니다.
- 상세의 **파스토 양식 내려받기**는 필수 칸을 검사한 뒤 `파스토_<양식>_<주문번호>.xlsx`를 저장합니다. 1~4행은 파스토 원본 그대로이고 5행부터 품목입니다. 엑셀은 대시보드가 이미 불러오는 SheetJS 0.18.5로 브라우저에서 만듭니다. 수량은 숫자 칸이라(템플릿 예시는 문자) 처음 쓸 때 김윤래에게 파스토가 이 파일을 받아 주는지 확인합니다.
- 주문번호(`logistics_requests.fassto_order_no`)는 등록 때 DB가 `LG날짜_순번`(KST, 예 `LG20261120_003`)으로 정하고 바꾸지 않습니다.
- 해외 발송인 기본값은 `fassto-forms.js`의 `SENDER`입니다. 전화·이메일은 사용자 확인 전 임시값입니다. 바꾸면 index.html의 `fassto-forms.js` 버전 쿼리를 올려 배포합니다.

### 파스토 목록 갱신 (Claude, 브라우저)

사용자가 "파스토 목록 갱신해줘"라고 하거나 예약 작업이 돌면 아래를 그대로 합니다.

1. 브라우저에서 `https://fms.fassto.ai`의 상품별재고현황 화면을 열고 엑셀로 내려받습니다. 내려받은 열(2026-11-19 확인): 상품코드, 상품바코드, 상품명, 상품구분, 유통기한, LOT번호, 출고 가능 수량(그 밖의 열도 있음). 로그인이 풀려 있으면 아무것도 바꾸지 않고 사용자에게 "FMS 로그인이 필요해요"라고 알린 뒤 멈춥니다. 비밀번호·인증번호는 입력하지 않습니다.
2. 저장소 폴더에서 변환합니다(요약은 화면에, SQL은 파일로).

   ```bash
   node tools/fassto-stock-json.cjs "<내려받은 파일>" --sql > "<스크래치 폴더>/fassto-stock.sql"
   ```

   필수 열을 못 찾으면 찾은 제목을 보여 주고 멈춥니다. 그때는 `tools/fassto-stock-json.cjs`의 `ALIASES`에 FMS 열 이름을 더하고 `tests/fassto-stock-json.test.cjs`를 맞춘 뒤 다시 합니다. 로트 행이 지난번 `row_count`의 절반보다 적으면 실행하지 말고 사용자에게 확인합니다.
   변환기는 상품코드·바코드 칸이 숫자인 파일(문자로 내보내야 합니다)과 수량·날짜가 잘못된 파일을 거부합니다. 거부하면 아무것도 바꾸지 말고 그 문구를 사용자에게 알립니다.
3. 운영 Supabase(SQL 편집기 또는 Supabase MCP `execute_sql`)에서 그 파일의 select 문 하나만 postgres 권한으로 실행합니다. 돌려준 숫자가 넣은 로트 행 수입니다. 이 함수는 anon·authenticated에는 실행 권한이 없습니다.
4. 확인합니다.

   ```sql
   select synced_at, source_text, row_count from public.logistics_fassto_sync order by synced_at desc limit 1;
   select count(*) as lots, count(distinct product_code) as products from public.logistics_fassto_stock;
   ```

5. 내려받은 엑셀과 SQL 파일은 저장소에 넣지 않고 지웁니다.

예약 작업(평일 08:30 KST)은 `tools/fassto-sync-routine.txt`의 지시문을 그대로 씁니다. 나중에 파스토 API를 받으면 같은 함수를 Edge Function이나 pg_cron이 `'fassto-api'`로 부르게 바꿉니다. 표와 화면은 그대로입니다.

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
