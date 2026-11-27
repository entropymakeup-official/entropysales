# 물류 요청: 파스토 OpenAPI 동기화 설계 (2026-11-27)

## 1. 목적

지금은 출고를 파스토 FMS에 직접 등록하면 대시보드 물류 요청에는 아무것도 생기지 않는다. 물류 담당자가 출고 건을 대시보드에서 확인하고, 패킹리스트를 올리고, 차량 출고는 기사 정보, 택배는 송장번호를 남기려면 같은 건을 손으로 다시 입력해야 한다. 재고 목록도 Claude가 브라우저로 FMS 엑셀을 받아 하루 한 번 갱신하는데, FMS 로그인이 매일 풀려서 자주 실패한다.

파스토 OpenAPI가 나왔으니 사무실 PC에서 도는 동기화 프로그램이 API로 재고와 출고 신청을 읽어 대시보드 DB에 넣게 한다.

결정 사항(사용자, 2026-11-27):
- 방향은 파스토 → 대시보드 읽기다. 출고는 지금처럼 FMS에 등록한다. 대시보드 → 파스토 등록은 범위 밖(나중에 API로 붙일 수 있음).
- 파스토 API는 파스토에 등록한 고정 IP에서만 호출된다. 사무실 회선 IP를 등록했고, 사무실에 상주하는 사용자 PC에서 돌린다.
- 실행 방식: 저장소의 Node 스크립트를 윈도우 작업 스케줄러로 돌린다(1안). DB 쓰기는 전용 함수 하나와 전용 열쇠로만 한다. Supabase 서비스 역할 키는 PC에 두지 않는다.
- 택배는 파스토가 송장번호를 주면 결과 칸만 채우고, 출고완료는 물류 담당자가 누른다.
- 차량 출고의 기사 정보는 API에 없으므로 물류 담당자가 입력한다.

범위 밖: 대시보드 → 파스토 출고 등록·수정·취소, 입고·반품 API, 슬랙 DM 오류 알림(필요하면 나중에).

## 2. 파스토 API (원본: Swagger `https://fmsapi.fassto.ai/swagger-ui.html`, 사용자 정리본 2026-11-26)

- 인증: `POST /api/v1/auth/connect?apiCd=&apiKey=` → `data.accessToken`, `data.expreDatetime`(`yyyyMMddHHmmss`, KST). 이후 요청 헤더 `accessToken`. 토큰을 받은 IP와 호출 IP가 같아야 하고, 다르면 `INVALID_ACCESS`.
- 공통 응답: `{header:{code,dataCount,msg}, errorInfo:{errorCode,errorMessage}, data}`.

쓰는 엔드포인트:

| 용도 | 엔드포인트 | 쓰는 필드 |
|---|---|---|
| 재고 | `GET /api/v1/stock/list/{cstCd}` | godCd, cstGodCd, godBarcd, godNm, giftDiv, distTermDt, canStockQty |
| 출고 목록 | `GET /api/v1/delivery/{cstCd}/{start}/{end}/ALL/{outDiv}` (outDiv 1 택배, 2 차량) | slipNo, ordNo, ordDt, shopNm, cstShopCd, outDiv, ordQty, sku, wrkStat, wrkStatNm, invoiceNo, parcelNm, salChanel, remark, updTime, updUserNm |
| 출고 상세(품목) | `GET /api/v1/delivery/detail/{cstCd}/{slipNo}` | 상품코드, 상품명, 유통기한, 수량 |

작업상태: 조회 경로값은 ALL·ORDER·WORKING·DONE·PARTDONE·CANCEL·SHORTAGE이고, 응답의 `wrkStat`은 숫자 코드다(1 출고요청, 2 출고작업중, 3 출고완료·부분출고완료, 8 출고요청취소, 9 재고부족결품; FMS 화면에서도 `wrkStat:"1"` 확인). 동기화는 숫자를 ORDER·WORKING·DONE·CANCEL·SHORTAGE로 바꿔 저장한다. 모르는 값이면 그 건을 건너뛰고 로그에 남긴다.

상품코드: 대시보드 `product_code`는 고객사상품코드(`cstGodCd`, 예 14자리 바코드형)다. FMS 내부 상품코드(`godCd`, 고객사코드가 앞에 붙음)는 쓰지 않는다. 첫 미리보기에서 지금 재고 표의 상품코드와 같은 체계인지 확인한다.

재고 응답에는 LOT 번호가 없다. `lot_text`는 빈 값으로 넣고, 화면과 양식은 유통기한으로 로트를 구분한다(지금 FMS 엑셀도 대부분 같음). 첫 실행에서 FMS 엑셀 갱신 결과와 행 수·수량을 비교한다.

## 3. 데이터

### 3.1 물류 요청에 파스토 연결 칸 (`logistics_requests`)

| 칸 | 형식 | 설명 |
|---|---|---|
| `fassto_slip_no` | text, 유일(값이 있을 때) | FMS 출고요청번호. 영문·숫자·`-_` 1~40자 |
| `fassto_status_code` | text | ORDER·WORKING·DONE·CANCEL·SHORTAGE 중 하나 또는 null (2장 숫자 코드 변환) |
| `fassto_synced_at` | timestamptz | 이 요청을 동기화가 마지막으로 본 시각 |

세 칸은 동기화 함수만 쓴다. 회사 구성원의 update에서 이 값을 바꾸려 하면 트리거가 옛 값으로 되돌린다(`fassto_order_no`와 같은 방식). 기존 `fassto_order_no`(`LG날짜_순번`)는 그대로 둔다. 파스토에서 들어온 요청도 등록 때 `LG…`를 받는다.

### 3.2 기사 정보 `logistics_request_drivers` (요청당 0~1행)

| 칸 | 설명 |
|---|---|
| `request_id` | 요청(기본키, 요청 삭제 시 같이 삭제) |
| `driver_name_text` | 기사 이름(0~40자) |
| `driver_phone_text` | 기사 연락처(0~40자) |
| `vehicle_no_text` | 차량번호(0~20자) |
| `updated_at`, `updated_by_text` | 트리거가 채움 |

읽기는 받는 곳 표(`logistics_request_recipients`)와 같다: 요청자 본인과 활성 물류 담당자. 쓰기는 활성 물류 담당자만 하고, 취소된 요청에는 쓸 수 없다(출고완료 뒤 고치는 것은 된다). 슬랙 알림에는 실리지 않는다. 출고완료 처리에서 차량번호를 넣으면 화면이 결과 칸에 `차량 <차량번호>`를 넣는다(기사 이름·연락처는 결과 칸에 넣지 않는다).

### 3.3 동기화 상태 `logistics_fassto_sync` 확장

지금 표에 칸 두 개를 더한다.
- `kind_code` text: `stock`(재고 갱신, 기본값) 또는 `delivery`(출고 동기화).
- `error_text` text(0~300자): 실패한 실행의 오류 요약. 성공이면 빈 문자열.

출고 동기화는 실행마다 한 행(`source_text='fassto-api'`, `kind_code='delivery'`, `row_count`=처리한 출고 건 수, `note_text`="새 N · 수정 N · 취소 N · 송장 N")을 남긴다. 실패는 `logistics_fassto_report_error`가 `error_text`를 채운 행으로 남긴다. 화면은 종류별 최신 행을 읽는다. 90일 지난 행은 동기화 함수가 지운다.

### 3.4 전용 열쇠 `approval_private.logistics_fassto_keys`

| 칸 | 설명 |
|---|---|
| `key_hash` | 열쇠의 sha256 hex(기본키) |
| `label_text` | 예: `사무실 PC` |
| `is_active` | 끄면 바로 거부 |

열쇠 원문은 DB와 저장소에 두지 않는다. 사용자가 PC 설정 파일에 원문을, SQL 편집기에서 해시를 넣는다(6장). 표는 `approval_private` 스키마라 anon·authenticated가 읽지 못한다.

### 3.5 동기화 설정 `approval_private.logistics_fassto_settings` (한 행, `id=1`)

| 칸 | 설명 |
|---|---|
| `default_requester_email` | 파스토 등록자를 명단에서 못 찾을 때 쓸 요청자. 회사 메일 형식 검사 |

설치 때 사용자가 SQL 편집기에서 넣는다(6장). 행이 없으면 ingest가 `LOGISTICS_FASSTO_SETTINGS` 오류를 낸다.

### 3.6 행위자 표시

동기화 함수는 로그인 없이(anon) 불리므로 기존 트리거가 이미 "시스템"(`auth.uid()`가 null) 경로로 처리한다: 권한 검사는 건너뛰고 상태 전이 규칙은 지킨다. 그래서 기존 트리거는 고치지 않는다.
- 요청의 `updated_by_text`와 변경 이력 행위자: `system`(기존 동작).
- 동기화가 남기는 댓글: `author_email`에 `fassto-sync`를 넣는다. 댓글 트리거가 `coalesce(current_email(), author_email, 'system')`이라 그대로 남는다.
- 화면은 `fassto-sync`를 `파스토 동기화`, `system`을 `시스템`으로 보인다.

## 4. 동기화 함수

### 4.1 `public.logistics_fassto_ingest(p_key text, p_stock jsonb, p_deliveries jsonb) returns jsonb`

- security definer, `search_path=''`. anon에게만 execute를 준다(사무실 PC는 로그인 없이 공개 키로 부른다). authenticated·public은 막는다.
- 맨 먼저 `sha256(p_key)`가 활성 열쇠인지 본다. 아니면 `LOGISTICS_FASSTO_KEY` 오류. 이 검사 전에는 아무것도 읽거나 쓰지 않는다.
- 한 트랜잭션이다. 중간에 실패하면 아무것도 바뀌지 않는다.
- `p_stock`이 null이면 재고는 건드리지 않는다. 배열이면 지난 재고 행 수의 절반 미만일 때 재고를 바꾸지 않고 결과에 경고를 넣는다(첫 갱신은 검사하지 않음). 통과하면 기존 `approval_private.logistics_replace_fassto_stock(rows,'fassto-api')`를 부른다. 그 함수의 `auth.uid() is not null` 검사는 anon 호출에서 통과한다(uid가 null).
- `p_deliveries`는 출고 건 배열(4.2 형식). 건마다 4.3 규칙을 적용한다.
- 돌려주는 값: `{stock_rows, stock_warning, created, updated, canceled, invoices, skipped}`.
- 행위자는 3.6과 같다(요청·이력은 `system`, 댓글은 `fassto-sync`).

### 4.2 출고 건 형식 (동기화 프로그램이 만든다)

```json
{
  "slip_no": "OO...", "order_no": "...", "order_date": "2026-11-30",
  "out_div": "car" | "parcel", "shop_name": "...", "status_code": "ORDER",
  "remark": "...", "invoice_no": "", "parcel_name": "", "registered_by": "이름",
  "qty_total": 120,
  "items": [{"product_code": "...", "product_name": "...", "expires_on": "2028-05-27", "qty": 120}]
}
```

`items`가 없으면(상세를 이번에 조회하지 않은 건) 품목은 건드리지 않는다.

### 4.3 건별 규칙

찾는 순서:
1. `fassto_slip_no = slip_no`인 요청 → 그 요청.
2. 없고 `order_no`가 `LG날짜_순번` 형식이며 `fassto_order_no = order_no`이고 `fassto_slip_no`가 비어 있는 요청 → 그 요청에 `fassto_slip_no`를 연결.
3. 둘 다 없고 상태가 CANCEL이 아니면 → 새 요청. CANCEL인데 요청이 없으면 건너뛴다.

새 요청 값:
- `type_code='b2b'`, `team_code='global'`
- `title_text` = `출고처 · 주문번호` (80자에서 자름)
- `counterparty_text` = 출고처(비면 `파스토 출고`)
- `want_date` = 요청일자
- `ship_mode_code` = 차량 `direct`, 택배 `parcel`
- `qty_summary_text` = `품목 N종 · 총 M개`
- `note_text` = `[파스토 <slip_no>] ` + 비고(1000자에서 자름)
- `requester_email` = `logistics_people.display_name`이 `registered_by`와 같은 사람의 이메일. 없으면 동기화 설정의 기본 요청자(3.5 `approval_private.logistics_fassto_settings`)
- 품목은 `logistics_request_items`에 넣는다(최대 50줄, 넘으면 50줄까지만 넣고 `note_text`에 "품목 N줄 중 50줄만 표시"를 붙인다)
- 새 요청 insert라 기존 트리거가 이력·슬랙 "새 요청" 알림을 만든다.

이미 있는 요청 갱신(물류 담당자 작업을 덮어쓰지 않는다):

| 파스토 변화 | 처리 |
|---|---|
| 품목·수량이 다름 | 요청이 `requested`·`accepted`면 품목과 `qty_summary_text`를 바꾼다. 그 밖의 상태면 바꾸지 않고 댓글 "파스토에서 품목이 바뀌었어요: …"를 한 번 남긴다(같은 내용 댓글이 이미 있으면 다시 안 남김) |
| 상태 CANCEL | 요청이 `shipped`·`canceled`가 아니면 `canceled`로 바꾸고 `status_note_text`="파스토에서 출고요청 취소". 출고완료된 요청이면 댓글만 남긴다 |
| 택배 송장번호가 생김 | `result_text`가 비어 있으면 `<택배사> <송장번호>`로 채운다. 상태는 바꾸지 않는다 |
| 그 밖 | `fassto_status_code`, `fassto_synced_at`만 갱신 |

요청 상태가 `canceled`인 건은 파스토에서 다시 살아나도 되살리지 않는다(댓글만).

### 4.4 `public.logistics_fassto_report_error(p_key text, p_error text) returns void`

열쇠 검사 후 `logistics_fassto_sync`에 `kind_code='delivery'`, `row_count=0`, `error_text`(300자에서 자름) 행을 넣는다. anon만 실행.

### 4.5 기존 표 트리거

기존 트리거는 고치지 않는다(3.6). 새로 더하는 트리거는 하나다: `logistics_requests`에 before insert/update 트리거를 두어, `auth.uid()`가 있는 호출(회사 구성원)이면 insert 때 파스토 연결 세 칸을 비우고 update 때 옛 값으로 되돌린다.

## 5. 동기화 프로그램 (`tools/fassto-sync.cjs`)

- Node 24 내장 기능만 쓴다(`fetch`, `crypto`, `fs`). 새 패키지 없음.
- 순수 변환은 `tools/fassto-sync-core.cjs`로 나눈다: 재고 행 변환, 출고 건 변환, 쇼핑몰 택배 거르기, 바뀐 건 고르기, 토큰 만료 판단. 테스트는 이 파일을 직접 부른다.

### 5.1 설정 파일 (저장소 밖)

`%LOCALAPPDATA%\entropy-fassto-sync\config.json`

```json
{
  "fassto": {"baseUrl": "https://fmsapi.fassto.ai", "apiCd": "", "apiKey": "", "cstCd": "", "whCd": ""},
  "supabase": {"url": "", "anonKey": "", "syncKey": ""},
  "parcelSalesChannelEmptyOnly": true,
  "lookbackDays": 14, "lookaheadDays": 14
}
```

- 처음 실행 때 파일이 없으면 빈 양식을 만들고 끝낸다. 값은 사용자가 직접 넣는다.
- 파일 권한은 `icacls`로 현재 사용자만 읽게 잠근다(안내 명령 제공).
- 같은 폴더에 `token.json`(토큰·만료), `state.json`(출고 건별 마지막 `updTime`), `logs/`(날짜별 로그, 30일 보관), `sync.lock`을 둔다.

### 5.2 한 번 실행

1. `sync.lock`이 있고 15분 안에 만든 것이면 끝낸다. 오래된 잠금은 지우고 진행한다.
2. 토큰: `token.json`이 만료 5분 전보다 이르면 재사용, 아니면 `connect`. 요청 중 토큰 오류가 나면 한 번만 다시 받는다.
3. 재고 조회 → 행 변환(`product_code`=cstGodCd, `barcode`=godBarcd, `product_name`=godNm, `kind_text`=giftDiv 이름, `lot_text`='', `expires_on`=distTermDt, `available_qty`=canStockQty).
4. 출고 목록 조회: 오늘(KST) − lookbackDays ~ 오늘 + lookaheadDays, outDiv 2와 1을 각각.
5. 택배 중 `salChanel`이 비어 있지 않은 건은 버린다(쇼핑몰 연동 주문). 설정으로 끌 수 있다.
6. `state.json`에 없거나 `updTime`이 바뀐 건만 상세 조회. 상세 조회가 실패한 건은 `items` 없이 넘기고 `state.json`을 갱신하지 않아 다음 실행에서 다시 조회한다.
7. `logistics_fassto_ingest` 한 번 호출. 성공하면 `state.json` 갱신, 결과 한 줄을 로그에 남긴다.
8. `--dry-run`: 6번까지 하고 DB 대신 "새로 만들 건 / 고칠 건 / 걸러낸 쇼핑몰 택배 수"를 화면에 출력한다. DB의 현재 연결 상태를 알 수 없으므로 "새로 만들 건"은 `state.json`에 없는 건 기준이다.

### 5.3 실패 처리

| 상황 | 처리 |
|---|---|
| `INVALID_ACCESS`(IP 다름) | 로그만 남기고 끝낸다. 대시보드에 오류를 남기지 않는다 |
| 파스토 그 밖의 오류, 네트워크 오류 | `logistics_fassto_report_error` 호출 후 끝낸다 |
| ingest 오류 | 로그 + report_error. `state.json`은 그대로라 다음 실행에서 다시 보낸다 |
| 재고 행 수 급감 | ingest가 재고만 건너뛰고 경고를 돌려준다. 로그에 남긴다 |

### 5.4 실행 일정

작업 스케줄러: 평일 08:00~19:00, 10분마다, 현재 사용자 로그온 시에만, 놓친 실행은 다음 기회에 한 번만. 등록 명령(`schtasks` 또는 PowerShell `Register-ScheduledTask`)은 문서로 제공하고 사용자가 실행한다.

## 6. 설치 순서 (운영, 단계마다 사용자 승인)

1. 운영 DB에 `sql/logistics-fassto-api.sql` 적용. 머지(=GitHub Pages 배포) 전에 한다.
2. SQL 편집기에서 사용자가 열쇠 해시와 기본 요청자를 넣는다.

   ```sql
   insert into approval_private.logistics_fassto_settings(id,default_requester_email) values (1,'name@entropymakeup.com')
    on conflict (id) do update set default_requester_email=excluded.default_requester_email;
   ```

   열쇠 해시 넣는 문장은 `node tools/fassto-sync.cjs --new-key`가 해시를 채워 만들어 준다(원문을 SQL에 넣지 않는다).
3. 사용자가 설정 파일에 파스토 키·열쇠 원문을 넣는다.
4. `--dry-run`으로 실제 데이터를 보고, 쇼핑몰 택배 거르기·작업상태 코드·재고 행 수를 확인한다.
5. 한 번 실제 실행 → 대시보드에 요청이 생기는지 확인.
6. 사용자가 작업 스케줄러 등록.
7. 화면 파일 배포(머지). `index.html`·`logistics.html` 버전 쿼리를 함께 올린다.
8. 며칠 정상이면 브라우저 재고 갱신 예약 작업(`tools/fassto-sync-routine.txt`)을 끈다.

## 7. 화면

### 7.1 목록

- `fassto_slip_no`가 있는 요청은 제목 옆에 `파스토` 표시와 파스토 작업상태 이름을 작게 붙인다.
- 위 안내 줄: 재고 최신 행과 출고 동기화 최신 행을 읽어 `파스토 동기화: HH:MM 정상 · 재고 N종`. 최신 출고 동기화 행에 `error_text`가 있으면 `파스토 동기화 오류(HH:MM): …`를 빨간 글씨로. 출고 동기화 행이 하나도 없으면 지금처럼 재고 기준 문구.

### 7.2 상세

- 파스토 칸(`renderFasstoSection`)에 출고요청번호, 작업상태, 마지막 확인 시각을 더한다.
- 패킹리스트 상태(대기·완료)는 지금도 `type_code='b2b'` 요청에 보인다(`needsOverseas`가 b2b를 포함). 바꾸지 않는다.
- 출고완료 처리 폼: 운송이 `direct`면 기사 이름·연락처·차량번호 칸을 보이고, 저장 때 `logistics_request_drivers`를 upsert한 뒤 결과 칸이 비어 있으면 `차량 <차량번호>`를 넣는다. 차량번호가 없으면 결과 칸을 직접 적어야 한다(지금 규칙 유지).
- 운송이 `parcel`이고 결과 칸이 채워져 있으면 출고완료 폼에 그 값을 미리 넣고 출고일 기본값을 오늘(KST)로 한다.
- 기사 정보는 볼 권한이 있는 사람에게 상세의 필드 목록에 보인다.

### 7.3 바꾸지 않는 것

상태 흐름, 보류·취소, 댓글, 슬랙 알림, "+ 새 요청", 파스토 양식 내려받기.

## 8. 테스트

- DB(PGlite, `tests/logistics-fassto-api-db.test.cjs`): 열쇠 거부·비활성 열쇠, 새 요청 생성(요청자 매핑·기본 요청자), `LG` 주문번호 연결, 같은 출고 두 번 보내도 한 건, 품목 변경(요청·접수 상태만), 준비중 이후 댓글, CANCEL 처리, 송장 채우기(결과 칸 비었을 때만), 재고 급감 경고, 회사 구성원이 동기화 칸을 못 바꿈, 기사 정보 RLS, anon이 다른 표·함수를 못 씀.
- 변환(`tests/fassto-sync-core.test.cjs`): 재고 변환, 출고 변환, 쇼핑몰 택배 거르기, 바뀐 건 고르기, 토큰 만료 판단, KST 날짜 범위.
- 화면(`tests/logistics-ui.test.cjs` 확장): 파스토 표시, 동기화 상태 줄(정상·오류·없음), 기사 정보 칸, 택배 송장 미리 채우기(동기화가 채운 결과 칸이 출고완료 폼에 들어감), 행위자 이름 표시.
- 모든 테스트 데이터는 예시값이다. 저장소는 공개라 실제 응답·키·연락처를 넣지 않는다(`repo-guard` 검사).

## 9. 문서

`LOGISTICS.md`에 "파스토 API 동기화" 절을 더하고(설치·설정 파일·작업 스케줄러·문제 해결), "파스토 목록 갱신(브라우저)" 절은 API 정상 확인 뒤 예비 절차로 표시한다.
