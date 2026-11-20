# 물류 요청 파스토 양식 자동 생성 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 물류 요청에서 요청자가 받는 곳과 품목(파스토 상품 목록에서 고름)을 칸으로 입력하면, 요청 상세에서 운송 방식에 맞는 파스토 FMS 업로드 양식(해외택배신청·택배신청·차량배송신청(상품)) 엑셀을 바로 내려받게 한다. 파스토 상품 목록은 Claude가 FMS에서 받아 DB 함수 하나로 통째로 바꾼다.

**Architecture:** 새 SQL 파일 `sql/logistics-fassto.sql`이 상품 목록·갱신 기록·받는 곳·품목 표와 주문번호 트리거, 권한 트리거, RLS를 더한다(기존 3개 SQL 다음에 설치, 다시 실행해도 안전). 순수 UMD 모듈 `fassto-forms.js`가 양식 상수(원본 1~4행), 검사, 행 만들기, SheetJS 워크북 만들기, 상품 목록 묶기·검색·경고를 맡는다. `logistics.js`는 데이터 계층(`createApi`)에 목록·받는 곳·품목 읽기/쓰기를 더하고, 새 요청·요약 수정 창에 받는 곳·품목 칸, 상세에 받는 곳·품목·내려받기, 탭 위에 목록 갱신 시각을 그린다. FMS 엑셀 → JSON/SQL 변환은 `tools/fassto-stock-json.cjs`가 한다.

**Tech Stack:** 바닐라 JS(UMD), supabase-js v2(CDN), SheetJS 0.18.5(브라우저는 이미 CDN으로 로드, 테스트는 devDependency `xlsx@0.18.5`), Postgres(PL/pgSQL, RLS), `node --test`, `@electric-sql/pglite` 0.5.8

**Spec:** `docs/superpowers/specs/2026-11-20-logistics-fassto-forms-design.md`

## Global Constraints

스펙 원문(그대로 옮김):

- 받는 곳·품목은 요청자가 요청할 때 입력한다.
- 운송 방식으로 양식을 정한다: 택배 → 택배신청, 해외특송 → 해외택배신청, 직납·Air·Ocean → 차량배송신청(상품), 퀵·기타 → 양식 없음.
- 품목은 파스토 상품 목록에서 고른다.
- 품목은 DB에 저장하고, 엑셀은 내려받을 때 브라우저에서 만든다.
- 받는 곳 정보는 요청자와 물류 담당자만 본다.
- 범위 밖: 파스토로 직접 출고 접수(업로드 자동화), 파스토 API 연동 자체, 페이지 안의 엑셀 업로드 기능.
- 파스토 안내대로 1~4행을 그대로 두고 5행부터 데이터를 넣는다.
- 생성기가 만드는 1~3행이 원본과 같은지 테스트한다(4행 예시도 원본 그대로 복사).
- 같은 요청의 모든 줄은 같은 주문번호를 쓴다(택배·해외는 주문번호·받는 분·주소가 같으면 합포장).
- 갱신할 때 전체를 지우고 새로 넣는다(한 트랜잭션).
- 쓰기: 서버 함수 `approval_private.logistics_replace_fassto_stock(rows jsonb, source text)`만. 이 함수는 SQL 편집기·Claude(서비스 역할)에서만 실행하고 anon·authenticated에는 실행 권한을 주지 않는다.
- RLS: 요청자 본인 또는 활성 담당자만 읽기·쓰기. 요청이 닫히면(shipped·canceled) 요청자는 못 고친다. 운송사·Incoterms는 담당자만 바꾼다(트리거로 검사).
- 한 요청당 최대 50줄.
- RLS: 읽기는 회사 구성원(품목은 개인정보가 아님). 쓰기는 요약 수정 규칙과 같다: 요청자는 requested 상태에서만, 담당자는 shipped·canceled 전까지.
- `logistics_requests.fassto_order_no text` — 요청 생성 때 트리거가 `LG날짜_순번`(예 `LG20261120_003`, KST 날짜, 그날 순번)으로 채운다. 문자 `- _`만 쓴다. 양식 종류는 저장하지 않고 운송 방식에서 계산한다.
- 로그인이 풀려 있으면 아무것도 바꾸지 않고 사용자에게 알린다(비밀번호는 입력하지 않는다).
- 출고 가능 수량(로트 지정 시 그 로트, 아니면 합계)보다 많으면 노란 경고만 한다.
- 파스토 목록 갱신 시각을 보여주고, 2일 넘게 지났으면 "재고 정보가 오래됐어요"를 표시한다.
- 저장 순서: 요청 → 받는 곳 → 품목. 받는 곳이나 품목 저장이 실패하면 "요청은 올라갔고 품목은 저장하지 못했어요. 상세에서 다시 입력해 주세요"라고 알린다(지금 첨부 실패 처리와 같은 방식).
- 누르면 필수 칸 검사 → 통과하면 `파스토_<양식>_<주문번호>.xlsx` 저장. 실패하면 빠진 칸 목록을 창 안에 보여주고 내려받지 않는다.
- 받는 곳·품목 수정은 요약 수정과 같은 권한·상태 규칙.
- 대시보드에 이미 있는 SheetJS 0.18.5(`XLSX`)를 쓴다. 새 라이브러리 없음.
- 상품코드는 항상 문자로 저장·출력(앞자리 0 유지).
- 주문번호·이름의 금지 문자는 내려받기 전에 검사한다(택배 받는 분: `( ) , - _` 외 특수문자 금지, 주문번호: `- _`만).
- 목록에 없는 상품코드(목록 갱신 후 사라진 상품)가 품목에 있으면 상세와 내려받기 검사에서 "파스토 목록에 없는 상품" 경고(막지는 않음).
- 받는 곳 표는 읽기 권한이 없으면 빈 결과가 오므로, 화면은 "볼 수 없음"과 "입력 안 됨"을 구분해 표시한다(요청자·담당자 여부로 판단).

저장소 규칙:

- 화면 문구는 모두 한국어로 쓰고, 화면에 넣는 문자열은 모두 `esc()`로 이스케이프한다.
- `logistics.js`의 기존 동작(목록·KPI·탭·상태 변경·결과 수정·첨부·댓글·슬랙 링크로 열기·STALE 처리·로그아웃 정리)은 그대로 둔다. 기존 `tests/logistics-*.test.cjs`는 Task마다 계속 통과해야 한다.
- 상태 모델과 권한은 `sql/logistics.sql`을 따른다: 요청자는 `requested`에서만 고치고, 담당자는 `shipped`·`canceled` 전까지 고친다. `auth.uid()`가 없으면 시스템(SQL 편집기·예약 작업)으로 보고 권한 검사를 건너뛴다.
- RLS는 기존 `approval_private.is_company_member()`, `approval_private.current_email()`, `approval_private.logistics_is_handler()`만 재사용한다. 새 SECURITY DEFINER 함수는 모두 `set search_path=''`이고 실행 권한을 명시한다. `logistics_replace_fassto_stock`은 anon·authenticated가 실행할 수 없다.
- 브라우저에 새 라이브러리를 넣지 않는다. `xlsx@0.18.5`는 테스트와 `tools/` 변환기용 devDependency로만 쓴다(CDN과 같은 버전).
- 실제 명단·주소·토큰·FMS 파일은 저장소에 넣지 않는다. 테스트와 미리보기의 이름·주소는 모두 가짜다.
- 이 worktree에는 git 사용자 설정이 없다. 커밋은 `GIT_AUTHOR_NAME=sylee GIT_AUTHOR_EMAIL=sylee@entropymakeup.com GIT_COMMITTER_NAME=sylee GIT_COMMITTER_EMAIL=sylee@entropymakeup.com git commit ...`로 하고 메시지 끝에 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`을 붙인다. git 설정은 바꾸지 않는다.
- 운영 DB 적용, FMS 첫 갱신, 배포, 예약 작업 등록은 이 계획의 Task에서 하지 않는다(맨 끝 "Production install", 사용자 승인 필요).

## 설계 결정 (스펙 해석)

- 품목 저장은 `public.logistics_replace_items(p_request uuid, p_items jsonb)`(SECURITY INVOKER) 한 번으로 통째로 바꾼다. 호출자 권한으로 돌아 RLS와 품목 트리거가 그대로 적용되고, 지우기·넣기가 한 트랜잭션이다.
- 받는 곳·품목 수정은 별도 버튼 없이 기존 "요약 수정" 창에 칸을 더해 같은 권한·상태 규칙을 쓴다. 운송사·Incoterms·발송인 칸은 담당자에게만 보이고, 요청자 저장은 그 칸을 보내지 않는다.
- 주문번호는 트리거가 `pg_advisory_xact_lock` 안에서 그날 최대 순번 + 1로 정한다(3자리, 999를 넘으면 자리 수가 늘어남). 설치 때 기존 요청은 등록 KST 날짜별 등록순으로 채운다(시스템만 빈 주문번호를 채울 수 있음).
- 파스토 목록 교체 함수는 빈 배열과 문자가 아닌 상품코드를 거절하고(잘못된 내보내기로 목록이 지워지거나 앞자리 0이 사라지는 것을 막음), `auth.uid()`가 있는 호출도 거절한다.
- 운송사·Incoterms와 함께 발송인 덮어쓰기 칸(`sender_*`)도 담당자만 바꾼다(스펙 §2 "담당자는 요청별로 바꿀 수 있다", §5.2). 같은 트리거 오류 `LOGISTICS_HANDLER_ONLY`를 쓴다.
- "파스토 양식 내려받기" 버튼은 받는 곳을 볼 수 있는 요청자와 활성 담당자에게만 보인다(차량배송도 같은 규칙).
- 택배 금지 문자 검사는 받는 분과 함께 기본주소·상세주소에도 한다(파스토 원본 3행 안내가 세 칸 모두 `( ) , - _` 외 특수문자 금지).
- 해외: 단가는 0보다 커야 하고, 무게를 비우면 1, 발송인 우편번호(E)·판매처(X)·기사 요청사항(Y)은 비운다. 택배: 보내는 분(K·L)은 담당자가 발송인 덮어쓰기를 넣었을 때만 채운다. 유통기한은 로트를 고른 줄에만 넣는다(DB 트리거도 로트가 없으면 유통기한을 비운다).
- 파스토 목록 "2일 넘게"는 마지막 `synced_at`에서 48시간 초과로 본다. 목록을 못 불러와도 물류 탭은 열고 목록 줄에 오류를 보인다.
- FMS '상품별재고현황'의 실제 열(2026-11-19 내려받은 파일로 확인): `No., 고객사명, 상품코드, 상품바코드, 상품명, 상품구분, 상품 취급온도, 출고금지일, 경과일, 유통기한, 제조일자, LOT번호, 출고 가능 수량, 출고 신청 수량, 출고 지시 수량, …, 총재고`. 상품마다 "상품명 - N 건" 제목 줄과 "소계" 줄이 끼어 있고, 맨 끝에 합계 줄이 있다(모두 상품코드 칸이 비거나 '소계'라 건너뜀). 상품코드는 `02553620331724`처럼 0으로 시작하는 값이 있다. 변환기는 별칭 표(`ALIASES`)로 열을 찾고, 필수 열이 없으면 찾은 제목을 보여 주고 멈춘다(파스토가 양식을 바꿀 때 대비). 첫 실제 갱신 때 상품코드 앞자리 0이 유지되는지 확인한다.

## File Structure

| 파일 | 역할 |
|---|---|
| `sql/logistics-fassto.sql` (새로) | `logistics_fassto_stock`, `logistics_fassto_sync`, `logistics_request_recipients`, `logistics_request_items`, `logistics_requests.fassto_order_no` + 주문번호 트리거·기존 요청 채우기, `approval_private.logistics_replace_fassto_stock`, 받는 곳·품목 권한 트리거, `public.logistics_replace_items`, RLS·권한. 기존 SQL 3개 다음에 설치, 다시 실행해도 안전 |
| `fassto-forms.js` (새로) | 순수 UMD(`FasstoForms`): `FORMS`(원본 1~4행 상수), `SENDER`, `formFor`, `formHint`, `validate`, `buildRows`, `toWorkbook`, `fileName`, 상품 목록 `groupStock`·`searchStock`·`qtyWarning`·`stockWarnings`·`stockAge`, 저장 변환 `toRecipientRow`·`toItemRows`·`checkInput` |
| `tools/fassto-stock-json.cjs` (새로) | FMS 엑셀 → 로트별 JSON 또는 교체 함수 호출 SQL |
| `tools/fassto-sync-routine.txt` (새로) | 평일 08:30 예약 작업 지시문 |
| `logistics-model.js` (수정) | 새 오류 코드 문구 3개 |
| `logistics.js` (수정) | `createApi`: `loadStock`·`loadRecipient`·`loadItems`·`saveRecipient`·`saveItems`. 렌더: `renderStockBanner`·`renderStockResults`·`renderItems`·`renderFasstoFields`·`renderFasstoSection`, `renderForm`·`renderDetail`에 연결. `mountTab`: 목록 불러오기, 창 안 품목 검색·추가·수량 경고, 저장 순서, 내려받기 |
| `logistics.css` (수정) | 파스토 칸·품목 표·노란 경고 |
| `index.html` (수정) | `fassto-forms.js` 스크립트와 물류 파일 버전 쿼리 `20261120-fassto-1` (app.js는 바꾸지 않으므로 `tests/asset-cache.test.cjs` 해시는 그대로) |
| `package.json`, `package-lock.json` (수정) | devDependency `xlsx@0.18.5`, `check`에 두 파일 추가 |
| `tests/logistics-fassto-db.test.cjs` (새로) | PGlite: 주문번호, 목록 교체 권한·전체 교체, 받는 곳 RLS·담당자 칸, 품목 권한·상태 |
| `tests/fassto-forms.test.cjs` (새로) | 원본 3종과 1~4행·열 수·시트 이름 비교, 5행 값, 검사, 목록 계산 |
| `tests/fassto-stock-json.test.cjs` (새로) | 변환기 |
| `tests/logistics-model.test.cjs`, `tests/logistics-ui.test.cjs` (수정) | 오류 문구, 가짜 client에 `upsert`·`range`·`rpc`, 데이터 계층·렌더·mountTab·대시보드 연결·문서 |
| `LOGISTICS.md`, `DEVELOPMENT.md` (수정) | 설치 순서, 파스토 양식 동작, FMS 목록 갱신 절차 |

---

### Task 1: 파스토 표·주문번호·권한 (`sql/logistics-fassto.sql`)

**Files:**
- Create: `sql/logistics-fassto.sql`
- Test: `tests/logistics-fassto-db.test.cjs`

**Interfaces:**
- Produces (DB):
  - 표 `public.logistics_fassto_stock(id, product_code text, barcode text, product_name text, kind_text text, lot_text text, expires_on date, available_qty integer)` — 회사 구성원 읽기만
  - 표 `public.logistics_fassto_sync(id, synced_at timestamptz, source_text 'fms-browser'|'fassto-api', row_count integer, note_text text)` — 회사 구성원 읽기만
  - 함수 `approval_private.logistics_replace_fassto_stock(rows jsonb, source text) → integer`(넣은 행 수). 오류: `LOGISTICS_FORBIDDEN`, `LOGISTICS_STOCK_BAD_SOURCE`, `LOGISTICS_STOCK_EMPTY`, `LOGISTICS_STOCK_CODE_NOT_TEXT`
  - 열 `public.logistics_requests.fassto_order_no text`(트리거 `logistics_requests_order_no`, 함수 `approval_private.logistics_next_order_no(date)`)
  - 표 `public.logistics_request_recipients(request_id uuid pk, name_text, phone_text, postal_text, country_code, state_text, city_text, district_text, address1_text, address2_text, email_text, tax_id_text, courier_text, incoterms_code ''|'DAP'|'DDU'|'DDP', currency_code ''|'USD'|'JPY'|'EUR', sender_name_text, sender_phone_text, sender_address_text, sender_email_text, updated_at, updated_by_text)` — 모든 글자 칸은 `not null default ''`
  - 표 `public.logistics_request_items(id, request_id, line_no 1~50, product_code text, product_name_text, qty integer ≥1, lot_text, expires_on date, en_name_text, weight_kg numeric, unit_price numeric, hs_code_text, created_at, unique(request_id,line_no))`
  - 함수 `public.logistics_replace_items(p_request uuid, p_items jsonb) → integer`(authenticated 실행 가능). 오류: `LOGISTICS_ITEM_BAD`, `LOGISTICS_ITEM_LIMIT`, `LOGISTICS_FORBIDDEN`, `LOGISTICS_CLOSED`
  - 받는 곳 트리거 오류 `LOGISTICS_HANDLER_ONLY`(운송사·Incoterms·발송인 칸을 담당자 아닌 사람이 바꿀 때)

- [ ] **Step 1: Write the failing test**

`tests/logistics-fassto-db.test.cjs`:

```js
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const {PGlite}=require('@electric-sql/pglite');
const read=f=>fs.readFileSync(path.join(__dirname,'../sql',f),'utf8');
const id=n=>'00000000-0000-0000-0000-'+String(n).padStart(12,'0');

async function setup({before}={}){
 const db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create schema auth;create schema approval_private;
 create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz);
 create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz);
 create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create function auth.jwt() returns jsonb language sql security definer as $$select jsonb_build_object('session_id',current_setting('request.jwt.claim.session_id',true),'email',(select email from auth.users where id=nullif(current_setting('request.jwt.claim.sub',true),'')::uuid))$$;
 grant usage on schema public,auth,approval_private to anon,authenticated;
 insert into auth.users values ('${id(1)}','req@entropymakeup.com',now(),null),('${id(2)}','outsider@example.com',now(),null),('${id(3)}','handler@entropymakeup.com',now(),null),('${id(4)}','other@entropymakeup.com',now(),null),('${id(5)}','old@entropymakeup.com',now(),null);
 insert into auth.sessions select id,id,null from auth.users;
 create table public.invoices(id uuid primary key default gen_random_uuid(),no text);grant select on public.invoices to authenticated;`);
 await db.exec(read('team-tasks.sql')); // is_company_member(), current_email()
 await db.exec(read('logistics.sql'));
 await db.exec(`insert into logistics_handlers(email,display_name) values ('handler@entropymakeup.com','가짜 담당');
  insert into logistics_handlers(email,display_name,is_active) values ('old@entropymakeup.com','전 담당',false)`);
 if(before)await before(db);
 const sql=read('logistics-fassto.sql');await db.exec(sql);await db.exec(sql); // 다시 실행해도 안전
 const login=async n=>{await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.session_id',$1,false)",[id(n)]);await db.exec('set role authenticated');};
 const asSystem=async()=>{await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub','',false)");};
 const create=async(o={})=>(await db.query(`insert into logistics_requests(type_code,title_text,team_code,counterparty_text,ship_mode_code,fassto_order_no)
  values ('sample',$1,'global','가짜 바이어',$2,$3) returning *`,[o.title||'샘플',o.mode||'parcel',o.order_no||null])).rows[0];
 const kstDay=async()=>(await db.query(`select to_char((now() at time zone 'UTC')+interval '9 hours','YYYYMMDD') d`)).rows[0].d;
 return {db,login,asSystem,create,kstDay};
}

test('주문번호: 등록할 때 LG+KST날짜_순번으로 채우고, 클라이언트 값과 수정은 무시한다',async()=>{
 const {db,login,create,kstDay}=await setup();
 try{
  const day=await kstDay();
  await login(1);
  const a=await create({order_no:'HACK'});
  const b=await create();
  assert.equal(a.fassto_order_no,`LG${day}_001`);
  assert.equal(b.fassto_order_no,`LG${day}_002`);
  await db.query(`update logistics_requests set fassto_order_no='X_1',title_text='고침' where id=$1`,[a.id]);
  assert.equal((await db.query('select fassto_order_no from logistics_requests where id=$1',[a.id])).rows[0].fassto_order_no,`LG${day}_001`);
 }finally{await db.close();}
});

test('주문번호: 설치 전 요청은 설치할 때 등록 KST 날짜별 순번으로 채운다',async()=>{
 const {db}=await setup({before:async db=>{
  await db.exec(`insert into logistics_requests(type_code,title_text,team_code,counterparty_text,ship_mode_code,requester_email) values
   ('sample','첫째','global','c','parcel','req@entropymakeup.com'),('sample','둘째','global','c','parcel','req@entropymakeup.com'),('sample','셋째','global','c','parcel','req@entropymakeup.com')`);
  await db.exec(`alter table logistics_requests disable trigger user; -- created_at은 트리거가 지키므로 잠시 끄고 과거 시각을 넣는다
   update logistics_requests set created_at='2026-11-19T14:30:00Z' where title_text='첫째';
   update logistics_requests set created_at='2026-11-19T15:30:00Z' where title_text='둘째';
   update logistics_requests set created_at='2026-11-19T16:00:00Z' where title_text='셋째';
   alter table logistics_requests enable trigger user;`);
 }});
 try{
  const rows=(await db.query('select title_text,fassto_order_no from logistics_requests order by created_at')).rows;
  assert.deepEqual(rows.map(r=>r.fassto_order_no),['LG20261119_001','LG20261120_001','LG20261120_002']); // 15:00Z = KST 자정
 }finally{await db.close();}
});

test('파스토 목록 교체: anon·authenticated는 실행 못 하고, 시스템은 전체를 바꾸며 상품코드는 문자만 받는다',async()=>{
 const {db,login,asSystem}=await setup();
 try{
  const rows=JSON.stringify([{product_code:'0012345',barcode:'8800000000001',product_name:'가짜 립',kind_text:'본품',lot_text:'L1',expires_on:'2028-01-31',available_qty:120},
   {product_code:'0012345',barcode:'8800000000001',product_name:'가짜 립',kind_text:'본품',lot_text:'L2',expires_on:'2028-06-30',available_qty:30},
   {product_code:'A-9',barcode:'',product_name:'가짜 쇼핑백',kind_text:'부자재',lot_text:'',expires_on:'',available_qty:'5'}]);
  await db.exec('set role anon');
  await assert.rejects(()=>db.query(`select approval_private.logistics_replace_fassto_stock($1::jsonb,'fms-browser')`,[rows]),/permission denied/);
  await login(3);
  await assert.rejects(()=>db.query(`select approval_private.logistics_replace_fassto_stock($1::jsonb,'fms-browser')`,[rows]),/permission denied/);
  await assert.rejects(()=>db.query(`insert into logistics_fassto_stock(product_code) values ('x')`),/permission denied/);
  await asSystem();
  await db.query(`insert into logistics_fassto_stock(product_code,product_name) values ('OLD','지워질 상품')`);
  assert.equal((await db.query(`select approval_private.logistics_replace_fassto_stock($1::jsonb,'fms-browser') n`,[rows])).rows[0].n,3);
  const s=(await db.query('select product_code,lot_text,expires_on::text e,available_qty from logistics_fassto_stock order by product_code,lot_text')).rows;
  assert.deepEqual(s.map(r=>[r.product_code,r.lot_text,r.e,r.available_qty]),[['0012345','L1','2028-01-31',120],['0012345','L2','2028-06-30',30],['A-9','',null,5]]);
  const sync=(await db.query('select source_text,row_count from logistics_fassto_sync')).rows;
  assert.deepEqual(sync.map(r=>[r.source_text,r.row_count]),[['fms-browser',3]]);
  await assert.rejects(()=>db.query(`select approval_private.logistics_replace_fassto_stock('[{"product_code":12345}]'::jsonb,'fms-browser')`),/LOGISTICS_STOCK_CODE_NOT_TEXT/);
  await assert.rejects(()=>db.query(`select approval_private.logistics_replace_fassto_stock('[]'::jsonb,'fms-browser')`),/LOGISTICS_STOCK_EMPTY/);
  await assert.rejects(()=>db.query(`select approval_private.logistics_replace_fassto_stock($1::jsonb,'manual')`,[rows]),/LOGISTICS_STOCK_BAD_SOURCE/);
  assert.equal((await db.query('select count(*)::int n from logistics_fassto_stock')).rows[0].n,3); // 실패하면 그대로
  await login(4);
  assert.equal((await db.query('select * from logistics_fassto_stock')).rows.length,3);
  assert.equal((await db.query('select * from logistics_fassto_sync')).rows.length,1);
  await login(2);
  assert.equal((await db.query('select * from logistics_fassto_stock')).rows.length,0);
 }finally{await db.close();}
});

test('받는 곳: 요청자와 활성 담당자만 읽고 쓰며, 다른 직원에게는 0행이다',async()=>{
 const {db,login,create}=await setup();
 try{
  await login(1);const r=await create();
  await db.query(`insert into logistics_request_recipients(request_id,name_text,phone_text,address1_text) values ($1,' 홍길동 ','010-0000-0000','가짜시 가짜로 1')`,[r.id]);
  const mine=(await db.query('select name_text,updated_by_text from logistics_request_recipients')).rows;
  assert.deepEqual([mine[0].name_text,mine[0].updated_by_text],['홍길동','req@entropymakeup.com']);
  await login(4);
  assert.equal((await db.query('select * from logistics_request_recipients')).rows.length,0);
  await assert.rejects(()=>db.query(`insert into logistics_request_recipients(request_id,name_text) values ($1,'x')`,[r.id]),/LOGISTICS_FORBIDDEN|row-level security/);
  assert.equal((await db.query(`update logistics_request_recipients set name_text='남' returning *`)).rows.length,0);
  await login(5); // 비활성 담당자
  assert.equal((await db.query('select * from logistics_request_recipients')).rows.length,0);
  await login(3);
  assert.equal((await db.query('select * from logistics_request_recipients')).rows.length,1);
  await login(2);
  assert.equal((await db.query('select * from logistics_request_recipients')).rows.length,0);
 }finally{await db.close();}
});

test('받는 곳: 운송사·Incoterms·발송인은 담당자만, 요청자는 requested에서만, 담당자는 닫히기 전까지',async()=>{
 const {db,login,create}=await setup();
 try{
  await login(1);const r=await create({mode:'express'});
  await assert.rejects(()=>db.query(`insert into logistics_request_recipients(request_id,name_text,courier_text) values ($1,'A','FEDEX')`,[r.id]),/LOGISTICS_HANDLER_ONLY/);
  await db.query(`insert into logistics_request_recipients(request_id,name_text,country_code) values ($1,'A','ch')`,[r.id]);
  assert.equal((await db.query('select country_code from logistics_request_recipients')).rows[0].country_code,'CH');
  await assert.rejects(()=>db.query(`update logistics_request_recipients set incoterms_code='DAP' where request_id=$1`,[r.id]),/LOGISTICS_HANDLER_ONLY/);
  await login(3);
  await db.query(`update logistics_request_recipients set courier_text='FEDEX',incoterms_code='DAP',sender_email_text='s@entropymakeup.com' where request_id=$1`,[r.id]);
  await db.query(`update logistics_requests set status_code='accepted' where id=$1`,[r.id]);
  await login(1);
  await assert.rejects(()=>db.query(`update logistics_request_recipients set name_text='B' where request_id=$1`,[r.id]),/LOGISTICS_FORBIDDEN/);
  // 요청자 upsert(담당자 칸을 보내지 않음)는 requested일 때 담당자 값을 지우지 않는다
  const r2=await create({mode:'express',title:'둘째'});
  await db.query(`insert into logistics_request_recipients(request_id,name_text) values ($1,'A')`,[r2.id]);
  await login(3);
  await db.query(`update logistics_request_recipients set courier_text='FEDEX' where request_id=$1`,[r2.id]);
  await login(1);
  await db.query(`insert into logistics_request_recipients(request_id,name_text) values ($1,'B') on conflict (request_id) do update set name_text=excluded.name_text`,[r2.id]);
  assert.deepEqual(Object.values((await db.query('select name_text,courier_text from logistics_request_recipients where request_id=$1',[r2.id])).rows[0]),['B','FEDEX']);
  await login(3);
  await db.query(`update logistics_requests set status_code='shipped',result_text='송장 1',shipped_on='2026-11-21' where id=$1`,[r.id]);
  await assert.rejects(()=>db.query(`update logistics_request_recipients set courier_text='DHL' where request_id=$1`,[r.id]),/LOGISTICS_CLOSED/);
 }finally{await db.close();}
});

test('품목: 회사 구성원은 읽고, 요청자는 requested에서만·담당자는 닫히기 전까지 통째로 바꾼다',async()=>{
 const {db,login,create}=await setup();
 try{
  await login(1);const r=await create();
  const items=JSON.stringify([{product_code:'0012345',product_name_text:'가짜 립',qty:3,lot_text:'L1',expires_on:'2028-01-31'},{product_code:'A-9',qty:1,lot_text:'',expires_on:'2028-01-01'}]);
  assert.equal((await db.query(`select public.logistics_replace_items($1,$2::jsonb) n`,[r.id,items])).rows[0].n,2);
  const got=(await db.query('select line_no,product_code,qty,expires_on::text e from logistics_request_items order by line_no')).rows;
  assert.deepEqual(got.map(x=>[x.line_no,x.product_code,x.qty,x.e]),[[1,'0012345',3,'2028-01-31'],[2,'A-9',1,null]]);
  await assert.rejects(()=>db.query(`select public.logistics_replace_items($1,'[{"product_code":12345,"qty":1}]'::jsonb)`,[r.id]),/LOGISTICS_ITEM_BAD/);
  await assert.rejects(()=>db.query(`select public.logistics_replace_items($1,'[{"product_code":"X","qty":0}]'::jsonb)`,[r.id]),/check constraint/);
  const many=JSON.stringify(Array.from({length:51},()=>({product_code:'X',qty:1})));
  await assert.rejects(()=>db.query(`select public.logistics_replace_items($1,$2::jsonb)`,[r.id,many]),/LOGISTICS_ITEM_LIMIT/);
  assert.equal((await db.query('select count(*)::int n from logistics_request_items')).rows[0].n,2); // 실패하면 그대로
  await login(4);
  assert.equal((await db.query('select * from logistics_request_items')).rows.length,2);
  await assert.rejects(()=>db.query(`select public.logistics_replace_items($1,'[]'::jsonb)`,[r.id]),/LOGISTICS_FORBIDDEN/);
  await assert.rejects(()=>db.query(`delete from logistics_request_items`),/LOGISTICS_FORBIDDEN/);
  await login(3);
  await db.query(`update logistics_requests set status_code='accepted' where id=$1`,[r.id]);
  await login(1);
  await assert.rejects(()=>db.query(`select public.logistics_replace_items($1,'[{"product_code":"X","qty":1}]'::jsonb)`,[r.id]),/LOGISTICS_FORBIDDEN/);
  await login(3);
  assert.equal((await db.query(`select public.logistics_replace_items($1,'[{"product_code":"X","qty":5}]'::jsonb) n`,[r.id])).rows[0].n,1);
  await db.query(`update logistics_requests set status_code='canceled' where id=$1`,[r.id]);
  await assert.rejects(()=>db.query(`select public.logistics_replace_items($1,'[]'::jsonb)`,[r.id]),/LOGISTICS_CLOSED/);
  await login(2);
  assert.equal((await db.query('select * from logistics_request_items')).rows.length,0);
  await db.exec('set role anon');
  await assert.rejects(()=>db.query(`select public.logistics_replace_items($1,'[]'::jsonb)`,[r.id]),/permission denied/);
 }finally{await db.close();}
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test tests/logistics-fassto-db.test.cjs
```
Expected: FAIL — `ENOENT: no such file or directory ... sql/logistics-fassto.sql`

- [ ] **Step 3: Write the implementation**

`sql/logistics-fassto.sql`:

```sql
-- 물류 요청 파스토 양식(설계: docs/superpowers/specs/2026-11-20-logistics-fassto-forms-design.md).
-- sql/logistics.sql → logistics-storage.sql → logistics-slack.sql 다음에 설치한다. 다시 실행해도 안전하다.
begin;

-- 1) 파스토 상품 목록(로트별 행)과 갱신 기록. 쓰기는 logistics_replace_fassto_stock만 한다.
create table if not exists public.logistics_fassto_stock (
 id bigint generated always as identity primary key,
 product_code text not null check (length(btrim(product_code)) between 1 and 60),
 barcode text not null default '' check (length(barcode) <= 60),
 product_name text not null default '' check (length(product_name) <= 200),
 kind_text text not null default '' check (length(kind_text) <= 40),
 lot_text text not null default '' check (length(lot_text) <= 60),
 expires_on date,
 available_qty integer not null default 0
);
create index if not exists logistics_fassto_stock_code_idx on public.logistics_fassto_stock(product_code);

create table if not exists public.logistics_fassto_sync (
 id bigint generated always as identity primary key,
 synced_at timestamptz not null default now(),
 source_text text not null check (source_text in ('fms-browser','fassto-api')),
 row_count integer not null check (row_count >= 0),
 note_text text not null default '' check (length(note_text) <= 300)
);
create index if not exists logistics_fassto_sync_at_idx on public.logistics_fassto_sync(synced_at desc);

-- 전체를 지우고 새로 넣는다(한 트랜잭션). SQL 편집기·서비스 역할만 실행한다. 상품코드는 JSON 문자열만 받는다(앞자리 0 유지).
create or replace function approval_private.logistics_replace_fassto_stock(rows jsonb, source text) returns integer
language plpgsql security definer set search_path='' as $$
declare p_rows jsonb := $1; p_source text := $2; n integer;
begin
 if (select auth.uid()) is not null then raise exception 'LOGISTICS_FORBIDDEN'; end if;
 if p_source is null or p_source not in ('fms-browser','fassto-api') then raise exception 'LOGISTICS_STOCK_BAD_SOURCE'; end if;
 if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then raise exception 'LOGISTICS_STOCK_EMPTY'; end if;
 if exists(select 1 from jsonb_array_elements(p_rows) e(v) where jsonb_typeof(e.v->'product_code') is distinct from 'string') then
  raise exception 'LOGISTICS_STOCK_CODE_NOT_TEXT';
 end if;
 delete from public.logistics_fassto_stock where true;
 insert into public.logistics_fassto_stock(product_code,barcode,product_name,kind_text,lot_text,expires_on,available_qty)
 select btrim(e.v->>'product_code'), btrim(coalesce(e.v->>'barcode','')), btrim(coalesce(e.v->>'product_name','')), btrim(coalesce(e.v->>'kind_text','')),
  btrim(coalesce(e.v->>'lot_text','')), nullif(btrim(coalesce(e.v->>'expires_on','')),'')::date, coalesce(nullif(btrim(coalesce(e.v->>'available_qty','')),'')::numeric::integer,0)
 from jsonb_array_elements(p_rows) e(v);
 get diagnostics n = row_count;
 insert into public.logistics_fassto_sync(source_text,row_count) values (p_source,n);
 return n;
end $$;

-- 2) 파스토 주문번호: LG + KST 날짜 + _ + 그날 순번(3자리 이상). 클라이언트 값은 무시하고, 한 번 정하면 바꾸지 않는다.
alter table public.logistics_requests add column if not exists fassto_order_no text;
alter table public.logistics_requests drop constraint if exists logistics_requests_fassto_order_no_check;
alter table public.logistics_requests add constraint logistics_requests_fassto_order_no_check
 check (fassto_order_no is null or fassto_order_no ~ '^[A-Za-z0-9_-]{1,40}$');
create unique index if not exists logistics_requests_fassto_order_no_idx on public.logistics_requests(fassto_order_no) where fassto_order_no is not null;

create or replace function approval_private.logistics_next_order_no(p_day date) returns text
language plpgsql security definer set search_path='' as $$
declare v_prefix text := 'LG'||to_char(p_day,'YYYYMMDD'); v_n integer;
begin
 perform pg_advisory_xact_lock(72430011);
 select coalesce(max(split_part(fassto_order_no,'_',2)::integer),0)+1 into v_n
  from public.logistics_requests where fassto_order_no ~ ('^'||v_prefix||'_[0-9]+$');
 return v_prefix||'_'||lpad(v_n::text,greatest(3,length(v_n::text)),'0');
end $$;

create or replace function approval_private.logistics_requests_order_no() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if tg_op = 'INSERT' then
  new.fassto_order_no := approval_private.logistics_next_order_no(((now() at time zone 'UTC') + interval '9 hours')::date);
 elsif old.fassto_order_no is not null or (select auth.uid()) is not null then
  new.fassto_order_no := old.fassto_order_no; -- 시스템만 설치 전 요청을 한 번 채울 수 있다
 end if;
 return new;
end $$;
drop trigger if exists logistics_requests_order_no on public.logistics_requests;
create trigger logistics_requests_order_no before insert or update on public.logistics_requests for each row execute function approval_private.logistics_requests_order_no();

-- 설치 전 요청 채우기(등록 KST 날짜별 등록순)
with n as (
 select id, 'LG'||to_char((created_at at time zone 'UTC') + interval '9 hours','YYYYMMDD')||'_'||
  lpad(rn::text,greatest(3,length(rn::text)),'0') as no
 from (select id, created_at, row_number() over (partition by ((created_at at time zone 'UTC') + interval '9 hours')::date order by created_at, id) as rn
       from public.logistics_requests where fassto_order_no is null) s)
update public.logistics_requests r set fassto_order_no = n.no from n where r.id = n.id;

-- 3) 받는 곳(요청당 0~1행). 요청자 본인과 활성 담당자만 읽고 쓴다.
create table if not exists public.logistics_request_recipients (
 request_id uuid primary key references public.logistics_requests(id) on delete cascade,
 name_text text not null default '' check (length(name_text) <= 100),
 phone_text text not null default '' check (length(phone_text) <= 40),
 postal_text text not null default '' check (length(postal_text) <= 20),
 country_code text not null default '' check (country_code ~ '^([A-Z]{2})?$'),
 state_text text not null default '' check (length(state_text) <= 100),
 city_text text not null default '' check (length(city_text) <= 100),
 district_text text not null default '' check (length(district_text) <= 100),
 address1_text text not null default '' check (length(address1_text) <= 300),
 address2_text text not null default '' check (length(address2_text) <= 300),
 email_text text not null default '' check (length(email_text) <= 200),
 tax_id_text text not null default '' check (length(tax_id_text) <= 60),
 courier_text text not null default '' check (length(courier_text) <= 60),
 incoterms_code text not null default '' check (incoterms_code in ('','DAP','DDU','DDP')),
 currency_code text not null default '' check (currency_code in ('','USD','JPY','EUR')),
 sender_name_text text not null default '' check (length(sender_name_text) <= 100),
 sender_phone_text text not null default '' check (length(sender_phone_text) <= 40),
 sender_address_text text not null default '' check (length(sender_address_text) <= 300),
 sender_email_text text not null default '' check (length(sender_email_text) <= 200),
 updated_at timestamptz not null default now(),
 updated_by_text text not null default ''
);

create or replace function approval_private.logistics_can_see_recipient(p_request uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select (select approval_private.is_company_member()) and ((select approval_private.logistics_is_handler()) or exists(
  select 1 from public.logistics_requests q where q.id=p_request and q.requester_email=(select approval_private.current_email())));
$$;

-- 요청 쪽 쓰기 규칙: 요청자는 requested에서만, 담당자는 shipped·canceled 전까지. 시스템(auth.uid() 없음)은 건너뛴다.
create or replace function approval_private.logistics_request_write_check(p_request uuid) returns void
language plpgsql security definer set search_path='' as $$
declare st text; req text; actor text := (select approval_private.current_email());
begin
 if (select auth.uid()) is null then return; end if;
 select status_code, requester_email into st, req from public.logistics_requests where id=p_request for update;
 if not found then raise exception 'LOGISTICS_FORBIDDEN'; end if;
 if st in ('shipped','canceled') then raise exception 'LOGISTICS_CLOSED'; end if;
 if not (select approval_private.logistics_is_handler()) and (actor is distinct from req or st <> 'requested') then raise exception 'LOGISTICS_FORBIDDEN'; end if;
end $$;

create or replace function approval_private.logistics_recipients_stamp() returns trigger
language plpgsql security definer set search_path='' as $$
declare is_h boolean := (select approval_private.logistics_is_handler()); is_system boolean := (select auth.uid()) is null;
begin
 if tg_op = 'UPDATE' then new.request_id := old.request_id; end if;
 perform approval_private.logistics_request_write_check(new.request_id);
 new.name_text := btrim(new.name_text); new.phone_text := btrim(new.phone_text); new.postal_text := btrim(new.postal_text);
 new.country_code := upper(btrim(new.country_code)); new.state_text := btrim(new.state_text); new.city_text := btrim(new.city_text);
 new.district_text := btrim(new.district_text); new.address1_text := btrim(new.address1_text); new.address2_text := btrim(new.address2_text);
 new.email_text := btrim(new.email_text); new.tax_id_text := btrim(new.tax_id_text); new.courier_text := btrim(new.courier_text);
 new.sender_name_text := btrim(new.sender_name_text); new.sender_phone_text := btrim(new.sender_phone_text);
 new.sender_address_text := btrim(new.sender_address_text); new.sender_email_text := btrim(new.sender_email_text);
 -- 운송사·Incoterms·발송인은 담당자만 정한다
 if not is_system and not is_h then
  if tg_op = 'INSERT' and (new.courier_text,new.incoterms_code,new.sender_name_text,new.sender_phone_text,new.sender_address_text,new.sender_email_text)
     is distinct from ('','','','','','') then raise exception 'LOGISTICS_HANDLER_ONLY'; end if;
  if tg_op = 'UPDATE' and (new.courier_text,new.incoterms_code,new.sender_name_text,new.sender_phone_text,new.sender_address_text,new.sender_email_text)
     is distinct from (old.courier_text,old.incoterms_code,old.sender_name_text,old.sender_phone_text,old.sender_address_text,old.sender_email_text) then
   raise exception 'LOGISTICS_HANDLER_ONLY';
  end if;
 end if;
 new.updated_at := clock_timestamp();
 new.updated_by_text := coalesce((select approval_private.current_email()), 'system');
 return new;
end $$;
drop trigger if exists logistics_recipients_stamp on public.logistics_request_recipients;
create trigger logistics_recipients_stamp before insert or update on public.logistics_request_recipients for each row execute function approval_private.logistics_recipients_stamp();

-- 4) 품목 줄. 읽기는 회사 구성원, 쓰기는 요약 수정과 같은 규칙. line_no 1~50 + (request_id,line_no) 유일 = 요청당 최대 50줄.
create table if not exists public.logistics_request_items (
 id uuid primary key default gen_random_uuid(),
 request_id uuid not null references public.logistics_requests(id) on delete cascade,
 line_no integer not null check (line_no between 1 and 50),
 product_code text not null check (length(btrim(product_code)) between 1 and 60),
 product_name_text text not null default '' check (length(product_name_text) <= 200),
 qty integer not null check (qty between 1 and 1000000),
 lot_text text not null default '' check (length(lot_text) <= 60),
 expires_on date,
 en_name_text text not null default '' check (length(en_name_text) <= 200),
 weight_kg numeric(10,3) check (weight_kg is null or weight_kg > 0),
 unit_price numeric(14,2) check (unit_price is null or unit_price >= 0),
 hs_code_text text not null default '' check (hs_code_text ~ '^[0-9.]{0,13}$'),
 created_at timestamptz not null default now(),
 unique (request_id, line_no)
);

create or replace function approval_private.logistics_items_guard() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if tg_op = 'DELETE' then
  -- 요청 삭제(on delete cascade)는 시스템만 하므로 그대로 둔다
  perform approval_private.logistics_request_write_check(old.request_id);
  return old;
 end if;
 if tg_op = 'UPDATE' then new.request_id := old.request_id; end if;
 perform approval_private.logistics_request_write_check(new.request_id);
 new.product_code := btrim(new.product_code); new.product_name_text := btrim(new.product_name_text);
 new.lot_text := btrim(new.lot_text); new.en_name_text := btrim(new.en_name_text); new.hs_code_text := btrim(new.hs_code_text);
 if new.lot_text = '' then new.expires_on := null; end if; -- 유통기한은 로트를 지정할 때만
 return new;
end $$;
drop trigger if exists logistics_items_guard on public.logistics_request_items;
create trigger logistics_items_guard before insert or update or delete on public.logistics_request_items for each row execute function approval_private.logistics_items_guard();

-- 품목 전체 바꾸기(한 트랜잭션). 호출자 권한으로 돌아 RLS와 위 트리거가 그대로 적용된다.
create or replace function public.logistics_replace_items(p_request uuid, p_items jsonb) returns integer
language plpgsql security invoker set search_path='' as $$
declare n integer;
begin
 if p_items is null or jsonb_typeof(p_items) <> 'array' then raise exception 'LOGISTICS_ITEM_BAD'; end if;
 if jsonb_array_length(p_items) > 50 then raise exception 'LOGISTICS_ITEM_LIMIT'; end if;
 if exists(select 1 from jsonb_array_elements(p_items) e(v) where jsonb_typeof(e.v->'product_code') is distinct from 'string') then
  raise exception 'LOGISTICS_ITEM_BAD';
 end if;
 perform approval_private.logistics_request_write_check(p_request); -- 빈 목록으로 지울 때도 권한을 본다
 delete from public.logistics_request_items where request_id = p_request;
 insert into public.logistics_request_items(request_id,line_no,product_code,product_name_text,qty,lot_text,expires_on,en_name_text,weight_kg,unit_price,hs_code_text)
 select p_request, e.ord::integer, e.v->>'product_code', coalesce(e.v->>'product_name_text',''), (e.v->>'qty')::integer,
  coalesce(e.v->>'lot_text',''), nullif(coalesce(e.v->>'expires_on',''),'')::date, coalesce(e.v->>'en_name_text',''),
  nullif(coalesce(e.v->>'weight_kg',''),'')::numeric, nullif(coalesce(e.v->>'unit_price',''),'')::numeric, coalesce(e.v->>'hs_code_text','')
 from jsonb_array_elements(p_items) with ordinality e(v, ord);
 get diagnostics n = row_count;
 return n;
end $$;

-- 5) 권한
revoke all on function approval_private.logistics_replace_fassto_stock(jsonb,text) from public,anon,authenticated;
revoke all on function approval_private.logistics_next_order_no(date),approval_private.logistics_requests_order_no(),
 approval_private.logistics_recipients_stamp(),approval_private.logistics_items_guard() from public,anon,authenticated;
revoke all on function approval_private.logistics_request_write_check(uuid) from public,anon;
grant execute on function approval_private.logistics_request_write_check(uuid) to authenticated;
revoke all on function approval_private.logistics_can_see_recipient(uuid) from public,anon;
grant execute on function approval_private.logistics_can_see_recipient(uuid) to authenticated;
revoke all on function public.logistics_replace_items(uuid,jsonb) from public,anon;
grant execute on function public.logistics_replace_items(uuid,jsonb) to authenticated;

alter table public.logistics_fassto_stock enable row level security;
alter table public.logistics_fassto_sync enable row level security;
alter table public.logistics_request_recipients enable row level security;
alter table public.logistics_request_items enable row level security;

revoke all on public.logistics_fassto_stock,public.logistics_fassto_sync,public.logistics_request_recipients,public.logistics_request_items from public,anon,authenticated;
grant select on public.logistics_fassto_stock,public.logistics_fassto_sync to authenticated;
grant select,insert,update on public.logistics_request_recipients to authenticated;
grant select,insert,update,delete on public.logistics_request_items to authenticated;

drop policy if exists logistics_fassto_stock_read on public.logistics_fassto_stock;
create policy logistics_fassto_stock_read on public.logistics_fassto_stock for select to authenticated using ((select approval_private.is_company_member()));
drop policy if exists logistics_fassto_sync_read on public.logistics_fassto_sync;
create policy logistics_fassto_sync_read on public.logistics_fassto_sync for select to authenticated using ((select approval_private.is_company_member()));
drop policy if exists logistics_recipients_read on public.logistics_request_recipients;
create policy logistics_recipients_read on public.logistics_request_recipients for select to authenticated using ((select approval_private.logistics_can_see_recipient(request_id)));
drop policy if exists logistics_recipients_insert on public.logistics_request_recipients;
create policy logistics_recipients_insert on public.logistics_request_recipients for insert to authenticated with check ((select approval_private.logistics_can_see_recipient(request_id)));
drop policy if exists logistics_recipients_update on public.logistics_request_recipients;
create policy logistics_recipients_update on public.logistics_request_recipients for update to authenticated
 using ((select approval_private.logistics_can_see_recipient(request_id))) with check ((select approval_private.logistics_can_see_recipient(request_id)));
drop policy if exists logistics_items_read on public.logistics_request_items;
create policy logistics_items_read on public.logistics_request_items for select to authenticated using ((select approval_private.is_company_member()));
drop policy if exists logistics_items_insert on public.logistics_request_items;
create policy logistics_items_insert on public.logistics_request_items for insert to authenticated with check ((select approval_private.is_company_member()));
drop policy if exists logistics_items_update on public.logistics_request_items;
create policy logistics_items_update on public.logistics_request_items for update to authenticated
 using ((select approval_private.is_company_member())) with check ((select approval_private.is_company_member()));
drop policy if exists logistics_items_delete on public.logistics_request_items;
create policy logistics_items_delete on public.logistics_request_items for delete to authenticated using ((select approval_private.is_company_member()));
commit;
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
node --test tests/logistics-fassto-db.test.cjs tests/logistics-db.test.cjs tests/logistics-slack-db.test.cjs
```
Expected: PASS (새 6개 + 기존 물류 DB 테스트 전부)

- [ ] **Step 5: Commit**

```bash
git add sql/logistics-fassto.sql tests/logistics-fassto-db.test.cjs
GIT_AUTHOR_NAME=sylee GIT_AUTHOR_EMAIL=sylee@entropymakeup.com GIT_COMMITTER_NAME=sylee GIT_COMMITTER_EMAIL=sylee@entropymakeup.com git commit -m "$(cat <<'EOF'
물류 요청: 파스토 목록·받는 곳·품목 표와 주문번호 트리거

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: 파스토 양식 생성기 (`fassto-forms.js`)

**Files:**
- Create: `fassto-forms.js`
- Test: `tests/fassto-forms.test.cjs`
- Modify: `package.json`, `package-lock.json` (devDependency `xlsx@0.18.5`, `check`)

**Interfaces:**
- Consumes: 원본 `tests/fixtures/fassto/*.xlsx`(테스트만)
- Produces (`FasstoForms.*`, Node에서는 `require('../fassto-forms.js')`):
  - 상수 `FORMS` = `{overseas|parcel|vehicle: {label, sheet, head:[4행 배열], text:[문자 셀 열 번호]}}`, `SENDER` = `{name_text, phone_text, address_text, email_text}`, `BRAND`='ENTROPY', `CURRENCIES`, `INCOTERMS`, `TAX_ID_COUNTRIES`, `MAX_ITEMS`=50, `RECIPIENT_KEYS`, `HANDLER_KEYS`, `RECIPIENT_FIELDS`(양식별 `[열, 라벨 HTML, 최대 길이]`), `HANDLER_FIELDS`
  - `formFor(ship_mode_code) → 'overseas'|'parcel'|'vehicle'|null`, `formHint(form) → string`
  - `senderOf(recipient, defaults=SENDER) → {name_text, phone_text, address_text, email_text}`
  - `validate(form, request, recipient, items, defaults=SENDER) → string[]`(빈 배열이면 통과)
  - `buildRows(form, request, recipient, items, defaults=SENDER) → any[][]`(5행부터, 품목 1개 = 1줄)
  - `toWorkbook(form, rows, lib=root.XLSX) → SheetJS workbook`, `fileName(form, request) → '파스토_<양식>_<주문번호>.xlsx'`
  - `groupStock(rows) → [{product_code, product_name, barcode, kind_text, total_qty, lots:[{lot_text, expires_on, available_qty}]}]`, `searchStock(groups, q, limit=20)`, `availableFor(item, groups) → number|null`, `qtyWarning(item, groups) → string`, `stockWarnings(items, groups) → string[]`, `stockAge(sync, groups, nowMs) → {text, stale}`
  - `toRecipientRow(values, {isHandler}) → object`(담당자 칸은 담당자일 때만), `toItemRows(items) → object[]`(RPC `p_items` 모양), `checkInput(form, recipient, items) → string[]`(저장 전 형식 검사)

- [ ] **Step 1: 테스트용 SheetJS 설치**

```bash
npm install --save-dev --save-exact xlsx@0.18.5
```
Expected: `package.json`의 devDependencies에 `"xlsx": "0.18.5"`가 생기고 `package-lock.json`이 바뀐다. npm이 xlsx 0.18.5의 알려진 보안 권고를 보고할 수 있다. 브라우저는 이미 CDN의 같은 버전을 쓰고 있고, 여기서는 테스트·로컬 변환기에서 저장소의 원본 양식과 FMS 내보내기만 읽으므로 그대로 둔다(`npm audit fix --force`는 하지 않는다).

- [ ] **Step 2: Write the failing test**

`tests/fassto-forms.test.cjs`:

```js
const {test}=require('node:test');const assert=require('node:assert/strict');const path=require('node:path');
const XLSX=require('xlsx');
const F=require('../fassto-forms.js');
const FIX={overseas:'파스토제공-해외택배신청_양식.xlsx',parcel:'파스토제공-택배신청_양식.xlsx',vehicle:'파스토제공-차량배송신청(상품)_양식.xlsx'};
const fixture=form=>XLSX.readFile(path.join(__dirname,'fixtures/fassto',FIX[form]));
const grid=wb=>XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{header:1,defval:'',raw:true});
const roundTrip=wb=>XLSX.read(XLSX.write(wb,{type:'buffer',bookType:'xlsx'}),{type:'buffer'});
const req={fassto_order_no:'LG20261120_003'};
const items=[{product_code:'0012345',product_name_text:'가짜 립',qty:3,lot_text:'',expires_on:null,unit_price:12.5,weight_kg:null,en_name_text:'Fake Lip'},
 {product_code:'0099',product_name_text:'가짜 크림',qty:2,lot_text:'L2',expires_on:'2028-06-30',unit_price:7,weight_kg:0.2,en_name_text:''}];
const parcelTo={name_text:'홍길동',phone_text:'010-0000-0000',postal_text:'01234',address1_text:'가짜시 가짜로 1',address2_text:'101동 1호'};
const overseasTo={name_text:'Fake Buyer',phone_text:'+41-00-000-0000',postal_text:'08001',country_code:'CH',state_text:'ZH',city_text:'Zurich',district_text:'',
 address1_text:'Fakestrasse 1',email_text:'buyer@example.com',tax_id_text:'',currency_code:'USD',courier_text:'FEDEX',incoterms_code:'DAP'};

test('운송 방식으로 양식을 정한다',()=>{
 assert.deepEqual(['parcel','express','direct','air','ocean','quick','etc'].map(F.formFor),['parcel','overseas','vehicle','vehicle','vehicle',null,null]);
 assert.equal(F.formHint('parcel'),'파스토 택배신청 양식으로 만들어요.');
 assert.equal(F.formHint(null),'이 운송 방식은 파스토 양식 없이 처리해요.');
});

for(const form of ['overseas','parcel','vehicle']){
 test(`${form}: 1~4행·열 수·시트 이름이 파스토 원본과 같다`,()=>{
  const orig=fixture(form),want=grid(orig).slice(0,4);
  const to=form==='overseas'?overseasTo:form==='parcel'?parcelTo:null;
  const wb=roundTrip(F.toWorkbook(form,F.buildRows(form,req,to,items),XLSX));
  assert.deepEqual(wb.SheetNames,orig.SheetNames);
  assert.equal(F.FORMS[form].sheet,orig.SheetNames[0]);
  const got=grid(wb);
  assert.deepEqual(got.slice(0,4).map(r=>r.map(String)),want.map(r=>r.map(String)));
  assert.equal(F.FORMS[form].head[0].length,want[0].length);
  assert.equal(got[4].length,want[0].length);
  assert.equal(got.length,6); // 1~4행 + 품목 2줄
 });
}

test('5행부터: 상품코드는 앞자리 0을 지킨 문자 셀, 모든 줄이 같은 주문번호',()=>{
 const cell=(wb,ref)=>wb.Sheets[wb.SheetNames[0]][ref];
 const p=roundTrip(F.toWorkbook('parcel',F.buildRows('parcel',req,parcelTo,items),XLSX));
 assert.deepEqual([cell(p,'I5').t,cell(p,'I5').v],['s','0012345']);
 assert.deepEqual([cell(p,'B5').v,cell(p,'B6').v],['LG20261120_003','LG20261120_003']);
 assert.deepEqual([cell(p,'D5').t,cell(p,'D5').v],['s','01234']);
 assert.deepEqual([cell(p,'J5').t,cell(p,'J5').v],['n',3]);
 assert.equal(cell(p,'R5'),undefined); // 로트를 안 고르면 유통기한 비움
 assert.equal(cell(p,'R6').v,'2028-06-30');
 const v=roundTrip(F.toWorkbook('vehicle',F.buildRows('vehicle',req,null,items),XLSX));
 assert.deepEqual([cell(v,'A5').t,cell(v,'A5').v,cell(v,'C5').v,cell(v,'G5').v,cell(v,'G6').v],['s','0012345','LG20261120_003','차량','차량']);
});

test('해외: 열 위치, 무게 기본 1, 브랜드 ENTROPY, 발송인 기본값과 담당자 덮어쓰기',()=>{
 const rows=F.buildRows('overseas',req,overseasTo,items);
 assert.equal(rows[0].length,28);
 const [a]=rows;
 assert.deepEqual([a[0],a[1],a[2],a[3],a[5],a[6]],['CH','FEDEX','LG20261120_003',F.SENDER.name_text,F.SENDER.phone_text,F.SENDER.address_text]);
 assert.deepEqual([a[7],a[9],a[10],a[11],a[13],a[15],a[16],a[17]],['Fake Buyer','08001','ZH','Zurich','Fakestrasse 1',3,'USD','0012345']);
 assert.deepEqual([a[18],a[20],a[21],a[22],a[25],a[26],a[27]],['Fake Lip',1,12.5,'ENTROPY','DAP','sylee@entropymakeup.com','buyer@example.com']);
 assert.equal(rows[1][20],0.2);
 const own=F.buildRows('overseas',req,{...overseasTo,sender_name_text:'Other Sender',sender_email_text:'x@entropymakeup.com'},items)[0];
 assert.deepEqual([own[3],own[26],own[5]],['Other Sender','x@entropymakeup.com',F.SENDER.phone_text]);
 assert.equal(F.fileName('overseas',req),'파스토_해외택배신청_LG20261120_003.xlsx');
 assert.equal(F.fileName('vehicle',req),'파스토_차량배송신청(상품)_LG20261120_003.xlsx');
});

test('검사: 양식별 필수 칸, 금지 문자, 주문번호, FEDEX 이메일',()=>{
 assert.deepEqual(F.validate('parcel',req,parcelTo,items),[]);
 assert.deepEqual(F.validate('vehicle',req,null,items),[]);
 assert.deepEqual(F.validate('overseas',req,overseasTo,items),[]);
 assert.deepEqual(F.validate(null,req,null,items),['이 운송 방식은 파스토 양식이 없어요.']);
 const p=F.validate('parcel',{fassto_order_no:'LG 1'},{...parcelTo,name_text:'홍길동#',phone_text:''},[]);
 assert.ok(p.includes('주문번호에는 영문·숫자와 - _만 쓸 수 있어요.'));
 assert.ok(p.includes('품목을 1줄 이상 넣어 주세요.'));
 assert.ok(p.includes('받는 곳: 전화 칸이 비어 있어요.'));
 assert.ok(p.includes('받는 곳: 받는 분에는 ( ) , - _ 말고 다른 특수문자를 쓸 수 없어요.'));
 assert.deepEqual(F.validate('parcel',req,{...parcelTo,name_text:'홍길동(본사)_1, 2-3'},items),[]);
 assert.ok(F.validate('vehicle',{},null,[{product_code:'',qty:0}]).includes('주문번호가 아직 없어요. 새로고침한 뒤 다시 해 주세요.'));
 assert.ok(F.validate('vehicle',req,null,[{product_code:'',qty:0}]).includes('1번째 품목의 상품코드가 없어요.'));
 assert.ok(F.validate('vehicle',req,null,[{product_code:'A',qty:1.5}]).includes('1번째 품목의 수량을 1 이상으로 적어 주세요.'));
 const o=F.validate('overseas',req,{...overseasTo,email_text:'',courier_text:'FEDEX',country_code:'BR',state_text:''},[{...items[0],unit_price:''}]);
 assert.ok(o.includes('FEDEX는 받는 분 이메일이 필요해요.'));
 assert.ok(o.includes('받는 곳: 신분번호 칸이 비어 있어요.'));
 assert.ok(o.includes('받는 곳: 주(성) 칸이 비어 있어요.'));
 assert.ok(o.includes('1번째 품목의 단가를 적어 주세요.'));
 assert.ok(!F.validate('overseas',req,{...overseasTo,country_code:'CN',state_text:'',city_text:'',tax_id_text:'110000'},items).some(x=>x.includes('주(성)')));
 assert.ok(F.validate('overseas',req,{...overseasTo,courier_text:''},items).includes('운송사가 비어 있어요. 물류 담당자가 요약 수정에서 정해 주세요.'));
 assert.ok(F.validate('overseas',req,{...overseasTo,courier_text:'FEDEX'},items,{...F.SENDER,email_text:''}).includes('FEDEX는 발송인 이메일이 필요해요.'));
 assert.ok(!F.validate('overseas',req,{...overseasTo,courier_text:'DHL',email_text:''},items).some(x=>x.includes('FEDEX')));
});

test('파스토 목록: 상품별로 묶고, 검색·수량 경고·목록에 없는 상품·갱신 시각',()=>{
 const stock=[{product_code:'0012345',barcode:'8800000000001',product_name:'가짜 립',kind_text:'본품',lot_text:'L1',expires_on:'2028-01-31',available_qty:120},
  {product_code:'0012345',barcode:'8800000000001',product_name:'가짜 립',kind_text:'본품',lot_text:'L2',expires_on:'2028-06-30',available_qty:30},
  {product_code:'A-9',barcode:'',product_name:'가짜 쇼핑백',kind_text:'부자재',lot_text:'',expires_on:null,available_qty:5}];
 const g=F.groupStock(stock);
 assert.deepEqual(g.map(x=>[x.product_code,x.total_qty,x.lots.length]),[['0012345',150,2],['A-9',5,0]]);
 assert.deepEqual(F.searchStock(g,'8800').map(x=>x.product_code),['0012345']);
 assert.deepEqual(F.searchStock(g,'쇼핑').map(x=>x.product_code),['A-9']);
 assert.deepEqual(F.searchStock(g,' '),[]);
 assert.equal(F.qtyWarning({product_code:'0012345',qty:151},g),'출고 가능 150개보다 많아요.');
 assert.equal(F.qtyWarning({product_code:'0012345',qty:150},g),'');
 assert.equal(F.qtyWarning({product_code:'0012345',lot_text:'L2',qty:31},g),'출고 가능 30개보다 많아요.');
 assert.equal(F.qtyWarning({product_code:'ZZ',qty:999},g),'');
 assert.deepEqual(F.stockWarnings([{product_code:'0012345'},{product_code:'ZZ'}],g),['2번째 품목(ZZ)은 파스토 목록에 없는 상품이에요.']);
 const now=Date.UTC(2026,10,21,3); // 11/21 12:00 KST
 assert.deepEqual(F.stockAge({synced_at:'2026-11-21T00:05:00Z'},g,now),{text:'파스토 목록: 11/21 09:05 기준 (상품 2종)',stale:false});
 assert.deepEqual(F.stockAge({synced_at:'2026-11-18T00:05:00Z'},g,now),{text:'파스토 목록: 11/18 09:05 기준 (상품 2종) · 재고 정보가 오래됐어요',stale:true});
 assert.equal(F.stockAge(null,[],now).stale,true);
});

test('저장 변환: 받는 곳 담당자 칸은 담당자만, 품목은 숫자·로트 규칙, 저장 전 형식 검사',()=>{
 const vals={name_text:' A ',country_code:'ch',courier_text:'FEDEX',incoterms_code:'DAP'};
 assert.deepEqual(F.toRecipientRow(vals),{name_text:'A',country_code:'CH'});
 assert.deepEqual(F.toRecipientRow(vals,{isHandler:true}),{name_text:'A',country_code:'CH',courier_text:'FEDEX',incoterms_code:'DAP'});
 assert.deepEqual(F.toItemRows([{product_code:'007',product_name_text:'x',qty:'2',lot_text:'',expires_on:'2028-01-01',unit_price:'',weight_kg:'0.5'}]),
  [{product_code:'007',product_name_text:'x',qty:2,lot_text:'',expires_on:null,en_name_text:'',weight_kg:0.5,unit_price:null,hs_code_text:''}]);
 assert.deepEqual(F.checkInput('parcel',{},[{qty:'1'}]),[]);
 assert.deepEqual(F.checkInput('overseas',{country_code:'CHE',currency_code:'KRW'},[{qty:'0',unit_price:'abc',weight_kg:'0'}]),
  ['1번째 품목의 수량을 1 이상의 정수로 적어 주세요.','1번째 품목의 단가는 숫자로 적어 주세요.','1번째 품목의 무게는 0보다 큰 숫자로 적어 주세요.','국가코드는 영문 두 글자로 적어 주세요(예 CH).','화폐는 USD·JPY·EUR 중에서 골라 주세요.']);
 assert.deepEqual(F.checkInput('vehicle',{},Array.from({length:51},()=>({qty:1}))),['품목은 50줄까지 넣을 수 있어요.']);
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
node --test tests/fassto-forms.test.cjs
```
Expected: FAIL — `Cannot find module '../fassto-forms.js'`

- [ ] **Step 4: Write the implementation**

`fassto-forms.js` (`HEAD`는 SheetJS로 원본을 읽은 1~4행 값 그대로다. 해외택배신청 3행은 원본처럼 `\r\n` 줄바꿈이다):

```js
(function(root,factory){const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;else root.FasstoForms=api;})(typeof globalThis!=='undefined'?globalThis:this,function(root){
'use strict';
// 파스토 FMS 업로드 양식 3종(해외택배신청·택배신청·차량배송신청(상품))을 만든다. DOM과 네트워크 없음.
// HEAD는 tests/fixtures/fassto/ 원본 1~4행을 그대로 옮긴 값이다. 원본이 바뀌면 tests/fassto-forms.test.cjs가 알려 준다.
const HEAD={
 overseas:[
  ["배송국가","운송사","주문번호","발송인명","발송인우편번호","발송인전화번호","발송인주소","수취인명","수취인전화번호","수취인우편번호","수취인주소(성)","수취인주소(시)","수취인주소(구)","수취인주소","수취인신분번호","출고 신청 수량","화폐단위코드","상품코드 또는 상품명","해외배송용 상품명","HS CODE","상품무게","상품단위금액","브랜드명","상품판매처","택배기사 요청사항","Incoterms","발송인이메일","수취인이메일"],
  ["조건부 필수","조건부 필수","필수","필수","선택","필수","필수","필수","필수","필수","조건부 필수","조건부 필수","선택","필수","조건부 필수","필수","필수","필수","선택","선택","필수","필수","필수","선택","선택","선택","조건부 필수","조건부 필수"],
  ["▶1~4행을 삭제하지 말고 올려주세요.\r\n▶ 배송하실 국가를 다운로드 받으 신 후 엑셀과 동일한 텍스트로 입력해주세요.\r\n▶ 해외 특송의 경우 필수로 입력해주세요.","▶ 배송하실 운송사를 선택해주세요.\r\n▶ 해외 특송의 경우 필수로 입력해주세요.","▶ 고객님께서 관리하시는 주문 번호 입니다.\r\n동일한 주문에 대해서는 같은 주문번호를, 서로 다른 주문건은 별개의 주문번호를 기재해주세요.\r\n특수문자는 '-', '_' 외 입력이 불가합니다.","▶ 발송인 이름을 입력 해주세요.","▶ 발송인 우편번호를 입력 해주세요.","▶ 발송인 전화번호를 입력 해주세요.","▶ 발송인 주소를 영어로 입력 해주세요","▶ 배송 받게 될 구매 고객명을 기재해주세요.\r\n▶ 영문입력 \r\n(FEDEX 는 영문 입력 필수 / 이코노미 는 일본,중국 자국어 입력)","▶ 배송 받게 될 구매고객 전화번호를 개재해주세요.","▶ 배송 가게 될 배송지의 우편번호를 기재해주세요.","▶ 배송 가게 될 배송지의 (성)을 영문으로 정확하게 기재해주세요.\r\n▶ 중국 외 국가는 반드시 (성)을 입력해주세요.\r\n▶ 영문입력 \r\n(FEDEX 는 영문 입력 필수 / 이코노미 는 일본,중국 자국어 입력)","▶ 배송 가게 될 배송지의 (성)을 영문으로 정확하게 기재해주세요.\r\n▶ 중국 외 국가는 반드시 (시)을 입력해주세요.\r\n▶ 영문입력 \r\n(FEDEX 는 영문 입력 필수 / 이코노미 는 일본,중국 자국어 입력)","▶ 배송 가게 될 배송지 주소를 영문으로 정확하게 기재해주세요.\r\n▶ 중국 외 국가는 반드시 성,시,구를 입력해주세요.\r\n▶ 영문입력 \r\n(FEDEX 는 영문 입력 필수 / 이코노미 는 일본,중국 자국어 입력)","▶ 배송 가게 될 배송지 주소를 영문으로 정확하게 기재해주세요.\r\n▶ [성/시/구] 중 입력하신 정보를 제외한 세부주소만 기재해주시고, 중국 주소 중 [성/시/구]를 입력하지 않으셨다면 [성/시/구]를 포함한 전체 주소를 기재해주세요.\r\n▶ 영문입력 \r\n(FEDEX 는 영문 입력 필수 / 이코노미 는 일본,중국 자국어 입력)","▶ 수취인 신분번호를 기재해주세요.\r\n▶ 배송지가 중국인 경우 필수 입력입니다. (신분증 번호)\r\n▶ 배송지가 브라질/멕시코/칠레인 경우 세금식별번호(Tax ID) 필수 입력입니다.\r\n   멕시코 RFC 또는 CURP / 브라질 CPF 또는 CNPJ / 칠레 RUT (브라질·칠레는 구분자 포함 가능, 멕시코는 구분자 없이 입력)","▶ 배송할 상품의 수량입니다.\r\n입력한 수량 만큼의 재고가 파스토 센터에 보관되어 있어야 합니다.","▶ 화폐 단위를 입력해주세요. \r\n(USD/JPY/EUR 외 입력 불가)","▶ 파스토 센터에 입고 되어 있는 상품코드를 입력해주세요.","▶ 해외 송장에 출력될 상품명을 영문으로 입력해주세요.\r\n▶ 미입력시, 상품 정보에 입력해주신 해외송장용 상품명이 입력됩니다.","▶ 상품의 HSCODE를 입력해주세요.\r\n▶ 미입력시, 상품 정보에 입력해주신 HSCODE가 입력됩니다.","▶ 상품의 중량을 입력해주세요. 모르실 경우 1로 입력하셔도 무방합니다.","▶ 상품의 금액을 입력해주세요\r\n(Q 열에 있는 화폐 단위에 맞는 금액 입력)","▶ 판매상품의 브랜드명을 영문/숫자/특수문자(.,/:[]{}<>()!@#$%^&*-_) 만 입력할 수 있습니다.","▶ 판매 상품의 URL 정보를 입력해 주세요.","▶ 배송기사에게 전달할 메모를 입력해주세요.","▶ 무역거래조건으로 DAP,DDU(수취인이 세금납부)와 DDP(발송인이 세금납부) 중에서만 입력가능합니다. \r\n\r\n▶일본 및 미국의 경우 DDP 조건만 가능하며, 그외의 국가는 DAP 발송이 가능합니다.\r\nDDP 조건의 경우 국가 와 운송사 별로 수수료가(관부가세 대납 수수료) 발생될 수 있습니다","▶ 발송인 이메일 주소를 입력해주세요.\r\n▶ 운송사 FEDEX는 필수 입력입니다. (2026-11-21 접수분부터, 미입력 시 FedEx 발송 접수 제한)\r\n▶ 그 외 운송사는 선택 입력입니다.","▶ 수취인(구매고객) 이메일 주소를 입력해주세요.\r\n▶ 운송사 FEDEX는 필수 입력입니다. (2026-11-21 접수분부터, 미입력 시 FedEx 발송 접수 제한)\r\n▶ 그 외 운송사는 선택 입력입니다."],
  ["JP","FEDEX","A1234","FASSTO","8770213","+81-347-4411-9297","36, Guryong-gil, Mapo-gu, Seoul, Republic of Korea","Wilfred Daniel PhD","+81-779-3965-1910","8770212","大分県","日田市","前津江町","大分県日田市前津江町大野 2-1-7-309","A0102345","2","JPY","F1","A001","3926102000","0.1","0.1","FASSTO","http://www.smartstore.com/fassto","Please be careful","DDP","sender@example.com","customer@example.com"]],
 parcel:[
  ["판매채널","주문번호","주문자","우편번호","기본주소","상세주소","주문자 전화번호","주문자 전화번호(기타)","상품코드 또는 상품명","출고 신청 수량","보내는 분","보내는 분 연락처","택배기사 요청사항","송장번호","구분","상세 일련번호","클레임 번호","유통기한","현관문비밀번호"],
  ["선택","필수","필수","선택","필수","조건부 필수","필수","선택","필수","필수","선택","선택","선택","선택","선택","선택","선택","조건부 필수","조건부 필수"],
  ["▶1~4행을 삭제하지 말고 올려주세요.\n▶상품을 판매하고 있는 쇼핑몰을 입력해 주세요.","▶쇼핑몰 주문번호입니다.\n▶주문번호, 고객명, 고객주소가 같은 행은 1개의 주문으로 \n합쳐져 등록되며, 합포장 배송됩니다.\n▶주문번호는 재사용할 수 없습니다.","▶상품을 받는 분 이름입니다.\n▶( ) , - _ 이외의 특수문자는 이용할 수 없습니다.","▶배송지의 우편번호 입니다.","▶상품을 받는 분 주소입니다.\n▶도로명 주소로 입력해 주세요. 구 주소(지번 주소)도 등록할 수 있지만,\n간혹 송장이 출력되지 않을 수 있어 권장하지 않습니다.\n▶( ) , - _ 이외의 특수문자는 이용할 수 없습니다.","▶상품을 받는 분의 상세주소 입니다.\n▶상세주소를 입력해주세요. 동/호수와 같은 정보를 추가입력해주세요.\n▶( ) , - _ 이외의 특수문자는 이용할 수 없습니다.\n▶정확한 배송을 위해 새벽배송 시 필수 항목입니다.\n▶상세주소를 정확히 입력해주세요.","▶상품을 받는 분 전화번호입니다.","▶상품을 받는 분 전화번호입니다.","▶받는 분 주소로 배송할 상품입니다. \n▶상품코드 또는 상품명 중 1가지만 입력해 주세요.\n▶파스토 센터에 입고되어 있는 상품이어야 합니다.\n▶상품코드로 입력하시는 것을 권장합니다. \n상품명으로 입력하실 경우, 띄어쓰기에 유의해 주세요. \nFMS에 등록한 상품명과 완벽하게 일치해야 합니다.","▶배송할 상품의 수량입니다.\n▶입력한 수량만큼의 재고가 \n파스토 센터에 보관되어 있어야 합니다.","▶상품을 보내는 분 이름입니다.\n▶보내는 분 미입력 시 \n송장에 고객님의 상호명이 표시되어 배송됩니다.","▶상품을 보내는 분 전화번호입니다.","▶요청 메시지는 택배기사에게 전달됩니다. \n▶받는 분의 개인정보 보호를 위해 송장에는 표시되지 않습니다.","▶외부 시스템과 연동하신 경우 입력하는 항목입니다.","▶외부 시스템과 연동하신 경우 입력하는 항목입니다.","▶외부 시스템과 연동하신 경우 입력하는 항목입니다.","▶외부 시스템과 연동하신 경우 입력하는 항목입니다.","▶'유통기한 지정'하여 출고하시는 경우, \n상품의 유통기한을 입력해 주세요.","▶새벽배송시 필수 항목 입니. 현관문 비밀번호를 입력해주세요. 최대 50자"],
  ["예시) 스마트스토어, 11번가, 인터파크, \nGS shop, 롯데닷컴, 하프클럽, ESM지마켓, \n롯데홈쇼핑, 현대홈쇼핑, 신세계몰, \nCJ Oshopping, SSG.com, 쿠팡","20200421","홍길동","56874","서울특별시 관악구 국회단지12길 23 (봉천동) ","단독주택 1층","010-1234-5678, \n01012345678","02-912-1234","북유럽 침구 세트(퀸size),\nA00001","1","홍길동, \n주식회사 지지스튜디오","010-1234-5678, \n01012345678","문 앞에 놓아 주세요.","","","","","2020-04-21,\n20200421","현관문 비밀번호"]],
 vehicle:[
  ["상품코드 또는 상품명","출고 신청 수량","주문번호","유통기한","공급가","판매가","배송구분"],
  ["필수","필수","필수","조건부 필수","선택","선택","필수"],
  ["▶1~4행을 삭제하지 말고 올려주세요.\n▶받는 분 주소로 배송할 상품입니다. \n▶상품코드 또는 상품명 중 1가지만 입력해 주세요.\n▶파스토 센터에 입고되어 있는 상품이어야 합니다.\n▶상품코드로 입력하시는 것을 권장합니다. \n상품명으로 입력하실 경우, 띄어쓰기에 유의해 주세요. \nFMS에 등록한 상품명과 완벽하게 일치해야 합니다.","▶배송할 상품의 수량입니다.\n▶입력한 수량만큼의 재고가 \n파스토 센터에 보관되어 있어야 합니다.","▶고객님께서 관리하시는 주문번호입니다.","▶'유통기한 지정'하여 출고하시는 경우, \n상품의 유통기한을 입력해 주세요.","공급가격을 입력해주세요.","판매가격을 입력해주세요.","▶배송구분을 입력해주세요. (기업, 차량)"],
  ["북유럽 침구 세트(퀸size),\nA00001","500","20200421","2020-04-21,\n20200421","","","차량"]]
};
const FORMS={
 overseas:{label:'해외택배신청',sheet:'파스토제공-해외택배신청',head:HEAD.overseas,text:[2,4,5,8,9,14,17,19]},
 parcel:{label:'택배신청',sheet:'파스토제공-택배신청',head:HEAD.parcel,text:[1,3,6,7,8,11]},
 vehicle:{label:'차량배송신청(상품)',sheet:'파스토제공-차량배송신청(상품)',head:HEAD.vehicle,text:[0,2]}
};
// 발송인 기본값(해외). 사용자 확인 전까지 Seoul Alpes 건에 쓴 전화·이메일. 담당자가 요청별로 덮어쓸 수 있다.
const SENDER={name_text:'ENTROPY (Brand Genome Co., Ltd.)',address_text:'4F, 94 Dokseodang-ro, Yongsan-gu, Seoul, Republic of Korea',phone_text:'+82-10-4089-9090',email_text:'sylee@entropymakeup.com'};
const BRAND='ENTROPY';
const MODE_FORM={parcel:'parcel',express:'overseas',direct:'vehicle',air:'vehicle',ocean:'vehicle'};
const TAX_ID_COUNTRIES=['CN','BR','MX','CL'];
const CURRENCIES=['USD','JPY','EUR'];
const INCOTERMS=['DAP','DDU','DDP'];
const MAX_ITEMS=50;
const DAY=86400000,KST=9*3600000,STALE_MS=2*DAY;
const RECIPIENT_KEYS=['name_text','phone_text','postal_text','country_code','state_text','city_text','district_text','address1_text','address2_text','email_text','tax_id_text','currency_code'];
const HANDLER_KEYS=['courier_text','incoterms_code','sender_name_text','sender_phone_text','sender_address_text','sender_email_text'];
// 받는 곳 입력 칸 [열 이름, 라벨 HTML, 최대 길이]. 화폐(currency_code)와 Incoterms는 고르는 칸이라 화면에서 따로 그린다.
const RECIPIENT_FIELDS={
 parcel:[['name_text','받는 분',100],['phone_text','전화',40],['postal_text','우편번호 <small>선택</small>',20],['address1_text','기본주소 <small>도로명</small>',300],['address2_text','상세주소',300]],
 overseas:[['name_text','받는 분 <small>영문</small>',100],['phone_text','전화',40],['email_text','이메일 <small>FEDEX면 필수</small>',200],['country_code','국가코드 <small>예 CH</small>',2],
  ['state_text','주(성) <small>영문</small>',100],['city_text','시 <small>영문</small>',100],['district_text','구 <small>선택</small>',100],['address1_text','상세주소 <small>영문</small>',300],
  ['postal_text','우편번호',20],['tax_id_text','신분번호 <small>중국·브라질·멕시코·칠레만</small>',60]],
 vehicle:[]
};
const HANDLER_FIELDS=[['courier_text','운송사 <small>예 FEDEX</small>',60],['sender_name_text','발송인 이름 <small>비우면 기본값</small>',100],['sender_phone_text','발송인 전화 <small>비우면 기본값</small>',40],
 ['sender_address_text','발송인 주소 <small>영문 · 비우면 기본값</small>',300],['sender_email_text','발송인 이메일 <small>비우면 기본값</small>',200]];
const BAD_PARCEL=/[^\p{L}\p{N}\s(),\-_]/u;

const s=v=>String(v??'').trim();
const blank=v=>v==null||String(v).trim()==='';
const formFor=mode=>MODE_FORM[mode]||null;
const formHint=form=>FORMS[form]?`파스토 ${FORMS[form].label} 양식으로 만들어요.`:'이 운송 방식은 파스토 양식 없이 처리해요.';
const senderOf=(r,d=SENDER)=>({name_text:s(r?.sender_name_text)||d.name_text,phone_text:s(r?.sender_phone_text)||d.phone_text,address_text:s(r?.sender_address_text)||d.address_text,email_text:s(r?.sender_email_text)||d.email_text});

// 내려받기 전 필수 칸 검사. 빠진 칸을 한국어 문장 배열로 돌려준다(빈 배열이면 통과).
function validate(form,request,recipient,items,defaults=SENDER){
 if(!FORMS[form])return ['이 운송 방식은 파스토 양식이 없어요.'];
 const e=[],r=recipient||{},list=items||[];
 const no=s(request?.fassto_order_no);
 if(!no)e.push('주문번호가 아직 없어요. 새로고침한 뒤 다시 해 주세요.');
 else if(!/^[A-Za-z0-9_-]+$/.test(no))e.push('주문번호에는 영문·숫자와 - _만 쓸 수 있어요.');
 if(!list.length)e.push('품목을 1줄 이상 넣어 주세요.');
 if(list.length>MAX_ITEMS)e.push('품목은 50줄까지 넣을 수 있어요.');
 list.forEach((it,i)=>{
  const n=i+1;
  if(!s(it.product_code))e.push(`${n}번째 품목의 상품코드가 없어요.`);
  if(!(Number.isInteger(Number(it.qty))&&Number(it.qty)>=1))e.push(`${n}번째 품목의 수량을 1 이상으로 적어 주세요.`);
  if(form==='overseas'){
   if(blank(it.unit_price)||!(Number(it.unit_price)>0))e.push(`${n}번째 품목의 단가를 적어 주세요.`);
   if(!blank(it.weight_kg)&&!(Number(it.weight_kg)>0))e.push(`${n}번째 품목의 무게는 0보다 커야 해요.`);
  }
 });
 const need=(key,label)=>{if(!s(r[key]))e.push(`받는 곳: ${label} 칸이 비어 있어요.`);};
 if(form==='parcel'){
  need('name_text','받는 분');need('address1_text','기본주소');need('phone_text','전화');
  for(const [key,label] of [['name_text','받는 분'],['address1_text','기본주소'],['address2_text','상세주소']])
   if(BAD_PARCEL.test(s(r[key])))e.push(`받는 곳: ${label}에는 ( ) , - _ 말고 다른 특수문자를 쓸 수 없어요.`);
 }
 if(form==='overseas'){
  const country=s(r.country_code).toUpperCase();
  if(!/^[A-Z]{2}$/.test(country))e.push('받는 곳: 국가코드를 영문 두 글자로 적어 주세요(예 CH).');
  need('name_text','받는 분');need('phone_text','전화');need('postal_text','우편번호');need('address1_text','상세주소');
  if(country!=='CN'){need('state_text','주(성)');need('city_text','시');}
  if(TAX_ID_COUNTRIES.includes(country))need('tax_id_text','신분번호');
  if(!CURRENCIES.includes(s(r.currency_code)))e.push('받는 곳: 화폐를 USD·JPY·EUR 중에서 골라 주세요.');
  if(!s(r.courier_text))e.push('운송사가 비어 있어요. 물류 담당자가 요약 수정에서 정해 주세요.');
  if(s(r.incoterms_code)&&!INCOTERMS.includes(s(r.incoterms_code)))e.push('Incoterms는 DAP·DDU·DDP 중 하나여야 해요.');
  const snd=senderOf(r,defaults);
  if(!snd.name_text||!snd.phone_text||!snd.address_text)e.push('발송인 이름·전화·주소가 비어 있어요.');
  if(/fedex/i.test(s(r.courier_text))){
   if(!snd.email_text)e.push('FEDEX는 발송인 이메일이 필요해요.');
   if(!s(r.email_text))e.push('FEDEX는 받는 분 이메일이 필요해요.');
  }
 }
 return e;
}

// 5행부터 넣을 2차원 배열. 빈 칸은 ''(셀을 만들지 않음), 수량·무게·단가는 숫자.
function buildRows(form,request,recipient,items,defaults=SENDER){
 if(!FORMS[form])throw new Error('이 운송 방식은 파스토 양식이 없어요.');
 const r=recipient||{},no=s(request?.fassto_order_no),snd=senderOf(r,defaults);
 return (items||[]).map(it=>{
  const code=s(it.product_code),qty=Number(it.qty),exp=s(it.lot_text)&&it.expires_on?String(it.expires_on).slice(0,10):'';
  if(form==='overseas')return [s(r.country_code).toUpperCase(),s(r.courier_text),no,snd.name_text,'',snd.phone_text,snd.address_text,
   s(r.name_text),s(r.phone_text),s(r.postal_text),s(r.state_text),s(r.city_text),s(r.district_text),s(r.address1_text),s(r.tax_id_text),
   qty,s(r.currency_code),code,s(it.en_name_text),s(it.hs_code_text),blank(it.weight_kg)?1:Number(it.weight_kg),blank(it.unit_price)?'':Number(it.unit_price),
   BRAND,'','',s(r.incoterms_code),snd.email_text,s(r.email_text)];
  if(form==='parcel')return ['',no,s(r.name_text),s(r.postal_text),s(r.address1_text),s(r.address2_text),s(r.phone_text),'',code,qty,
   s(r.sender_name_text),s(r.sender_phone_text),'','','','','',exp,''];
  return [code,qty,no,exp,'','','차량'];
 });
}

// SheetJS 워크북. 1~4행은 원본 그대로, 시트 이름도 원본과 같게. 상품코드·주문번호·우편번호·전화 칸은 문자 셀(@).
function toWorkbook(form,rows,lib){
 const X=lib||root.XLSX,f=FORMS[form];
 if(!X)throw new Error('엑셀 도구를 불러오지 못했어요. 새로고침한 뒤 다시 해 주세요.');
 if(!f)throw new Error('이 운송 방식은 파스토 양식이 없어요.');
 const ws={},all=[...f.head,...(rows||[])],width=f.head[0].length;
 all.forEach((row,r)=>row.forEach((v,c)=>{
  if(v==null||v==='')return;
  const ref=X.utils.encode_cell({r,c});
  if(typeof v==='number'&&r>=4)ws[ref]={t:'n',v};
  else{ws[ref]={t:'s',v:String(v)};if(r>=4&&f.text.includes(c))ws[ref].z='@';}
 }));
 ws['!ref']=X.utils.encode_range({s:{r:0,c:0},e:{r:all.length-1,c:width-1}});
 ws['!cols']=Array.from({length:width},()=>({wch:18}));
 const wb=X.utils.book_new();X.utils.book_append_sheet(wb,ws,f.sheet);
 return wb;
}
const fileName=(form,request)=>`파스토_${FORMS[form]?.label||'양식'}_${s(request?.fassto_order_no)||'주문번호없음'}.xlsx`;

// ── 파스토 상품 목록(로트별 행) ──
function groupStock(rows){
 const map=new Map();
 for(const x of rows||[]){
  const code=s(x.product_code);if(!code)continue;
  let g=map.get(code);
  if(!g){g={product_code:code,product_name:s(x.product_name),barcode:s(x.barcode),kind_text:s(x.kind_text),total_qty:0,lots:[]};map.set(code,g);}
  const q=Number(x.available_qty)||0;g.total_qty+=q;
  if(s(x.lot_text))g.lots.push({lot_text:s(x.lot_text),expires_on:x.expires_on?String(x.expires_on).slice(0,10):null,available_qty:q});
 }
 return [...map.values()].sort((a,b)=>a.product_name.localeCompare(b.product_name,'ko')||a.product_code.localeCompare(b.product_code));
}
function searchStock(groups,q,limit=20){
 const t=s(q).toLowerCase();if(!t)return [];
 return (groups||[]).filter(g=>[g.product_name,g.barcode,g.product_code].some(v=>v.toLowerCase().includes(t))).slice(0,limit);
}
function availableFor(item,groups){
 const g=(groups||[]).find(x=>x.product_code===s(item?.product_code));if(!g)return null;
 if(s(item.lot_text)){const l=g.lots.find(x=>x.lot_text===s(item.lot_text));return l?l.available_qty:0;}
 return g.total_qty;
}
function qtyWarning(item,groups){
 const a=availableFor(item,groups),q=Number(item?.qty);
 return a!=null&&Number.isFinite(q)&&q>a?`출고 가능 ${a.toLocaleString('ko-KR')}개보다 많아요.`:'';
}
function stockWarnings(items,groups){
 return (items||[]).map((it,i)=>(groups||[]).some(g=>g.product_code===s(it.product_code))?'':`${i+1}번째 품목(${s(it.product_code)})은 파스토 목록에 없는 상품이에요.`).filter(Boolean);
}
function stockAge(sync,groups,nowMs){
 const t=Date.parse(sync?.synced_at||'');
 if(!Number.isFinite(t))return {text:'파스토 목록이 아직 없어요. 품목은 상품코드를 직접 확인해 주세요.',stale:true};
 const k=new Date(t+KST).toISOString(),stale=nowMs-t>STALE_MS;
 return {text:`파스토 목록: ${k.slice(5,7)}/${k.slice(8,10)} ${k.slice(11,16)} 기준 (상품 ${(groups||[]).length}종)${stale?' · 재고 정보가 오래됐어요':''}`,stale};
}

// ── 저장용 변환 ──
// 폼 값({name_text,...})에서 받는 곳 행을 만든다. 담당자 칸은 담당자일 때만 넣는다(요청자 저장이 담당자 값을 덮지 않게).
function toRecipientRow(values,{isHandler=false}={}){
 const v=values||{},row={};
 for(const k of [...RECIPIENT_KEYS,...(isHandler?HANDLER_KEYS:[])])if(k in v)row[k]=k==='country_code'?s(v[k]).toUpperCase():s(v[k]);
 return row;
}
function toItemRows(items){
 return (items||[]).map(it=>({product_code:s(it.product_code),product_name_text:s(it.product_name_text),qty:Number(it.qty),
  lot_text:s(it.lot_text),expires_on:s(it.lot_text)&&it.expires_on?String(it.expires_on).slice(0,10):null,en_name_text:s(it.en_name_text),
  weight_kg:blank(it.weight_kg)?null:Number(it.weight_kg),unit_price:blank(it.unit_price)?null:Number(it.unit_price),hs_code_text:s(it.hs_code_text)}));
}
// 저장 전 형식 검사(필수 칸은 내려받을 때 본다)
function checkInput(form,recipient,items){
 const e=[],r=recipient||{},list=items||[];
 if(list.length>MAX_ITEMS)e.push('품목은 50줄까지 넣을 수 있어요.');
 list.forEach((it,i)=>{
  const n=i+1;
  if(!(Number.isInteger(Number(it.qty))&&Number(it.qty)>=1))e.push(`${n}번째 품목의 수량을 1 이상의 정수로 적어 주세요.`);
  if(!blank(it.unit_price)&&!(Number(it.unit_price)>=0))e.push(`${n}번째 품목의 단가는 숫자로 적어 주세요.`);
  if(!blank(it.weight_kg)&&!(Number(it.weight_kg)>0))e.push(`${n}번째 품목의 무게는 0보다 큰 숫자로 적어 주세요.`);
 });
 if(form==='overseas'){
  if(s(r.country_code)&&!/^[A-Za-z]{2}$/.test(s(r.country_code)))e.push('국가코드는 영문 두 글자로 적어 주세요(예 CH).');
  if(s(r.currency_code)&&!CURRENCIES.includes(s(r.currency_code)))e.push('화폐는 USD·JPY·EUR 중에서 골라 주세요.');
 }
 return e;
}

return {FORMS,SENDER,BRAND,CURRENCIES,INCOTERMS,TAX_ID_COUNTRIES,MAX_ITEMS,RECIPIENT_KEYS,HANDLER_KEYS,RECIPIENT_FIELDS,HANDLER_FIELDS,
 formFor,formHint,senderOf,validate,buildRows,toWorkbook,fileName,groupStock,searchStock,availableFor,qtyWarning,stockWarnings,stockAge,
 toRecipientRow,toItemRows,checkInput};
});
```

`package.json`의 `check` 끝을 바꾼다:

1) `package.json`에서 아래 부분(파일 안에 한 번만 있음)을 찾아

```json
node --check logistics.js"
```

다음으로 바꾼다.

```json
node --check logistics.js && node --check fassto-forms.js"
```

- [ ] **Step 5: Run test to verify it passes**

```bash
node --test tests/fassto-forms.test.cjs && npm run check
```
Expected: PASS 9개, 검사 통과

- [ ] **Step 6: Commit**

```bash
git add fassto-forms.js tests/fassto-forms.test.cjs package.json package-lock.json
GIT_AUTHOR_NAME=sylee GIT_AUTHOR_EMAIL=sylee@entropymakeup.com GIT_COMMITTER_NAME=sylee GIT_COMMITTER_EMAIL=sylee@entropymakeup.com git commit -m "$(cat <<'EOF'
물류 요청: 파스토 양식 3종 생성기(원본 1~4행, 검사, 상품 목록 계산)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: FMS 엑셀 변환기 (`tools/fassto-stock-json.cjs`)

**Files:**
- Create: `tools/fassto-stock-json.cjs`
- Test: `tests/fassto-stock-json.test.cjs`
- Modify: `package.json` (`check`)

**Interfaces:**
- Consumes: Task 1 `approval_private.logistics_replace_fassto_stock(rows jsonb, source text)`의 rows 모양 `{product_code(문자), barcode, product_name, kind_text, lot_text, expires_on('YYYY-MM-DD' 또는 ''), available_qty(정수)}`
- Produces: `node tools/fassto-stock-json.cjs <파일.xlsx> [--sql]`, 모듈 `{ALIASES, normalizeDate(v) → 'YYYY-MM-DD'|''|null, parseStockRows(aoa) → {rows, skipped, badDates}, parseWorkbook(wb), toSql(rows, source='fms-browser') → string}`

- [ ] **Step 1: Write the failing test**

`tests/fassto-stock-json.test.cjs`:

```js
const {test}=require('node:test');const assert=require('node:assert/strict');
const XLSX=require('xlsx');
const T=require('../tools/fassto-stock-json.cjs');

// 가짜 FMS 내보내기: 제목 줄, 빈 줄, 제목, 로트 행, 소계 행. 상품코드는 문자 셀(앞자리 0).
function fakeExport(){
 const ws=XLSX.utils.aoa_to_sheet([
  ['상품별재고현황'],[],
  ['상품코드','상품바코드','상품명','상품구분','LOT번호','유통기한','출고가능수량'],
  ['0012345','8800000000001','가짜 립','본품','L1','2028-01-31','1,200'],
  ['0012345','8800000000001','가짜 립','본품','L2','2028.06.30','30'],
  ['','','','','','소계','1230'],
  ['A-9','','가짜 쇼핑백','부자재','','','5'],
  ['0077','','가짜 크림','사은품','L9','언젠가','1']]);
 const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,ws,'Sheet1');
 return XLSX.read(XLSX.write(wb,{type:'buffer',bookType:'xlsx'}),{type:'buffer'});
}

test('FMS 엑셀: 제목·소계 행을 빼고 로트별 행을 문자 상품코드로 만든다',()=>{
 const {rows,skipped,badDates}=T.parseWorkbook(fakeExport());
 assert.deepEqual(rows.map(r=>[r.product_code,r.lot_text,r.expires_on,r.available_qty]),
  [['0012345','L1','2028-01-31',1200],['0012345','L2','2028-06-30',30],['A-9','','',5],['0077','L9','',1]]);
 assert.equal(rows[0].kind_text,'본품');assert.equal(rows[0].barcode,'8800000000001');
 assert.deepEqual(skipped,[6]);
 assert.deepEqual(badDates,[8]);
});

test('FMS 엑셀: 필수 열이 없으면 찾은 제목을 보여 주고 멈춘다',()=>{
 assert.throws(()=>T.parseStockRows([['상품코드','상품명','현재고']]),/열을 찾지 못했어요: 출고 가능 수량\. 찾은 제목: 상품코드, 상품명, 현재고/);
 assert.throws(()=>T.parseStockRows([['a','b']]),/상품코드 제목 줄을 찾지 못했어요/);
});

test('날짜 표기와 SQL 문',()=>{
 assert.deepEqual(['2028-1-5','20280105','2028/01/05','1/5/28','','x'].map(T.normalizeDate),['2028-01-05','2028-01-05','2028-01-05','2028-01-05','',null]);
 const sql=T.toSql([{product_code:"0'1",available_qty:1}]);
 assert.equal(sql,`select approval_private.logistics_replace_fassto_stock($fassto$[{"product_code":"0'1","available_qty":1}]$fassto$::jsonb, 'fms-browser');`);
 assert.throws(()=>T.toSql([{product_code:'$fassto$'}]),/\$fassto\$/);
 assert.throws(()=>T.toSql([],'manual'),/source/);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test tests/fassto-stock-json.test.cjs
```
Expected: FAIL — `Cannot find module '../tools/fassto-stock-json.cjs'`

- [ ] **Step 3: Write the implementation**

`tools/fassto-stock-json.cjs`:

```js
#!/usr/bin/env node
'use strict';
// FMS '상품별재고현황' 엑셀을 logistics_replace_fassto_stock(rows, source)에 넘길 로트별 JSON으로 바꾼다.
// 쓰는 법: node tools/fassto-stock-json.cjs <내려받은.xlsx> [--sql]
//  --sql 이면 SQL 편집기·Supabase MCP에 그대로 넣을 select 문을 출력한다. 요약은 stderr로 보낸다.
// 열 이름은 2026-11-19 FMS 상품별재고현황으로 확인했다. 파스토가 바꾸면 ALIASES에 더한다(필수 열을 못 찾으면 찾은 제목을 보여 주고 멈춘다).
const XLSX=require('xlsx');

const ALIASES={
 product_code:['상품코드'],
 barcode:['상품바코드','바코드'],
 product_name:['상품명'],
 kind_text:['상품구분','구분'],
 lot_text:['LOT번호','LOT','로트번호','로트'],
 expires_on:['유통기한'],
 available_qty:['출고가능수량','출고가능','가용재고','가용수량']
};
const REQUIRED={product_code:'상품코드',product_name:'상품명',available_qty:'출고 가능 수량'};
const TOTAL=/^(소계|합계|총계|총합계)$/;
const norm=v=>String(v??'').replace(/\s+/g,'').trim();

function normalizeDate(v){
 const t=String(v??'').trim();if(!t)return '';
 let m=/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})/.exec(t)||/^(\d{4})(\d{2})(\d{2})$/.exec(t);
 if(m)return `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
 m=/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/.exec(t); // 엑셀 기본 날짜 표시(m/d/yy)
 if(m)return `20${m[3]}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`;
 return null;
}

// aoa: sheet_to_json(header:1, raw:false) 결과(문자 2차원 배열)
function parseStockRows(aoa){
 const rows=aoa||[];
 const h=rows.findIndex(r=>(r||[]).some(c=>norm(c)==='상품코드'));
 if(h<0)throw new Error('FMS 엑셀에서 상품코드 제목 줄을 찾지 못했어요.');
 const head=rows[h].map(norm),col={};
 for(const [key,names] of Object.entries(ALIASES)){const i=head.findIndex(x=>names.includes(x));if(i>=0)col[key]=i;}
 const missing=Object.entries(REQUIRED).filter(([k])=>col[k]==null).map(([,label])=>label);
 if(missing.length)throw new Error(`FMS 엑셀 열을 찾지 못했어요: ${missing.join(', ')}. 찾은 제목: ${head.filter(Boolean).join(', ')}`);
 const out=[],skipped=[],badDates=[];
 rows.slice(h+1).forEach((r,k)=>{
  const at=key=>col[key]==null?'':String((r||[])[col[key]]??'').trim();
  const code=at('product_code');
  if(!code||norm(code)==='상품코드'||(r||[]).some(c=>TOTAL.test(norm(c)))){if((r||[]).some(c=>norm(c)))skipped.push(h+2+k);return;}
  const exp=normalizeDate(at('expires_on'));
  if(exp===null)badDates.push(h+2+k);
  const qty=Number(at('available_qty').replace(/,/g,''));
  out.push({product_code:code,barcode:at('barcode'),product_name:at('product_name'),kind_text:at('kind_text'),lot_text:at('lot_text'),
   expires_on:exp||'',available_qty:Number.isFinite(qty)?Math.trunc(qty):0});
 });
 return {rows:out,skipped,badDates};
}
function parseWorkbook(wb){
 const ws=wb.Sheets[wb.SheetNames[0]];
 return parseStockRows(XLSX.utils.sheet_to_json(ws,{header:1,raw:false,defval:''}));
}
function toSql(rows,source='fms-browser'){
 const json=JSON.stringify(rows);
 if(json.includes('$fassto$'))throw new Error('상품 정보에 $fassto$ 글자가 있어 SQL로 만들 수 없어요.');
 if(!['fms-browser','fassto-api'].includes(source))throw new Error('source는 fms-browser 또는 fassto-api예요.');
 return `select approval_private.logistics_replace_fassto_stock($fassto$${json}$fassto$::jsonb, '${source}');`;
}

if(require.main===module){
 const file=process.argv[2];
 if(!file){console.error('쓰는 법: node tools/fassto-stock-json.cjs <상품별재고현황.xlsx> [--sql]');process.exit(2);}
 const {rows,skipped,badDates}=parseWorkbook(XLSX.readFile(file));
 if(!rows.length){console.error('로트 행이 0개예요. 파일을 확인해 주세요.');process.exit(1);}
 const codes=new Set(rows.map(r=>r.product_code)).size;
 console.error(`로트 행 ${rows.length}개, 상품 ${codes}종, 건너뛴 행 ${skipped.length}개${badDates.length?`, 유통기한을 못 읽은 행 ${badDates.join(',')}`:''}`);
 process.stdout.write(process.argv.includes('--sql')?toSql(rows)+'\n':JSON.stringify(rows,null,1)+'\n');
}
module.exports={ALIASES,normalizeDate,parseStockRows,parseWorkbook,toSql};
```

`package.json`의 `check` 끝을 바꾼다:

1) `package.json`에서 아래 부분(파일 안에 한 번만 있음)을 찾아

```json
node --check fassto-forms.js"
```

다음으로 바꾼다.

```json
node --check fassto-forms.js && node --check tools/fassto-stock-json.cjs"
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test tests/fassto-stock-json.test.cjs && npm run check
```
Expected: PASS 3개, 검사 통과

- [ ] **Step 5: Commit**

```bash
git add tools/fassto-stock-json.cjs tests/fassto-stock-json.test.cjs package.json
GIT_AUTHOR_NAME=sylee GIT_AUTHOR_EMAIL=sylee@entropymakeup.com GIT_COMMITTER_NAME=sylee GIT_COMMITTER_EMAIL=sylee@entropymakeup.com git commit -m "$(cat <<'EOF'
물류 요청: FMS 상품별재고현황 엑셀을 파스토 목록 JSON·SQL로 바꾸는 도구

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: 데이터 계층 (`createApi`)과 오류 문구

**Files:**
- Modify: `logistics-model.js` (ERRORS), `logistics.js` (`F` 불러오기, `createApi`)
- Test: `tests/logistics-model.test.cjs`, `tests/logistics-ui.test.cjs` (가짜 client 확장 + 새 테스트)

**Interfaces:**
- Consumes: Task 1 표·`logistics_replace_items`, Task 2 `F.toItemRows`
- Produces (`createApi(client)`의 새 메서드):
  - `loadStock() → {rows, sync}` — `logistics_fassto_stock`을 `.order('id').range(from, from+999)`로 1000행씩, `logistics_fassto_sync` 최신 1행
  - `loadRecipient(id) → row|null`, `loadItems(id) → row[]`(line_no 순)
  - `saveRecipient(id, row) → row` — `upsert({...row, request_id:id}, {onConflict:'request_id'}).select()`, 1행이 아니면 `UNCONFIRMED`
  - `saveItems(id, items) → number` — `rpc('logistics_replace_items', {p_request:id, p_items:F.toItemRows(items)})`, 돌려준 수가 다르면 `UNCONFIRMED`
  - `LogisticsModel.ERRORS`에 `LOGISTICS_HANDLER_ONLY`, `LOGISTICS_ITEM_LIMIT`, `LOGISTICS_ITEM_BAD`
  - 테스트 상수(이후 Task가 씀): `STOCK`, `SYNC`, `stockHandler(q)`, `G`(= `groupStock(STOCK)`)

- [ ] **Step 1: Write the failing tests**

`tests/logistics-model.test.cjs` 끝에 추가:

```js

test('파스토 오류 코드도 한국어 문구로 바꾼다',()=>{
 assert.equal(M.errorMessage({message:'LOGISTICS_HANDLER_ONLY'}),'운송사·Incoterms·발송인은 물류 담당자만 정할 수 있어요.');
 assert.equal(M.errorMessage({message:'LOGISTICS_ITEM_LIMIT'}),'품목은 요청당 50줄까지예요.');
 assert.equal(M.errorMessage(new Error('LOGISTICS_ITEM_BAD')),'품목을 확인해 주세요. 상품코드는 문자, 수량은 1 이상이어야 해요.');
});
```

`tests/logistics-ui.test.cjs`의 가짜 client를 넓힌다:

1) `tests/logistics-ui.test.cjs`에서 아래 부분(파일 안에 한 번만 있음)을 찾아

```js
  for(const m of ['select','insert','update','delete','eq','order','limit','in','gte'])chain[m]=(...a)=>{q.ops.push([m,...a]);return chain;};
```

다음으로 바꾼다.

```js
  for(const m of ['select','insert','update','upsert','delete','eq','order','limit','range','in','gte'])chain[m]=(...a)=>{q.ops.push([m,...a]);return chain;};
```

2) `tests/logistics-ui.test.cjs`에서 아래 부분(파일 안에 한 번만 있음)을 찾아

```js
 return {client:{from:builder,storage},calls};
```

다음으로 바꾼다.

```js
 const rpc=(fn,args)=>{const q={table:'rpc:'+fn,ops:[['rpc',args]]};calls.push(q);return Promise.resolve(handler(q));};
 return {client:{from:builder,storage,rpc},calls};
```

`tests/logistics-ui.test.cjs` 끝에 추가:

```js

// ── 파스토 양식 ──
const STOCK=[{product_code:'0012345',barcode:'8800000000001',product_name:'가짜 립',kind_text:'본품',lot_text:'L1',expires_on:'2028-01-31',available_qty:120},
 {product_code:'0012345',barcode:'8800000000001',product_name:'가짜 립',kind_text:'본품',lot_text:'L2',expires_on:'2028-06-30',available_qty:30},
 {product_code:'A-9',barcode:'',product_name:'가짜 쇼핑백',kind_text:'부자재',lot_text:'',expires_on:null,available_qty:5}];
const SYNC=[{synced_at:'2026-11-20T00:05:00Z',source_text:'fms-browser',row_count:3}];
const stockHandler=q=>q.table==='logistics_fassto_stock'?{data:STOCK,error:null}:q.table==='logistics_fassto_sync'?{data:SYNC,error:null}:null;
const G=require('../fassto-forms.js').groupStock(STOCK);

test('createApi: 파스토 목록은 1000행씩 받고, 받는 곳은 upsert 1행, 품목은 RPC 줄 수를 확인한다',async()=>{
 const page=n=>Array.from({length:n},(_,i)=>({product_code:'P'+i,available_qty:1}));
 const {client,calls}=fakeClient(q=>{
  if(q.table==='logistics_fassto_stock'){const r=q.ops.find(o=>o[0]==='range');return {data:r[1]===0?page(1000):page(3),error:null};}
  if(q.table==='logistics_fassto_sync')return {data:SYNC,error:null};
  if(q.table==='logistics_request_recipients'&&q.ops[0][0]==='upsert')return {data:[{request_id:'r1'}],error:null};
  if(q.table==='logistics_request_recipients')return {data:[],error:null};
  if(q.table==='rpc:logistics_replace_items')return {data:q.ops[0][1].p_items.length,error:null};
  return {data:[],error:null};});
 const api=P.createApi(client);
 const s=await api.loadStock();
 assert.equal(s.rows.length,1003);
 assert.deepEqual(calls.filter(c=>c.table==='logistics_fassto_stock').map(c=>c.ops.find(o=>o[0]==='range').slice(1)),[[0,999],[1000,1999]]);
 assert.equal(s.sync.synced_at,'2026-11-20T00:05:00Z');
 assert.equal(await api.loadRecipient('r1'),null);
 await api.saveRecipient('r1',{name_text:'A'});
 const up=calls.find(c=>c.ops[0][0]==='upsert');
 assert.deepEqual(up.ops[0].slice(1),[{name_text:'A',request_id:'r1'},{onConflict:'request_id'}]);
 assert.equal(await api.saveItems('r1',[{product_code:'007',qty:'2'}]),1);
 const rpc=calls.find(c=>c.table==='rpc:logistics_replace_items');
 assert.deepEqual(rpc.ops[0][1].p_items[0],{product_code:'007',product_name_text:'',qty:2,lot_text:'',expires_on:null,en_name_text:'',weight_kg:null,unit_price:null,hs_code_text:''});
 const bad=fakeClient(q=>q.table.startsWith('rpc:')?{data:0,error:null}:{data:[],error:null});
 await assert.rejects(()=>P.createApi(bad.client).saveItems('r1',[{product_code:'X',qty:1}]),/UNCONFIRMED/);
 await assert.rejects(()=>P.createApi(bad.client).saveRecipient('r1',{}),/UNCONFIRMED/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
node --test tests/logistics-model.test.cjs tests/logistics-ui.test.cjs
```
Expected: FAIL 2개 — 오류 문구가 `저장하지 못했어요: LOGISTICS_HANDLER_ONLY`, `api.loadStock is not a function`

- [ ] **Step 3: Write the implementation**

1) `logistics-model.js`에서 아래 부분(파일 안에 한 번만 있음)을 찾아

```js
 LOGISTICS_LOGIN_REQUIRED:'회사 계정으로 로그인해 주세요.',
```

다음으로 바꾼다.

```js
 LOGISTICS_LOGIN_REQUIRED:'회사 계정으로 로그인해 주세요.',
 LOGISTICS_HANDLER_ONLY:'운송사·Incoterms·발송인은 물류 담당자만 정할 수 있어요.',
 LOGISTICS_ITEM_LIMIT:'품목은 요청당 50줄까지예요.',
 LOGISTICS_ITEM_BAD:'품목을 확인해 주세요. 상품코드는 문자, 수량은 1 이상이어야 해요.',
```

2) `logistics.js`에서 아래 부분(파일 안에 한 번만 있음)을 찾아

```js
const M=root.LogisticsModel||(typeof require==='function'?require('./logistics-model.js'):null);
const {esc}=M;
```

다음으로 바꾼다.

```js
const M=root.LogisticsModel||(typeof require==='function'?require('./logistics-model.js'):null);
const F=root.FasstoForms||(typeof require==='function'?require('./fassto-forms.js'):null);
const {esc}=M;
```

3) `logistics.js`에서 아래 부분(파일 안에 한 번만 있음)을 찾아

```js
  async deleteComment(id){
   const rows=await need(client.from('logistics_request_comments').delete().eq('id',id).select());
   if(!Array.isArray(rows)||rows.length!==1)throw new Error('STALE');
  }
 };
}
```

다음으로 바꾼다.

```js
  async deleteComment(id){
   const rows=await need(client.from('logistics_request_comments').delete().eq('id',id).select());
   if(!Array.isArray(rows)||rows.length!==1)throw new Error('STALE');
  },
  // 파스토 상품 목록. select가 1000행에서 잘리므로 1000행씩 나눠 받는다.
  async loadStock(){
   const rows=[];
   for(let from=0;from<20000;from+=1000){
    const page=(await need(client.from('logistics_fassto_stock').select('product_code,barcode,product_name,kind_text,lot_text,expires_on,available_qty').order('id').range(from,from+999)))||[];
    rows.push(...page);if(page.length<1000)break;
   }
   const sync=await need(client.from('logistics_fassto_sync').select('synced_at,source_text,row_count').order('synced_at',{ascending:false}).limit(1));
   return {rows,sync:Array.isArray(sync)?sync[0]||null:null};
  },
  // 볼 권한이 없으면 RLS가 빈 결과를 준다(null). 볼 수 없음과 입력 안 됨은 화면이 요청자·담당자 여부로 나눈다.
  async loadRecipient(id){
   const rows=await need(client.from('logistics_request_recipients').select('*').eq('request_id',id));
   return Array.isArray(rows)?rows[0]||null:null;
  },
  async loadItems(id){return (await need(client.from('logistics_request_items').select('*').eq('request_id',id).order('line_no')))||[];},
  async saveRecipient(id,row){
   const rows=await need(client.from('logistics_request_recipients').upsert({...row,request_id:id},{onConflict:'request_id'}).select());
   if(!Array.isArray(rows)||rows.length!==1)throw new Error('UNCONFIRMED');return rows[0];
  },
  // 품목은 통째로 바꾼다(DB 함수 하나 = 한 트랜잭션). 돌려준 줄 수가 보낸 줄 수와 같아야 성공이다.
  async saveItems(id,items){
   const rows=F.toItemRows(items);
   const n=await need(client.rpc('logistics_replace_items',{p_request:id,p_items:rows}));
   if(Number(n)!==rows.length)throw new Error('UNCONFIRMED');return rows.length;
  }
 };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
node --test tests/logistics-model.test.cjs tests/logistics-ui.test.cjs && npm run check
```
Expected: PASS (기존 테스트 포함 전부)

- [ ] **Step 5: Commit**

```bash
git add logistics-model.js logistics.js tests/logistics-model.test.cjs tests/logistics-ui.test.cjs
GIT_AUTHOR_NAME=sylee GIT_AUTHOR_EMAIL=sylee@entropymakeup.com GIT_COMMITTER_NAME=sylee GIT_COMMITTER_EMAIL=sylee@entropymakeup.com git commit -m "$(cat <<'EOF'
물류 요청: 파스토 목록·받는 곳·품목 데이터 계층

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: 파스토 칸 렌더링 (새 요청·요약 수정 창, 상세)

**Files:**
- Modify: `logistics.js` (렌더 함수와 `renderForm`·`renderDetail` 연결, 내보내기 목록)
- Test: `tests/logistics-ui.test.cjs`

**Interfaces:**
- Consumes: Task 2 `F.*`, Task 4 테스트 상수 `STOCK`, `SYNC`, `G`
- Produces (`LogisticsPage.*`):
  - `renderStockBanner(stock, nowMs)` — stock = `{rows, groups, sync, error}`
  - `renderStockResults(groups, q)` — 버튼 `data-item-add="<상품코드>"`
  - `renderItems(items, {form, groups})` — 입력 `name="item_qty_<i>"`·`item_lot_<i>`·(해외) `item_unit_price_<i>`·`item_weight_kg_<i>`·`item_en_name_text_<i>`, 각 입력에 `data-item-field`·`data-line`, 경고 `id="lg-item-warn-<i>"`, 빼기 `data-item-del="<i>"`
  - `renderFasstoFields(ship_mode_code, fx, ctx)` — fx = `{recipient, items, q}` 또는 null(못 불러옴). 받는 곳 입력 `name="r_<열>"`·`id="lg-r-<열>"`·`data-recipient="<열>"`, 상품 찾기 `id="lg-item-q"`, 결과 `id="lg-item-results"`, 줄 `id="lg-item-lines"`. ctx = `{isHandler, groups, stock, nowMs}`
  - `renderFasstoSection(request, ctx)` — ctx.fassto = `{loaded, loading, recipient, items, error}`, ctx.fasstoErrors, 버튼 `data-act="fassto-download"`
  - `renderForm(d, ctx)`는 `<div class="lg-fassto" id="lg-f-fassto">`를 그린다(ctx.fassto가 없으면 새 요청은 빈 값, 요약 수정은 null). `renderDetail`은 필드 목록 바로 뒤에 `renderFasstoSection`을 그린다.
  - 모듈 안 함수 `itemWarn(item, groups)`(Task 6이 씀)

- [ ] **Step 1: Write the failing test** (`tests/logistics-ui.test.cjs` 끝에 추가)

```js
test('입력 폼: 운송 방식별 받는 곳 칸과 안내, 운송사·Incoterms는 담당자에게만',()=>{
 const base={invoices:[],groups:G,stock:{sync:SYNC[0],groups:G},nowMs:NOW,fassto:{recipient:{},items:[],q:''}};
 const parcel=P.renderForm({ship_mode_code:'parcel'},base);
 assert.ok(parcel.includes('파스토 택배신청 양식으로 만들어요.'));
 for(const n of ['r_name_text','r_phone_text','r_postal_text','r_address1_text','r_address2_text'])assert.ok(parcel.includes(`name="${n}"`),n);
 assert.ok(!parcel.includes('name="r_country_code"')&&!parcel.includes('name="r_courier_text"'));
 assert.ok(parcel.includes('파스토 목록: 11/20 09:05 기준 (상품 2종)'));
 const ov=P.renderForm({ship_mode_code:'express'},base);
 for(const n of ['r_email_text','r_country_code','r_state_text','r_city_text','r_district_text','r_tax_id_text','r_currency_code'])assert.ok(ov.includes(`name="${n}"`),n);
 assert.ok(!ov.includes('name="r_courier_text"')&&ov.includes('운송사·Incoterms·발송인은 물류 담당자가 정해요.'));
 const ovh=P.renderForm({ship_mode_code:'express'},{...base,isHandler:true});
 assert.ok(ovh.includes('name="r_courier_text"')&&ovh.includes('name="r_incoterms_code"')&&ovh.includes('name="r_sender_email_text"'));
 const veh=P.renderForm({ship_mode_code:'direct'},base);
 assert.ok(veh.includes('파스토 차량배송신청(상품) 양식으로 만들어요.')&&veh.includes('차량배송은 받는 곳 칸이 없어요')&&!veh.includes('name="r_name_text"'));
 assert.ok(P.renderForm({ship_mode_code:'quick'},base).includes('이 운송 방식은 파스토 양식 없이 처리해요.'));
 assert.ok(!P.renderForm({ship_mode_code:''},base).includes('lg-hint'));
 assert.ok(P.renderForm({ship_mode_code:'parcel'},{...base,mode:'edit',fassto:null}).includes('받는 곳·품목을 불러오지 못해 이번에는 고칠 수 없어요.'));
 const old=P.renderFasstoFields('parcel',{recipient:{},items:[],q:''},{groups:G,stock:{sync:{synced_at:'2026-11-17T00:00:00Z'},groups:G},nowMs:NOW});
 assert.ok(old.includes('lg-stock warn')&&old.includes('재고 정보가 오래됐어요'));
 const lines=P.renderItems([{product_code:'0012345',product_name_text:'가짜 립',qty:200,lot_text:'L2'}],{form:'overseas',groups:G});
 assert.ok(lines.includes('name="item_qty_0"')&&lines.includes('name="item_unit_price_0"')&&lines.includes('<option value="L2" selected>'));
 assert.ok(lines.includes('출고 가능 30개보다 많아요.'));
 assert.ok(P.renderItems([{product_code:'ZZ',qty:1}],{form:'parcel',groups:G}).includes('파스토 목록에 없는 상품이에요.'));
});

test('상세 렌더링: 받는 곳은 요청자·담당자만, 입력 안 됨과 볼 수 없음을 나누고, 내려받기 버튼과 빠진 칸 목록',()=>{
 const r=R('r1',{ship_mode_code:'parcel',fassto_order_no:'LG20261120_001'});
 const fx={loaded:true,loading:false,recipient:null,items:[{product_code:'ZZ',product_name_text:'없는 상품',qty:1,lot_text:''}],error:''};
 const other=P.renderDetail(r,{email:'other@entropymakeup.com',isHandler:false,nowMs:NOW,fassto:{...fx,recipient:null},groups:G});
 assert.ok(other.includes('요청자와 물류 담당자만 볼 수 있어요.')&&!other.includes('data-act="fassto-download"'));
 const owner=P.renderDetail(r,{email:'req@entropymakeup.com',isHandler:false,nowMs:NOW,fassto:fx,groups:G});
 assert.ok(owner.includes('입력 안 됨')&&owner.includes('data-act="fassto-download"')&&owner.includes('주문번호 LG20261120_001'));
 assert.ok(owner.includes('파스토 목록에 없는 상품이에요.'));
 const full=P.renderDetail({...r,ship_mode_code:'express'},{email:'h@x',isHandler:true,nowMs:NOW,groups:G,fassto:{...fx,recipient:{name_text:'<b>Buyer</b>',country_code:'CH',courier_text:''}},fasstoErrors:['받는 곳: 전화 칸이 비어 있어요.']});
 assert.ok(full.includes('&lt;b&gt;Buyer&lt;/b&gt;')&&full.includes('담당자가 정해요')&&full.includes('ENTROPY (Brand Genome Co., Ltd.)'));
 assert.match(full,/내려받지 않았어요\. 아래 칸을 채워 주세요\.<\/p><ul><li>받는 곳: 전화 칸이 비어 있어요\.<\/li>/);
 assert.equal(P.renderDetail(R('q1'),{email:'req@entropymakeup.com',nowMs:NOW,fassto:{loaded:true,items:[]}}).includes('파스토 양식'),false); // 퀵은 칸 자체가 없다
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test tests/logistics-ui.test.cjs
```
Expected: FAIL 2개 — `P.renderFasstoFields is not a function` 등

- [ ] **Step 3: Write the implementation**

1) `logistics.js`에서 아래 부분(파일 안에 한 번만 있음)을 찾아

```js
function renderDetail(r,ctx){
```

다음으로 바꾼다.

```js
// ── 파스토 양식(받는 곳·품목) ──
const itemWarn=(it,groups)=>F.qtyWarning(it,groups)||((groups||[]).some(g=>g.product_code===String(it.product_code||'').trim())?'':'파스토 목록에 없는 상품이에요.');
function renderStockBanner(stock,nowMs){
 if(!stock)return '';
 if(stock.error)return `<p class="lg-stock warn" role="status">파스토 목록을 불러오지 못했어요: ${esc(stock.error)}</p>`;
 const a=F.stockAge(stock.sync,stock.groups,nowMs);
 return `<p class="lg-stock${a.stale?' warn':''}" role="status">${esc(a.text)}</p>`;
}
function renderStockResults(list,q){
 if(!String(q||'').trim())return '';
 if(!list.length)return '<p class="lg-muted">찾는 상품이 없어요. 파스토 목록에 있는 상품만 넣을 수 있어요.</p>';
 return `<ul class="lg-stock-results">${list.map(g=>`<li><button type="button" class="lg-link" data-item-add="${esc(g.product_code)}">${esc(g.product_name||g.product_code)} <span class="lg-muted">${esc(g.product_code)}${g.barcode?' · '+esc(g.barcode):''}${g.kind_text?' · '+esc(g.kind_text):''} · 출고 가능 ${esc(g.total_qty.toLocaleString('ko-KR'))}개</span></button></li>`).join('')}</ul>`;
}
function renderItemRow(it,i,{form,groups}){
 const g=(groups||[]).find(x=>x.product_code===it.product_code),lots=g?.lots||[];
 const box=(field,label,val,mode='decimal')=>`<input name="item_${field}_${i}" data-item-field="${field}" data-line="${i}" inputmode="${mode}" value="${esc(val??'')}" aria-label="${i+1}번째 ${label}">`;
 const lotOpts=`<option value="">로트 지정 안 함</option>`+lots.map(l=>`<option value="${esc(l.lot_text)}"${l.lot_text===it.lot_text?' selected':''}>${esc(l.lot_text)} · ${esc(l.expires_on||'유통기한 없음')} · ${esc(l.available_qty)}개</option>`).join('')
  +(it.lot_text&&!lots.some(l=>l.lot_text===it.lot_text)?`<option value="${esc(it.lot_text)}" selected>${esc(it.lot_text)} (목록에 없음)</option>`:'');
 return `<tr><td><b>${esc(it.product_name_text||g?.product_name||'')}</b><br><span class="lg-muted">${esc(it.product_code)}</span></td>`
  +`<td>${box('qty','수량',it.qty,'numeric')}</td>`
  +`<td><select name="item_lot_${i}" data-item-field="lot" data-line="${i}" aria-label="${i+1}번째 로트">${lotOpts}</select></td>`
  +(form==='overseas'?`<td>${box('unit_price','단가',it.unit_price)}</td><td>${box('weight_kg','무게',it.weight_kg)}</td><td><input name="item_en_name_text_${i}" data-item-field="en_name_text" data-line="${i}" maxlength="200" value="${esc(it.en_name_text||'')}" aria-label="${i+1}번째 영문 상품명"></td>`:'')
  +`<td><span class="lg-item-warn" id="lg-item-warn-${i}">${esc(itemWarn(it,groups))}</span> <button type="button" class="btn btn-sm" data-item-del="${i}" aria-label="${i+1}번째 품목 빼기">빼기</button></td></tr>`;
}
function renderItems(items,ctx){
 if(!items.length)return '<p class="lg-muted">아직 넣은 품목이 없어요. 위에서 상품을 찾아 넣어 주세요.</p>';
 const head=`<tr><th>상품</th><th>수량</th><th>로트</th>${ctx.form==='overseas'?'<th>단가 <small>필수</small></th><th>무게(kg)</th><th>영문 상품명</th>':''}<th>${items.length}/${F.MAX_ITEMS}줄</th></tr>`;
 return `<div class="tw"><table class="lg-items"><thead>${head}</thead><tbody>${items.map((it,i)=>renderItemRow(it,i,ctx)).join('')}</tbody></table></div>`;
}
// 새 요청·요약 수정 창의 파스토 칸. mode=운송 방식 코드, fx=null이면 받는 곳·품목을 못 불러와 고칠 수 없다.
function renderFasstoFields(mode,fx,ctx){
 if(!mode)return '';
 const form=F.formFor(mode);
 if(!form)return `<p class="lg-hint">${esc(F.formHint(null))}</p>`;
 if(!fx)return `<p class="lg-hint">${esc(F.formHint(form))}</p><p class="lg-muted">받는 곳·품목을 불러오지 못해 이번에는 고칠 수 없어요. 상세를 다시 열어 주세요.</p>`;
 const r=fx.recipient||{};
 const inp=([key,label,max])=>`<div class="fg"><label for="lg-r-${key}">${label}</label><input id="lg-r-${key}" name="r_${key}" data-recipient="${key}" maxlength="${max}" value="${esc(r[key]||'')}"></div>`;
 const sel=(key,label,list)=>`<div class="fg"><label for="lg-r-${key}">${label}</label><select id="lg-r-${key}" name="r_${key}" data-recipient="${key}"><option value="">선택</option>${list.map(v=>`<option value="${esc(v)}"${r[key]===v?' selected':''}>${esc(v)}</option>`).join('')}</select></div>`;
 let rec='';
 if(form!=='vehicle'){
  rec=`<fieldset class="lg-fassto-box"><legend>받는 곳 <small>요청자와 물류 담당자만 봐요</small></legend><div class="lg-form-grid">${F.RECIPIENT_FIELDS[form].map(inp).join('')}${form==='overseas'?sel('currency_code','화폐',F.CURRENCIES):''}</div>`
   +(form==='overseas'?(ctx.isHandler?`<div class="lg-form-grid lg-handler-only">${inp(F.HANDLER_FIELDS[0])}${sel('incoterms_code','Incoterms',F.INCOTERMS)}${F.HANDLER_FIELDS.slice(1).map(inp).join('')}</div>`
    :'<p class="lg-muted">운송사·Incoterms·발송인은 물류 담당자가 정해요.</p>'):'')+`</fieldset>`;
 }else rec='<p class="lg-muted">차량배송은 받는 곳 칸이 없어요. 도착지는 특이사항에 적어 주세요.</p>';
 const groups=ctx.groups||[],stockLine=ctx.stock?.error?'파스토 목록을 불러오지 못했어요.':F.stockAge(ctx.stock?.sync,groups,ctx.nowMs);
 const stale=typeof stockLine==='string'||stockLine.stale;
 return `<p class="lg-hint">${esc(F.formHint(form))}</p>${rec}`
  +`<fieldset class="lg-fassto-box"><legend>품목 <small>파스토 목록에서 골라요</small></legend>`
  +`<p class="lg-stock${stale?' warn':''}">${esc(typeof stockLine==='string'?stockLine:stockLine.text)}</p>`
  +`<div class="fg"><label for="lg-item-q">상품 찾기 <small>상품명·바코드·상품코드</small></label><input type="search" id="lg-item-q" autocomplete="off" value="${esc(fx.q||'')}"></div>`
  +`<div id="lg-item-results">${renderStockResults(F.searchStock(groups,fx.q),fx.q)}</div>`
  +`<div id="lg-item-lines">${renderItems(fx.items||[],{form,groups})}</div></fieldset>`;
}
// 상세 창의 파스토 칸: 받는 곳(권한), 품목 표, 내려받기 버튼, 검사 결과
function renderFasstoSection(r,ctx){
 const form=F.formFor(r.ship_mode_code),fx=ctx.fassto||{},items=fx.items||[];
 if(!form&&!items.length)return '';
 const owner=String(ctx.email||'').toLowerCase()===String(r.requester_email||'').toLowerCase(),canSee=Boolean(ctx.isHandler||owner);
 const groups=ctx.groups||[];
 const f=(l,v,c='')=>`<div class="lg-f${c}"><dt>${esc(l)}</dt><dd>${esc(v||'-')}</dd></div>`;
 let rec='';
 if(form==='parcel'||form==='overseas'){
  let body;
  if(!canSee)body='<p class="lg-muted">요청자와 물류 담당자만 볼 수 있어요.</p>';
  else if(fx.loading)body='<p class="lg-muted">불러오는 중…</p>';
  else if(fx.error)body='';
  else if(!fx.recipient)body='<p class="lg-muted">입력 안 됨</p>';
  else{
   const x=fx.recipient;
   body=`<dl class="lg-fields">${f('받는 분',x.name_text)}${f('전화',x.phone_text)}`
    +(form==='overseas'?f('이메일',x.email_text)+f('국가',x.country_code)+f('주·시·구',[x.state_text,x.city_text,x.district_text].filter(Boolean).join(', '))+f('화폐',x.currency_code)+(x.tax_id_text?f('신분번호',x.tax_id_text):''):'')
    +`${f('우편번호',x.postal_text)}${f('주소',[x.address1_text,x.address2_text].filter(Boolean).join(' '),' lg-wide')}`
    +(form==='overseas'?(()=>{const snd=F.senderOf(x);return f('운송사',x.courier_text||'담당자가 정해요')+f('Incoterms',x.incoterms_code)+f('발송인',`${snd.name_text} · ${snd.phone_text} · ${snd.email_text}`,' lg-wide');})():'')+`</dl>`;
  }
  rec=`<h4>받는 곳</h4>${body}`;
 }
 const list=fx.error?'':items.length?`<div class="tw"><table class="lg-items"><thead><tr><th>#</th><th>상품코드</th><th>상품명</th><th>수량</th><th>로트·유통기한</th>${form==='overseas'?'<th>단가</th><th>무게(kg)</th>':''}<th>확인</th></tr></thead><tbody>${items.map((it,i)=>
   `<tr><td>${i+1}</td><td>${esc(it.product_code)}</td><td>${esc(it.product_name_text)}</td><td>${esc(it.qty)}</td><td>${esc(it.lot_text?`${it.lot_text} · ${it.expires_on||'유통기한 없음'}`:'지정 안 함')}</td>`
   +(form==='overseas'?`<td>${esc(it.unit_price??'')}</td><td>${esc(it.weight_kg??'1')}</td>`:'')+`<td class="lg-item-warn">${esc(itemWarn(it,groups))}</td></tr>`).join('')}</tbody></table></div>`
  :(fx.loading?'<p class="lg-muted">불러오는 중…</p>':'<p class="lg-muted">품목이 없어요.</p>');
 const canDownload=Boolean(form&&canSee&&fx.loaded);
 const errs=ctx.fasstoErrors||[];
 return `<section class="lg-sec lg-fassto"><h3>파스토 양식${r.fassto_order_no?` <span class="lg-muted">주문번호 ${esc(r.fassto_order_no)}</span>`:''}</h3><p class="lg-hint">${esc(F.formHint(form))}</p>`
  +(fx.error?`<p class="lg-error">${esc(fx.error)}</p>`:'')+rec+`<h4>품목 <span class="lg-count">${items.length}</span></h4>${list}`
  +(canDownload?`<div class="lg-actions"><button type="button" class="btn" data-act="fassto-download"><i class="ti ti-download"></i> 파스토 양식 내려받기</button></div>`:'')
  +(errs.length?`<div class="lg-error" role="alert"><p>내려받지 않았어요. 아래 칸을 채워 주세요.</p><ul>${errs.map(x=>`<li>${esc(x)}</li>`).join('')}</ul></div>`:'')
  +`</section>`;
}

function renderDetail(r,ctx){
```

2) `logistics.js`에서 아래 부분(파일 안에 한 번만 있음)을 찾아

```js
${r.quick_fee_krw!=null?field('퀵비',won(r.quick_fee_krw)):''}${r.status_note_text?field('사유',r.status_note_text,' lg-wide'):''}</dl>`
```

다음으로 바꾼다.

```js
${r.quick_fee_krw!=null?field('퀵비',won(r.quick_fee_krw)):''}${r.status_note_text?field('사유',r.status_note_text,' lg-wide'):''}</dl>`
 +renderFasstoSection(r,ctx)
```

3) `logistics.js`에서 아래 부분(파일 안에 한 번만 있음)을 찾아

```js
 +`</div>`
 +(showOverseas?`<fieldset class="lg-overseas" id="lg-f-overseas"
```

다음으로 바꾼다.

```js
 +`</div>`
 +`<div class="lg-fassto" id="lg-f-fassto">${renderFasstoFields(d.ship_mode_code,ctx.fassto!==undefined?ctx.fassto:(edit?null:{recipient:{},items:[],q:''}),ctx)}</div>`
 +(showOverseas?`<fieldset class="lg-overseas" id="lg-f-overseas"
```

4) `logistics.js`에서 아래 부분(파일 안에 한 번만 있음)을 찾아

```js
return {createApi,kstWeek,summarize,listView,renderKpis,renderTabs,renderList,renderDetail,renderForm,mountTab};
```

다음으로 바꾼다.

```js
return {createApi,kstWeek,summarize,listView,renderKpis,renderTabs,renderList,renderDetail,renderForm,renderStockBanner,renderStockResults,renderItems,renderFasstoFields,renderFasstoSection,mountTab};
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test tests/logistics-ui.test.cjs && npm run check
```
Expected: PASS (기존 렌더 테스트 포함)

- [ ] **Step 5: Commit**

```bash
git add logistics.js tests/logistics-ui.test.cjs
GIT_AUTHOR_NAME=sylee GIT_AUTHOR_EMAIL=sylee@entropymakeup.com GIT_COMMITTER_NAME=sylee GIT_COMMITTER_EMAIL=sylee@entropymakeup.com git commit -m "$(cat <<'EOF'
물류 요청: 새 요청·요약 수정·상세에 받는 곳·품목 칸 그리기

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: 탭 연결 — 목록 시각, 품목 검색·경고, 저장 순서, 내려받기

**Files:**
- Modify: `logistics.js` (`mountTab`), `logistics.css`
- Test: `tests/logistics-ui.test.cjs` (`setup`에 `xlsx`·`saveWorkbook` 전달 + 새 테스트)

**Interfaces:**
- Consumes: Task 4 api 메서드, Task 5 렌더 함수, Task 2 `F.*`
- Produces:
  - `mountTab({..., xlsx=null, saveWorkbook=null})` — 기본은 `root.XLSX`와 `XLSX.writeFile(wb, name)`
  - 반환 객체에 `downloadFassto` 추가. `state.stock`(`{rows, groups, sync, error}`), `state.fassto`(`{loaded, loading, recipient, items, error}`), `state.fasstoErrors`, `state.formFassto`(`{form, recipient, items, q, hadRecipient, origRecipient, origItems}`)
  - 화면: `<div id="lg-stock-line">`(KPI 아래)
  - 저장: 새 요청은 `create` → `saveRecipient`(택배·해외이고 받는 곳 값이 있을 때) → `saveItems` → 첨부. 요약 수정은 `update` → 바뀐 경우에만 `saveRecipient`·`saveItems`

- [ ] **Step 1: Write the failing test**

`tests/logistics-ui.test.cjs`의 `setup`이 내려받기 의존성을 넘기게 바꾼다:

1) `tests/logistics-ui.test.cjs`에서 아래 부분(파일 안에 한 번만 있음)을 찾아

```js
function setup({rows=[],email='handler@entropymakeup.com',onUpdate=()=>({data:[{id:'x'}],error:null}),invoices=[],files=[],handler,confirm=()=>true,open,location,history}={}){
```

다음으로 바꾼다.

```js
function setup({rows=[],email='handler@entropymakeup.com',onUpdate=()=>({data:[{id:'x'}],error:null}),invoices=[],files=[],handler,confirm=()=>true,open,location,history,xlsx,saveWorkbook}={}){
```

2) `tests/logistics-ui.test.cjs`에서 아래 부분(파일 안에 한 번만 있음)을 찾아

```js
 const page=P.mountTab({document:d.document,client,onMessage:m=>messages.push(m),now:()=>NOW,confirm,open,location,history});
```

다음으로 바꾼다.

```js
 const page=P.mountTab({document:d.document,client,onMessage:m=>messages.push(m),now:()=>NOW,confirm,open,location,history,xlsx,saveWorkbook});
```

`tests/logistics-ui.test.cjs` 끝에 추가:

```js
test('mountTab: 물류 탭 위에 파스토 목록 갱신 시각을 보이고, 못 불러와도 목록은 연다',async()=>{
 const t=setup({rows:[R('a')],handler:stockHandler});
 await t.page.show();
 assert.match(t.d.els['lg-stock-line'].innerHTML,/<p class="lg-stock" role="status">파스토 목록: 11\/20 09:05 기준 \(상품 2종\)<\/p>/);
 const bad=setup({rows:[R('a')],handler:q=>q.table==='logistics_fassto_stock'?{data:null,error:{message:'boom'}}:null});
 await bad.page.show();
 assert.ok(bad.d.els['lg-list'].innerHTML.includes('요청 a'));
 assert.match(bad.d.els['lg-stock-line'].innerHTML,/lg-stock warn.*파스토 목록을 불러오지 못했어요: boom/);
});

test('mountTab: 새 요청에서 택배를 고르면 받는 곳·품목 칸이 나오고, 검색해 넣은 품목과 받는 곳을 요청 → 받는 곳 → 품목 순서로 저장한다',async()=>{
 const rows=[];const order=[];
 const t=setup({rows,handler:q=>{
  const s=stockHandler(q);if(s)return s;
  if(q.table==='logistics_requests'&&q.ops[0][0]==='insert'){order.push('request');rows.push(R('new1',{requester_email:'handler@entropymakeup.com',ship_mode_code:'parcel'}));return {data:{id:'new1'},error:null};}
  if(q.table==='logistics_request_recipients'&&q.ops[0][0]==='upsert'){order.push('recipient');return {data:[{request_id:'new1'}],error:null};}
  if(q.table==='rpc:logistics_replace_items'){order.push('items');return {data:q.ops[0][1].p_items.length,error:null};}
  return null;}});
 await t.page.show();
 click(t.d,{act:'new'});
 assert.ok(!t.d.els['lg-form'].innerHTML.includes('name="r_name_text"')); // 운송 방식을 고르기 전
 t.d.els.content.onchange({target:{name:'ship_mode_code',value:'parcel',dataset:{}}});
 assert.ok(t.d.els['lg-f-fassto'].innerHTML.includes('name="r_name_text"'));
 t.d.els.content.oninput({target:{id:'lg-item-q',value:'8800',dataset:{}}});
 assert.ok(t.d.els['lg-item-results'].innerHTML.includes('data-item-add="0012345"'));
 click(t.d,{itemAdd:'0012345'});
 assert.ok(t.d.els['lg-item-lines'].innerHTML.includes('name="item_qty_0"'));
 assert.equal(t.d.els['lg-item-results'].innerHTML,'');
 t.d.els.content.oninput({target:{name:'item_qty_0',value:'151',dataset:{itemField:'qty',line:'0'}}});
 assert.equal(t.d.els['lg-item-warn-0'].textContent,'출고 가능 150개보다 많아요.'); // 경고만, 막지 않는다
 t.d.els.content.onchange({target:{name:'item_lot_0',value:'L2',dataset:{itemField:'lot',line:'0'}}});
 assert.deepEqual([t.page.state.formFassto.items[0].lot_text,t.page.state.formFassto.items[0].expires_on],['L2','2028-06-30']);
 await submit(t.d,{type_code:'sample',title_text:'샘플',team_code:'global',counterparty_text:'가짜 바이어',want_date:'',ship_mode_code:'parcel',qty_summary_text:'',note_text:'',invoice_id:'',
  r_name_text:'홍길동',r_phone_text:'010-0000-0000',r_postal_text:'',r_address1_text:'가짜시 가짜로 1',r_address2_text:'',item_qty_0:'2',item_lot_0:'L2'},'create');
 assert.deepEqual(order,['request','recipient','items']);
 const up=t.calls.find(c=>c.table==='logistics_request_recipients'&&c.ops[0][0]==='upsert');
 assert.equal(up.ops[0][1].name_text,'홍길동');assert.ok(!('courier_text' in up.ops[0][1]));
 const rpc=t.calls.find(c=>c.table==='rpc:logistics_replace_items').ops[0][1];
 assert.deepEqual([rpc.p_request,rpc.p_items[0].product_code,rpc.p_items[0].qty,rpc.p_items[0].lot_text,rpc.p_items[0].expires_on],['new1','0012345',2,'L2','2028-06-30']);
 assert.match(t.messages.at(-1),/요청을 올렸어요/);
});

test('mountTab: 품목 저장이 실패해도 요청은 올라갔다고 알리고, 형식이 틀리면 아무것도 보내지 않는다',async()=>{
 const rows=[];
 const t=setup({rows,handler:q=>{
  const s=stockHandler(q);if(s)return s;
  if(q.table==='logistics_requests'&&q.ops[0][0]==='insert'){rows.push(R('new1',{requester_email:'handler@entropymakeup.com',ship_mode_code:'direct'}));return {data:{id:'new1'},error:null};}
  if(q.table==='rpc:logistics_replace_items')return {data:null,error:{message:'LOGISTICS_ITEM_BAD'}};
  return null;}});
 await t.page.show();click(t.d,{act:'new'});
 t.d.els.content.onchange({target:{name:'ship_mode_code',value:'direct',dataset:{}}});
 t.d.els.content.oninput({target:{id:'lg-item-q',value:'쇼핑',dataset:{}}});click(t.d,{itemAdd:'A-9'});
 const vals={type_code:'b2b',title_text:'직납',team_code:'domestic',counterparty_text:'가짜 매장',want_date:'',ship_mode_code:'direct',qty_summary_text:'',note_text:'',invoice_id:''};
 await submit(t.d,{...vals,item_qty_0:'0'},'create');
 assert.match(t.d.els['lg-form-error'].textContent,/1번째 품목의 수량을 1 이상의 정수로 적어 주세요/);
 assert.ok(!t.calls.some(c=>c.table==='logistics_requests'&&c.ops[0][0]==='insert'));
 await submit(t.d,{...vals,item_qty_0:'3'},'create');
 assert.match(t.messages.at(-1),/요청은 올라갔고 품목은 저장하지 못했어요\. 상세에서 다시 입력해 주세요\./);
 assert.equal(t.d.els['lg-detail'].open,true);
});

test('mountTab: 상세의 파스토 양식 내려받기는 빠진 칸이 있으면 창 안에 목록만 보이고, 통과하면 양식 파일을 저장한다',async()=>{
 const saved=[];let recipient={request_id:'r1',name_text:'홍길동',phone_text:'',address1_text:'가짜시 가짜로 1'};
 const t=setup({rows:[R('r1',{ship_mode_code:'parcel',fassto_order_no:'LG20261120_001',requester_email:'req@entropymakeup.com'})],xlsx:require('xlsx'),saveWorkbook:(wb,name)=>saved.push([wb,name]),
  handler:q=>{const s=stockHandler(q);if(s)return s;
   if(q.table==='logistics_request_recipients')return {data:[recipient],error:null};
   if(q.table==='logistics_request_items')return {data:[{product_code:'0012345',product_name_text:'가짜 립',qty:2,lot_text:'',expires_on:null,line_no:1}],error:null};
   return null;}});
 await t.page.show();await t.page.openDetail('r1');
 assert.ok(t.d.els['lg-detail'].innerHTML.includes('data-act="fassto-download"'));
 click(t.d,{act:'fassto-download'});
 assert.equal(saved.length,0);
 assert.match(t.d.els['lg-detail'].innerHTML,/<li>받는 곳: 전화 칸이 비어 있어요\.<\/li>/);
 recipient={...recipient,phone_text:'010-0000-0000'};
 await t.page.openDetail('r1');
 click(t.d,{act:'fassto-download'});
 assert.equal(saved.length,1);
 assert.equal(saved[0][1],'파스토_택배신청_LG20261120_001.xlsx');
 assert.deepEqual(saved[0][0].SheetNames,['파스토제공-택배신청']);
 assert.equal(saved[0][0].Sheets['파스토제공-택배신청'].I5.v,'0012345');
 assert.ok(t.d.els['lg-detail'].innerHTML.includes('파스토 양식을 내려받았어요.'));
 assert.ok(!t.d.els['lg-detail'].innerHTML.includes('내려받지 않았어요'));
});

test('mountTab: 다른 직원은 받는 곳을 부르지 않고, 요약 수정은 담당자만 운송사를 보내며 바뀌지 않은 품목은 다시 저장하지 않는다',async()=>{
 const rows=[R('r1',{ship_mode_code:'express',requester_email:'req@entropymakeup.com'})];
 const rec={request_id:'r1',name_text:'Buyer',country_code:'CH',currency_code:'USD',courier_text:'',incoterms_code:'',sender_name_text:'',sender_phone_text:'',sender_address_text:'',sender_email_text:''};
 const h=q=>{const s=stockHandler(q);if(s)return s;
  if(q.table==='logistics_request_recipients'&&q.ops[0][0]==='upsert')return {data:[{request_id:'r1'}],error:null};
  if(q.table==='logistics_request_recipients')return {data:[rec],error:null};
  if(q.table==='logistics_request_items')return {data:[{product_code:'0012345',product_name_text:'가짜 립',qty:2,lot_text:'',unit_price:10,line_no:1}],error:null};
  if(q.table==='rpc:logistics_replace_items')return {data:q.ops[0][1].p_items.length,error:null};
  return null;};
 const other=setup({rows,email:'other@entropymakeup.com',handler:h});
 await other.page.show();await other.page.openDetail('r1');
 assert.ok(!other.calls.some(c=>c.table==='logistics_request_recipients'));
 assert.ok(other.d.els['lg-detail'].innerHTML.includes('요청자와 물류 담당자만 볼 수 있어요.'));
 const t=setup({rows,handler:h}); // 담당자
 await t.page.show();await t.page.openDetail('r1');
 click(t.d,{act:'edit-summary'});
 assert.ok(t.d.els['lg-form'].innerHTML.includes('name="r_courier_text"'));
 const summary={type_code:'quick',title_text:'요청 r1',team_code:'global',counterparty_text:'c',want_date:'',ship_mode_code:'express',qty_summary_text:'',note_text:'',invoice_id:''};
 await submit(t.d,{...summary,r_courier_text:'FEDEX',r_incoterms_code:'DAP',item_qty_0:'2',item_unit_price_0:'10'},'edit');
 const up=t.calls.filter(c=>c.table==='logistics_request_recipients'&&c.ops[0][0]==='upsert');
 assert.equal(up.length,1);assert.deepEqual([up[0].ops[0][1].courier_text,up[0].ops[0][1].incoterms_code],['FEDEX','DAP']);
 assert.ok(!t.calls.some(c=>c.table==='rpc:logistics_replace_items')); // 품목은 그대로라 보내지 않는다
 const owner=setup({rows,email:'req@entropymakeup.com',handler:h});
 await owner.page.show();await owner.page.openDetail('r1');
 click(owner.d,{act:'edit-summary'});
 assert.ok(!owner.d.els['lg-form'].innerHTML.includes('name="r_courier_text"'));
 await submit(owner.d,{...summary,r_name_text:'New Buyer',item_qty_0:'3',item_unit_price_0:'10'},'edit');
 const up2=owner.calls.find(c=>c.table==='logistics_request_recipients'&&c.ops[0][0]==='upsert').ops[0][1];
 assert.equal(up2.name_text,'New Buyer');assert.ok(!('courier_text' in up2));
 assert.equal(owner.calls.find(c=>c.table==='rpc:logistics_replace_items').ops[0][1].p_items[0].qty,3);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test tests/logistics-ui.test.cjs
```
Expected: FAIL 5개 — `lg-stock-line`이 비어 있음, `t.page.state.formFassto`가 undefined 등

- [ ] **Step 3: Write the implementation**

1) `logistics.js`에서 아래 부분(파일 안에 한 번만 있음)을 찾아

```js
function mountTab({document,client,onMessage=()=>{},now=()=>Date.now(),confirm=m=>root.confirm(m),location=root.location,history=root.history,open=u=>root.open(u,'_blank')}){
 const $=id=>document.getElementById(id);
 const api=createApi(client,{now});
 const EMPTY=()=>({requests:[],files:[],handlers:[],people:[],invoices:[]});
 const state={active:false,loaded:false,loading:false,error:'',email:'',isHandler:false,data:EMPTY(),tab:'todo',quick:'',q:'',
  selected:null,detail:{comments:[],history:[]},detailLoading:false,pending:null,detailError:'',detailNote:'',busy:false,form:null,editTarget:null,pendingOpen:null,ready:Promise.resolve(),commentDraft:'',renderedId:null};
```

다음으로 바꾼다.

```js
function mountTab({document,client,onMessage=()=>{},now=()=>Date.now(),confirm=m=>root.confirm(m),location=root.location,history=root.history,open=u=>root.open(u,'_blank'),xlsx=null,saveWorkbook=null}){
 const $=id=>document.getElementById(id);
 const api=createApi(client,{now});
 const EMPTY=()=>({requests:[],files:[],handlers:[],people:[],invoices:[]});
 const NO_STOCK=()=>({rows:[],groups:[],sync:null,error:''});
 const NO_FASSTO=()=>({loaded:false,loading:false,recipient:null,items:[],error:''});
 const XL=()=>xlsx||root.XLSX;
 const save=saveWorkbook||((wb,name)=>XL().writeFile(wb,name));
 const state={active:false,loaded:false,loading:false,error:'',email:'',isHandler:false,data:EMPTY(),tab:'todo',quick:'',q:'',
  selected:null,detail:{comments:[],history:[]},detailLoading:false,pending:null,detailError:'',detailNote:'',busy:false,form:null,editTarget:null,pendingOpen:null,ready:Promise.resolve(),commentDraft:'',renderedId:null,
  stock:NO_STOCK(),fassto:NO_FASSTO(),fasstoErrors:[],formFassto:null};
```

2) `logistics.js`에서 아래 부분(파일 안에 한 번만 있음)을 찾아

```js
const ctx=()=>({email:state.email,isHandler:state.isHandler,nowMs:now(),files:state.data.files,people:state.data.people,handlers:state.data.handlers,invoices:state.data.invoices});
```

다음으로 바꾼다.

```js
const ctx=()=>({email:state.email,isHandler:state.isHandler,nowMs:now(),files:state.data.files,people:state.data.people,handlers:state.data.handlers,invoices:state.data.invoices,groups:state.stock.groups,stock:state.stock});
```

3) `logistics.js`에서 아래 부분(파일 안에 한 번만 있음)을 찾아

```js
  const k=$('lg-kpis'),t=$('lg-tabs'),nowMs=now();
  if(k)k.innerHTML=state.loaded?renderKpis(summarize(state.data.requests,nowMs),state.quick||(state.tab==='todo'?'todo':'')):'';
```

다음으로 바꾼다.

```js
  const k=$('lg-kpis'),t=$('lg-tabs'),sl=$('lg-stock-line'),nowMs=now();
  if(k)k.innerHTML=state.loaded?renderKpis(summarize(state.data.requests,nowMs),state.quick||(state.tab==='todo'?'todo':'')):'';
  if(sl)sl.innerHTML=state.loaded?renderStockBanner(state.stock,nowMs):'';
```

4) `logistics.js`에서 아래 부분(파일 안에 한 번만 있음)을 찾아

```js
  d.innerHTML=renderDetail(r,{...ctx(),...state.detail,loading:state.detailLoading,pending:state.pending,error:state.detailError,note:state.detailNote,commentDraft:state.commentDraft});
```

다음으로 바꾼다.

```js
  d.innerHTML=renderDetail(r,{...ctx(),...state.detail,loading:state.detailLoading,pending:state.pending,error:state.detailError,note:state.detailNote,commentDraft:state.commentDraft,fassto:state.fassto,fasstoErrors:state.fasstoErrors});
```

5) `logistics.js`에서 아래 부분(파일 안에 한 번만 있음)을 찾아

```js
function closeDetail(){state.selected=null;state.renderedId=null;state.commentDraft='';state.pending=null;state.detailError='';state.detailNote='';state.detail={comments:[],history:[]};const d=$('lg-detail');dlgClose(d);if(d)d.innerHTML='';}
 function closeForm(){state.form=null;state.editTarget=null;const f=$('lg-form');dlgClose(f);if(f)f.innerHTML='';}
```

다음으로 바꾼다.

```js
function closeDetail(){state.selected=null;state.renderedId=null;state.commentDraft='';state.pending=null;state.detailError='';state.detailNote='';state.detail={comments:[],history:[]};state.fassto=NO_FASSTO();state.fasstoErrors=[];const d=$('lg-detail');dlgClose(d);if(d)d.innerHTML='';}
 function closeForm(){state.form=null;state.editTarget=null;state.formFassto=null;const f=$('lg-form');dlgClose(f);if(f)f.innerHTML='';}
```

6) `logistics.js`에서 아래 부분(파일 안에 한 번만 있음)을 찾아

```js
  if(!keep||!same){captureInputs();state.pending=null;state.detailError='';state.detailNote='';state.commentDraft='';state.renderedId=null;}
  const r0=current();
  if(!r0){closeDetail();say('요청을 찾지 못했어요. 닫힌 지 180일이 지났거나 지워진 요청일 수 있어요.');return;}
  state.detail={comments:[],history:[]};state.detailLoading=true;
```

다음으로 바꾼다.

```js
  if(!keep||!same){captureInputs();state.pending=null;state.detailError='';state.detailNote='';state.commentDraft='';state.renderedId=null;state.fasstoErrors=[];}
  const r0=current();
  if(!r0){closeDetail();say('요청을 찾지 못했어요. 닫힌 지 180일이 지났거나 지워진 요청일 수 있어요.');return;}
  state.detail={comments:[],history:[]};state.detailLoading=true;state.fassto={...NO_FASSTO(),loading:true};
```

7) `logistics.js`에서 아래 부분(파일 안에 한 번만 있음)을 찾아

```js
  try{const d=await api.loadDetail(id);if(g!==generation||state.selected!==id)return;state.detail=d;}
  catch(e){if(g!==generation||state.selected!==id)return;state.detailError='댓글과 이력을 불러오지 못했어요: '+(e?.message||e);}
  state.detailLoading=false;drawDetail();
 }
```

다음으로 바꾼다.

```js
  // 받는 곳은 요청자·담당자만 부른다(다른 사람은 RLS가 0행). 품목은 운송 방식이 바뀌었을 때도 보이게 늘 부른다.
  const canSee=state.isHandler||state.email===String(r0.requester_email||'').toLowerCase();
  const [det,rec,its]=await Promise.allSettled([api.loadDetail(id),canSee?api.loadRecipient(id):Promise.resolve(null),api.loadItems(id)]);
  if(g!==generation||state.selected!==id)return;
  if(det.status==='fulfilled')state.detail=det.value;else state.detailError='댓글과 이력을 불러오지 못했어요: '+(det.reason?.message||det.reason);
  if(rec.status==='fulfilled'&&its.status==='fulfilled')state.fassto={loaded:true,loading:false,recipient:rec.value,items:its.value||[],error:''};
  else{const e=rec.status==='rejected'?rec.reason:its.reason;state.fassto={...NO_FASSTO(),error:'받는 곳과 품목을 불러오지 못했어요: '+(e?.message||e)};}
  state.detailLoading=false;drawDetail();
 }
```

8) `logistics.js`에서 아래 부분(파일 안에 한 번만 있음)을 찾아

```js
   const d=await api.loadAll();if(g!==generation)return;
   state.email=email;state.data=d;state.isHandler=M.isHandler(email,d.handlers);state.loaded=true;
```

다음으로 바꾼다.

```js
   // 파스토 목록을 못 받아도 물류 요청 화면은 연다(목록 줄에 오류를 보인다)
   const [d,stock]=await Promise.all([api.loadAll(),api.loadStock().then(x=>({...x,groups:F.groupStock(x.rows),error:''}),e=>({...NO_STOCK(),error:String(e?.message||e)}))]);
   if(g!==generation)return;
   state.email=email;state.data=d;state.stock=stock;state.isHandler=M.isHandler(email,d.handlers);state.loaded=true;
```

9) `logistics.js`에서 아래 부분(파일 안에 한 번만 있음)을 찾아

```js
function openForm(mode,draft){
  const f=$('lg-form');if(!state.active||!f)return;
  state.form={mode};
  f.innerHTML=renderForm(draft,{invoices:state.data.invoices,mode,isHandler:state.isHandler});dlgOpen(f);
  try{f.querySelector?.('select,input')?.focus?.();}catch(_){}
 }
 function openNew(){if(!state.active||!state.loaded)return;state.editTarget=null;openForm('create',{team_code:'',want_date:''});}
 function openEdit(){const r=current();if(!r)return;state.editTarget={id:r.id,status_code:r.status_code};openForm('edit',{...r});}
```

다음으로 바꾼다.

```js
const fasstoCtx=()=>({isHandler:state.isHandler,groups:state.stock.groups,stock:state.stock,nowMs:now()});
 function openForm(mode,draft){
  const f=$('lg-form');if(!state.active||!f)return;
  state.form={mode};
  f.innerHTML=renderForm(draft,{invoices:state.data.invoices,mode,...fasstoCtx(),fassto:state.formFassto});dlgOpen(f);
  try{f.querySelector?.('select,input')?.focus?.();}catch(_){}
 }
 // 창에서 고치는 받는 곳·품목의 사본. orig*는 바뀌지 않았으면 저장하지 않으려고 둔다.
 function formFasstoFrom(recipient,items,mode){
  return {form:F.formFor(mode),recipient:{...(recipient||{})},items:(items||[]).map(x=>({...x})),q:'',hadRecipient:Boolean(recipient),
   origRecipient:JSON.stringify(F.toRecipientRow(recipient||{},{isHandler:state.isHandler})),origItems:JSON.stringify(F.toItemRows(items||[]))};
 }
 function openNew(){if(!state.active||!state.loaded)return;state.editTarget=null;state.formFassto=formFasstoFrom(null,[],'');openForm('create',{team_code:'',want_date:''});}
 function openEdit(){
  const r=current();if(!r)return;
  state.editTarget={id:r.id,status_code:r.status_code};
  state.formFassto=state.fassto.loaded?formFasstoFrom(state.fassto.recipient,state.fassto.items,r.ship_mode_code):null; // 못 불러왔으면 받는 곳·품목은 건드리지 않는다
  openForm('edit',{...r});
 }
 const lotExpiry=(it,lot)=>{const l=state.stock.groups.find(g=>g.product_code===it.product_code)?.lots.find(x=>x.lot_text===lot);return lot?(l?l.expires_on:(it.lot_text===lot?it.expires_on:null)):null;};
 // 폼 값(r_*, item_*_<줄>)을 창 사본에 덮어 받는 곳·품목을 만든다. 입력 이벤트를 놓쳐도 제출 순간의 값이 이긴다.
 function fasstoFromForm(draft){
  const fx=state.formFassto;if(!fx)return null;
  const recipient={...fx.recipient};
  for(const k of [...F.RECIPIENT_KEYS,...F.HANDLER_KEYS])if(('r_'+k) in draft)recipient[k]=draft['r_'+k];
  const items=fx.items.map((it,i)=>{
   const o={...it};
   for(const k of ['qty','unit_price','weight_kg','en_name_text'])if(`item_${k}_${i}` in draft)o[k]=draft[`item_${k}_${i}`];
   if(`item_lot_${i}` in draft){const lot=draft[`item_lot_${i}`];o.expires_on=lotExpiry(it,lot);o.lot_text=lot;}
   return o;});
  return {...fx,recipient,items};
 }
 const hasRecipientValues=r=>F.RECIPIENT_KEYS.some(k=>String(r?.[k]??'').trim());
 // 요청 저장 뒤 받는 곳 → 품목 순서로 저장한다. 바뀌지 않은 것은 보내지 않는다.
 async function saveFassto(id,form,fx){
  if(!form||!fx)return;
  const rec=F.toRecipientRow(fx.recipient,{isHandler:state.isHandler});
  if(form!=='vehicle'&&(fx.hadRecipient||hasRecipientValues(fx.recipient))&&JSON.stringify(rec)!==fx.origRecipient)await api.saveRecipient(id,rec);
  if(JSON.stringify(F.toItemRows(fx.items))!==fx.origItems)await api.saveItems(id,fx.items);
 }
 function drawItems(){const host=$('lg-item-lines'),fx=state.formFassto;if(host&&fx)host.innerHTML=renderItems(fx.items,{form:fx.form,groups:state.stock.groups});}
 function addItem(code){
  const fx=state.formFassto;if(!fx||state.busy)return;
  if(fx.items.length>=F.MAX_ITEMS)return formError('품목은 50줄까지 넣을 수 있어요.');
  const g=state.stock.groups.find(x=>x.product_code===code);if(!g)return;
  fx.items.push({product_code:g.product_code,product_name_text:g.product_name,qty:1,lot_text:'',expires_on:null,en_name_text:'',weight_kg:'',unit_price:''});
  fx.q='';const q=$('lg-item-q');if(q)q.value='';const res=$('lg-item-results');if(res)res.innerHTML='';
  formError('');drawItems();
 }
 function removeItem(i){const fx=state.formFassto;if(!fx||state.busy||!fx.items[i])return;fx.items.splice(i,1);drawItems();}
 function updateItem(i,field,value){
  const it=state.formFassto?.items[i];if(!it)return;
  if(field==='lot'){it.expires_on=lotExpiry(it,value);it.lot_text=value;}else it[field]=value;
  const w=$('lg-item-warn-'+i);if(w)w.textContent=itemWarn(it,state.stock.groups);
 }
 function downloadFassto(){
  const r=current();if(!r||state.busy)return;
  const form=F.formFor(r.ship_mode_code);if(!form||!state.fassto.loaded)return;
  const {recipient,items}=state.fassto;
  const errors=F.validate(form,r,recipient,items);
  state.detailError='';state.detailNote='';
  if(errors.length){state.fasstoErrors=errors;drawDetail();return;}
  try{
   save(F.toWorkbook(form,F.buildRows(form,r,recipient,items),XL()),F.fileName(form,r));
   const warn=F.stockWarnings(items,state.stock.groups);
   state.fasstoErrors=[];state.detailNote='파스토 양식을 내려받았어요.'+(warn.length?' 확인할 점: '+warn.join(' '):'');
  }catch(e){state.fasstoErrors=[String(e?.message||e)];}
  drawDetail();
 }
```

10) `logistics.js`에서 아래 부분(파일 안에 한 번만 있음)을 찾아

```js
  const draft=readForm(form),errors=M.validateDraft(draft);
  if(errors.length)return formError(errors.join(' '));
  const row=M.toInsertRow(draft),patch={};
  for(const k of SUMMARY)patch[k]=row[k];
  if(state.isHandler)for(const k of ['packing_code','etd_on','forwarder_text'])patch[k]=row[k];
  setBusy(true);formError('');
  try{await api.update(t.id,t.status_code,patch);closeForm();state.detailNote='요약을 저장했어요.';say(state.detailNote);await reload();}
  catch(e){
   if(!isStale(e)){formError(M.errorMessage(e));return;}
```

다음으로 바꾼다.

```js
  const draft=readForm(form),errors=M.validateDraft(draft);
  const fform=F.formFor(draft.ship_mode_code),fx=fasstoFromForm(draft);
  if(fform&&fx)errors.push(...F.checkInput(fform,fx.recipient,fx.items));
  if(errors.length)return formError(errors.join(' '));
  const row=M.toInsertRow(draft),patch={};
  for(const k of SUMMARY)patch[k]=row[k];
  if(state.isHandler)for(const k of ['packing_code','etd_on','forwarder_text'])patch[k]=row[k];
  setBusy(true);formError('');
  let summarySaved=false;
  try{
   await api.update(t.id,t.status_code,patch);summarySaved=true;
   await saveFassto(t.id,fform,fx);
   closeForm();state.detailNote='요약을 저장했어요.';say(state.detailNote);await reload();
  }
  catch(e){
   if(summarySaved){formError('요약은 저장했지만 받는 곳·품목은 저장하지 못했어요. 다시 저장해 주세요. ('+M.errorMessage(e)+')');return;}
   if(!isStale(e)){formError(M.errorMessage(e));return;}
```

11) `logistics.js`에서 아래 부분(파일 안에 한 번만 있음)을 찾아

```js
  const draft=readForm(form),errors=M.validateDraft(draft);
  if(errors.length)return formError(errors.join(' '));
  const picked=Array.from($('lg-f-files')?.files||[]); // 기다리는 동안 창이 바뀌어도 고른 파일을 잃지 않게 먼저 읽는다
  setBusy(true);formError('');
  let row=null;
  try{
   row=await api.create(draft);const failed=[];
   for(const f of picked){try{await api.uploadFile(row.id,f,'request');}catch(e){failed.push(f.name);}}
   closeForm();state.tab='mine';state.quick='';state.selected=row.id;state.pending=null;state.detailError='';
   state.detailNote=failed.length?`요청은 올라갔고, ${failed.join(', ')} 파일은 올리지 못했어요. 아래 첨부에서 다시 올려 주세요.`:'요청을 올렸어요. 슬랙에도 곧 알림이 가요.';
```

다음으로 바꾼다.

```js
  const draft=readForm(form),errors=M.validateDraft(draft);
  const fform=F.formFor(draft.ship_mode_code),fx=fasstoFromForm(draft);
  if(fform&&fx)errors.push(...F.checkInput(fform,fx.recipient,fx.items));
  if(errors.length)return formError(errors.join(' '));
  const picked=Array.from($('lg-f-files')?.files||[]); // 기다리는 동안 창이 바뀌어도 고른 파일을 잃지 않게 먼저 읽는다
  setBusy(true);formError('');
  let row=null;
  try{
   row=await api.create(draft);const failed=[];let fasstoFailed=false;
   try{await saveFassto(row.id,fform,fx);}catch(e){fasstoFailed=true;} // 저장 순서: 요청 → 받는 곳 → 품목
   for(const f of picked){try{await api.uploadFile(row.id,f,'request');}catch(e){failed.push(f.name);}}
   closeForm();state.tab='mine';state.quick='';state.selected=row.id;state.pending=null;state.detailError='';
   const notes=[];
   if(fasstoFailed)notes.push('요청은 올라갔고 품목은 저장하지 못했어요. 상세에서 다시 입력해 주세요.');
   if(failed.length)notes.push(`요청은 올라갔고, ${failed.join(', ')} 파일은 올리지 못했어요. 아래 첨부에서 다시 올려 주세요.`);
   state.detailNote=notes.length?notes.join(' '):'요청을 올렸어요. 슬랙에도 곧 알림이 가요.';
```

12) `logistics.js`에서 아래 부분(파일 안에 한 번만 있음)을 찾아

```js
   if(act==='edit-result'){if(state.busy)return;state.pending={kind:'result'};state.detailError='';drawDetail();focusPending();return;}
   return;
  }
```

다음으로 바꾼다.

```js
   if(act==='edit-result'){if(state.busy)return;state.pending={kind:'result'};state.detailError='';drawDetail();focusPending();return;}
   if(act==='fassto-download')return downloadFassto();
   return;
  }
  if((el=at('[data-item-add]')))return addItem(el.dataset.itemAdd);
  if((el=at('[data-item-del]')))return removeItem(Number(el.dataset.itemDel));
```

13) `logistics.js`에서 아래 부분(파일 안에 한 번만 있음)을 찾아

```js
  if(t?.name==='type_code'||t?.name==='ship_mode_code'){
   const fs=$('lg-f-overseas');if(fs)fs.hidden=!M.needsOverseas({type_code:$('lg-f-type_code')?.value,ship_mode_code:$('lg-f-ship_mode_code')?.value});
  }
 }
 function onInput(e){
  if(e.target?.id==='lg-search'){state.q=e.target.value;drawList();return;}
```

다음으로 바꾼다.

```js
  if(t?.name==='type_code'||t?.name==='ship_mode_code'){
   const fs=$('lg-f-overseas');if(fs)fs.hidden=!M.needsOverseas({type_code:$('lg-f-type_code')?.value,ship_mode_code:$('lg-f-ship_mode_code')?.value});
  }
  if(t?.name==='ship_mode_code'){
   if(state.formFassto)state.formFassto.form=F.formFor(t.value);
   const host=$('lg-f-fassto');if(host)host.innerHTML=renderFasstoFields(t.value,state.formFassto,fasstoCtx());
   return;
  }
  if(t?.dataset?.recipient&&state.formFassto){state.formFassto.recipient[t.dataset.recipient]=t.value;return;}
  if(t?.dataset?.itemField)return updateItem(Number(t.dataset.line),t.dataset.itemField,t.value);
 }
 function onInput(e){
  const t=e.target;
  if(t?.id==='lg-item-q'&&state.formFassto){state.formFassto.q=t.value;const host=$('lg-item-results');if(host)host.innerHTML=renderStockResults(F.searchStock(state.stock.groups,t.value),t.value);return;}
  if(t?.dataset?.recipient&&state.formFassto){state.formFassto.recipient[t.dataset.recipient]=t.value;return;}
  if(t?.dataset?.itemField&&t.dataset.itemField!=='lot')return updateItem(Number(t.dataset.line),t.dataset.itemField,t.value);
  if(e.target?.id==='lg-search'){state.q=e.target.value;drawList();return;}
```

14) `logistics.js`에서 아래 부분(파일 안에 한 번만 있음)을 찾아

```js
  $('content').innerHTML='<section class="lg"><div class="kpi-grid lg-kpis" id="lg-kpis"></div>'
```

다음으로 바꾼다.

```js
  $('content').innerHTML='<section class="lg"><div class="kpi-grid lg-kpis" id="lg-kpis"></div><div id="lg-stock-line"></div>'
```

15) `logistics.js`에서 아래 부분(파일 안에 한 번만 있음)을 찾아

```js
  for(const el of [d,f]){el.onkeydown=e=>e.stopPropagation?.();el.onpaste=e=>e.stopPropagation?.();}
```

다음으로 바꾼다.

```js
  for(const el of [d,f]){el.onkeydown=e=>e.stopPropagation?.();el.onpaste=e=>e.stopPropagation?.();}
  f.onkeydown=e=>{e.stopPropagation?.();if(e.key==='Enter'&&e.target?.id==='lg-item-q')e.preventDefault?.();}; // 상품 찾기에서 Enter가 요청을 올리지 않게
```

16) `logistics.js`에서 아래 부분(파일 안에 한 번만 있음)을 찾아

```js
  if(ev==='SIGNED_OUT'){hide();generation++;Object.assign(state,{loaded:false,loading:false,error:'',email:'',isHandler:false,data:EMPTY(),tab:'todo',quick:'',q:'',busy:false});}
```

다음으로 바꾼다.

```js
  if(ev==='SIGNED_OUT'){hide();generation++;Object.assign(state,{loaded:false,loading:false,error:'',email:'',isHandler:false,data:EMPTY(),tab:'todo',quick:'',q:'',busy:false,stock:NO_STOCK(),fassto:NO_FASSTO(),fasstoErrors:[],formFassto:null});}
```

17) `logistics.js`에서 아래 부분(파일 안에 한 번만 있음)을 찾아

```js
return {show,hide,reload,openRequest,takeUrlRequest,state,changeStatus:chooseStatus,openDetail};
```

다음으로 바꾼다.

```js
return {show,hide,reload,openRequest,takeUrlRequest,state,changeStatus:chooseStatus,openDetail,downloadFassto};
```

`logistics.css` 끝에 추가:

```css
/* 파스토 양식(받는 곳·품목·목록 갱신 시각) */
.lg-hint{margin:0;font-size:11px;color:var(--text2)}
.lg-fassto{display:grid;gap:10px;margin-top:12px}
.lg-fassto-box{border:1px solid var(--border2);border-radius:var(--radius);padding:10px;margin:0;min-width:0}
.lg-fassto-box legend{font-size:11px;color:var(--text2);padding:0 4px}
.lg-fassto-box legend small,.lg-items th small{color:var(--text3);font-weight:400}
.lg-handler-only{margin-top:10px;padding-top:10px;border-top:1px dashed var(--border2)}
.lg-stock{margin:0;font-size:11px;color:var(--text2)}
.lg-stock.warn{color:var(--amber);background:var(--amber-light);border-radius:var(--radius);padding:4px 8px;font-weight:600}
.lg-stock-results{list-style:none;margin:6px 0 0;padding:0;display:grid;gap:4px;max-height:180px;overflow-y:auto}
.lg-items{width:100%}
.lg-items td,.lg-items th{vertical-align:top}
.lg-items input,.lg-items select{width:100%;min-width:56px;font:inherit;font-size:12px;padding:4px 6px;border:0.5px solid var(--border2);border-radius:var(--radius);background:var(--bg2);color:var(--text)}
.lg-item-warn{color:var(--amber);font-size:11px}
.lg-sec h4{font-size:11px;margin:10px 0 6px;color:var(--text2)}
.lg-error ul{margin:4px 0 0;padding-left:1.2em}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
node --test tests/logistics-ui.test.cjs tests/logistics-model.test.cjs && npm run check
```
Expected: PASS (기존 mountTab 테스트 포함 전부)

- [ ] **Step 5: Commit**

```bash
git add logistics.js logistics.css tests/logistics-ui.test.cjs
GIT_AUTHOR_NAME=sylee GIT_AUTHOR_EMAIL=sylee@entropymakeup.com GIT_COMMITTER_NAME=sylee GIT_COMMITTER_EMAIL=sylee@entropymakeup.com git commit -m "$(cat <<'EOF'
물류 요청: 받는 곳·품목 입력과 파스토 양식 내려받기 연결

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: 대시보드에 스크립트 연결과 버전 쿼리

**Files:**
- Modify: `index.html`, `tests/logistics-ui.test.cjs` (기존 '대시보드: 메뉴는…' 테스트의 버전·순서 기대값)

**Interfaces:**
- Consumes: `fassto-forms.js`(전역 `FasstoForms`), 기존 `<script src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js">`(index.html 20행, 전역 `XLSX`)
- Produces: 스크립트 순서 SheetJS → `logistics-model.js` → `fassto-forms.js` → `logistics.js` → `app.js` → `mountTab` 호출. 버전 쿼리 `?v=20261120-fassto-1`. `app.js`는 바꾸지 않는다(`tests/asset-cache.test.cjs`의 app.js 해시 그대로).

- [ ] **Step 1: Write the failing test**

1) `tests/logistics-ui.test.cjs`에서 아래 부분(파일 안에 한 번만 있음)을 찾아

```js
 assert.ok(index.includes('<link rel="stylesheet" href="logistics.css?v=20261120-logistics-tab-1">'));
 const iModel=index.indexOf('<script src="logistics-model.js?v=20261120-logistics-tab-1"></script>'),iPage=index.indexOf('<script src="logistics.js?v=20261120-logistics-tab-1"></script>');
 const iApp=index.indexOf('<script src="app.js?v='),iMount=index.indexOf('globalThis.logistics=LogisticsPage.mountTab({document,client:sb,onMessage:m=>toast(m)});');
 assert.ok(iModel>0&&iModel<iPage&&iPage<iApp&&iApp<iMount);
```

다음으로 바꾼다.

```js
 assert.ok(index.includes('<link rel="stylesheet" href="logistics.css?v=20261120-fassto-1">'));
 const iModel=index.indexOf('<script src="logistics-model.js?v=20261120-fassto-1"></script>'),iForms=index.indexOf('<script src="fassto-forms.js?v=20261120-fassto-1"></script>'),iPage=index.indexOf('<script src="logistics.js?v=20261120-fassto-1"></script>');
 const iXlsx=index.indexOf('<script src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"></script>');
 const iApp=index.indexOf('<script src="app.js?v='),iMount=index.indexOf('globalThis.logistics=LogisticsPage.mountTab({document,client:sb,onMessage:m=>toast(m)});');
 assert.ok(iXlsx>0&&iXlsx<iModel&&iModel<iForms&&iForms<iPage&&iPage<iApp&&iApp<iMount);
 assert.equal((index.match(/xlsx[^"]*\.js/g)||[]).length,1); // 브라우저 엑셀 라이브러리는 기존 SheetJS 0.18.5 하나뿐
```

2) `tests/logistics-ui.test.cjs`에서 아래 부분(파일 안에 한 번만 있음)을 찾아

```js
 assert.match(pkg.scripts.check,/node --check logistics-model\.js && node --check logistics\.js/);
```

다음으로 바꾼다.

```js
 assert.match(pkg.scripts.check,/node --check logistics-model\.js && node --check logistics\.js && node --check fassto-forms\.js && node --check tools\/fassto-stock-json\.cjs/);
 assert.equal(pkg.devDependencies.xlsx,'0.18.5');
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test tests/logistics-ui.test.cjs
```
Expected: FAIL 1개 — `logistics.css?v=20261120-fassto-1`이 없음

- [ ] **Step 3: 변경하기**

1) `index.html`에서 아래 부분(파일 안에 한 번만 있음)을 찾아

```html
<link rel="stylesheet" href="logistics.css?v=20261120-logistics-tab-1">
<script src="logistics-model.js?v=20261120-logistics-tab-1"></script>
<script src="logistics.js?v=20261120-logistics-tab-1"></script>
```

다음으로 바꾼다.

```html
<link rel="stylesheet" href="logistics.css?v=20261120-fassto-1">
<script src="logistics-model.js?v=20261120-fassto-1"></script>
<script src="fassto-forms.js?v=20261120-fassto-1"></script>
<script src="logistics.js?v=20261120-fassto-1"></script>
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
node --test tests/logistics-ui.test.cjs tests/asset-cache.test.cjs && npm run check
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add index.html tests/logistics-ui.test.cjs
GIT_AUTHOR_NAME=sylee GIT_AUTHOR_EMAIL=sylee@entropymakeup.com GIT_COMMITTER_NAME=sylee GIT_COMMITTER_EMAIL=sylee@entropymakeup.com git commit -m "$(cat <<'EOF'
물류 요청: 대시보드에 파스토 양식 스크립트 연결

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: 운영 문서 — 설치 순서, 파스토 목록 갱신 절차, 예약 작업 지시문

**Files:**
- Modify: `LOGISTICS.md`, `DEVELOPMENT.md`
- Create: `tools/fassto-sync-routine.txt`
- Test: `tests/logistics-ui.test.cjs`

**Interfaces:**
- Consumes: Task 1 함수 이름, Task 3 변환기 사용법
- Produces: `LOGISTICS.md`의 "## 파스토 양식 (2026-11-20)"과 "### 파스토 목록 갱신 (Claude, 브라우저)", 예약 작업 지시문 파일(배포하지 않음)

- [ ] **Step 1: Write the failing test** (`tests/logistics-ui.test.cjs` 끝에 추가)

```js

test('운영 문서: 설치 순서에 파스토 SQL, 목록 갱신 절차와 예약 작업 지시문이 있다',()=>{
 const fs=require('node:fs'),path=require('node:path');
 const doc=fs.readFileSync(path.join(__dirname,'../LOGISTICS.md'),'utf8');
 assert.ok(doc.includes('4. `sql/logistics-fassto.sql`'));
 assert.ok(doc.includes('### 파스토 목록 갱신 (Claude, 브라우저)'));
 assert.ok(doc.includes('node tools/fassto-stock-json.cjs'));
 const routine=fs.readFileSync(path.join(__dirname,'../tools/fassto-sync-routine.txt'),'utf8');
 assert.ok(routine.includes('평일 08:30 KST')&&routine.includes('비밀번호·인증번호는 입력하지 않는다'));
 const dev=fs.readFileSync(path.join(__dirname,'../DEVELOPMENT.md'),'utf8');
 assert.ok(dev.includes('sql/logistics-slack.sql → sql/logistics-fassto.sql'));
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test tests/logistics-ui.test.cjs
```
Expected: FAIL 1개 — LOGISTICS.md 설치 순서에 `sql/logistics-fassto.sql` 단계가 없음

- [ ] **Step 3: 문서 쓰기**

1) `LOGISTICS.md`에서 아래 부분(파일 안에 한 번만 있음)을 찾아

~~~~markdown
4. 명단 넣기(실제 값은 저장소에 넣지 않습니다)
~~~~

다음으로 바꾼다.

~~~~markdown
4. `sql/logistics-fassto.sql` (파스토 양식: 상품 목록·받는 곳·품목·주문번호. 앞의 세 파일 다음에 설치합니다. 설치 전 요청에도 주문번호를 채웁니다)
5. 명단 넣기(실제 값은 저장소에 넣지 않습니다)
~~~~

2) `LOGISTICS.md`에서 아래 부분(파일 안에 한 번만 있음)을 찾아

~~~~markdown
5. 정적 파일 배포: index.html, app.js, logistics.js, logistics-model.js, logistics.css, logistics.html(이동 페이지). 바꾼 파일은 index.html의 버전 쿼리도 함께 올립니다.
~~~~

다음으로 바꾼다.

~~~~markdown
6. 첫 파스토 목록 갱신(아래 "파스토 목록 갱신" 절차)
7. 정적 파일 배포: index.html, app.js, logistics.js, logistics-model.js, fassto-forms.js, logistics.css, logistics.html(이동 페이지). 바꾼 파일은 index.html의 버전 쿼리도 함께 올립니다.
8. 예약 작업 등록(평일 08:30 KST, 지시문은 `tools/fassto-sync-routine.txt`)
~~~~

3) `LOGISTICS.md`에서 아래 부분(파일 안에 한 번만 있음)을 찾아

~~~~markdown
## 슬랙 앱 등록 (사용자 또는 슬랙 관리자)
~~~~

다음으로 바꾼다.

~~~~markdown
## 파스토 양식 (2026-11-20)

설계: `docs/superpowers/specs/2026-11-20-logistics-fassto-forms-design.md`

- 운송 방식으로 양식을 정합니다: 택배 → 택배신청, 해외특송 → 해외택배신청, 직납·Air·Ocean → 차량배송신청(상품), 퀵·기타 → 양식 없음.
- 요청자가 새 요청 창에서 받는 곳과 품목을 넣습니다. 품목은 파스토 상품 목록(`logistics_fassto_stock`)에서만 고르고, 출고 가능 수량보다 많으면 노란 경고만 합니다.
- 받는 곳(`logistics_request_recipients`)은 요청자와 활성 물류 담당자만 봅니다. 운송사·Incoterms·발송인은 담당자만 "요약 수정"에서 정합니다(DB 트리거가 `LOGISTICS_HANDLER_ONLY`로 막습니다).
- 품목(`logistics_request_items`)은 회사 구성원 누구나 보고, 쓰기는 요약 수정과 같은 규칙입니다(요청자는 요청 상태에서만, 담당자는 출고완료·취소 전까지). 요청당 50줄까지이며 `public.logistics_replace_items`로 통째로 바꿉니다.
- 상세의 **파스토 양식 내려받기**는 필수 칸을 검사한 뒤 `파스토_<양식>_<주문번호>.xlsx`를 저장합니다. 1~4행은 파스토 원본 그대로이고 5행부터 품목입니다. 엑셀은 대시보드가 이미 불러오는 SheetJS 0.18.5로 브라우저에서 만듭니다.
- 주문번호(`logistics_requests.fassto_order_no`)는 등록 때 DB가 `LG날짜_순번`(KST, 예 `LG20261120_003`)으로 정하고 바꾸지 않습니다.
- 해외 발송인 기본값은 `fassto-forms.js`의 `SENDER`입니다. 전화·이메일은 사용자 확인 전 임시값입니다. 바꾸면 index.html의 `fassto-forms.js` 버전 쿼리를 올려 배포합니다.

### 파스토 목록 갱신 (Claude, 브라우저)

사용자가 "파스토 목록 갱신해줘"라고 하거나 예약 작업이 돌면 아래를 그대로 합니다.

1. 브라우저에서 `https://fms.fassto.ai`의 상품별재고현황 화면을 열고 엑셀로 내려받습니다. 로그인이 풀려 있으면 아무것도 바꾸지 않고 사용자에게 "FMS 로그인이 필요해요"라고 알린 뒤 멈춥니다. 비밀번호·인증번호는 입력하지 않습니다.
2. 저장소 폴더에서 변환합니다(요약은 화면에, SQL은 파일로).

   ```bash
   node tools/fassto-stock-json.cjs "<내려받은 파일>" --sql > "<스크래치 폴더>/fassto-stock.sql"
   ```

   필수 열을 못 찾으면 찾은 제목을 보여 주고 멈춥니다. 그때는 `tools/fassto-stock-json.cjs`의 `ALIASES`에 FMS 열 이름을 더하고 `tests/fassto-stock-json.test.cjs`를 맞춘 뒤 다시 합니다. 로트 행이 지난번 `row_count`의 절반보다 적으면 실행하지 말고 사용자에게 확인합니다.
3. 운영 Supabase(SQL 편집기 또는 Supabase MCP `execute_sql`)에서 그 파일의 select 문 하나만 실행합니다. 돌려준 숫자가 넣은 로트 행 수입니다. 이 함수는 anon·authenticated에는 실행 권한이 없습니다.
4. 확인합니다.

   ```sql
   select synced_at, source_text, row_count from public.logistics_fassto_sync order by synced_at desc limit 1;
   select count(*) as lots, count(distinct product_code) as products from public.logistics_fassto_stock;
   ```

5. 내려받은 엑셀과 SQL 파일은 저장소에 넣지 않고 지웁니다.

예약 작업(평일 08:30 KST)은 `tools/fassto-sync-routine.txt`의 지시문을 그대로 씁니다. 나중에 파스토 API를 받으면 같은 함수를 Edge Function이나 pg_cron이 `'fassto-api'`로 부르게 바꿉니다. 표와 화면은 그대로입니다.

## 슬랙 앱 등록 (사용자 또는 슬랙 관리자)
~~~~

1) `DEVELOPMENT.md`에서 아래 부분(파일 안에 한 번만 있음)을 찾아

~~~~markdown
물류 요청은 대시보드 탭이며 logistics.js, logistics-model.js, logistics.css를 index.html에서 불러옵니다.
~~~~

다음으로 바꾼다.

~~~~markdown
물류 요청은 대시보드 탭이며 logistics.js, logistics-model.js, fassto-forms.js, logistics.css를 index.html에서 불러옵니다(파스토 양식 엑셀은 이미 불러오는 SheetJS 0.18.5로 만듭니다).
~~~~

2) `DEVELOPMENT.md`에서 아래 부분(파일 안에 한 번만 있음)을 찾아

~~~~markdown
sql/logistics.sql → sql/logistics-storage.sql → sql/logistics-slack.sql 순서로 설치한 뒤 배포합니다.
~~~~

다음으로 바꾼다.

~~~~markdown
sql/logistics.sql → sql/logistics-storage.sql → sql/logistics-slack.sql → sql/logistics-fassto.sql 순서로 설치한 뒤 배포합니다.
~~~~

`tools/fassto-sync-routine.txt`:

```text
[파스토 목록 갱신 - 평일 08:30 KST 예약 작업]
작업 폴더: entropysales-dashboard 저장소(main 최신). 절차는 LOGISTICS.md의 "파스토 목록 갱신"과 같다.

1. 브라우저로 https://fms.fassto.ai 상품별재고현황 화면을 열어 엑셀로 내려받는다.
   로그인이 풀려 있으면 아무것도 바꾸지 말고 "FMS 로그인이 필요해요. 로그인해 주시면 다시 갱신할게요."라고 사용자에게 알리고 끝낸다.
   비밀번호·인증번호는 입력하지 않는다.
2. node tools/fassto-stock-json.cjs "<내려받은 파일>" --sql > "<스크래치 폴더>/fassto-stock.sql"
   - 필수 열을 못 찾았다는 오류면 실행하지 말고 오류 문구를 사용자에게 알린다.
   - 로트 행이 지난번 row_count의 절반보다 적으면 실행하지 말고 두 숫자를 사용자에게 보여 확인받는다.
3. 운영 Supabase에서 그 파일의 select 문 하나만 실행한다(Supabase MCP execute_sql). 다른 SQL은 실행하지 않는다.
4. select synced_at, row_count from public.logistics_fassto_sync order by synced_at desc limit 1; 로 확인하고
   "파스토 목록 갱신: 로트 N행, 상품 M종"을 한 줄로 남긴다.
5. 내려받은 파일과 SQL 파일을 지운다. 저장소에는 아무것도 커밋하지 않는다.
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
node --test tests/logistics-ui.test.cjs
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add LOGISTICS.md DEVELOPMENT.md tools/fassto-sync-routine.txt tests/logistics-ui.test.cjs
GIT_AUTHOR_NAME=sylee GIT_AUTHOR_EMAIL=sylee@entropymakeup.com GIT_COMMITTER_NAME=sylee GIT_COMMITTER_EMAIL=sylee@entropymakeup.com git commit -m "$(cat <<'EOF'
물류 요청: 파스토 양식 설치 순서와 FMS 목록 갱신 절차 문서

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: 로컬 브라우저 확인과 마무리

**Files:**
- Create: `tools/logistics-preview.html` (커밋하지 않는 확인용. 끝나면 지운다)

- [ ] **Step 1: 가짜 client로 화면 띄우기**

`tools/logistics-preview.html`을 만든다. 실제 DB·슬랙·스토리지에 연결하지 않는 메모리 client로 `LogisticsPage.mountTab`을 띄운다(택배 요청 p1: 받는 곳·품목 있음, 해외특송 요청 e1: 남의 요청·운송사 없음·로트 수량 초과, 퀵 요청 q1). SheetJS는 `node_modules/xlsx/dist/xlsx.full.min.js`를 쓴다(Task 2에서 설치됨, 네트워크 불필요).

```html
<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>물류 요청 미리보기</title>
<link rel="stylesheet" href="../style.css"><link rel="stylesheet" href="../logistics.css">
<script src="../node_modules/xlsx/dist/xlsx.full.min.js"></script>
<script src="../logistics-model.js"></script><script src="../fassto-forms.js"></script><script src="../logistics.js"></script></head>
<body><div class="main"><div class="topbar"><h1 id="page-title">물류 요청 (미리보기)</h1><div id="topbar-actions"></div></div><div id="content"></div></div>
<script>
// 확인용 가짜 client. 실제 DB·슬랙·스토리지에 연결하지 않는다. 모든 이름·주소는 가짜다.
const ME='me@entropymakeup.com';let seq=1;
const db={
 logistics_requests:[
  {id:'p1',type_code:'sample',title_text:'가짜 택배 샘플',team_code:'domestic',counterparty_text:'가짜 매장',want_date:'2026-11-24',ship_mode_code:'parcel',status_code:'requested',requester_email:ME,result_text:'',status_note_text:'',slack_state_code:'sent',created_at:'2026-11-20T00:00:00Z',fassto_order_no:'LG20261120_001',qty_summary_text:'',note_text:''},
  {id:'e1',type_code:'sample',title_text:'가짜 해외 샘플',team_code:'global',counterparty_text:'가짜 바이어',want_date:'2026-11-25',ship_mode_code:'express',status_code:'accepted',requester_email:'other@entropymakeup.com',result_text:'',status_note_text:'',slack_state_code:'sent',created_at:'2026-11-20T01:00:00Z',fassto_order_no:'LG20261120_002',qty_summary_text:'',note_text:''},
  {id:'q1',type_code:'quick',title_text:'가짜 퀵',team_code:'domestic',counterparty_text:'가짜 사무실',want_date:'2026-11-20',ship_mode_code:'quick',status_code:'requested',requester_email:ME,result_text:'',status_note_text:'',slack_state_code:'sent',created_at:'2026-11-20T02:00:00Z',fassto_order_no:'LG20261120_003',qty_summary_text:'',note_text:''}],
 logistics_request_recipients:[
  {request_id:'p1',name_text:'홍길동',phone_text:'010-0000-0000',postal_text:'01234',address1_text:'가짜시 가짜로 1',address2_text:'101동 1호',country_code:'',state_text:'',city_text:'',district_text:'',email_text:'',tax_id_text:'',courier_text:'',incoterms_code:'',currency_code:'',sender_name_text:'',sender_phone_text:'',sender_address_text:'',sender_email_text:''},
  {request_id:'e1',name_text:'Fake Buyer',phone_text:'+41-00-000-0000',postal_text:'8001',address1_text:'Fakestrasse 1',address2_text:'',country_code:'CH',state_text:'ZH',city_text:'Zurich',district_text:'',email_text:'',tax_id_text:'',courier_text:'',incoterms_code:'',currency_code:'USD',sender_name_text:'',sender_phone_text:'',sender_address_text:'',sender_email_text:''}],
 logistics_request_items:[
  {id:'i1',request_id:'p1',line_no:1,product_code:'0012345',product_name_text:'가짜 립',qty:2,lot_text:'',expires_on:null,en_name_text:'',weight_kg:null,unit_price:null,hs_code_text:''},
  {id:'i2',request_id:'e1',line_no:1,product_code:'0012345',product_name_text:'가짜 립',qty:500,lot_text:'L2',expires_on:'2028-06-30',en_name_text:'Fake Lip',weight_kg:null,unit_price:null,hs_code_text:''}],
 logistics_fassto_stock:[
  {id:1,product_code:'0012345',barcode:'8800000000001',product_name:'가짜 립',kind_text:'본품',lot_text:'L1',expires_on:'2028-01-31',available_qty:120},
  {id:2,product_code:'0012345',barcode:'8800000000001',product_name:'가짜 립',kind_text:'본품',lot_text:'L2',expires_on:'2028-06-30',available_qty:30},
  {id:3,product_code:'A-9',barcode:'',product_name:'가짜 쇼핑백',kind_text:'부자재',lot_text:'',expires_on:null,available_qty:5}],
 logistics_fassto_sync:[{synced_at:new Date(Date.now()-3600000).toISOString(),source_text:'fms-browser',row_count:3}],
 logistics_request_files:[],logistics_handlers:[{email:ME,display_name:'나',is_active:true}],logistics_people:[],invoices:[],logistics_request_comments:[],logistics_request_history:[]};
function q(table){
 let op='select',patch=null,single=false,range=null;const filters=[];
 const c={select(){return c},order(){return c},limit(){return c},gte(){return c},
  in(k,v){filters.push(r=>v.includes(r[k]));return c},eq(k,v){filters.push(r=>r[k]===v);return c},range(a,b){range=[a,b];return c},single(){single=true;return c},
  insert(v){op='insert';patch=v;return c},update(v){op='update';patch=v;return c},upsert(v){op='upsert';patch=v;return c},delete(){op='delete';return c},
  then(res,rej){
   const rows=db[table]||(db[table]=[]),hit=r=>filters.every(f=>f(r));let data;
   if(op==='insert'){const row={id:'n'+(seq++),status_code:'requested',requester_email:ME,created_at:new Date().toISOString(),slack_state_code:'pending',result_text:'',status_note_text:'',fassto_order_no:'LG20261120_'+String(100+seq),...patch};rows.push(row);data=single?row:[row];}
   else if(op==='upsert'){let row=rows.find(r=>r.request_id===patch.request_id);if(row)Object.assign(row,patch);else{row={...patch};rows.push(row);}data=[row];}
   else if(op==='update'){data=rows.filter(hit);data.forEach(r=>Object.assign(r,patch));}
   else if(op==='delete'){data=rows.filter(hit);db[table]=rows.filter(r=>!hit(r));}
   else{data=rows.filter(hit);if(range)data=data.slice(range[0],range[1]+1);}
   return Promise.resolve({data,error:null}).then(res,rej);}};
 return c;}
const client={from:q,
 rpc:async(fn,args)=>{if(fn!=='logistics_replace_items')return {data:null,error:{message:'unknown rpc'}};
  db.logistics_request_items=db.logistics_request_items.filter(r=>r.request_id!==args.p_request).concat(args.p_items.map((x,i)=>({id:'it'+(seq++),request_id:args.p_request,line_no:i+1,...x})));
  return {data:args.p_items.length,error:null};},
 storage:{from:()=>({upload:async()=>({data:{},error:null}),remove:async p=>({data:p,error:null}),createSignedUrl:async()=>({data:{signedUrl:'about:blank'},error:null})})},
 auth:{getSession:async()=>({data:{session:{user:{email:ME}}},error:null}),onAuthStateChange(){}}};
const page=LogisticsPage.mountTab({document,client,onMessage:m=>console.log('[알림]',m)});
page.show();
</script></body></html>
```

- [ ] **Step 2: 브라우저에서 확인** (Claude Browser `preview_start`에 `url`로 `file:///<worktree>/tools/logistics-preview.html`을 연다. 로컬 파일이 막히면 `npx http-server -p 5178 .`을 백그라운드로 띄우고 `http://localhost:5178/tools/logistics-preview.html`을 연다)

확인 목록:
- KPI 아래에 "파스토 목록: MM/DD HH:MM 기준 (상품 2종)"이 보인다.
- "새 요청" → 운송 방식을 택배로 바꾸면 "파스토 택배신청 양식으로 만들어요."와 받는 곳 5칸·품목 칸이 나타나고, 퀵으로 바꾸면 "이 운송 방식은 파스토 양식 없이 처리해요."만 남는다. 해외특송이면 국가코드·주·시·화폐가 나오고, 담당자(미리보기 사용자)에게는 운송사·Incoterms·발송인 칸도 보인다.
- 상품 찾기에 `립`을 치면 결과가 나오고, 누르면 품목 줄이 생긴다. 수량을 151로 바꾸면 노란 "출고 가능 150개보다 많아요."가 보이고, 로트 L2를 고르면 기준이 30개로 바뀐다. 상품 찾기에서 Enter를 눌러도 요청이 올라가지 않는다.
- 요청을 올리면 상세가 열리고 받는 곳·품목 표와 주문번호가 보인다.
- p1 상세에서 "파스토 양식 내려받기" → `파스토_택배신청_LG20261120_001.xlsx`가 저장된다. 엑셀로 열어 1~4행이 원본과 같고 5행 I열 상품코드가 `0012345`(앞자리 0 유지)인지 본다. 확인한 파일은 지운다.
- e1 상세에서 내려받기를 누르면 내려받지 않고 "운송사가 비어 있어요…", "1번째 품목의 단가를 적어 주세요." 목록이 창 안에 보이고, 품목 줄에 "출고 가능 30개보다 많아요."가 보인다. 요약 수정에서 운송사 `FEDEX`를 넣으면 "FEDEX는 받는 분 이메일이 필요해요."가 추가로 보인다.
- 375px 폭(모바일 프리셋)에서 새 요청 창의 받는 곳·품목 칸이 한 줄씩 쌓이고 가로 스크롤이 없다. 확인 뒤 데스크톱으로 되돌린다.
- 다크 모드에서 노란 경고와 표 글자가 읽힌다.

- [ ] **Step 3: 확인용 파일 지우고 전체 검사**

```bash
rm tools/logistics-preview.html
npm run check && npm test
git status --short
```
Expected: 검사 통과, 테스트 전부 통과, `git status`에 남은 변경 없음

- [ ] **Step 4: 코드 리뷰 요청**

superpowers:requesting-code-review로 Task 1~8 변경을 검토받는다. 특히 볼 것: 받는 곳 RLS와 트리거의 구멍(다른 직원·비활성 담당자·닫힌 요청), 요청자 upsert가 담당자 칸을 지우지 않는지, `logistics_replace_fassto_stock`의 실행 권한, 상품코드가 숫자로 바뀌는 경로(JSON·엑셀 셀), 화면 문자열 이스케이프 누락, 기존 탭 동작 회귀.

- [ ] **Step 5: 진행현황 갱신**

`C:/Users/sylee/OneDrive/Desktop/클로드/Codex_계정전환_인수인계_20260908/진행현황/logistics-workflow-20261119.md`에 완료한 Task, 테스트 결과, 남은 운영 단계(아래 Production install)를 덧붙인다.

## Production install (이 계획 밖. 사용자 승인을 받은 뒤 진행, 위 Task에서는 실행하지 않음)

- [ ] PR 생성 → 사용자 검토 → main 병합
- [ ] 운영 DB SQL 적용 순서(사용자 승인 후 Supabase MCP `apply_migration` 또는 SQL 편집기): 이미 설치된 `sql/logistics.sql` → `sql/logistics-storage.sql` → `sql/logistics-slack.sql` 다음에 **`sql/logistics-fassto.sql`**. 적용 후 확인:
  ```sql
  select has_function_privilege('anon','approval_private.logistics_replace_fassto_stock(jsonb,text)','execute') as anon_exec,
         has_function_privilege('authenticated','approval_private.logistics_replace_fassto_stock(jsonb,text)','execute') as auth_exec; -- 둘 다 false
  select count(*) filter (where fassto_order_no is null) as missing from public.logistics_requests; -- 0
  ```
- [ ] 첫 FMS 목록 갱신(사용자 승인 후, LOGISTICS.md "파스토 목록 갱신" 절차). FMS 실제 열 이름이 `ALIASES`와 다르면 변환기와 테스트를 고쳐 별도 커밋한 뒤 다시 한다.
- [ ] 정적 파일 배포(GitHub Pages): index.html, logistics.js, logistics-model.js, fassto-forms.js, logistics.css
- [ ] 예약 작업 등록(평일 08:30 KST, `tools/fassto-sync-routine.txt`)
- [ ] 해외 발송인 전화·이메일(`SENDER`)을 사용자에게 확인받고, 다르면 고쳐 배포
- [ ] 운영 첫 사용: 김윤래님과 실제 요청 1건으로 내려받은 엑셀을 FMS에 올려 확인

---

## Self-Review

**스펙 대응**

| 스펙 | Task |
|---|---|
| §1 결정: 요청자가 받는 곳·품목 입력 | 5(입력 칸), 6(저장) |
| §1 결정: 운송 방식 → 양식 | 2(`formFor`), 5(안내 문구), 6(방식 바꾸면 다시 그림) |
| §1 결정: 품목은 파스토 목록에서, Claude가 갱신 | 1(목록 표·교체 함수), 3(변환기), 5·6(검색해서만 추가), 8(절차) |
| §1 결정: 품목 DB 저장, 엑셀은 브라우저 | 1(품목 표), 2(`toWorkbook`), 6(내려받기) |
| §1 결정: 받는 곳은 요청자·담당자만 | 1(RLS·`logistics_can_see_recipient`), 5(볼 수 없음/입력 안 됨), 6(다른 직원은 부르지 않음) |
| §2 양식 3종, 1~4행 그대로, 5행부터, 시트 이름 | 2(원본 비교 테스트) |
| §2 열 채우기·같은 주문번호·발송인 기본값 | 2(`buildRows`·`SENDER` 테스트) |
| §3.1 목록·갱신 기록·교체 함수 권한 | 1 |
| §3.2 받는 곳 칸·RLS·닫힘·운송사/Incoterms 담당자만 | 1(트리거 `LOGISTICS_HANDLER_ONLY`), 5·6(담당자에게만 칸) |
| §3.3 품목 칸·50줄·쓰기 규칙 | 1(`logistics_replace_items`·트리거), 2(`checkInput`), 6(50줄 안내) |
| §3.4 `fassto_order_no` 트리거 | 1 |
| §4 FMS 브라우저 갱신·로그인 풀림·예약 작업·나중 API | 3, 8, Production install |
| §5.1 새 요청 창(안내, 칸, 검색, 로트, 노란 경고, 해외 단가·무게·영문명, 갱신 시각·2일, 저장 순서·실패 문구) | 5, 6 |
| §5.2 상세(받는 곳·품목, 담당자 칸, 내려받기·빠진 칸 목록, 수정 권한) | 5, 6 |
| §5.3 탭 위 목록 시각·오래됨 노란색 | 6 |
| §6 `fassto-forms.js` API, SheetJS 0.18.5, 새 라이브러리 없음 | 2, 7 |
| §7 상품코드 문자, 금지 문자, 목록에 없는 상품 경고, 볼 수 없음/입력 안 됨 | 1, 2, 5 |
| §8 테스트(생성기·검사·DB·화면), 운영 첫 사용 | 1, 2, 4~6, Production install |
| §9 설치 순서 | 8(LOGISTICS.md), Production install |

**자리표시자 검사:** "TBD", "나중에 채움", "Task N과 비슷" 없음. 모든 코드 단계는 넣을 코드 전체 또는 찾을 부분·바꿀 부분을 그대로 담았다. `<내려받은 파일>`·`<스크래치 폴더>`는 운영 절차에서 실행할 때 정하는 경로다.

**이름 일관성:** 표·열(`fassto_order_no`, `logistics_request_recipients.*_text`, `logistics_request_items.*`), DB 함수(`approval_private.logistics_replace_fassto_stock`, `public.logistics_replace_items`, `approval_private.logistics_can_see_recipient`, `approval_private.logistics_request_write_check`), 오류 코드(`LOGISTICS_HANDLER_ONLY`, `LOGISTICS_ITEM_LIMIT`, `LOGISTICS_ITEM_BAD`, `LOGISTICS_STOCK_*`), JS(`FasstoForms.formFor/validate/buildRows/toWorkbook/fileName/groupStock/searchStock/qtyWarning/stockWarnings/stockAge/toRecipientRow/toItemRows/checkInput`, api `loadStock/loadRecipient/loadItems/saveRecipient/saveItems`, 렌더 `renderStockBanner/renderStockResults/renderItems/renderFasstoFields/renderFasstoSection`), DOM(`lg-stock-line`, `lg-f-fassto`, `lg-item-q`, `lg-item-results`, `lg-item-lines`, `lg-item-warn-<i>`, `r_<열>`, `item_<열>_<i>`, `data-item-add`, `data-item-del`, `data-act="fassto-download"`)은 Task 1~9에서 같은 이름으로 쓴다. 이 계획의 코드는 작성할 때 임시 사본에서 Task 순서대로 적용해 각 Task의 실패→통과와 전체 `npm run check && npm test`(652개 통과)를 확인했다.
