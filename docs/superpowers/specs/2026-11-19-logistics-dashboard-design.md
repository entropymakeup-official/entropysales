# 물류 요청 대시보드 설계 (2026-11-19)

사용자 승인: 2026-11-19. 회사 전체 범위, 별도 페이지와 같은 DB 사용, 슬랙 자동 알림(방법 A: DB가 직접 호출), 엑셀 첨부와 요약 칸 방식.

## 1. 배경

- 출고·샘플·퀵·시딩·CS 요청은 슬랙 #업무-배송요청에 양식 글과 출고요청서 엑셀로 올라온다. 하루 5~10건이고, 요청자는 여러 팀이다. 처리는 물류 담당 김윤래님이 한다.
- 요청 양식은 자리 잡혔지만 요청한 뒤의 진행 상태를 볼 곳이 없다. 접수·출고 표시가 일정하지 않고, 송장·배차정보도 스레드에 가끔만 남는다.
- 그래서 진행 확인이 DM으로 흩어진다. 11/16에는 사용자가 출고 건 9개를 상태별로 손으로 정리해 DM으로 보냈다.
- 해외 B2B 출고는 단계가 많다: 재고 확인 → 패킹리스트 → 거래처 회신 → 운송·포워더·입고증 → 배차 → 출고 → 송장/BL. 대부분 이 중간 단계에서 멈춘다.
- 출고 결과가 주문과 떨어져 있어서, 나중에 영업 대시보드에서 증빙을 대조할 때 시간이 많이 든다.

## 2. 목표와 범위

목표: 요청 한 건의 상태와 결과(송장·배차·BL)를 한 화면에서 보이게 한다. 진행 확인 DM을 없애고, 출고완료에는 증빙을 반드시 남긴다.

포함:
- 별도 페이지 `logistics.html`. 영업 대시보드와 같은 Supabase 프로젝트와 회사 계정 로그인을 쓴다.
- 요청 등록·수정·취소, 담당자의 상태 처리, 첨부, 댓글, 변경 이력, 슬랙 자동 알림
- 영업 주문(`invoices`)과는 선택적으로 연결만 한다.

제외(첫 버전):
- 품목별 입력, 재고 차감, 엑셀 자동 읽기
- 퀵비 정산 화면. 퀵비는 숫자 칸만 둔다.
- 영업 주문의 출고 상태 자동 변경. 기존 승인 절차(APPROVALS.md)를 그대로 유지한다.
- 슬랙에서 들어오는 요청 수집. 요청은 대시보드에서만 등록한다.

## 3. 화면

### 요청 등록 폼

| 칸 | 필수 | 값 |
|---|---|---|
| 유형 | 예 | B2B출고 / 샘플 / 퀵 / 마케팅·시딩 / CS·교체 / 회송·재입고 / 기타 |
| 제목 | 예 | 80자 이하. 예: "예스스타일 Air 11월 발주" |
| 요청팀 | 예 | 글로벌 / 국내 / 마케팅·크리에이티브 / CS / 기타 |
| 거래처·수신처 | 예 | 120자 이하 |
| 희망 출고일 | 예 | 날짜. "미정" 체크를 허용하고, 미정이면 빈 값으로 저장 |
| 운송 방식 | 예 | 택배 / 퀵 / Air / Ocean / 직납 / 해외특송 / 기타 |
| 수량 요약 | 아니오 | 300자 이하. 예: "12 SKU, 3,240ea" |
| 특이사항 | 아니오 | 1000자 이하. 박스 표기, 유통기한 조건, 입고 가능 시간 등 |
| 연결 주문 | 아니오 | 영업 주문 선택(`invoices.id`) |
| 첨부 | 아니오 | 출고요청서·패킹리스트·입고증·기타. 파일당 20MB, 요청당 최대 10개 |

유형이 B2B출고이거나 운송 방식이 Air/Ocean이면 해외 B2B 칸을 추가로 보여 준다.
- 패킹리스트: 대기 / 작성완료 / 거래처회신
- ETD
- 포워더: 텍스트

### 목록

- 탭: 처리할 것(요청·접수·준비중), 보류, 출고완료(최근 30일 기본), 취소, 내 요청
- 정렬: 희망일이 지난 것 → 가까운 것 → 미정, 같은 날짜면 먼저 등록한 순서
- 희망일이 지났는데 출고되지 않은 건은 빨간색으로 표시한다.
- 줄마다 유형, 제목, 요청자, 희망일, 운송, 상태, 첨부 수, 슬랙 알림 상태를 보여 준다.
- 검색: 제목, 거래처, 송장번호

### 상세

요약 칸, 첨부, 결과 칸, 해외 B2B 칸, 댓글, 변경 이력, 슬랙 글 링크를 보여 준다. 상태 버튼은 물류 담당자에게만 보인다.

## 4. 상태 규칙

```
requested(요청) → accepted(접수) → preparing(준비중) → shipped(출고완료)
     │                 │                  │
     └──── on_hold(보류) ⇄ 이전 상태로 복귀 ─┘
requested/accepted/preparing/on_hold → canceled(취소)
shipped → preparing (담당자가 되돌리기, 사유 필수)
```

- 출고완료로 바꾸려면 결과(송장·배차·BL 텍스트, 1~500자)와 출고일이 반드시 있어야 한다.
- 보류로 바꾸거나 출고완료를 되돌리려면 사유(1~300자)가 반드시 있어야 한다. 사유는 `status_note_text`에 남는다.
- 취소: 요청자는 자기 요청이 "요청" 상태일 때만 취소할 수 있다. 담당자는 출고완료가 아니면 언제든 취소할 수 있다.
- 출고완료와 취소는 닫힌 상태라서 요약 칸을 수정할 수 없다. 단, 담당자는 결과 칸을 정정할 수 있다.
- 이 규칙은 화면(`logistics-model.js`)과 DB 트리거 양쪽에서 검사한다. 최종 판정은 DB가 한다.

## 5. DB (`sql/logistics.sql`)

새로 만드는 것만 있다. 기존 표·함수는 바꾸지 않고, `approval_private.is_company_member()`와 `current_email()`만 재사용한다.

### 표

`logistics_handlers(email pk, display_name, is_active)`
- 상태를 처리할 수 있는 사람 명단. 실제 명단은 저장소에 넣지 않고 DB에 직접 넣는다.

`logistics_people(email pk, display_name, slack_user_id)`
- 슬랙 태그용 명단. `slack_user_id`는 `^U[A-Z0-9]{6,20}$` 형식만 허용한다.

`logistics_requests`
- id uuid, type_code, title_text, team_code, requester_email(트리거가 채움), counterparty_text
- want_date(null=미정), ship_mode_code, qty_summary_text, note_text, invoice_id(fk invoices, on delete set null)
- status_code(기본 requested), status_note_text
- result_text, shipped_on, quick_fee_krw(정수, 0 이상)
- packing_code(null/waiting/done/replied), etd_on, forwarder_text
- slack_ts, slack_state_code(pending/sent/failed/none)
- created_at, updated_at, updated_by_text
- 인덱스: (status_code, want_date), (requester_email)

`logistics_request_files(id, request_id fk cascade, kind_code, storage_path unique, name_text, size_bytes, created_by, created_at)`

`logistics_request_comments(id, request_id fk cascade, body_text 1~1000자, author_email, created_at)`
- 작성자 본인만 24시간 안에 삭제할 수 있고, 수정은 안 된다.

`logistics_request_history(id, request_id, field_code, from_text, to_text, changed_by_text, changed_at)`
- 트리거만 쓴다. 기록하는 칸: created, status, want_date, result, packing, invoice

`logistics_slack_outbox(id, request_id, event_code, payload jsonb, state_code, attempts, net_request_id, last_error_text, created_at, sent_at)`
- 클라이언트 권한이 없다. 트리거와 예약 함수만 쓴다.

### 트리거

- `logistics_requests_stamp`(before insert/update)
  - insert: `requester_email`을 로그인 사용자로 강제하고, status는 requested로만 만들 수 있다.
  - update: 상태 전환표와 필수 칸을 검사한다. 비담당자는 자기 요청이 requested일 때 요약 칸 수정과 취소만 할 수 있다. 닫힌 상태의 요약 칸 수정은 막는다. `updated_*`를 채운다.
- `logistics_requests_log`(after insert/update): 이력 기록. 알림 대상 이벤트(created, shipped, on_hold, canceled, reopened)이면 outbox에 한 줄을 넣는다.

### 권한 (RLS)

- requests, files, comments, history: 회사 계정이면 읽기 가능
- requests insert: 회사 계정이면 가능
- requests update: 회사 계정. 세부 권한은 트리거가 판정한다.
- 삭제: 없음. 취소 상태로 대신한다.
- files insert: 회사 계정이고 해당 요청이 닫히지 않았을 때
- files delete: 올린 사람이나 담당자
- Storage: 비공개 버킷 `logistics-docs`, 경로 `{request_id}/{uuid}-{파일명}`. 회사 계정만 읽고 쓸 수 있다.
- outbox, handlers, people: 클라이언트 쓰기 없음. handlers와 people은 회사 계정이면 읽기 가능하다(화면에서 버튼 표시와 이름 표시에 사용).

## 6. 슬랙 알림

- 봇 토큰(`chat:write`)과 채널 ID를 Vault에 `logistics_slack_bot_token`, `logistics_slack_channel`로 저장한다. 저장소에는 넣지 않는다.
- pg_cron `logistics-slack-send`가 1분마다 `approval_private.logistics_slack_flush()`를 실행한다.
  1. 이전에 보낸 요청의 응답을 `net._http_response`에서 읽는다. 결과가 `ok=true`면 sent로 바꾸고, 새 요청 글이면 `ts`를 `logistics_requests.slack_ts`에 저장한다. 실패면 attempts를 하나 올리고 오류를 남긴다.
  2. 보낼 차례인 건을 처리한다. 새 요청 글은 바로 보낸다. 그 밖의 이벤트는 같은 요청의 새 요청 글 ts가 생긴 뒤에 `thread_ts`로 답글을 단다. 새 요청 글이 실패로 끝났으면 채널에 새 글로 보낸다.
  3. 5번 실패하면 failed로 두고, 요청의 `slack_state_code`를 failed로 바꾼다. 화면에 "알림 실패"로 표시한다.
- 메시지 예시
  - 새 요청: `[B2B출고] 예스스타일 Air 11월 발주 · 희망 11/24 · Air` / 요청 `<@요청자>` → `<@담당자들>` / 대시보드 링크
  - 출고완료: `출고완료 11/24 · 송장 …` `<@요청자>`
  - 보류: `보류: 사유` `<@요청자>`
- 슬랙 ID가 없는 사람은 표시 이름만 적는다.
- 메시지에는 금액, 연락처, 주소를 넣지 않는다. 대시보드 링크로 대신한다.
- 저장과 알림은 분리돼 있다. 알림이 실패해도 요청 저장은 그대로 성공한다.

## 7. 화면 파일

- `logistics.html`: 로그인, 목록, 상세, 등록 창
- `logistics-model.js`: UMD 순수 함수. 전환표, `canTransition(role, from, to, fields)`, 필수 칸 검사, 지연 판정(KST 기준), 정렬
- `logistics.js`: Supabase 조회·저장, 렌더링. 문자열은 모두 이스케이프한다.
  - 저장은 반환 행을 확인한 뒤에만 성공으로 표시한다. 응답이 없으면 새로고침을 안내하고 자동 재시도하지 않는다(기존 대시보드 기준과 같음).
  - 상태 변경은 이전 상태를 조건으로 건 UPDATE로 한다. 0행이면 "다른 사람이 먼저 바꿈"을 안내한다.
- `logistics.css`
- `LOGISTICS.md`: 운영 안내. 명단 입력 SQL, 슬랙 앱 등록 절차, Vault 저장 방법을 적는다.
- 영업 대시보드 `index.html`에는 메뉴 링크 하나만 추가한다.

## 8. 테스트

- `tests/logistics-model.test.cjs`: 전환표 전부, 필수 칸, 요청자와 담당자 권한 차이, 지연 판정(자정 경계, 미정), 정렬
- `tests/logistics-db.test.cjs`(PGlite, 기존 auth stub 방식)
  - 외부 계정 읽기·쓰기 거부
  - 요청자 강제 기록, 비담당자 상태 변경 거부, 결과 없는 출고완료 거부, 사유 없는 보류 거부
  - 닫힌 요청 수정 거부, 이력 기록, outbox 생성
  - pg_net과 Vault는 대체 스키마로 바꿔 flush 함수의 ts 저장, 재시도, 실패 처리 검사
- `npm run check`, `npm test` 전체 통과
- 로컬 브라우저에서 가짜 데이터로 등록 → 접수 → 출고완료 흐름 확인
- 운영 반영(사용자 승인 후)
  - SQL 설치 → 명단 입력 → Vault 저장 → 테스트 요청 1건으로 슬랙 새 글과 스레드 답글 확인 → 테스트 건 취소

## 9. 도입 순서와 남은 결정

1. 개발·테스트 → PR → 사용자 검토
2. 사용자 또는 슬랙 관리자가 슬랙 앱을 만들고 봇 토큰을 발급한다(`chat:write`, #업무-배송요청 초대). Claude는 토큰을 다루지 않고, 사용자가 Vault에 직접 넣는다.
3. 운영 DB 설치와 배포
4. 김윤래님과 사용법 합의 → 글로벌팀부터 시범 사용 → 다른 팀 안내(채널 공지는 사용자가 결정)

남은 결정:
- 물류 담당자 명단: 처음에는 김윤래님과 이상윤님. 추가할 사람은 운영 시작 전에 정한다.
- 다른 팀의 전환 시점, 그리고 기존 슬랙 양식 글을 받지 않을지 여부
