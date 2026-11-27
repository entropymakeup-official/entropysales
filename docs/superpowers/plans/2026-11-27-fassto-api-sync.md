# 파스토 OpenAPI 동기화 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 사무실 PC에서 도는 Node 스크립트가 파스토 OpenAPI로 재고와 출고 신청을 읽어, 대시보드 물류 요청을 자동으로 만들고 고치게 한다.

**Architecture:** 운영 DB에 전용 함수 `public.logistics_fassto_ingest`(anon 실행, 전용 열쇠 해시 검사, 한 트랜잭션)를 더한다. 저장소 `tools/fassto-sync.cjs`가 파스토 API를 부르고, 순수 변환은 `tools/fassto-sync-core.cjs`에 둔다. 화면(`logistics.js`)은 파스토 표시·동기화 상태·차량 기사 정보만 더한다. 기존 트리거는 고치지 않는다(anon 호출은 이미 "시스템" 경로).

**Tech Stack:** PostgreSQL(Supabase) plpgsql, PGlite 0.5.8 테스트, Node 24(내장 `fetch`·`crypto`·`fs`, `node --test`), 브라우저 바닐라 JS.

**Spec:** `docs/superpowers/specs/2026-11-27-fassto-api-sync-design.md`

## Global Constraints

- 저장소는 공개(GitHub Pages)다. API 키·설정 파일·로그·실제 파스토 응답·실제 연락처를 저장소에 넣지 않는다. 테스트 값은 모두 예시값(`가짜 …`, `GG24OO261201000001`, `11111111111111` 등). `tests/public-repo-guard.test.cjs`가 통과해야 한다.
- 새 npm 패키지를 더하지 않는다.
- SQL 파일은 다시 실행해도 안전해야 한다(`if not exists`, `drop … if exists`, `create or replace`). 테스트는 두 번 실행한다.
- 모든 새 함수는 `security definer set search_path=''`(트리거·헬퍼 포함), 이름은 스키마로 완전히 적는다.
- 오류 코드는 `LOGISTICS_` 접두어 대문자.
- 사용자에게 보이는 문구는 한국어 해요체.
- 운영 DB 적용, 머지(=배포), 작업 스케줄러 등록, 브라우저 예약 작업 끄기는 사용자 승인 뒤에만 한다. 이 계획의 작업 1~6은 저장소 안 변경과 테스트까지만 한다.
- 커밋 작성자: 이 PC는 git 사용자 설정이 없다. `git -c user.name=sylee -c user.email=sylee@entropymakeup.com commit …`으로 하고, 메시지 끝에 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`을 붙인다.
- 테스트 실행: `npm test`(= `node --test tests/*.test.cjs`). 개별: `node --test tests/<파일>`.

## File Structure

| 파일 | 할 일 |
|---|---|
| `sql/logistics-fassto-api.sql` (새로) | 연결 칸·보호 트리거, 기사 표, 동기화 표 확장, 열쇠·설정 표, ingest·report_error 함수, 권한 |
| `tests/logistics-fassto-api-db.test.cjs` (새로) | 위 SQL의 PGlite 테스트 |
| `tools/fassto-sync-core.cjs` (새로) | 순수 변환: 날짜, 재고 행, 출고 건, 거르기, 바뀐 건, 토큰 만료, 요약 |
| `tests/fassto-sync-core.test.cjs` (새로) | core 테스트 |
| `tools/fassto-sync.cjs` (새로) | 설정·잠금·로그·토큰·파스토 호출·RPC·미리보기·열쇠 만들기 |
| `tests/fassto-sync-run.test.cjs` (새로) | 가짜 fetch·임시 폴더로 run() 테스트 |
| `logistics.js` (수정) | API(loadStock 두 종류, 기사 읽기·쓰기), 목록 파스토 표시, 동기화 줄, 상세 파스토 정보·기사 칸, 출고완료 폼 기사 칸, 이름 표시 |
| `tests/logistics-ui.test.cjs` (수정) | 화면 테스트 추가 |
| `index.html`, `logistics.html` (수정) | `logistics.js` 버전 쿼리 올림 |
| `package.json` (수정) | `check`에 새 tools 파일 |
| `LOGISTICS.md`, `DEVELOPMENT.md`, `tools/fassto-sync-routine.txt` (수정) | 설치 순서·API 동기화 절·재고 쿼리에 `kind_code='stock'` |
| `docs/superpowers/specs/2026-11-27-fassto-api-sync-design.md` (수정) | 6장 열쇠 넣는 SQL을 해시 직접 입력으로 |

---

### Task 1: DB — 연결 칸, 보호 트리거, 기사 표, 동기화 표 확장, 열쇠·설정 표

**Files:**
- Create: `sql/logistics-fassto-api.sql`
- Test: `tests/logistics-fassto-api-db.test.cjs`

**Interfaces:**
- Consumes: `sql/team-tasks.sql`(`approval_private.is_company_member()`, `current_email()`), `sql/logistics.sql`, `sql/logistics-fassto.sql`(`logistics_can_see_recipient`, `logistics_fassto_sync`).
- Produces: `logistics_requests.fassto_slip_no|fassto_status_code|fassto_synced_at`, `public.logistics_request_drivers(request_id, driver_name_text, driver_phone_text, vehicle_no_text, updated_at, updated_by_text)`, `logistics_fassto_sync.kind_code('stock'|'delivery')`, `logistics_fassto_sync.error_text`, `approval_private.logistics_fassto_keys(key_hash, label_text, is_active, created_at)`, `approval_private.logistics_fassto_settings(id=1, default_requester_email)`.

- [ ] **Step 1: Write the failing test** — `tests/logistics-fassto-api-db.test.cjs`

```js
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const {PGlite}=require('@electric-sql/pglite');
const read=f=>fs.readFileSync(path.join(__dirname,'../sql',f),'utf8');
const id=n=>'00000000-0000-0000-0000-'+String(n).padStart(12,'0');
const KEY='test-sync-key-'+'0'.repeat(40);

async function setup(){
 const db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create schema auth;create schema approval_private;
 create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz);
 create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz);
 create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create function auth.jwt() returns jsonb language sql security definer as $$select jsonb_build_object('session_id',current_setting('request.jwt.claim.session_id',true),'email',(select email from auth.users where id=nullif(current_setting('request.jwt.claim.sub',true),'')::uuid))$$;
 grant usage on schema public,auth,approval_private to anon,authenticated;
 insert into auth.users values ('${id(1)}','req@entropymakeup.com',now(),null),('${id(3)}','handler@entropymakeup.com',now(),null),('${id(4)}','other@entropymakeup.com',now(),null);
 insert into auth.sessions select id,id,null from auth.users;
 create table public.invoices(id uuid primary key default gen_random_uuid(),no text);grant select on public.invoices to authenticated;`);
 await db.exec(read('team-tasks.sql'));
 await db.exec(read('logistics.sql'));
 await db.exec(`insert into logistics_handlers(email,display_name) values ('handler@entropymakeup.com','가짜 담당');
  insert into logistics_people(email,display_name) values ('req@entropymakeup.com','가짜 요청자');`);
 await db.exec(read('logistics-fassto.sql'));
 const sql=read('logistics-fassto-api.sql');await db.exec(sql);await db.exec(sql); // 다시 실행해도 안전
 await db.exec(`insert into approval_private.logistics_fassto_keys(key_hash,label_text) values (encode(sha256(convert_to('${KEY}','UTF8')),'hex'),'테스트');
  insert into approval_private.logistics_fassto_settings(id,default_requester_email) values (1,'handler@entropymakeup.com');`);
 const login=async n=>{await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.session_id',$1,false)",[id(n)]);await db.exec('set role authenticated');};
 const asSystem=async()=>{await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub','',false)");};
 const asAnon=async()=>{await asSystem();await db.exec('set role anon');};
 const ingest=async(deliveries,stock=null,key=KEY)=>{await asAnon();try{return (await db.query('select public.logistics_fassto_ingest($1,$2::jsonb,$3::jsonb) r',[key,stock==null?null:JSON.stringify(stock),deliveries==null?null:JSON.stringify(deliveries)])).rows[0].r;}finally{await asSystem();}};
 const create=async(o={})=>{await login(1);try{return (await db.query(`insert into logistics_requests(type_code,title_text,team_code,counterparty_text,ship_mode_code) values ('b2b',$1,'global','가짜 바이어',$2) returning *`,[o.title||'수동 요청',o.mode||'direct'])).rows[0];}finally{await asSystem();}};
 const req=async slip=>(await db.query('select * from logistics_requests where fassto_slip_no=$1',[slip])).rows[0];
 return {db,login,asSystem,asAnon,ingest,create,req};
}
const dlv=(o={})=>({slip_no:'GG24OO261201000001',order_no:'가짜 주문 1',order_date:'2026-12-01',out_div:'car',shop_name:'가짜 바이어',status_code:'ORDER',
 remark:'가짜 비고',invoice_no:'',parcel_name:'',registered_by:'가짜 요청자',qty_total:30,
 items:[{product_code:'11111111111111',product_name:'가짜 상품',expires_on:'2029-01-01',qty:30}],...o});

test('연결 칸: 회사 구성원은 파스토 칸을 넣거나 바꿀 수 없고, 시스템은 바꿀 수 있다',async()=>{
 const {db,login,asSystem}=await setup();
 try{
  await login(1);
  const r=(await db.query(`insert into logistics_requests(type_code,title_text,team_code,counterparty_text,ship_mode_code,fassto_slip_no,fassto_status_code)
   values ('b2b','t','global','c','direct','HACK1','DONE') returning *`)).rows[0];
  assert.equal(r.fassto_slip_no,null);assert.equal(r.fassto_status_code,null);
  await asSystem();
  await db.query(`update logistics_requests set fassto_slip_no='GG24OO261201000009',fassto_status_code='ORDER' where id=$1`,[r.id]);
  await login(3);
  await db.query(`update logistics_requests set fassto_slip_no='HACK2',fassto_status_code='DONE',title_text='고침' where id=$1`,[r.id]);
  await asSystem();
  const after=(await db.query('select * from logistics_requests where id=$1',[r.id])).rows[0];
  assert.equal(after.fassto_slip_no,'GG24OO261201000009');assert.equal(after.fassto_status_code,'ORDER');assert.equal(after.title_text,'고침');
  await assert.rejects(()=>db.query(`update logistics_requests set fassto_status_code='PARTDONE' where id=$1`,[r.id]),/check/i);
 }finally{await db.close();}
});

test('기사 정보: 담당자만 쓰고, 요청자·담당자만 읽고, 취소된 요청에는 못 쓴다',async()=>{
 const {db,login,asSystem,create}=await setup();
 try{
  const r=await create();
  await login(1);
  await assert.rejects(()=>db.query(`insert into logistics_request_drivers(request_id,driver_name_text) values ($1,'가짜 기사')`,[r.id]));
  await login(3);
  await db.query(`insert into logistics_request_drivers(request_id,driver_name_text,driver_phone_text,vehicle_no_text) values ($1,' 가짜 기사 ','010-0000-0000','00가0000')`,[r.id]);
  const row=(await db.query('select * from logistics_request_drivers where request_id=$1',[r.id])).rows[0];
  assert.equal(row.driver_name_text,'가짜 기사');assert.equal(row.updated_by_text,'handler@entropymakeup.com');
  await login(1);
  assert.equal((await db.query('select * from logistics_request_drivers where request_id=$1',[r.id])).rows.length,1);
  await login(4);
  assert.equal((await db.query('select * from logistics_request_drivers where request_id=$1',[r.id])).rows.length,0);
  await asSystem();
  await db.query(`update logistics_requests set status_code='canceled' where id=$1`,[r.id]);
  await login(3);
  await assert.rejects(()=>db.query(`update logistics_request_drivers set vehicle_no_text='11나1111' where request_id=$1`,[r.id]),/LOGISTICS_CLOSED/);
 }finally{await db.close();}
});

test('동기화 표: 기존 재고 갱신 행은 kind_code=stock, 오류 칸 기본값은 빈 문자열',async()=>{
 const {db}=await setup();
 try{
  await db.query(`select approval_private.logistics_replace_fassto_stock('[{"product_code":"11111111111111","available_qty":5}]'::jsonb,'fms-browser')`);
  const s=(await db.query('select kind_code,error_text from logistics_fassto_sync')).rows[0];
  assert.deepEqual(s,{kind_code:'stock',error_text:''});
  await assert.rejects(()=>db.query(`insert into logistics_fassto_sync(source_text,row_count,kind_code) values ('fassto-api',0,'etc')`),/check/i);
 }finally{await db.close();}
});

test('열쇠·설정 표: anon·authenticated는 읽을 수 없다',async()=>{
 const {db,login,asAnon,asSystem}=await setup();
 try{
  await login(3);
  await assert.rejects(()=>db.query('select * from approval_private.logistics_fassto_keys'),/permission denied/);
  await asAnon();
  await assert.rejects(()=>db.query('select * from approval_private.logistics_fassto_settings'),/permission denied/);
  await asSystem();
 }finally{await db.close();}
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/logistics-fassto-api-db.test.cjs`
Expected: FAIL — `ENOENT … logistics-fassto-api.sql`

- [ ] **Step 3: Write `sql/logistics-fassto-api.sql` (1부: 표와 트리거)**

```sql
-- 파스토 OpenAPI 동기화(설계: docs/superpowers/specs/2026-11-27-fassto-api-sync-design.md).
-- logistics.sql → logistics-storage.sql → logistics-slack.sql → logistics-fassto.sql 다음에 설치한다. 다시 실행해도 안전하다.
-- 동기화는 사무실 PC가 anon으로 public.logistics_fassto_ingest를 부른다. 로그인 없는 호출이라 기존 트리거의 "시스템" 경로를 탄다.
begin;

-- 1) 요청의 파스토 연결 칸. 로그인한 회사 구성원은 넣거나 바꿀 수 없다.
alter table public.logistics_requests add column if not exists fassto_slip_no text;
alter table public.logistics_requests add column if not exists fassto_status_code text;
alter table public.logistics_requests add column if not exists fassto_synced_at timestamptz;
alter table public.logistics_requests drop constraint if exists logistics_requests_fassto_slip_no_check;
alter table public.logistics_requests add constraint logistics_requests_fassto_slip_no_check
 check (fassto_slip_no is null or fassto_slip_no ~ '^[A-Za-z0-9_-]{1,40}$');
alter table public.logistics_requests drop constraint if exists logistics_requests_fassto_status_code_check;
alter table public.logistics_requests add constraint logistics_requests_fassto_status_code_check
 check (fassto_status_code is null or fassto_status_code in ('ORDER','WORKING','DONE','CANCEL','SHORTAGE'));
create unique index if not exists logistics_requests_fassto_slip_no_idx on public.logistics_requests(fassto_slip_no) where fassto_slip_no is not null;

create or replace function approval_private.logistics_requests_fassto_guard() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if (select auth.uid()) is null then return new; end if;
 if tg_op = 'INSERT' then
  new.fassto_slip_no := null; new.fassto_status_code := null; new.fassto_synced_at := null;
 else
  new.fassto_slip_no := old.fassto_slip_no; new.fassto_status_code := old.fassto_status_code; new.fassto_synced_at := old.fassto_synced_at;
 end if;
 return new;
end $$;
drop trigger if exists logistics_requests_fassto_guard on public.logistics_requests;
create trigger logistics_requests_fassto_guard before insert or update on public.logistics_requests
 for each row execute function approval_private.logistics_requests_fassto_guard();

-- 2) 차량 기사 정보(요청당 0~1행). 슬랙에 실리지 않는다. 읽기는 요청자·활성 담당자, 쓰기는 활성 담당자. 취소된 요청에는 못 쓴다.
create table if not exists public.logistics_request_drivers (
 request_id uuid primary key references public.logistics_requests(id) on delete cascade,
 driver_name_text text not null default '' check (length(driver_name_text) <= 40),
 driver_phone_text text not null default '' check (length(driver_phone_text) <= 40),
 vehicle_no_text text not null default '' check (length(vehicle_no_text) <= 20),
 updated_at timestamptz not null default now(),
 updated_by_text text not null default ''
);

create or replace function approval_private.logistics_drivers_stamp() returns trigger
language plpgsql security definer set search_path='' as $$
declare st text;
begin
 if tg_op = 'UPDATE' then new.request_id := old.request_id; end if;
 select status_code into st from public.logistics_requests where id = new.request_id for update;
 if not found then raise exception 'LOGISTICS_FORBIDDEN'; end if;
 if st = 'canceled' then raise exception 'LOGISTICS_CLOSED'; end if;
 if (select auth.uid()) is not null and not (select approval_private.logistics_is_handler()) then raise exception 'LOGISTICS_HANDLER_ONLY'; end if;
 new.driver_name_text := btrim(new.driver_name_text); new.driver_phone_text := btrim(new.driver_phone_text);
 new.vehicle_no_text := btrim(new.vehicle_no_text);
 new.updated_at := clock_timestamp();
 new.updated_by_text := coalesce((select approval_private.current_email()), 'system');
 return new;
end $$;
drop trigger if exists logistics_drivers_stamp on public.logistics_request_drivers;
create trigger logistics_drivers_stamp before insert or update on public.logistics_request_drivers
 for each row execute function approval_private.logistics_drivers_stamp();

-- 3) 동기화 기록: 재고(stock)와 출고(delivery)를 나누고, 실패 실행은 error_text에 남긴다.
alter table public.logistics_fassto_sync add column if not exists kind_code text not null default 'stock';
alter table public.logistics_fassto_sync drop constraint if exists logistics_fassto_sync_kind_code_check;
alter table public.logistics_fassto_sync add constraint logistics_fassto_sync_kind_code_check check (kind_code in ('stock','delivery'));
alter table public.logistics_fassto_sync add column if not exists error_text text not null default '';
alter table public.logistics_fassto_sync drop constraint if exists logistics_fassto_sync_error_text_check;
alter table public.logistics_fassto_sync add constraint logistics_fassto_sync_error_text_check check (length(error_text) <= 300);
create index if not exists logistics_fassto_sync_kind_idx on public.logistics_fassto_sync(kind_code, synced_at desc);

-- 4) 전용 열쇠(sha256 hex만)와 동기화 설정. approval_private라 anon·authenticated는 못 읽는다.
create table if not exists approval_private.logistics_fassto_keys (
 key_hash text primary key check (key_hash ~ '^[0-9a-f]{64}$'),
 label_text text not null default '' check (length(label_text) <= 60),
 is_active boolean not null default true,
 created_at timestamptz not null default now()
);
create table if not exists approval_private.logistics_fassto_settings (
 id integer primary key check (id = 1),
 default_requester_email text not null check (default_requester_email ~ '^[a-z0-9._%+-]+@entropymakeup\.com$')
);

-- 5) 권한
revoke all on function approval_private.logistics_requests_fassto_guard(),approval_private.logistics_drivers_stamp() from public,anon,authenticated;
revoke all on approval_private.logistics_fassto_keys,approval_private.logistics_fassto_settings from public,anon,authenticated;

alter table public.logistics_request_drivers enable row level security;
revoke all on public.logistics_request_drivers from public,anon,authenticated;
grant select,insert,update on public.logistics_request_drivers to authenticated;
drop policy if exists logistics_drivers_read on public.logistics_request_drivers;
create policy logistics_drivers_read on public.logistics_request_drivers for select to authenticated
 using ((select approval_private.logistics_can_see_recipient(request_id)));
drop policy if exists logistics_drivers_insert on public.logistics_request_drivers;
create policy logistics_drivers_insert on public.logistics_request_drivers for insert to authenticated
 with check ((select approval_private.logistics_is_handler()));
drop policy if exists logistics_drivers_update on public.logistics_request_drivers;
create policy logistics_drivers_update on public.logistics_request_drivers for update to authenticated
 using ((select approval_private.logistics_is_handler())) with check ((select approval_private.logistics_is_handler()));

commit;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/logistics-fassto-api-db.test.cjs`
Expected: PASS (4 tests). 기존 `node --test tests/logistics-fassto-db.test.cjs tests/logistics-db.test.cjs`(있는 파일만)도 PASS인지 함께 본다.

- [ ] **Step 5: Commit**

```bash
git add sql/logistics-fassto-api.sql tests/logistics-fassto-api-db.test.cjs
git -c user.name=sylee -c user.email=sylee@entropymakeup.com commit -m "물류 요청: 파스토 연결 칸·기사 정보 표·동기화 기록 확장

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: DB — ingest·report_error 함수

**Files:**
- Modify: `sql/logistics-fassto-api.sql` (`-- 5) 권한` 앞에 함수, 권한 절에 grant 추가)
- Test: `tests/logistics-fassto-api-db.test.cjs` (테스트 추가)

**Interfaces:**
- Consumes: Task 1 표, `approval_private.logistics_replace_fassto_stock(jsonb,text) → integer`, `public.logistics_replace_items(uuid,jsonb) → integer`.
- Produces:
  - `public.logistics_fassto_ingest(p_key text, p_stock jsonb, p_deliveries jsonb) returns jsonb` → `{stock_rows:int|null, stock_warning:text, created, updated, canceled, invoices, skipped}` (anon만 실행)
  - `public.logistics_fassto_report_error(p_key text, p_error text) returns void` (anon만 실행)
  - 출고 건 JSON 형식: `{slip_no, order_no, order_date:'YYYY-MM-DD', out_div:'car'|'parcel', shop_name, status_code:'ORDER'|'WORKING'|'DONE'|'CANCEL'|'SHORTAGE', remark, invoice_no, parcel_name, registered_by, qty_total:int, items?:[{product_code, product_name, expires_on:'YYYY-MM-DD'|'', qty:int}]}`
  - 오류: `LOGISTICS_FASSTO_KEY`, `LOGISTICS_FASSTO_SETTINGS`, `LOGISTICS_FASSTO_BAD`, `LOGISTICS_FORBIDDEN`

- [ ] **Step 1: Write the failing tests** — 파일 끝에 추가

```js
test('ingest: 열쇠가 틀리거나 꺼졌으면 거부하고, 로그인한 구성원은 실행할 수 없다',async()=>{
 const {db,login,ingest,asSystem}=await setup();
 try{
  await assert.rejects(()=>ingest([dlv()],null,'wrong-key-'+'1'.repeat(40)),/LOGISTICS_FASSTO_KEY/);
  await db.exec(`update approval_private.logistics_fassto_keys set is_active=false`);
  await assert.rejects(()=>ingest([dlv()]),/LOGISTICS_FASSTO_KEY/);
  await db.exec(`update approval_private.logistics_fassto_keys set is_active=true`);
  await login(3);
  await assert.rejects(()=>db.query('select public.logistics_fassto_ingest($1,null,null)',[KEY]),/permission denied/);
  await asSystem();
  assert.equal((await db.query('select count(*)::int n from logistics_requests')).rows[0].n,0);
 }finally{await db.close();}
});

test('ingest: 새 출고는 요청 한 건을 만들고(요청자 매핑·품목·슬랙 알림), 다시 보내도 늘지 않는다',async()=>{
 const {db,ingest,req}=await setup();
 try{
  const res=await ingest([dlv()]);
  assert.equal(res.created,1);
  const r=await req('GG24OO261201000001');
  assert.equal(r.type_code,'b2b');assert.equal(r.ship_mode_code,'direct');assert.equal(r.title_text,'가짜 바이어 · 가짜 주문 1');
  assert.equal(r.counterparty_text,'가짜 바이어');assert.equal(r.requester_email,'req@entropymakeup.com');
  assert.equal((await db.query('select want_date::text d from logistics_requests where id=$1',[r.id])).rows[0].d,'2026-12-01');
  assert.equal(r.qty_summary_text,'품목 1종 · 총 30개');assert.equal(r.note_text,'[파스토 GG24OO261201000001] 가짜 비고');
  assert.equal(r.fassto_status_code,'ORDER');assert.match(r.fassto_order_no,/^LG\d{8}_\d{3}$/);assert.equal(r.status_code,'requested');
  const it=(await db.query('select product_code,qty,lot_text,expires_on::text exp from logistics_request_items where request_id=$1',[r.id])).rows;
  assert.equal(it.length,1);assert.equal(it[0].lot_text,'2029-01-01');assert.equal(it[0].exp,'2029-01-01');
  assert.equal((await db.query(`select count(*)::int n from logistics_slack_outbox where request_id=$1 and event_code='created'`,[r.id])).rows[0].n,1);
  const again=await ingest([dlv()]);
  assert.deepEqual([again.created,again.updated],[0,0]);
  assert.equal((await db.query('select count(*)::int n from logistics_requests')).rows[0].n,1);
  const unknown=await ingest([dlv({slip_no:'GG24OO261201000002',registered_by:'모르는 사람',out_div:'parcel',items:undefined})]);
  assert.equal(unknown.created,1);
  const u=await req('GG24OO261201000002');
  assert.equal(u.requester_email,'handler@entropymakeup.com');assert.equal(u.ship_mode_code,'parcel');assert.equal(u.qty_summary_text,'총 30개');
  const sync=(await db.query(`select row_count,note_text from logistics_fassto_sync where kind_code='delivery' order by id desc limit 1`)).rows[0];
  assert.equal(sync.row_count,1);assert.match(sync.note_text,/새 1/);
 }finally{await db.close();}
});

test('ingest: 대시보드에서 만든 요청은 LG 주문번호로 연결하고 새로 만들지 않는다',async()=>{
 const {db,ingest,create,req}=await setup();
 try{
  const mine=await create();
  const res=await ingest([dlv({order_no:mine.fassto_order_no})]);
  assert.deepEqual([res.created,res.updated],[0,1]);
  assert.equal((await req('GG24OO261201000001')).id,mine.id);
 }finally{await db.close();}
});

test('ingest: 품목 변경은 요청·접수 상태에서만 반영하고, 준비중 이후는 댓글을 한 번만 남긴다',async()=>{
 const {db,ingest,req,login,asSystem}=await setup();
 try{
  await ingest([dlv()]);
  const r=await req('GG24OO261201000001');
  const changed=dlv({items:[{product_code:'11111111111111',product_name:'가짜 상품',expires_on:'2029-01-01',qty:40}]});
  assert.equal((await ingest([changed])).updated,1);
  assert.equal((await db.query('select qty from logistics_request_items where request_id=$1',[r.id])).rows[0].qty,40);
  assert.equal((await req('GG24OO261201000001')).qty_summary_text,'품목 1종 · 총 40개');
  await login(3);await db.query(`update logistics_requests set status_code='preparing' where id=$1`,[r.id]);await asSystem();
  const again=dlv({items:[{product_code:'11111111111111',product_name:'가짜 상품',expires_on:'2029-01-01',qty:50}]});
  await ingest([again]);await ingest([again]);
  assert.equal((await db.query('select qty from logistics_request_items where request_id=$1',[r.id])).rows[0].qty,40);
  const c=(await db.query('select body_text,author_email from logistics_request_comments where request_id=$1',[r.id])).rows;
  assert.equal(c.length,1);assert.equal(c[0].author_email,'fassto-sync');assert.match(c[0].body_text,/품목이 바뀌었어요/);
 }finally{await db.close();}
});

test('ingest: 파스토 취소는 출고완료 전이면 요청을 취소하고, 출고완료면 댓글만, 없는 건은 건너뛴다',async()=>{
 const {db,ingest,req,login,asSystem}=await setup();
 try{
  await ingest([dlv(),dlv({slip_no:'GG24OO261201000003'})]);
  const res=await ingest([dlv({status_code:'CANCEL'}),dlv({slip_no:'GG24OO261201000099',status_code:'CANCEL'})]);
  assert.deepEqual([res.canceled,res.skipped],[1,1]);
  const a=await req('GG24OO261201000001');
  assert.equal(a.status_code,'canceled');assert.equal(a.status_note_text,'파스토에서 출고요청 취소');assert.equal(a.fassto_status_code,'CANCEL');
  const b=await req('GG24OO261201000003');
  await login(3);await db.query(`update logistics_requests set status_code='shipped',result_text='차량 00가0000',shipped_on='2026-12-01' where id=$1`,[b.id]);await asSystem();
  await ingest([dlv({slip_no:'GG24OO261201000003',status_code:'CANCEL'})]);
  assert.equal((await req('GG24OO261201000003')).status_code,'shipped');
  assert.equal((await db.query(`select count(*)::int n from logistics_request_comments where request_id=$1`,[b.id])).rows[0].n,1);
 }finally{await db.close();}
});

test('ingest: 택배 송장은 결과 칸이 비어 있을 때만 채우고 상태는 바꾸지 않는다',async()=>{
 const {db,ingest,req,login,asSystem}=await setup();
 try{
  await ingest([dlv({out_div:'parcel',status_code:'DONE',invoice_no:'000011112222',parcel_name:'가짜택배'})]);
  const r=await req('GG24OO261201000001');
  assert.equal(r.result_text,'가짜택배 000011112222');assert.equal(r.status_code,'requested');
  await login(3);await db.query(`update logistics_requests set result_text='직접 적음' where id=$1`,[r.id]);await asSystem();
  const res=await ingest([dlv({out_div:'parcel',status_code:'DONE',invoice_no:'999',parcel_name:'가짜택배'})]);
  assert.equal(res.invoices,0);assert.equal((await req('GG24OO261201000001')).result_text,'직접 적음');
 }finally{await db.close();}
});

test('ingest: 재고는 fassto-api로 바꾸고, 지난번 절반 미만이면 바꾸지 않고 경고한다',async()=>{
 const {db,ingest}=await setup();
 try{
  const rows=n=>Array.from({length:n},(_,i)=>({product_code:String(11111111111110+i),barcode:'',product_name:'가짜 상품',kind_text:'본품',lot_text:'',expires_on:'2029-01-01',available_qty:5}));
  const a=await ingest(null,rows(10));
  assert.equal(a.stock_rows,10);
  assert.equal((await db.query(`select source_text from logistics_fassto_sync where kind_code='stock' order by id desc limit 1`)).rows[0].source_text,'fassto-api');
  const b=await ingest(null,rows(4));
  assert.equal(b.stock_rows,null);assert.match(b.stock_warning,/재고 4행\(지난번 10행\)/);
  assert.equal((await db.query('select count(*)::int n from logistics_fassto_stock')).rows[0].n,10);
 }finally{await db.close();}
});

test('report_error: 열쇠 검사 후 delivery 실패 행을 남긴다',async()=>{
 const {db,asAnon,asSystem}=await setup();
 try{
  await asAnon();
  await assert.rejects(()=>db.query('select public.logistics_fassto_report_error($1,$2)',['x'.repeat(40),'e']),/LOGISTICS_FASSTO_KEY/);
  await db.query('select public.logistics_fassto_report_error($1,$2)',[KEY,'파스토 응답 없음']);
  await asSystem();
  const s=(await db.query(`select kind_code,row_count,error_text from logistics_fassto_sync order by id desc limit 1`)).rows[0];
  assert.deepEqual(s,{kind_code:'delivery',row_count:0,error_text:'파스토 응답 없음'});
 }finally{await db.close();}
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/logistics-fassto-api-db.test.cjs`
Expected: 새 테스트 FAIL — `function public.logistics_fassto_ingest(...) does not exist`

- [ ] **Step 3: Add functions to `sql/logistics-fassto-api.sql`** — `-- 5) 권한` 줄 바로 앞에 넣는다

```sql
-- 5) 동기화 함수. 사무실 PC가 anon 키 + 전용 열쇠로 부른다(한 트랜잭션).
create or replace function approval_private.logistics_fassto_key_ok(p_key text) returns boolean
language sql stable security definer set search_path='' as $$
 select coalesce(length(p_key) between 32 and 200, false) and exists(
  select 1 from approval_private.logistics_fassto_keys k
  where k.is_active and k.key_hash = encode(sha256(convert_to(p_key,'UTF8')),'hex'));
$$;

-- 동기화 품목 → logistics_replace_items 형식. 로트가 비면 유통기한이 지워지므로 유통기한을 로트 칸에도 넣는다. 최대 50줄.
create or replace function approval_private.logistics_fassto_items(p_items jsonb) returns jsonb
language sql immutable security definer set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('product_code',x.code,'product_name_text',x.name,'qty',x.qty,'lot_text',x.exp,'expires_on',x.exp) order by x.ord),'[]'::jsonb)
 from (
  select e.ord, btrim(e.v->>'product_code') code, left(btrim(coalesce(e.v->>'product_name','')),200) name, (e.v->>'qty')::integer qty,
   case when coalesce(e.v->>'expires_on','') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then e.v->>'expires_on' else '' end exp
  from jsonb_array_elements(case when jsonb_typeof(p_items)='array' then p_items else '[]'::jsonb end) with ordinality e(v,ord)
  where jsonb_typeof(e.v->'product_code')='string' and length(btrim(e.v->>'product_code')) between 1 and 60
    and coalesce(e.v->>'qty','') ~ '^[0-9]{1,7}$' and (e.v->>'qty')::integer >= 1
  order by e.ord limit 50) x;
$$;

-- 품목 비교용 서명(상품코드|유통기한|수량, 줄 순서대로)
create or replace function approval_private.logistics_fassto_sig(p_items jsonb) returns text
language sql immutable security definer set search_path='' as $$
 select coalesce(string_agg(concat_ws('|',e.v->>'product_code',e.v->>'expires_on',e.v->>'qty'),';' order by e.ord),'')
 from jsonb_array_elements(p_items) with ordinality e(v,ord);
$$;

create or replace function approval_private.logistics_fassto_qty_text(p_items jsonb, p_total integer) returns text
language sql immutable security definer set search_path='' as $$
 select case when jsonb_array_length(p_items) > 0 then
   format('품목 %s종 · 총 %s개', jsonb_array_length(p_items), (select sum((e.v->>'qty')::integer) from jsonb_array_elements(p_items) e(v)))
  when p_total is not null then format('총 %s개', p_total) else '' end;
$$;

-- 같은 내용 댓글은 한 번만
create or replace function approval_private.logistics_fassto_comment(p_request uuid, p_body text) returns void
language plpgsql security definer set search_path='' as $$
declare b text := left(btrim(p_body),1000);
begin
 if exists(select 1 from public.logistics_request_comments c where c.request_id = p_request and c.body_text = b) then return; end if;
 insert into public.logistics_request_comments(request_id, body_text, author_email) values (p_request, b, 'fassto-sync');
end $$;

create or replace function public.logistics_fassto_ingest(p_key text, p_stock jsonb, p_deliveries jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 d jsonb; r public.logistics_requests%rowtype; v_found boolean; v_linked boolean;
 v_slip text; v_order text; v_status text; v_div text; v_shop text; v_has_items boolean; v_items jsonb; v_raw_n integer; v_total integer;
 v_email text; v_default text; v_title text; v_note text; v_old_sig text; v_invoice text;
 n_created integer := 0; n_updated integer := 0; n_canceled integer := 0; n_invoices integer := 0; n_skipped integer := 0;
 v_stock_rows integer; v_stock_warning text := ''; v_last integer;
begin
 if not approval_private.logistics_fassto_key_ok(p_key) then raise exception 'LOGISTICS_FASSTO_KEY'; end if;
 if (select auth.uid()) is not null then raise exception 'LOGISTICS_FORBIDDEN'; end if;
 select s.default_requester_email into v_default from approval_private.logistics_fassto_settings s where s.id = 1;
 if v_default is null then raise exception 'LOGISTICS_FASSTO_SETTINGS'; end if;
 if (p_stock is not null and jsonb_typeof(p_stock) <> 'array') or (p_deliveries is not null and jsonb_typeof(p_deliveries) <> 'array') then
  raise exception 'LOGISTICS_FASSTO_BAD';
 end if;

 -- 재고: 지난 정상 갱신의 절반 미만이면 바꾸지 않는다(첫 갱신은 검사하지 않음)
 if p_stock is not null then
  select s.row_count into v_last from public.logistics_fassto_sync s where s.kind_code = 'stock' and s.error_text = '' order by s.synced_at desc, s.id desc limit 1;
  if jsonb_array_length(p_stock) = 0 or (v_last is not null and jsonb_array_length(p_stock) * 2 < v_last) then
   v_stock_warning := format('재고 %s행(지난번 %s행)이라 재고를 바꾸지 않았어요', jsonb_array_length(p_stock), coalesce(v_last,0));
  else
   v_stock_rows := approval_private.logistics_replace_fassto_stock(p_stock, 'fassto-api');
  end if;
 end if;

 for d in select e.v from jsonb_array_elements(coalesce(p_deliveries,'[]'::jsonb)) e(v) loop
  v_slip := btrim(coalesce(d->>'slip_no',''));
  v_order := btrim(coalesce(d->>'order_no',''));
  v_status := d->>'status_code';
  v_div := d->>'out_div';
  if v_slip !~ '^[A-Za-z0-9_-]{1,40}$' or v_status is null or v_status not in ('ORDER','WORKING','DONE','CANCEL','SHORTAGE')
     or v_div is null or v_div not in ('car','parcel') then
   n_skipped := n_skipped + 1; continue;
  end if;
  v_has_items := jsonb_typeof(d->'items') = 'array';
  v_items := case when v_has_items then approval_private.logistics_fassto_items(d->'items') end;
  v_raw_n := case when v_has_items then jsonb_array_length(d->'items') else 0 end;
  v_total := case when coalesce(d->>'qty_total','') ~ '^[0-9]{1,9}$' then (d->>'qty_total')::integer end;
  v_shop := left(btrim(coalesce(d->>'shop_name','')),120);
  v_linked := false;

  select * into r from public.logistics_requests q where q.fassto_slip_no = v_slip for update;
  v_found := found;
  if not v_found and v_order ~ '^LG[0-9]{8}_[0-9]{3,}$' then
   select * into r from public.logistics_requests q where q.fassto_order_no = v_order and q.fassto_slip_no is null for update;
   v_found := found; v_linked := found;
  end if;

  if not v_found then
   if v_status = 'CANCEL' then n_skipped := n_skipped + 1; continue; end if;
   v_email := null;
   select lower(x.email) into v_email from (
    select p.email, 1 o from public.logistics_people p where p.display_name = btrim(coalesce(d->>'registered_by',''))
    union all
    select h.email, 2 o from public.logistics_handlers h where h.is_active and h.display_name = btrim(coalesce(d->>'registered_by',''))
   ) x order by x.o limit 1;
   v_title := left(concat_ws(' · ', nullif(v_shop,''), nullif(v_order,'')), 80);
   if v_title = '' then v_title := '파스토 ' || v_slip; end if;
   v_note := btrim('[파스토 ' || v_slip || '] ' || btrim(coalesce(d->>'remark','')));
   if v_raw_n > 50 then v_note := v_note || format(' (품목 %s줄 중 50줄만 표시)', v_raw_n); end if;
   insert into public.logistics_requests(type_code, title_text, team_code, requester_email, counterparty_text, want_date, ship_mode_code,
    qty_summary_text, note_text, fassto_slip_no, fassto_status_code, fassto_synced_at)
   values ('b2b', v_title, 'global', coalesce(v_email, v_default), coalesce(nullif(v_shop,''),'파스토 출고'),
    case when coalesce(d->>'order_date','') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then (d->>'order_date')::date end,
    case v_div when 'car' then 'direct' else 'parcel' end,
    left(approval_private.logistics_fassto_qty_text(coalesce(v_items,'[]'::jsonb), v_total),300), left(v_note,1000),
    v_slip, v_status, now())
   returning * into r;
   if v_has_items then perform public.logistics_replace_items(r.id, v_items); end if;
   n_created := n_created + 1;
  else
   -- 품목: 요청·접수 상태에서만 바꾸고, 그 뒤에는 댓글로 알린다
   if v_has_items then
    select coalesce(string_agg(concat_ws('|',i.product_code,coalesce(i.expires_on::text,''),i.qty::text),';' order by i.line_no),'')
     into v_old_sig from public.logistics_request_items i where i.request_id = r.id;
    if approval_private.logistics_fassto_sig(v_items) <> v_old_sig then
     if r.status_code in ('requested','accepted') then
      perform public.logistics_replace_items(r.id, v_items);
      update public.logistics_requests set qty_summary_text = left(approval_private.logistics_fassto_qty_text(v_items, v_total),300) where id = r.id;
      n_updated := n_updated + 1;
     elsif r.status_code <> 'canceled' then
      perform approval_private.logistics_fassto_comment(r.id, '[파스토 동기화] 파스토에서 품목이 바뀌었어요: '||approval_private.logistics_fassto_qty_text(v_items, v_total));
     end if;
    end if;
   end if;
   -- 취소
   if v_status = 'CANCEL' and r.fassto_status_code is distinct from 'CANCEL' then
    if r.status_code in ('requested','accepted','preparing','on_hold') then
     update public.logistics_requests set status_code = 'canceled', status_note_text = '파스토에서 출고요청 취소' where id = r.id;
     n_canceled := n_canceled + 1;
    elsif r.status_code = 'shipped' then
     perform approval_private.logistics_fassto_comment(r.id, '[파스토 동기화] 출고완료된 요청인데 파스토에서 출고요청이 취소됐어요. 확인해 주세요.');
    end if;
   elsif v_status <> 'CANCEL' and r.status_code = 'canceled' and r.fassto_status_code = 'CANCEL' then
    perform approval_private.logistics_fassto_comment(r.id, '[파스토 동기화] 취소된 요청인데 파스토에서 출고요청이 다시 살아났어요. 확인해 주세요.');
   end if;
   if v_linked then n_updated := n_updated + 1; end if;
  end if;

  -- 택배 송장: 결과 칸이 비어 있을 때만. 상태는 바꾸지 않는다.
  select * into r from public.logistics_requests q where q.id = r.id;
  v_invoice := left(btrim(concat_ws(' ', nullif(btrim(coalesce(d->>'parcel_name','')),''), nullif(btrim(coalesce(d->>'invoice_no','')),''))),500);
  if v_div = 'parcel' and btrim(coalesce(d->>'invoice_no','')) <> '' and r.result_text = '' and r.status_code <> 'canceled' then
   update public.logistics_requests set result_text = v_invoice where id = r.id;
   n_invoices := n_invoices + 1;
  end if;
  update public.logistics_requests set fassto_slip_no = v_slip, fassto_status_code = v_status, fassto_synced_at = now() where id = r.id;
 end loop;

 if p_deliveries is not null then
  insert into public.logistics_fassto_sync(source_text, kind_code, row_count, note_text)
  values ('fassto-api','delivery', jsonb_array_length(p_deliveries),
   format('새 %s · 수정 %s · 취소 %s · 송장 %s · 건너뜀 %s', n_created, n_updated, n_canceled, n_invoices, n_skipped));
 end if;
 delete from public.logistics_fassto_sync s where s.synced_at < now() - interval '90 days'
  and s.id not in (select max(t.id) from public.logistics_fassto_sync t group by t.kind_code);
 return jsonb_build_object('stock_rows', v_stock_rows, 'stock_warning', v_stock_warning, 'created', n_created, 'updated', n_updated,
  'canceled', n_canceled, 'invoices', n_invoices, 'skipped', n_skipped);
end $$;

create or replace function public.logistics_fassto_report_error(p_key text, p_error text) returns void
language plpgsql security definer set search_path='' as $$
begin
 if not approval_private.logistics_fassto_key_ok(p_key) then raise exception 'LOGISTICS_FASSTO_KEY'; end if;
 insert into public.logistics_fassto_sync(source_text, kind_code, row_count, error_text)
 values ('fassto-api','delivery',0, left(coalesce(nullif(btrim(p_error),''),'알 수 없는 오류'),300));
end $$;
```

그리고 `-- 5) 권한` 절 제목을 `-- 6) 권한`으로 바꾸고, 그 절 맨 앞에 넣는다:

```sql
revoke all on function approval_private.logistics_fassto_key_ok(text),approval_private.logistics_fassto_items(jsonb),
 approval_private.logistics_fassto_sig(jsonb),approval_private.logistics_fassto_qty_text(jsonb,integer),
 approval_private.logistics_fassto_comment(uuid,text) from public,anon,authenticated;
revoke all on function public.logistics_fassto_ingest(text,jsonb,jsonb),public.logistics_fassto_report_error(text,text) from public,anon,authenticated;
grant execute on function public.logistics_fassto_ingest(text,jsonb,jsonb),public.logistics_fassto_report_error(text,text) to anon;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/logistics-fassto-api-db.test.cjs`
Expected: PASS (12 tests). 실패하면 오류 문구로 고친다. 흔한 원인: `logistics_replace_items`가 `product_code` 문자 검사, 상태 전이(`requested→canceled` 등)는 `logistics_transition_ok` 표에 있어야 함.

- [ ] **Step 5: Run whole suite, then commit**

Run: `npm test`
Expected: 전부 PASS

```bash
git add sql/logistics-fassto-api.sql tests/logistics-fassto-api-db.test.cjs
git -c user.name=sylee -c user.email=sylee@entropymakeup.com commit -m "물류 요청: 파스토 동기화 함수(ingest·report_error)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: 동기화 변환 모듈 `tools/fassto-sync-core.cjs`

**Files:**
- Create: `tools/fassto-sync-core.cjs`
- Test: `tests/fassto-sync-core.test.cjs`

**Interfaces:**
- Consumes: 파스토 응답 필드(설계 2장): 재고 `cstGodCd, godBarcd, godNm, giftDiv, distTermDt, canStockQty`; 출고 목록 `slipNo, ordNo, ordDt, outDiv('1'|'2'), shopNm, ordQty, wrkStat('1'|'2'|'3'|'8'|'9'), invoiceNo, parcelNm, salChanel, remark, updTime, updUserNm`; 상세 `data`(배열 또는 객체)`.goods[]: cstGodCd, godNm, distTermDt, ordQty`.
- Produces (module.exports):
  - `kstDay(ms) → 'YYYY-MM-DD'`, `addDays(day, n) → 'YYYY-MM-DD'`, `dateRange(nowMs, back, ahead) → {start, end}`
  - `normDate(v) → 'YYYY-MM-DD' | ''`
  - `toStockRows(list) → [{product_code, barcode, product_name, kind_text, lot_text:'', expires_on, available_qty}]`
  - `statusOf(x) → 'ORDER'|'WORKING'|'DONE'|'CANCEL'|'SHORTAGE'|null`
  - `keepDelivery(x, {parcelSalesChannelEmptyOnly}) → boolean`
  - `needsDetail(x, state) → boolean` (`state = {slips:{[slipNo]: updTime}}`)
  - `toItems(detailData) → [{product_code, product_name, expires_on, qty}]`
  - `toDelivery(x, items|null) → 출고 건 JSON(Task 2 형식)`
  - `tokenValid(token, nowMs) → boolean` (`token = {accessToken, expreDatetime:'yyyyMMddHHmmss' KST}`)
  - `summary(result, {mall}) → string`

- [ ] **Step 1: Write the failing test** — `tests/fassto-sync-core.test.cjs`

```js
const {test}=require('node:test');const assert=require('node:assert/strict');
const C=require('../tools/fassto-sync-core.cjs');
const NOW=Date.UTC(2026,10,27,1); // KST 2026-11-27 10:00

test('날짜: KST 오늘 기준 범위, 여러 형식 정규화',()=>{
 assert.equal(C.kstDay(Date.UTC(2026,10,26,15)),'2026-11-27');
 assert.deepEqual(C.dateRange(NOW,14,14),{start:'2026-11-13',end:'2026-12-11'});
 assert.equal(C.normDate('2028-05-27'),'2028-05-27');
 assert.equal(C.normDate('20280527'),'2028-05-27');
 assert.equal(C.normDate('2028-05-26T15:00:00.000Z'),'2028-05-27'); // UTC 표기는 KST 날짜로
 assert.equal(C.normDate('2028-02-30'),'');assert.equal(C.normDate(''),'');assert.equal(C.normDate(null),'');
});

test('재고: 고객사상품코드·유통기한별로 합치고 주문가능수량을 쓴다',()=>{
 const rows=C.toStockRows([
  {cstGodCd:'11111111111111',godBarcd:'11111111111111',godNm:'가짜 상품',giftDiv:'01',distTermDt:'20290101',canStockQty:5,stockQty:9,whCd:'A'},
  {cstGodCd:'11111111111111',godBarcd:'11111111111111',godNm:'가짜 상품',giftDiv:'01',distTermDt:'2029-01-01',canStockQty:3,whCd:'B'},
  {cstGodCd:'22222222222222',godNm:'가짜 사은품',giftDiv:'02',distTermDt:'',canStockQty:0},
  {cstGodCd:'',godNm:'코드 없음',canStockQty:1}]);
 assert.deepEqual(rows,[
  {product_code:'11111111111111',barcode:'11111111111111',product_name:'가짜 상품',kind_text:'본품',lot_text:'',expires_on:'2029-01-01',available_qty:8},
  {product_code:'22222222222222',barcode:'',product_name:'가짜 사은품',kind_text:'사은품',lot_text:'',expires_on:'',available_qty:0}]);
});

test('출고: 상태 코드 변환, 쇼핑몰 택배 거르기, 바뀐 건 고르기',()=>{
 assert.equal(C.statusOf({wrkStat:'1'}),'ORDER');assert.equal(C.statusOf({wrkStat:'3'}),'DONE');
 assert.equal(C.statusOf({wrkStat:'8'}),'CANCEL');assert.equal(C.statusOf({wrkStat:'9'}),'SHORTAGE');assert.equal(C.statusOf({wrkStat:'7'}),null);
 assert.equal(C.keepDelivery({outDiv:'2',salChanel:'가짜몰'}),true);
 assert.equal(C.keepDelivery({outDiv:'1',salChanel:''}),true);
 assert.equal(C.keepDelivery({outDiv:'1',salChanel:'가짜몰'}),false);
 assert.equal(C.keepDelivery({outDiv:'1',salChanel:'가짜몰'},{parcelSalesChannelEmptyOnly:false}),true);
 const st={slips:{A:'2026-11-26 10:00'}};
 assert.equal(C.needsDetail({slipNo:'A',updTime:'2026-11-26 10:00'},st),false);
 assert.equal(C.needsDetail({slipNo:'A',updTime:'2026-11-26 11:00'},st),true);
 assert.equal(C.needsDetail({slipNo:'B',updTime:'x'},st),true);
});

test('출고: 목록 행과 상세 품목을 ingest 형식으로 바꾼다',()=>{
 const items=C.toItems([{goods:[{cstGodCd:'11111111111111',godNm:'가짜 상품',distTermDt:'2029-01-01',ordQty:30},{cstGodCd:'',ordQty:1},{cstGodCd:'3',ordQty:0}]}]);
 assert.deepEqual(items,[{product_code:'11111111111111',product_name:'가짜 상품',expires_on:'2029-01-01',qty:30}]);
 assert.deepEqual(C.toItems({goods:[{cstGodCd:'9',godNm:'x',distTermDt:'',ordQty:'2'}]}),[{product_code:'9',product_name:'x',expires_on:'',qty:2}]);
 const x={slipNo:'GG24OO261201000001',ordNo:'가짜 주문 1',ordDt:'2026-12-01',outDiv:'2',shopNm:'가짜 바이어',ordQty:30,wrkStat:'1',
  invoiceNo:'',parcelNm:'',remark:'가짜 비고',updUserNm:'가짜 요청자'};
 assert.deepEqual(C.toDelivery(x,items),{slip_no:'GG24OO261201000001',order_no:'가짜 주문 1',order_date:'2026-12-01',out_div:'car',shop_name:'가짜 바이어',
  status_code:'ORDER',remark:'가짜 비고',invoice_no:'',parcel_name:'',registered_by:'가짜 요청자',qty_total:30,items});
 assert.equal('items' in C.toDelivery({...x,outDiv:'1'},null),false);
 assert.equal(C.toDelivery({...x,outDiv:'1'},null).out_div,'parcel');
});

test('토큰: 만료 5분 전까지만 다시 쓴다(만료시각은 KST)',()=>{
 assert.equal(C.tokenValid({accessToken:'t',expreDatetime:'20261127103000'},NOW),true);  // 30분 남음
 assert.equal(C.tokenValid({accessToken:'t',expreDatetime:'20261127100400'},NOW),false); // 4분 남음
 assert.equal(C.tokenValid({accessToken:'',expreDatetime:'20261127103000'},NOW),false);
 assert.equal(C.tokenValid(null,NOW),false);
});

test('요약 한 줄',()=>{
 assert.equal(C.summary({stock_rows:120,stock_warning:'',created:2,updated:1,canceled:0,invoices:1,skipped:0},{mall:5}),
  '재고 120행 · 새 요청 2 · 수정 1 · 취소 0 · 송장 1 · 건너뜀 0 · 쇼핑몰 택배 제외 5');
 assert.equal(C.summary({stock_rows:null,stock_warning:'재고 4행(지난번 10행)이라 재고를 바꾸지 않았어요',created:0,updated:0,canceled:0,invoices:0,skipped:0},{mall:0}),
  '재고 경고: 재고 4행(지난번 10행)이라 재고를 바꾸지 않았어요 · 새 요청 0 · 수정 0 · 취소 0 · 송장 0 · 건너뜀 0 · 쇼핑몰 택배 제외 0');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/fassto-sync-core.test.cjs`
Expected: FAIL — `Cannot find module '../tools/fassto-sync-core.cjs'`

- [ ] **Step 3: Write `tools/fassto-sync-core.cjs`**

```js
'use strict';
// 파스토 OpenAPI 응답 → 대시보드 동기화 형식. 순수 함수만 둔다(네트워크·파일은 fassto-sync.cjs).
// 설계: docs/superpowers/specs/2026-11-27-fassto-api-sync-design.md
const KST=9*3600000;
// 응답 wrkStat는 숫자(1 출고요청, 2 작업중, 3 출고완료·부분출고완료, 8 취소, 9 결품). 조회 경로 코드도 받아 둔다.
const STATUS={'1':'ORDER','2':'WORKING','3':'DONE','8':'CANCEL','9':'SHORTAGE',
 ORDER:'ORDER',WORKING:'WORKING',DONE:'DONE',PARTDONE:'DONE',CANCEL:'CANCEL',SHORTAGE:'SHORTAGE'};
const GIFT={'01':'본품','02':'사은품','03':'부자재'};
const s=v=>String(v??'').trim();

const kstDay=ms=>new Date(ms+KST).toISOString().slice(0,10);
function addDays(day,n){const [y,m,d]=day.split('-').map(Number);return new Date(Date.UTC(y,m-1,d+n)).toISOString().slice(0,10);}
function dateRange(nowMs,back=14,ahead=14){const t=kstDay(nowMs);return {start:addDays(t,-back),end:addDays(t,ahead)};}

function normDate(v){
 const t=s(v);if(!t)return '';
 if(/T\d{2}:\d{2}/.test(t)&&/(Z|[+-]\d{2}:?\d{2})$/.test(t)){const ms=Date.parse(t);return Number.isFinite(ms)?kstDay(ms):'';}
 const m=/^(\d{4})-?(\d{2})-?(\d{2})/.exec(t);if(!m)return '';
 const iso=`${m[1]}-${m[2]}-${m[3]}`,dt=new Date(iso+'T00:00:00Z');
 return Number.isNaN(dt.getTime())||dt.toISOString().slice(0,10)!==iso?'':iso;
}

function toStockRows(list){
 const map=new Map();
 for(const x of list||[]){
  const code=s(x.cstGodCd);if(!code)continue;
  const exp=normDate(x.distTermDt),key=code+'|'+exp,qty=Number(x.canStockQty)||0;
  const prev=map.get(key);
  if(prev){prev.available_qty+=qty;continue;}
  map.set(key,{product_code:code,barcode:s(x.godBarcd),product_name:s(x.godNm),kind_text:GIFT[s(x.giftDiv)]||s(x.giftDiv),lot_text:'',expires_on:exp,available_qty:qty});
 }
 return [...map.values()];
}

const statusOf=x=>STATUS[s(x?.wrkStat)]||null;
function keepDelivery(x,{parcelSalesChannelEmptyOnly=true}={}){
 const div=s(x?.outDiv);
 if(div==='2')return true;
 if(div==='1')return !parcelSalesChannelEmptyOnly||!s(x.salChanel);
 return false;
}
const needsDetail=(x,state)=>(state?.slips||{})[s(x?.slipNo)]!==s(x?.updTime);

function toItems(detail){
 const d=Array.isArray(detail)?detail[0]:detail;
 return (d?.goods||[]).map(g=>({product_code:s(g.cstGodCd),product_name:s(g.godNm),expires_on:normDate(g.distTermDt),qty:Number(g.ordQty)||0}))
  .filter(g=>g.product_code&&g.qty>0);
}

function toDelivery(x,items){
 const o={slip_no:s(x.slipNo),order_no:s(x.ordNo),order_date:normDate(x.ordDt),out_div:s(x.outDiv)==='2'?'car':'parcel',shop_name:s(x.shopNm),
  status_code:statusOf(x),remark:s(x.remark),invoice_no:s(x.invoiceNo),parcel_name:s(x.parcelNm),registered_by:s(x.updUserNm),qty_total:Number(x.ordQty)||0};
 if(items)o.items=items;
 return o;
}

function tokenValid(tok,nowMs){
 const m=/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(s(tok?.expreDatetime));
 if(!s(tok?.accessToken)||!m)return false;
 const exp=Date.UTC(+m[1],+m[2]-1,+m[3],+m[4],+m[5],+m[6])-KST;
 return exp-nowMs>5*60000;
}

function summary(res,{mall=0}={}){
 const r=res||{};
 const stock=r.stock_warning?`재고 경고: ${r.stock_warning}`:r.stock_rows!=null?`재고 ${r.stock_rows}행`:'재고 없음';
 return `${stock} · 새 요청 ${r.created||0} · 수정 ${r.updated||0} · 취소 ${r.canceled||0} · 송장 ${r.invoices||0} · 건너뜀 ${r.skipped||0} · 쇼핑몰 택배 제외 ${mall}`;
}

module.exports={kstDay,addDays,dateRange,normDate,toStockRows,statusOf,keepDelivery,needsDetail,toItems,toDelivery,tokenValid,summary};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/fassto-sync-core.test.cjs`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add tools/fassto-sync-core.cjs tests/fassto-sync-core.test.cjs
git -c user.name=sylee -c user.email=sylee@entropymakeup.com commit -m "파스토 동기화: 응답 변환 모듈

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: 동기화 실행기 `tools/fassto-sync.cjs`

**Files:**
- Create: `tools/fassto-sync.cjs`
- Test: `tests/fassto-sync-run.test.cjs`
- Modify: `package.json` (`check`에 `&& node --check tools/fassto-sync-core.cjs && node --check tools/fassto-sync.cjs`)

**Interfaces:**
- Consumes: Task 3 모듈 전체, Task 2 RPC 이름과 인자(`{p_key,p_stock,p_deliveries}`, `{p_key,p_error}`).
- Produces: `run({dir, fetch, nowMs, dryRun, out}) → Promise<{status:'config-created'|'config-missing'|'locked'|'ip-skip'|'dry-run'|'ok'|'error', ...}>`, `newKey(out) → {key, hash}`, `loadConfig(dir)`, `defaultDir(env)`, `TEMPLATE`. CLI: `node tools/fassto-sync.cjs [--dry-run|--new-key]`. 설정 폴더: `FASSTO_SYNC_DIR` 또는 `%LOCALAPPDATA%\entropy-fassto-sync`.

- [ ] **Step 1: Write the failing test** — `tests/fassto-sync-run.test.cjs`

```js
const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const S=require('../tools/fassto-sync.cjs');
const NOW=Date.UTC(2026,10,27,1);
const tmp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'fassto-sync-'));
const CONFIG={fassto:{baseUrl:'https://fassto.example',apiCd:'cd',apiKey:'k',cstCd:'C1',whCd:''},supabase:{url:'https://db.example',anonKey:'anon',syncKey:'s'.repeat(40)}};
const writeConfig=(dir,c=CONFIG)=>fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify(c));

// 경로별로 응답을 돌려주는 가짜 fetch. 호출을 기록한다.
function fakeFetch(routes){
 const calls=[];
 const fetch=async(url,opt={})=>{
  calls.push({url,method:opt.method||'GET',headers:opt.headers||{},body:opt.body?JSON.parse(opt.body):null});
  for(const [re,fn] of routes){const m=re.exec(url);if(m){const r=await fn(m,opt);return {ok:(r.status||200)<400,status:r.status||200,json:async()=>r.body,text:async()=>JSON.stringify(r.body??null)};}}
  return {ok:false,status:404,json:async()=>({}),text:async()=>'not found'};
 };
 return {fetch,calls};
}
const ok=data=>({body:{header:{code:'200'},data}});
const baseRoutes=(over={})=>[
 [/\/api\/v1\/auth\/connect/,()=>ok({accessToken:'tok',expreDatetime:'20261127180000'})],
 [/\/api\/v1\/stock\/list\/C1/,()=>ok([{cstGodCd:'11111111111111',godNm:'가짜 상품',giftDiv:'01',distTermDt:'2029-01-01',canStockQty:5}])],
 [/\/api\/v1\/delivery\/C1\/2026-11-13\/2026-12-11\/ALL\/2/,()=>ok([{slipNo:'GG24OO261201000001',ordNo:'가짜 주문 1',ordDt:'2026-12-01',outDiv:'2',shopNm:'가짜 바이어',ordQty:30,wrkStat:'1',updTime:'t1',updUserNm:'가짜 요청자'}])],
 [/\/api\/v1\/delivery\/C1\/2026-11-13\/2026-12-11\/ALL\/1/,()=>ok([{slipNo:'GG24OO261201000002',outDiv:'1',salChanel:'가짜몰',wrkStat:'1',updTime:'t'}])],
 [/\/api\/v1\/delivery\/detail\/C1\/GG24OO261201000001/,()=>ok([{goods:[{cstGodCd:'11111111111111',godNm:'가짜 상품',distTermDt:'2029-01-01',ordQty:30}]}])],
 [/\/rest\/v1\/rpc\/logistics_fassto_ingest/,()=>({body:{stock_rows:1,stock_warning:'',created:1,updated:0,canceled:0,invoices:0,skipped:0}})],
 [/\/rest\/v1\/rpc\/logistics_fassto_report_error/,()=>({body:null})],
 ...(over.routes||[])];

test('처음 실행하면 빈 설정 파일을 만들고 끝낸다',async()=>{
 const dir=tmp(),out=[];
 const r=await S.run({dir,fetch:async()=>{throw new Error('부르면 안 됨');},nowMs:NOW,out:m=>out.push(m)});
 assert.equal(r.status,'config-created');
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,'config.json'),'utf8')),S.TEMPLATE);
 const r2=await S.run({dir,fetch:async()=>{throw new Error('x');},nowMs:NOW,out:m=>out.push(m)});
 assert.equal(r2.status,'config-missing');assert.match(out.at(-1),/fassto\.apiCd/);
});

test('정상 실행: 쇼핑몰 택배를 빼고, 바뀐 건만 상세를 부르고, 한 번에 ingest하고, 토큰과 상태를 다시 쓴다',async()=>{
 const dir=tmp();writeConfig(dir);
 const f=fakeFetch(baseRoutes());
 const r=await S.run({dir,fetch:f.fetch,nowMs:NOW,out:()=>{}});
 assert.equal(r.status,'ok');
 const ingest=f.calls.find(c=>/logistics_fassto_ingest/.test(c.url));
 assert.equal(ingest.headers.apikey,'anon');assert.equal(ingest.headers.Authorization,'Bearer anon');
 assert.equal(ingest.body.p_key,'s'.repeat(40));
 assert.equal(ingest.body.p_stock.length,1);
 assert.deepEqual(ingest.body.p_deliveries.map(d=>d.slip_no),['GG24OO261201000001']);
 assert.equal(ingest.body.p_deliveries[0].items[0].qty,30);
 const api=f.calls.filter(c=>c.url.startsWith('https://fassto.example')&&!/auth/.test(c.url));
 assert.ok(api.every(c=>c.headers.accessToken==='tok'));
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,'state.json'),'utf8')),{slips:{GG24OO261201000001:'t1'}});
 // 두 번째: 토큰 재사용(connect 없음), 상세 다시 안 부름, 품목 없이 보냄
 const g=fakeFetch(baseRoutes());
 await S.run({dir,fetch:g.fetch,nowMs:NOW+60000,out:()=>{}});
 assert.equal(g.calls.filter(c=>/auth\/connect/.test(c.url)).length,0);
 assert.equal(g.calls.filter(c=>/delivery\/detail/.test(c.url)).length,0);
 assert.equal('items' in g.calls.find(c=>/ingest/.test(c.url)).body.p_deliveries[0],false);
 const log=fs.readFileSync(path.join(dir,'logs','2026-11-27.log'),'utf8');
 assert.match(log,/새 요청 1/);
});

test('상세 조회가 실패한 건은 품목 없이 보내고, 다음 실행에서 다시 부른다',async()=>{
 const dir=tmp();writeConfig(dir);
 const f=fakeFetch([[/delivery\/detail/,()=>({status:500,body:{errorInfo:{errorCode:'SERVER',errorMessage:'x'}}})],...baseRoutes()]);
 const r=await S.run({dir,fetch:f.fetch,nowMs:NOW,out:()=>{}});
 assert.equal(r.status,'ok');
 assert.equal('items' in f.calls.find(c=>/ingest/.test(c.url)).body.p_deliveries[0],false);
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,'state.json'),'utf8')),{slips:{}});
});

test('IP가 거부되면 DB에 아무것도 쓰지 않고 조용히 끝낸다',async()=>{
 const dir=tmp();writeConfig(dir);
 const f=fakeFetch([[/auth\/connect/,()=>({status:403,body:{errorInfo:{errorCode:'INVALID_ACCESS',errorMessage:'ip'}}})],...baseRoutes()]);
 const r=await S.run({dir,fetch:f.fetch,nowMs:NOW,out:()=>{}});
 assert.equal(r.status,'ip-skip');
 assert.equal(f.calls.filter(c=>/rest\/v1/.test(c.url)).length,0);
});

test('그 밖의 오류는 report_error로 남기고, 미리보기는 DB를 부르지 않는다',async()=>{
 const dir=tmp();writeConfig(dir);
 const f=fakeFetch([[/stock\/list/,()=>({status:500,body:{errorInfo:{errorCode:'SERVER',errorMessage:'점검 중'}}})],...baseRoutes()]);
 const r=await S.run({dir,fetch:f.fetch,nowMs:NOW,out:()=>{}});
 assert.equal(r.status,'error');process.exitCode=0;
 assert.match(f.calls.find(c=>/report_error/.test(c.url)).body.p_error,/SERVER: 점검 중/);
 const g=fakeFetch(baseRoutes()),out=[];
 const d=await S.run({dir,fetch:g.fetch,nowMs:NOW,dryRun:true,out:m=>out.push(m)});
 assert.equal(d.status,'dry-run');assert.equal(d.mall,1);
 assert.equal(g.calls.filter(c=>/rest\/v1/.test(c.url)).length,0);
 assert.match(out.join('\n'),/쇼핑몰 택배 1건 제외/);
 assert.equal(fs.existsSync(path.join(dir,'state.json')),false);
});

test('15분 안에 만든 잠금 파일이 있으면 건너뛴다',async()=>{
 const dir=tmp();writeConfig(dir);fs.writeFileSync(path.join(dir,'sync.lock'),'x');
 const r=await S.run({dir,fetch:async()=>{throw new Error('x');},nowMs:NOW,out:()=>{}});
 assert.equal(r.status,'locked');
});

test('--new-key: 열쇠와 sha256 해시를 만들고, SQL에는 해시만 넣는다',()=>{
 const out=[];const {key,hash}=S.newKey(m=>out.push(m));
 assert.match(key,/^[0-9a-f]{64}$/);
 assert.equal(hash,crypto.createHash('sha256').update(key,'utf8').digest('hex'));
 const sqlLine=out.find(l=>l.startsWith('insert into'));
 assert.ok(sqlLine.includes(hash)&&!sqlLine.includes(key));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/fassto-sync-run.test.cjs`
Expected: FAIL — `Cannot find module '../tools/fassto-sync.cjs'`

- [ ] **Step 3: Write `tools/fassto-sync.cjs`**

```js
#!/usr/bin/env node
'use strict';
// 파스토 OpenAPI → 대시보드 물류 요청 동기화. 파스토에 등록한 사무실 고정 IP의 PC에서 작업 스케줄러로 돈다.
// 쓰는 법: node tools/fassto-sync.cjs [--dry-run] [--new-key]
// 설정·토큰·상태·로그는 저장소 밖(FASSTO_SYNC_DIR 또는 %LOCALAPPDATA%\entropy-fassto-sync)에 둔다. 설치: LOGISTICS.md "파스토 API 동기화".
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const C=require('./fassto-sync-core.cjs');

const TEMPLATE={fassto:{baseUrl:'https://fmsapi.fassto.ai',apiCd:'',apiKey:'',cstCd:'',whCd:''},
 supabase:{url:'',anonKey:'',syncKey:''},parcelSalesChannelEmptyOnly:true,lookbackDays:14,lookaheadDays:14};
const REQUIRED=['fassto.apiCd','fassto.apiKey','fassto.cstCd','supabase.url','supabase.anonKey','supabase.syncKey'];
const LOCK_MS=15*60000;

class FasstoError extends Error{constructor(code,msg){super(`${code}: ${msg}`);this.code=code;}}

const defaultDir=(env=process.env)=>env.FASSTO_SYNC_DIR||path.join(env.LOCALAPPDATA||path.join(os.homedir(),'AppData','Local'),'entropy-fassto-sync');
function readJson(p,def){try{return JSON.parse(fs.readFileSync(p,'utf8'));}catch(e){if(e.code==='ENOENT')return def;throw e;}}
function writeJson(p,v){const t=p+'.tmp';fs.writeFileSync(t,JSON.stringify(v,null,1));fs.renameSync(t,p);}

function loadConfig(dir){
 const p=path.join(dir,'config.json');
 if(!fs.existsSync(p)){fs.mkdirSync(dir,{recursive:true});writeJson(p,TEMPLATE);return {created:p};}
 const c=readJson(p,{});
 const config={...TEMPLATE,...c,fassto:{...TEMPLATE.fassto,...c.fassto},supabase:{...TEMPLATE.supabase,...c.supabase}};
 const missing=REQUIRED.filter(k=>!String(k.split('.').reduce((o,x)=>o?.[x],config)||'').trim());
 return {config,missing};
}

function takeLock(dir){
 const p=path.join(dir,'sync.lock');
 try{fs.writeFileSync(p,String(Date.now()),{flag:'wx'});return ()=>fs.rmSync(p,{force:true});}
 catch(e){
  if(e.code!=='EEXIST')throw e;
  if(Date.now()-fs.statSync(p).mtimeMs<LOCK_MS)return null;
  fs.rmSync(p,{force:true});return takeLock(dir);
 }
}

function logger(dir,nowMs){
 const ld=path.join(dir,'logs');fs.mkdirSync(ld,{recursive:true});
 const day=C.kstDay(nowMs),cut=C.addDays(day,-30);
 for(const f of fs.readdirSync(ld)){const m=/^(\d{4}-\d{2}-\d{2})\.log$/.exec(f);if(m&&m[1]<cut)fs.rmSync(path.join(ld,f),{force:true});}
 return line=>fs.appendFileSync(path.join(ld,day+'.log'),`${new Date(nowMs+9*3600000).toISOString().slice(11,19)} ${line}\n`);
}

function fasstoClient({config,fetch,dir,nowMs}){
 const base=config.fassto.baseUrl.replace(/\/+$/,''),cst=encodeURIComponent(config.fassto.cstCd),tokenPath=path.join(dir,'token.json');
 let token=readJson(tokenPath,null);
 async function call(method,url,headers={}){
  const res=await fetch(url,{method,headers:{Accept:'application/json',...headers}});
  let body;try{body=await res.json();}catch(_){throw new FasstoError('BAD_RESPONSE',`HTTP ${res.status}`);}
  const err=body&&body.errorInfo;
  if(err&&err.errorCode)throw new FasstoError(err.errorCode,err.errorMessage||'');
  if(!res.ok)throw new FasstoError('HTTP_'+res.status,(body&&body.header&&body.header.msg)||'');
  return body?body.data:null;
 }
 async function connect(){
  const q=`apiCd=${encodeURIComponent(config.fassto.apiCd)}&apiKey=${encodeURIComponent(config.fassto.apiKey)}`;
  const d=await call('POST',`${base}/api/v1/auth/connect?${q}`);
  if(!d||!d.accessToken)throw new FasstoError('NO_TOKEN','토큰을 받지 못했어요');
  token={accessToken:String(d.accessToken),expreDatetime:String(d.expreDatetime||'')};writeJson(tokenPath,token);
 }
 async function get(p){
  if(!C.tokenValid(token,nowMs))await connect();
  try{return await call('GET',base+p,{accessToken:token.accessToken});}
  catch(e){if(!/TOKEN|AUTH/i.test(e.code||''))throw e;await connect();return call('GET',base+p,{accessToken:token.accessToken});}
 }
 return {
  stock:()=>get(`/api/v1/stock/list/${cst}`+(config.fassto.whCd?`?whCd=${encodeURIComponent(config.fassto.whCd)}`:'')),
  deliveries:(start,end,outDiv)=>get(`/api/v1/delivery/${cst}/${start}/${end}/ALL/${outDiv}`),
  detail:slip=>get(`/api/v1/delivery/detail/${cst}/${encodeURIComponent(slip)}`)
 };
}

async function rpc(config,fetch,fn,args){
 const res=await fetch(`${config.supabase.url.replace(/\/+$/,'')}/rest/v1/rpc/${fn}`,{method:'POST',
  headers:{apikey:config.supabase.anonKey,Authorization:`Bearer ${config.supabase.anonKey}`,'Content-Type':'application/json'},body:JSON.stringify(args)});
 const text=await res.text();
 if(!res.ok)throw new Error(`DB ${res.status}: ${String(text).slice(0,200)}`);
 return text?JSON.parse(text):null;
}

async function run({dir=defaultDir(),fetch=globalThis.fetch,nowMs=Date.now(),dryRun=false,out=console.log}={}){
 const cfg=loadConfig(dir);
 if(cfg.created){out(`설정 파일을 만들었어요: ${cfg.created}\n값을 채운 뒤 다시 실행하세요.`);return {status:'config-created'};}
 if(cfg.missing.length){out('설정 파일에 빈 값이 있어요: '+cfg.missing.join(', '));return {status:'config-missing'};}
 const config=cfg.config,log=logger(dir,nowMs);
 const release=takeLock(dir);
 if(!release){log('이전 실행이 아직 끝나지 않아 건너뜀');return {status:'locked'};}
 try{
  const fx=fasstoClient({config,fetch,dir,nowMs});
  const statePath=path.join(dir,'state.json'),state=readJson(statePath,{slips:{}});
  let stockList,raw;
  try{
   stockList=await fx.stock();
   const {start,end}=C.dateRange(nowMs,config.lookbackDays,config.lookaheadDays);
   raw=[...((await fx.deliveries(start,end,'2'))||[]),...((await fx.deliveries(start,end,'1'))||[])];
  }catch(e){
   if(e.code==='INVALID_ACCESS'){log('파스토가 이 IP를 거부함(사무실 밖에서 실행?) — 건너뜀');return {status:'ip-skip'};}
   throw e;
  }
  const kept=raw.filter(x=>C.keepDelivery(x,config)),mall=raw.length-kept.length;
  const deliveries=[],slips={},unknown=[];
  for(const x of kept){
   const slip=String(x.slipNo||'').trim();if(!slip)continue;
   if(!C.statusOf(x)){unknown.push(`${slip}:${x.wrkStat}`);continue;}
   let items=null;
   if(C.needsDetail(x,state)){
    try{items=C.toItems(await fx.detail(slip));slips[slip]=String(x.updTime||'');}
    catch(e){log(`상세 조회 실패 ${slip}: ${e.message}`);} // slips에 안 넣어 다음 실행에서 다시 부른다
   }else slips[slip]=state.slips[slip];
   deliveries.push(C.toDelivery(x,items));
  }
  if(unknown.length)log('모르는 작업상태라 건너뜀: '+unknown.join(', '));
  const stock=C.toStockRows(stockList);
  if(dryRun){
   out(`[미리보기] 재고 ${stock.length}행 · 출고 ${raw.length}건 중 쇼핑몰 택배 ${mall}건 제외 · 동기화 대상 ${deliveries.length}건`);
   for(const d of deliveries)out(`- ${d.slip_no} | ${d.out_div==='car'?'차량':'택배'} | ${d.status_code} | ${d.order_date} | ${d.shop_name} | ${d.order_no} | ${d.qty_total}개`
    +(d.items?` | 품목 ${d.items.length}줄`:'')+(d.invoice_no?` | 송장 ${d.parcel_name} ${d.invoice_no}`:''));
   out('재고 상품코드 예시: '+stock.slice(0,5).map(r=>r.product_code).join(', '));
   if(unknown.length)out('모르는 작업상태: '+unknown.join(', '));
   return {status:'dry-run',stock,deliveries,mall};
  }
  const res=await rpc(config,fetch,'logistics_fassto_ingest',{p_key:config.supabase.syncKey,p_stock:stock,p_deliveries:deliveries});
  writeJson(statePath,{slips});
  const line=C.summary(res,{mall});log(line);out(line);
  return {status:'ok',result:res};
 }catch(e){
  log('실패: '+e.message);out('실패: '+e.message);
  if(!dryRun){try{await rpc(config,fetch,'logistics_fassto_report_error',{p_key:config.supabase.syncKey,p_error:String(e.message).slice(0,300)});}
   catch(e2){log('오류 기록 실패: '+e2.message);}}
  process.exitCode=1;
  return {status:'error',error:e};
 }finally{release();}
}

function newKey(out=console.log){
 const key=crypto.randomBytes(32).toString('hex'),hash=crypto.createHash('sha256').update(key,'utf8').digest('hex');
 out('아래 열쇠를 설정 파일의 supabase.syncKey에 넣으세요. 이 화면에만 한 번 보여요:');
 out(key);
 out('Supabase SQL 편집기에서 아래 문장을 실행하세요(해시만 들어 있어요):');
 out(`insert into approval_private.logistics_fassto_keys(key_hash,label_text) values ('${hash}','사무실 PC');`);
 return {key,hash};
}

if(require.main===module){
 const args=process.argv.slice(2);
 if(args.includes('--new-key'))newKey();
 else run({dryRun:args.includes('--dry-run')});
}
module.exports={run,newKey,loadConfig,defaultDir,TEMPLATE};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/fassto-sync-run.test.cjs`
Expected: PASS (7 tests)

- [ ] **Step 5: Add to `package.json` check, run suite, commit**

`package.json`의 `"check"` 값 끝 `&& node --check tools/fassto-stock-json.cjs` 뒤에 ` && node --check tools/fassto-sync-core.cjs && node --check tools/fassto-sync.cjs`를 붙인다.

Run: `npm run check && npm test`
Expected: 오류 없음, 전부 PASS

```bash
git add tools/fassto-sync.cjs tests/fassto-sync-run.test.cjs package.json
git -c user.name=sylee -c user.email=sylee@entropymakeup.com commit -m "파스토 동기화: 실행기(설정·잠금·토큰·미리보기·열쇠)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: 화면 — 파스토 표시, 동기화 상태 줄, 기사 정보

**Files:**
- Modify: `logistics.js` (`nameOf` 9행, `createApi.loadStock` 79~87행, `renderList` 159~169행, `renderStockBanner` 197~202행, `renderPending` 171~194행, `renderFasstoSection` 249~282행, `renderDetail` 284~318행, `mountTab` 안 `NO_FASSTO` 352행·`drawDetail` 394행·`openDetail` 403~426행·`submitStatus` 474~484행)
- Modify: `index.html:703`, `logistics.html:55` (`logistics.js?v=20261127-fassto-api-1`)
- Test: `tests/logistics-ui.test.cjs` (파일 끝에 추가)

**Interfaces:**
- Consumes: Task 1 칸·표(`fassto_slip_no`, `fassto_status_code`, `fassto_synced_at`, `logistics_request_drivers`, `logistics_fassto_sync.kind_code|error_text`).
- Produces: `api.loadStock() → {rows, sync, deliverySync}`, `api.loadDriver(id) → row|null`, `api.saveDriver(id, {driver_name_text, driver_phone_text, vehicle_no_text}) → row`, `renderStockBanner(stock, nowMs)`가 `stock.deliverySync`를 읽음, `renderDetail` ctx에 `driver`.

- [ ] **Step 1: Write the failing tests** — `tests/logistics-ui.test.cjs` 끝에 추가

```js
test('파스토 동기화: 목록에 파스토 표시와 작업상태, 상태 줄은 정상·오류를 나눈다',()=>{
 const html=P.renderList([R('r1',{fassto_slip_no:'GG24OO261201000001',fassto_status_code:'WORKING'}),R('r2')],{nowMs:NOW,view:'todo'});
 assert.ok(html.includes('파스토 · 출고작업중'));
 assert.equal(html.split('lg-fassto-tag').length-1,1);
 const stock={rows:[],groups:[],error:'',sync:{synced_at:'2026-11-20T00:50:00Z'}};
 assert.ok(P.renderStockBanner({...stock,deliverySync:{synced_at:'2026-11-20T00:55:00Z',error_text:'',note_text:'새 1'}},NOW).includes('파스토 동기화: 11/20 09:55 정상'));
 const bad=P.renderStockBanner({...stock,deliverySync:{synced_at:'2026-11-20T00:55:00Z',error_text:'SERVER: 점검 중',note_text:''}},NOW);
 assert.ok(bad.includes('파스토 동기화 오류(11/20 09:55): SERVER: 점검 중')&&bad.includes('warn'));
 assert.ok(!P.renderStockBanner(stock,NOW).includes('파스토 동기화'));
});

test('파스토 동기화: 상세에 출고요청번호·작업상태, 기사 정보는 볼 수 있는 사람에게, 동기화 작성자 이름',()=>{
 const r=R('r1',{type_code:'b2b',ship_mode_code:'direct',fassto_slip_no:'GG24OO261201000001',fassto_status_code:'ORDER',fassto_synced_at:'2026-11-20T00:55:00Z'});
 const base={isHandler:true,email:'handler@entropymakeup.com',nowMs:NOW,fassto:{loaded:true,items:[],recipient:null}};
 const html=P.renderDetail(r,{...base,driver:{driver_name_text:'가짜 기사',driver_phone_text:'010-0000-0000',vehicle_no_text:'00가0000'},
  comments:[{id:'c1',author_email:'fassto-sync',body_text:'[파스토 동기화] x',created_at:'2026-11-20T00:00:00Z'}],history:[]});
 assert.ok(html.includes('파스토 출고요청 GG24OO261201000001 · 출고요청'));
 assert.ok(html.includes('가짜 기사 · 010-0000-0000 · 00가0000'));
 assert.ok(html.includes('<b>파스토 동기화</b>'));
 const other=P.renderDetail(r,{...base,isHandler:false,email:'other@entropymakeup.com',driver:null,comments:[],history:[]});
 assert.ok(!other.includes('기사 정보'));
});

test('파스토 동기화: 직납 출고완료 폼에 기사 칸이 나오고, 택배는 동기화가 채운 송장이 결과 칸에 들어간다',()=>{
 const base={isHandler:true,email:'handler@entropymakeup.com',nowMs:NOW,fassto:{loaded:true,items:[],recipient:null},comments:[],history:[],pending:{kind:'status',to:'shipped'}};
 const car=P.renderDetail(R('r1',{type_code:'b2b',ship_mode_code:'direct',status_code:'preparing'}),{...base,driver:{driver_name_text:'가짜 기사',driver_phone_text:'',vehicle_no_text:'00가0000'}});
 assert.ok(car.includes('name="vehicle_no_text" value="00가0000"')&&car.includes('name="driver_name_text"')&&car.includes('name="driver_phone_text"'));
 assert.ok(!/name="result_text"[^>]*required/.test(car)); // 차량번호로 결과를 채울 수 있어 필수 표시를 하지 않는다
 const parcel=P.renderDetail(R('r2',{type_code:'b2b',ship_mode_code:'parcel',status_code:'preparing',result_text:'가짜택배 000011112222'}),base);
 assert.ok(parcel.includes('가짜택배 000011112222</textarea>')&&!parcel.includes('name="vehicle_no_text"'));
});

test('api: 재고·출고 동기화 기록을 따로 읽고, 기사 정보는 upsert로 저장한다',async()=>{
 const {client,calls}=fakeClient(q=>{
  if(q.table==='logistics_fassto_stock')return {data:[],error:null};
  if(q.table==='logistics_fassto_sync'){const k=q.ops.find(o=>o[0]==='eq'&&o[1]==='kind_code')[2];return {data:[{synced_at:'x',kind_code:k,error_text:''}],error:null};}
  if(q.table==='logistics_request_drivers')return {data:[{request_id:'r1',vehicle_no_text:'00가0000'}],error:null};
  return {data:null,error:null};});
 const api=P.createApi(client,{uuid:()=>'u'});
 const s=await api.loadStock();
 assert.equal(s.sync.kind_code,'stock');assert.equal(s.deliverySync.kind_code,'delivery');
 assert.ok(calls.some(c=>c.table==='logistics_fassto_sync'&&c.ops.some(o=>o[0]==='eq'&&o[1]==='error_text'&&o[2]==='')));
 assert.equal((await api.loadDriver('r1')).vehicle_no_text,'00가0000');
 await api.saveDriver('r1',{driver_name_text:'가짜 기사',driver_phone_text:'',vehicle_no_text:'00가0000'});
 const up=calls.find(c=>c.table==='logistics_request_drivers'&&c.ops[0][0]==='upsert');
 assert.deepEqual(up.ops[0][1],{driver_name_text:'가짜 기사',driver_phone_text:'',vehicle_no_text:'00가0000',request_id:'r1'});
 assert.deepEqual(up.ops[0][2],{onConflict:'request_id'});
});

test('mountTab: 직납 출고완료는 기사 정보를 먼저 저장하고, 결과가 비면 "차량 <번호>"로 채운다',async()=>{
 const drivers=[];
 const t=setup({rows:[R('r1',{type_code:'b2b',ship_mode_code:'direct',status_code:'preparing'})],handler:q=>{
  if(q.table==='logistics_request_drivers'&&q.ops[0][0]==='upsert'){drivers.push(q.ops[0][1]);return {data:[q.ops[0][1]],error:null};}
  if(q.table==='logistics_request_drivers')return {data:[],error:null};}});
 await t.page.show();await t.page.openDetail('r1');
 click(t.d,{to:'shipped'});
 await submit(t.d,{result_text:'',shipped_on:'2026-11-20',driver_name_text:'가짜 기사',driver_phone_text:'010-0000-0000',vehicle_no_text:'00가0000'},'status');
 assert.deepEqual(drivers,[{driver_name_text:'가짜 기사',driver_phone_text:'010-0000-0000',vehicle_no_text:'00가0000',request_id:'r1'}]);
 assert.deepEqual(t.updates[0].ops[0][1],{status_code:'shipped',result_text:'차량 00가0000',shipped_on:'2026-11-20'});
 const i=t.calls.findIndex(c=>c.table==='logistics_request_drivers'&&c.ops[0][0]==='upsert'),j=t.calls.indexOf(t.updates[0]);
 assert.ok(i>=0&&i<j);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/logistics-ui.test.cjs`
Expected: 새 테스트 5개 FAIL(예: `api.loadDriver is not a function`, `파스토 · 출고작업중` 없음)

- [ ] **Step 3: Implement in `logistics.js`**

3-1. 9행 `nameOf`를 바꾼다(동기화·시스템 작성자 이름):

```js
const SPECIAL_NAMES={'fassto-sync':'파스토 동기화',system:'시스템'};
const nameOf=(email,people)=>SPECIAL_NAMES[String(email||'')]||(people||[]).find(p=>p.email===String(email||'').toLowerCase())?.display_name||String(email||'').split('@')[0];
const FASSTO_STATUS={ORDER:'출고요청',WORKING:'출고작업중',DONE:'출고완료',CANCEL:'출고요청취소',SHORTAGE:'재고부족결품'};
```

3-2. `createApi`의 `loadStock`에서 sync 한 줄(`const sync=await need(...)`)과 return을 바꾸고, 아래 두 메서드를 `loadRecipient` 바로 앞에 더한다:

```js
   const [sync,deliverySync]=await Promise.all([
    need(client.from('logistics_fassto_sync').select('synced_at,source_text,row_count,kind_code,error_text').eq('kind_code','stock').eq('error_text','').order('synced_at',{ascending:false}).limit(1)),
    need(client.from('logistics_fassto_sync').select('synced_at,source_text,row_count,kind_code,error_text,note_text').eq('kind_code','delivery').order('synced_at',{ascending:false}).limit(1))]);
   return {rows,sync:Array.isArray(sync)?sync[0]||null:null,deliverySync:Array.isArray(deliverySync)?deliverySync[0]||null:null};
  },
  // 기사 정보: 요청자·담당자만 읽힌다(RLS). 쓰기는 담당자만.
  async loadDriver(id){
   const rows=await need(client.from('logistics_request_drivers').select('*').eq('request_id',id));
   return Array.isArray(rows)?rows[0]||null:null;
  },
  async saveDriver(id,row){
   const rows=await need(client.from('logistics_request_drivers').upsert({...row,request_id:id},{onConflict:'request_id'}).select());
   if(!Array.isArray(rows)||rows.length!==1)throw new Error('UNCONFIRMED');return rows[0];
```

(원래 `loadStock`의 닫는 `},`는 위 코드의 `},`로 대체된다. `saveDriver` 뒤에는 원래 있던 `},`와 `// 볼 권한이 없으면…` 주석, `async loadRecipient`가 이어진다.)

3-3. `renderList`의 제목 칸에서 `${esc(r.title_text)}</button>` 바로 뒤에 넣는다:

```js
${r.fassto_slip_no?` <span class="badge bg-gray lg-fassto-tag" title="파스토 ${esc(r.fassto_slip_no)}">파스토${r.fassto_status_code?' · '+esc(FASSTO_STATUS[r.fassto_status_code]||r.fassto_status_code):''}</span>`:''}
```

3-4. `renderStockBanner`를 바꾼다:

```js
function renderStockBanner(stock,nowMs){
 if(!stock)return '';
 if(stock.error)return `<p class="lg-stock warn" role="status">파스토 목록을 불러오지 못했어요: ${esc(stock.error)}</p>`;
 const a=F.stockAge(stock.sync,stock.groups,nowMs),ds=stock.deliverySync;
 const sync=!ds?'':ds.error_text?`<p class="lg-stock warn" role="status">파스토 동기화 오류(${esc(kstTime(ds.synced_at))}): ${esc(ds.error_text)}</p>`
  :`<p class="lg-stock" role="status">파스토 동기화: ${esc(kstTime(ds.synced_at))} 정상</p>`;
 return `<p class="lg-stock${a.stale?' warn':''}" role="status">${esc(a.text)}</p>`+sync;
}
```

(`kstTime`은 116행에 정의돼 있고 `MM/DD HH:MM`을 돌려준다. `renderStockBanner`는 197행이라 이미 정의된 뒤다.)

3-5. `renderPending`의 `if(to==='shipped')body+=…` 부분을 바꾼다:

```js
  if(to==='shipped'){
   const car=r.ship_mode_code==='direct',dv=ctx.driver||{};
   const inp=(name,label,val,max)=>`<div class="fg"><label for="lg-p-${name}">${label}</label><input id="lg-p-${name}" name="${name}" maxlength="${max}" value="${esc(v(name,val||''))}"></div>`;
   body+=ta('result_text',`결과(송장·배차·BL) <small>${car?'차량번호를 적으면 비워 둬도 돼요':'필수'} · 슬랙 채널에 그대로 보여요</small>`,r.result_text||'',M.LIMITS.result,car?' data-autofocus':' required data-autofocus')
    +`<div class="fg"><label for="lg-p-shipped_on">출고일 <small>필수</small></label><input type="date" id="lg-p-shipped_on" name="shipped_on" value="${esc(v('shipped_on',r.shipped_on||today))}" required></div>`
    +(car?inp('vehicle_no_text','차량번호',dv.vehicle_no_text,20)+inp('driver_name_text','기사 이름 <small>슬랙에 안 보여요</small>',dv.driver_name_text,40)+inp('driver_phone_text','기사 연락처 <small>슬랙에 안 보여요</small>',dv.driver_phone_text,40):'');
  }
```

3-6. `renderFasstoSection`: 맨 앞 조건을 `if(!form&&!items.length&&!r.fassto_slip_no)return '';`로 바꾸고, return 문자열의 `<p class="lg-hint">…</p>` 바로 뒤에 넣는다:

```js
  +(r.fassto_slip_no?`<p class="lg-muted">파스토 출고요청 ${esc(r.fassto_slip_no)} · ${esc(FASSTO_STATUS[r.fassto_status_code]||'-')}${r.fassto_synced_at?` · 확인 ${esc(kstTime(r.fassto_synced_at))}`:''}</p>`:'')
```

3-7. `renderDetail`: 필드 목록(`${field('결과(송장·배차·BL)',…)}` 바로 앞)에 넣는다:

```js
 +(r.ship_mode_code==='direct'&&(ctx.isHandler||owner)&&ctx.driver?field('기사 정보',[ctx.driver.driver_name_text,ctx.driver.driver_phone_text,ctx.driver.vehicle_no_text].filter(Boolean).join(' · '),' lg-wide'):'')
```

3-8. `mountTab`:
- `drawDetail`의 `renderDetail(r,{…,fassto:state.fassto,fasstoErrors:state.fasstoErrors})`에 `,driver:state.driver`를 더한다.
- `openDetail`에서 `state.fassto={...NO_FASSTO(),loading:true};` 뒤에 `state.driver=null;`을 넣고, `Promise.allSettled([...])` 배열에 넷째로 `canSee&&r0.ship_mode_code==='direct'?api.loadDriver(id):Promise.resolve(null)`을 더해 `const [det,rec,its,drv]=…`로 받는다. `state.detailLoading=false;` 바로 앞에 `state.driver=drv.status==='fulfilled'?drv.value:null;`을 넣는다(기사 정보를 못 불러와도 상세는 연다).
- `submitStatus`의 `if(p.to==='shipped'){…}` 블록을 바꾼다:

```js
  if(p.to==='shipped'){
   fields.result_text=String(v.result_text||'').trim();fields.shipped_on=String(v.shipped_on||'').trim();
   const car=r.ship_mode_code==='direct';
   const drv=car?{driver_name_text:String(v.driver_name_text||'').trim(),driver_phone_text:String(v.driver_phone_text||'').trim(),vehicle_no_text:String(v.vehicle_no_text||'').trim()}:null;
   if(!fields.result_text&&drv?.vehicle_no_text)fields.result_text='차량 '+drv.vehicle_no_text;
   if(!fields.result_text)return fail('결과(송장·배차·BL)를 적어 주세요.');
   if(!M.isDate(fields.shipped_on))return fail('출고일을 골라 주세요.');
   if(drv&&(drv.driver_name_text||drv.driver_phone_text||drv.vehicle_no_text))return saveDriverThenStatus(r,drv,fields);
  }
```

  그리고 `submitStatus` 함수 바로 위에 더한다:

```js
 async function saveDriverThenStatus(r,drv,fields){
  if(state.busy)return;
  setBusy(true);
  try{await api.saveDriver(r.id,drv);state.driver={request_id:r.id,...drv};}
  catch(e){setBusy(false);return detailFail(e);}
  setBusy(false);
  return saveStatus(r,'shipped',fields);
 }
```

3-9. `index.html` 703행과 `logistics.html` 55행의 `logistics.js?v=20261123-standalone-1`을 `logistics.js?v=20261127-fassto-api-1`로 바꾼다.

- [ ] **Step 4: Run tests**

Run: `node --test tests/logistics-ui.test.cjs`
Expected: 새 테스트 포함 전부 PASS. 기존 "출고완료" 테스트(`quick` 운송)는 기사 칸이 없으므로 그대로 통과해야 한다. 버전 쿼리를 확인하는 기존 테스트(`asset-cache.test.cjs` 등)가 있으면 함께 맞춘다: `node --test tests/asset-cache.test.cjs`.

- [ ] **Step 5: Run suite, commit**

Run: `npm run check && npm test`
Expected: 전부 PASS

```bash
git add logistics.js index.html logistics.html tests/logistics-ui.test.cjs
git -c user.name=sylee -c user.email=sylee@entropymakeup.com commit -m "물류 요청 화면: 파스토 표시·동기화 상태·차량 기사 정보

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: 문서 — 설치 순서, API 동기화 절차, 재고 쿼리 정리

**Files:**
- Modify: `LOGISTICS.md`, `DEVELOPMENT.md`, `tools/fassto-sync-routine.txt`, `docs/superpowers/specs/2026-11-27-fassto-api-sync-design.md`
- Test: `tests/logistics-ui.test.cjs` (문서 테스트 추가)

**Interfaces:**
- Consumes: Task 1~5 이름(파일·함수·설정 폴더·CLI 옵션).
- Produces: 운영 절차 문서(사용자가 따라 함).

- [ ] **Step 1: Write the failing test** — `tests/logistics-ui.test.cjs` 끝에 추가

```js
test('운영 문서: 파스토 API 동기화 설치 절차와 재고 쿼리의 kind_code 조건',()=>{
 const fs=require('node:fs'),path=require('node:path');
 const doc=fs.readFileSync(path.join(__dirname,'../LOGISTICS.md'),'utf8');
 assert.ok(doc.includes('5. `sql/logistics-fassto-api.sql`'));
 assert.ok(doc.includes('### 파스토 API 동기화 (사무실 PC)'));
 for(const s of ['node tools/fassto-sync.cjs --new-key','node tools/fassto-sync.cjs --dry-run','Register-ScheduledTask','icacls','logistics_fassto_settings'])assert.ok(doc.includes(s),s);
 const routine=fs.readFileSync(path.join(__dirname,'../tools/fassto-sync-routine.txt'),'utf8');
 assert.ok(routine.includes("where kind_code='stock'"));
 assert.ok(doc.includes("where kind_code='stock'"));
 const dev=fs.readFileSync(path.join(__dirname,'../DEVELOPMENT.md'),'utf8');
 assert.ok(dev.includes('sql/logistics-fassto.sql → sql/logistics-fassto-api.sql'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/logistics-ui.test.cjs`
Expected: 새 테스트 FAIL

- [ ] **Step 3: Edit docs**

3-1. `LOGISTICS.md` 설치 순서: 지금 4번(`sql/logistics-fassto.sql`) 뒤에 새 5번을 넣고, 기존 5~8번을 6~9번으로 민다.

```markdown
5. `sql/logistics-fassto-api.sql` (파스토 API 동기화. **머지 전에 운영에 먼저 적용합니다.** 앞 파일 다음에 설치합니다. 적용 후 아래 "파스토 API 동기화 (사무실 PC)"의 1~2단계로 열쇠와 기본 요청자를 넣습니다)
```

3-2. `LOGISTICS.md`의 두 SQL(`select row_count from public.logistics_fassto_sync order by synced_at desc limit 1;`, `select synced_at, source_text, row_count from public.logistics_fassto_sync order by synced_at desc limit 1;`)에 `where kind_code='stock'`을 `order by` 앞에 넣는다. `tools/fassto-sync-routine.txt`의 같은 두 문장도 같게 바꾼다(문장 앞부분 `select row_count from public.logistics_fassto_sync`는 그대로 남아 기존 문서 테스트가 통과한다).

3-3. `LOGISTICS.md` "### 파스토 목록 갱신 (Claude, 브라우저)" 절 바로 앞에 새 절을 넣는다:

````markdown
### 파스토 API 동기화 (사무실 PC)

설계: `docs/superpowers/specs/2026-11-27-fassto-api-sync-design.md`. 파스토 API는 파스토에 등록한 사무실 회선 IP에서만 호출됩니다. 사무실에 상주하는 PC에서 돌립니다. 키·설정·로그는 저장소에 넣지 않습니다.

1. 열쇠 만들기(저장소 폴더에서): `node tools/fassto-sync.cjs --new-key`. 화면의 열쇠(64자)는 4단계 설정 파일에만 넣고, 함께 나온 `insert into approval_private.logistics_fassto_keys …` 문장을 Supabase SQL 편집기에서 실행합니다(해시만 들어 있습니다). 열쇠를 채팅이나 저장소에 붙이지 않습니다.
2. 기본 요청자(파스토 등록자를 명단에서 못 찾을 때) 넣기:

   ```sql
   insert into approval_private.logistics_fassto_settings(id, default_requester_email) values (1, 'name@entropymakeup.com')
    on conflict (id) do update set default_requester_email = excluded.default_requester_email;
   ```

3. `node tools/fassto-sync.cjs`를 한 번 실행하면 `%LOCALAPPDATA%\entropy-fassto-sync\config.json` 빈 양식이 생깁니다. 파일을 현재 사용자만 읽게 잠급니다:

   ```powershell
   icacls "$env:LOCALAPPDATA\entropy-fassto-sync" /inheritance:r /grant:r "${env:USERNAME}:(OI)(CI)F"
   ```

4. 설정 파일에 사용자가 직접 넣습니다: `fassto.apiCd`, `fassto.apiKey`, `fassto.cstCd`(고객사 코드), `supabase.url`, `supabase.anonKey`(웹페이지가 쓰는 공개 키), `supabase.syncKey`(1단계 열쇠).
5. 미리보기: `node tools/fassto-sync.cjs --dry-run`. DB에 쓰지 않고 동기화 대상 목록을 보여 줍니다. 확인할 것: 쇼핑몰 택배가 빠졌는지, 작업상태가 모두 읽혔는지("모르는 작업상태"가 없어야 함), 재고 상품코드가 지금 재고 표와 같은 체계(고객사상품코드)인지.
6. 한 번 실제 실행: `node tools/fassto-sync.cjs`. 물류 요청 화면에 파스토 요청이 생기고, 상단에 "파스토 동기화: … 정상"이 보이는지 확인합니다.
7. 작업 스케줄러 등록(평일 08:00~19:00, 10분마다, 로그온 중에만). PowerShell에서 저장소 폴더 기준으로:

   ```powershell
   $repo = (Get-Location).Path
   $action = New-ScheduledTaskAction -Execute "node" -Argument "tools\fassto-sync.cjs" -WorkingDirectory $repo
   $trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At 08:00
   $trigger.Repetition = (New-ScheduledTaskTrigger -Once -At 08:00 -RepetitionInterval (New-TimeSpan -Minutes 10) -RepetitionDuration (New-TimeSpan -Hours 11)).Repetition
   $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 9)
   Register-ScheduledTask -TaskName "Entropy Fassto Sync" -Action $action -Trigger $trigger -Settings $settings
   ```

8. 며칠 정상으로 돌면(사용자 확인 후) 브라우저 재고 갱신 예약 작업을 끕니다. 아래 "파스토 목록 갱신 (Claude, 브라우저)"는 API가 안 될 때 쓰는 예비 절차로 남깁니다.

문제 해결: 로그는 `%LOCALAPPDATA%\entropy-fassto-sync\logs\<날짜>.log`(30일 보관). "IP를 거부함"은 사무실 밖에서 실행된 경우라 무시해도 됩니다. 실패는 화면 상단에 빨간 "파스토 동기화 오류"로 보입니다. 열쇠를 바꾸려면 1단계를 다시 하고 옛 열쇠는 `update approval_private.logistics_fassto_keys set is_active=false where label_text=…`로 끕니다. 쓰는 함수는 `public.logistics_fassto_ingest`, `public.logistics_fassto_report_error` 두 개뿐이고 anon만 실행할 수 있습니다.
````

3-4. `DEVELOPMENT.md`에서 SQL 설치 순서 문구 `sql/logistics-slack.sql → sql/logistics-fassto.sql`를 `sql/logistics-slack.sql → sql/logistics-fassto.sql → sql/logistics-fassto-api.sql`로 바꾼다.

3-5. 설계 문서 6장 2단계의 SQL 블록 첫 줄(`insert into approval_private.logistics_fassto_keys(key_hash,label_text) values (encode(sha256(convert_to('<열쇠 원문>','UTF8')),'hex'),'사무실 PC');`)을 지우고, 그 아래 설명을 "열쇠 해시 넣는 문장은 `node tools/fassto-sync.cjs --new-key`가 해시를 채워 만들어 준다(원문을 SQL에 넣지 않는다)"로 바꾼다.

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: 전부 PASS(공개 저장소 검사 포함)

- [ ] **Step 5: Commit**

```bash
git add LOGISTICS.md DEVELOPMENT.md tools/fassto-sync-routine.txt docs/superpowers/specs/2026-11-27-fassto-api-sync-design.md tests/logistics-ui.test.cjs
git -c user.name=sylee -c user.email=sylee@entropymakeup.com commit -m "물류 문서: 파스토 API 동기화 설치 절차

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## 구현 뒤 운영 적용 (계획 밖, 단계마다 사용자 승인)

LOGISTICS.md 순서대로: 운영 DB에 `sql/logistics-fassto-api.sql` 적용 → 열쇠·기본 요청자 → 설정 파일 → `--dry-run` 검토 → 한 번 실행 → 작업 스케줄러 → PR 머지(배포) → 며칠 뒤 브라우저 예약 작업 끄기. 11/30(월) 출고 전 "한 번 실행"까지 끝내는 것이 목표다.
