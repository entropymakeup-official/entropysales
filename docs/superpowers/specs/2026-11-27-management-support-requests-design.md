# 경영지원 요청 (2026-11-27)

## 목적

세금계산서·구매확인서·수출/은행 증명서·사업자 서류처럼 공인인증서가 필요해 경영지원팀(원정민)에게 따로 부탁하던 일을 물류 요청과 같은 방식으로 접수·추적한다.

## 사용자 결정 (2026-11-27)

- 메뉴 이름: **경영지원** (해외영업 대시보드 "업무" 묶음, 물류 요청 아래)
- 요청자: 회사 계정 누구나. 처리(상태 변경·발급본 첨부)는 담당자 명단(`support_handlers`)만
- 종류: 세금계산서 발행, 구매확인서, 수출·은행 증명서, 사업자 서류, 기타
- 알림: 전용 슬랙 채널에 새 요청 + 담당자 멘션, 완료·보류·취소·되돌리기는 그 글 스레드에 요청자 멘션
- 완료 조건: 발급본 파일(kind=result) 1개 이상. 승인번호 등은 결과 칸(선택)

## 구조 (물류 요청을 그대로 따름)

| 물류 | 경영지원 |
|---|---|
| `logistics.html` / `logistics-standalone.js` | `support.html` / 같은 `logistics-standalone.js`(제목·클래스 인자 추가) |
| `logistics-model.js` | `support-model.js` |
| `logistics.js` (`LogisticsPage.mountTab`) | `support.js` (`SupportPage.mountTab`), 화면 클래스는 `logistics.css`의 `lg-*` 재사용, 요소 id는 `sp-*` |
| `sql/logistics.sql`, `-storage.sql`, `-slack.sql` | `sql/support.sql`, `support-storage.sql`, `support-slack.sql` |

파스토·품목·받는 곳·기사 정보는 없다.

## 데이터

- `support_handlers(email, display_name, is_active, mention_on_new)`
- `support_requests`: `type_code`(tax_invoice·purchase_confirm·certificate·business_doc·etc), `title_text`(1~80), `counterparty_text`(1~120), `due_date`(필요 기한), `amount_text`(≤100, 금액·통화 자유 기재), `issue_date`(작성일·기준일), `note_text`(≤1000), `invoice_id`(주문 연결, 선택), `status_code`, `status_note_text`, `result_text`(≤300, 승인번호 등), `done_at`, 슬랙 칸, 생성·수정 칸
- `support_request_files`: `kind_code`(request 요청 근거·result 발급본·etc), 요청당 10개, 20MB
- `support_request_comments`, `support_request_history`, `support_slack_outbox`
- 슬랙 ID는 기존 `logistics_people`을 그대로 쓴다(사람 명단을 두 벌 두지 않음). 이 파일은 `sql/logistics.sql` 다음에 설치한다.

## 상태

요청 → 처리중 → 완료, 보류(사유 필수), 취소. 완료 → 처리중 되돌리기(사유 필수).

- 요청 → 처리중·완료·보류·취소 / 처리중 → 완료·보류·취소 / 보류 → 요청·처리중·취소 / 완료 → 처리중
- 완료로 바꿀 때 발급본 첨부가 없으면 `SUPPORT_RESULT_FILE_REQUIRED`. `done_at`은 트리거가 정한다.
- 요청자는 자기 요청이 "요청" 상태일 때만 요약 수정·취소. 담당자는 완료·취소 전까지 요약 수정.

## 권한

- 요청 목록·댓글·이력: 회사 계정 누구나 읽기
- **첨부(행과 파일 모두): 요청자와 담당자만.** 잔액증명 등 민감 서류가 있어 물류보다 좁다. 버킷 `support-docs`는 기존 전사 허용 정책 위에 제한(restrictive) 정책으로 읽기·쓰기·지우기를 좁힌다.
- 올리기: 요청자는 열린 요청(완료·취소 전)에 request·etc만. 담당자는 취소 전이면 아무 종류나(발급본 포함, 완료 뒤 정정본 추가 가능)
- 지우기: 담당자는 언제든, 단 완료 상태에서 마지막 발급본은 못 지운다(되돌린 뒤 지움). 요청자는 자기가 올린 파일을 열린 요청에서만.

## 슬랙

- Vault: 봇 토큰은 물류와 같은 `logistics_slack_bot_token`, 채널은 새 `support_slack_channel`. 채널이 없으면 아무것도 보내지 않는다.
- 새 요청: `*[세금계산서 발행] 제목*` / 거래처 · 기한 / 요청자 → 담당자 멘션 / 상세 링크(`support.html?id=`)
- 완료: 스레드에 "완료 · 결과(승인번호) · 발급본은 상세에서 확인" + 요청자 멘션. 파일은 슬랙에 올리지 않는다.
- pg_cron `support-slack-send` 매분.

## 설치 순서 (사용자 승인 후)

1. 운영 DB에 `sql/support.sql` → `support-storage.sql` → `support-slack.sql` 적용 (머지 전, 자세한 절차는 SUPPORT.md)
2. 담당자 명단·슬랙 ID·채널(Vault) 넣기
3. Supabase Auth 리디렉트 허용 목록에 `support.html` 추가
4. 머지(= GitHub Pages 배포)

## 검증

- PGlite DB 테스트(권한·상태·완료 조건·첨부 범위·슬랙 문구), 모델·화면 단위 테스트. 가상 데이터만 쓴다.
