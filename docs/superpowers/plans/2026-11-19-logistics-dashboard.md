# 물류 요청 대시보드 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 회사 전체가 출고·샘플·퀵·시딩·CS 요청을 등록하고, 물류 담당자가 상태와 결과(송장·배차·BL)를 남기며, 슬랙 #업무-배송요청에 자동 알림이 가는 별도 페이지 `logistics.html`을 만든다.

**Architecture:** 정적 페이지(GitHub Pages)와 기존 Supabase 프로젝트를 쓴다. 상태 규칙은 순수 함수 모듈 `logistics-model.js`(화면용)와 DB 트리거(최종 판정) 두 곳에 같은 표로 둔다. 슬랙 알림은 트리거가 outbox에 넣고, pg_cron이 1분마다 pg_net으로 `chat.postMessage`를 호출해 처리한다. 봇 토큰은 Vault에 둔다.

**Tech Stack:** 바닐라 JS(UMD 모듈), supabase-js v2(CDN), Postgres(PL/pgSQL, RLS, pg_net, pg_cron, Vault), `node --test`, `@electric-sql/pglite` 0.5.8(DB 테스트)

**Spec:** `docs/superpowers/specs/2026-11-19-logistics-dashboard-design.md`

## Global Constraints

- 기존 표·함수·정책은 바꾸지 않는다. `approval_private.is_company_member()`와 `approval_private.current_email()`만 재사용한다.
- 회사 계정 판정: `@entropymakeup.com` 또는 `entropyadmin@entropy.internal`(기존 `is_company_member()` 그대로)
- 상태 코드: `requested`(요청) `accepted`(접수) `preparing`(준비중) `shipped`(출고완료) `on_hold`(보류) `canceled`(취소)
- 유형 코드: `b2b` `sample` `quick` `seeding` `cs` `return` `etc`
- 요청팀 코드: `global` `domestic` `marketing` `cs` `etc`
- 운송 코드: `parcel` `quick` `air` `ocean` `direct` `express` `etc`
- 패킹리스트 코드: `waiting` `done` `replied`(null 허용). 첨부 종류: `request` `packing` `receipt` `etc`
- 길이 제한: 제목 1~80, 거래처·수신처 1~120, 수량 요약 ≤300, 특이사항 ≤1000, 결과 ≤500(출고완료 시 1~500), 상태 사유 ≤300, 포워더 ≤120, 댓글 1~1000
- 첨부: 파일당 20MB(20971520 bytes), 요청당 최대 10개, 비공개 버킷 `logistics-docs`, 경로 `{request_id}/{uuid}-{파일명}`
- 슬랙 메시지에는 금액·연락처·주소를 넣지 않는다. 사용자가 쓴 글자는 `& < >`를 이스케이프한다.
- 화면 저장은 반환 행을 확인한 뒤에만 성공으로 표시한다. 자동 재시도하지 않는다. 상태 변경은 이전 상태 조건 UPDATE로 하고, 0행이면 "다른 사람이 먼저 바꿨어요"를 안내한다.
- 화면에 넣는 문자열은 모두 `esc()`로 이스케이프한다.
- 실제 명단·토큰·영업자료는 저장소에 넣지 않는다.
- 페이지 주소: `https://entropymakeup-official.github.io/entropysales/logistics.html`
- 이 worktree에는 git 사용자 설정이 없다. 커밋은 `GIT_AUTHOR_NAME=sylee GIT_AUTHOR_EMAIL=sylee@entropymakeup.com GIT_COMMITTER_NAME=sylee GIT_COMMITTER_EMAIL=sylee@entropymakeup.com git commit ...`로 하고, 메시지 끝에 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`을 붙인다. git 설정은 바꾸지 않는다.
- 운영 DB 설치, Vault 저장, 배포는 이 계획에 넣지 않는다. 사용자 승인 뒤 별도로 한다(Task 8 끝의 운영 체크리스트).

## 설계 보완 (스펙 4절 해석)

스펙 4절의 화살표는 기본 흐름이다. 퀵처럼 바로 나가는 건을 위해 **담당자는 앞 단계를 건너뛸 수 있다**(requested→preparing, requested→shipped, accepted→shipped). 보류에서 돌아갈 때는 requested·accepted·preparing 중 하나를 고른다. 이 보완은 Task 1에서 스펙 문서에도 한 줄 반영한다.

## File Structure

| 파일 | 역할 |
|---|---|
| `logistics-model.js` (새로) | 코드표·라벨, 상태 전환표, 입력 검증, 지연 판정, 탭·검색·정렬, 오류 문구. DOM과 네트워크 없음 |
| `sql/logistics.sql` (새로) | 표 5개(handlers, people, requests, files, comments) + history + outbox, 트리거, RLS |
| `sql/logistics-storage.sql` (새로) | 버킷 `logistics-docs`, storage.objects 제한 정책 |
| `sql/logistics-slack.sql` (새로) | 메시지 문구 함수, flush 함수, pg_cron 등록 |
| `logistics.js` (새로) | `createApi(client)` 데이터 계층, `render*` HTML 함수, `mount()` 화면 연결 |
| `logistics.html`, `logistics.css` (새로) | 페이지 골격과 스타일 |
| `tests/logistics-model.test.cjs` | 모델 단위 테스트 |
| `tests/logistics-db.test.cjs` | PGlite로 표·트리거·RLS·storage 정책 검사 |
| `tests/logistics-slack-db.test.cjs` | PGlite + net/vault/cron 대체 스키마로 flush 검사 |
| `tests/logistics-ui.test.cjs` | 가짜 client로 `createApi`와 render 검사 |
| `index.html` (수정) | 왼쪽 메뉴에 링크 한 줄 |
| `package.json` (수정) | `check`에 두 파일 추가 |
| `LOGISTICS.md` (새로), `DEVELOPMENT.md` (수정) | 운영 안내, 배포 파일 목록 |

---

### Task 1: 상태 규칙과 입력 검증 모델

**Files:**
- Create: `logistics-model.js`
- Test: `tests/logistics-model.test.cjs`
- Modify: `docs/superpowers/specs/2026-11-19-logistics-dashboard-design.md` (4절 끝에 한 줄)

**Interfaces:**
- Produces (모두 `LogisticsModel.*`, Node에서는 `require('../logistics-model.js')`):
  - 상수: `TYPES, TEAMS, SHIP_MODES, STATUSES, PACKING, FILE_KINDS`(코드→라벨 객체), `OPEN`(배열), `CLOSED`(배열), `LIMITS`
  - `esc(v) → string`
  - `kstToday(nowMs) → 'YYYY-MM-DD'`
  - `isHandler(email, handlers) → boolean` (handlers: `[{email,is_active}]`)
  - `transitionAllowed(from, to) → boolean`
  - `checkTransition({isHandler, isOwner, from, to, fields}) → {ok:true} | {ok:false, reason:string}` (fields: `{result_text, shipped_on, status_note_text}`)
  - `allowedNext({isHandler, isOwner, from}) → string[]`
  - `validateDraft(draft) → string[]` (빈 배열이면 통과)
  - `toInsertRow(draft) → object`
  - `needsOverseas({type_code, ship_mode_code}) → boolean`
  - `isLate(req, nowMs) → boolean`
  - `sortRequests(list) → array` (새 배열)
  - `filterTab(list, tab, {email, nowMs}) → array` (tab: `'todo'|'hold'|'shipped'|'canceled'|'mine'`)
  - `search(list, q) → array`
  - `safeFileName(name) → string`
  - `errorMessage(err) → string`

- [ ] **Step 1: Write the failing test**

`tests/logistics-model.test.cjs`:

```js
const {test}=require('node:test');const assert=require('node:assert/strict');
const M=require('../logistics-model.js');
const KST=9*60*60*1000;
const kst=(day,hh=10)=>{const [y,m,d]=day.split('-').map(Number);return Date.UTC(y,m-1,d,hh)-KST;};
const NOW=kst('2026-11-20');
const req=o=>({id:'x',title_text:'요청',counterparty_text:'거래처',status_code:'requested',want_date:null,created_at:'2026-11-01T00:00:00Z',requester_email:'a@entropymakeup.com',result_text:'',...o});

test('전환표: 앞 단계는 건너뛸 수 있고 닫힌 상태에서는 출고완료 되돌리기만 된다',()=>{
 for(const [f,t] of [['requested','accepted'],['requested','preparing'],['requested','shipped'],['accepted','shipped'],['preparing','shipped'],['requested','on_hold'],['on_hold','accepted'],['on_hold','canceled'],['shipped','preparing']])
  assert.equal(M.transitionAllowed(f,t),true,`${f}->${t}`);
 for(const [f,t] of [['accepted','requested'],['shipped','canceled'],['canceled','requested'],['shipped','accepted'],['on_hold','shipped'],['requested','requested']])
  assert.equal(M.transitionAllowed(f,t),false,`${f}->${t}`);
});

test('담당자 검사: 출고완료는 결과와 출고일, 보류와 되돌리기는 사유가 필요하다',()=>{
 const h={isHandler:true,isOwner:false};
 assert.deepEqual(M.checkTransition({...h,from:'preparing',to:'shipped',fields:{result_text:' ',shipped_on:'2026-11-20'}}),{ok:false,reason:'출고완료에는 송장·배차·BL과 출고일이 필요해요.'});
 assert.deepEqual(M.checkTransition({...h,from:'preparing',to:'shipped',fields:{result_text:'CJ 1234',shipped_on:''}}).ok,false);
 assert.deepEqual(M.checkTransition({...h,from:'preparing',to:'shipped',fields:{result_text:'CJ 1234',shipped_on:'2026-11-20'}}),{ok:true});
 assert.deepEqual(M.checkTransition({...h,from:'accepted',to:'on_hold',fields:{status_note_text:''}}),{ok:false,reason:'보류나 되돌리기에는 사유가 필요해요.'});
 assert.deepEqual(M.checkTransition({...h,from:'shipped',to:'preparing',fields:{status_note_text:'송장 오기'}}),{ok:true});
 assert.equal(M.checkTransition({...h,from:'shipped',to:'preparing',fields:{status_note_text:''}}).ok,false);
});

test('요청자는 자기 요청이 요청 상태일 때 취소만 할 수 있다',()=>{
 assert.deepEqual(M.checkTransition({isHandler:false,isOwner:true,from:'requested',to:'canceled',fields:{}}),{ok:true});
 assert.equal(M.checkTransition({isHandler:false,isOwner:true,from:'accepted',to:'canceled',fields:{}}).ok,false);
 assert.equal(M.checkTransition({isHandler:false,isOwner:true,from:'requested',to:'accepted',fields:{}}).ok,false);
 assert.equal(M.checkTransition({isHandler:false,isOwner:false,from:'requested',to:'canceled',fields:{}}).ok,false);
 assert.deepEqual(M.allowedNext({isHandler:false,isOwner:true,from:'requested'}),['canceled']);
 assert.deepEqual(M.allowedNext({isHandler:true,isOwner:false,from:'on_hold'}),['requested','accepted','preparing','canceled']);
 assert.deepEqual(M.allowedNext({isHandler:true,isOwner:false,from:'canceled'}),[]);
});

test('담당자 명단은 활성 상태이고 메일이 대소문자 무관하게 같아야 한다',()=>{
 const hs=[{email:'h@entropymakeup.com',is_active:true},{email:'old@entropymakeup.com',is_active:false}];
 assert.equal(M.isHandler('H@entropymakeup.com',hs),true);
 assert.equal(M.isHandler('old@entropymakeup.com',hs),false);
 assert.equal(M.isHandler('',hs),false);
});

test('등록 검증: 필수 칸, 코드, 길이, 날짜 형식',()=>{
 const ok={type_code:'b2b',title_text:'예스스타일 Air',team_code:'global',counterparty_text:'예스스타일',want_date:'2026-11-24',ship_mode_code:'air',qty_summary_text:'',note_text:''};
 assert.deepEqual(M.validateDraft(ok),[]);
 assert.deepEqual(M.validateDraft({...ok,want_date:null}),[]);
 assert.deepEqual(M.validateDraft({...ok,title_text:'  '}),['제목을 1~80자로 적어 주세요.']);
 assert.deepEqual(M.validateDraft({...ok,type_code:'x',ship_mode_code:'x'}),['유형을 골라 주세요.','운송 방식을 골라 주세요.']);
 assert.deepEqual(M.validateDraft({...ok,want_date:'2026-02-30'}),['희망 출고일이 올바른 날짜가 아니에요.']);
 assert.deepEqual(M.validateDraft({...ok,counterparty_text:'가'.repeat(121)}),['거래처·수신처를 1~120자로 적어 주세요.']);
 assert.deepEqual(M.validateDraft({...ok,note_text:'가'.repeat(1001)}),['특이사항은 1000자 이하로 적어 주세요.']);
});

test('저장용 행은 앞뒤 공백을 지우고 해외 칸은 해외 건에만 남긴다',()=>{
 const row=M.toInsertRow({type_code:'sample',title_text:' 샘플 ',team_code:'global',counterparty_text:' NOVI ',want_date:'',ship_mode_code:'express',qty_summary_text:' 5 SKU ',note_text:'',invoice_id:'',packing_code:'waiting',etd_on:'2026-11-25',forwarder_text:'X'});
 assert.deepEqual(row,{type_code:'sample',title_text:'샘플',team_code:'global',counterparty_text:'NOVI',want_date:null,ship_mode_code:'express',qty_summary_text:'5 SKU',note_text:'',invoice_id:null,packing_code:null,etd_on:null,forwarder_text:''});
 assert.equal(M.needsOverseas({type_code:'sample',ship_mode_code:'ocean'}),true);
 assert.equal(M.needsOverseas({type_code:'b2b',ship_mode_code:'parcel'}),true);
 assert.equal(M.needsOverseas({type_code:'quick',ship_mode_code:'quick'}),false);
 const b2b=M.toInsertRow({type_code:'b2b',title_text:'t',team_code:'global',counterparty_text:'c',want_date:'2026-11-24',ship_mode_code:'air',packing_code:'waiting',etd_on:'2026-11-25',forwarder_text:' 더카고 '});
 assert.deepEqual([b2b.packing_code,b2b.etd_on,b2b.forwarder_text],['waiting','2026-11-25','더카고']);
});

test('지연: 열린 요청이고 한국 날짜로 희망일이 지났을 때',()=>{
 assert.equal(M.isLate(req({want_date:'2026-11-19'}),NOW),true);
 assert.equal(M.isLate(req({want_date:'2026-11-20'}),NOW),false);
 assert.equal(M.isLate(req({want_date:null}),NOW),false);
 assert.equal(M.isLate(req({want_date:'2026-11-01',status_code:'shipped'}),NOW),false);
 assert.equal(M.kstToday(Date.UTC(2026,10,19,15,0)),'2026-11-20');
});

test('정렬·탭·검색',()=>{
 const list=[req({id:'a',want_date:'2026-11-25'}),req({id:'b',want_date:null}),req({id:'c',want_date:'2026-11-18'}),req({id:'d',want_date:'2026-11-18',created_at:'2026-10-01T00:00:00Z',status_code:'accepted'}),
  req({id:'e',status_code:'on_hold'}),req({id:'f',status_code:'shipped',shipped_on:'2026-11-19',result_text:'CJ 5551234'}),req({id:'g',status_code:'shipped',shipped_on:'2026-10-01'}),req({id:'h',status_code:'canceled',requester_email:'me@entropymakeup.com'})];
 assert.deepEqual(M.sortRequests(list.slice(0,4)).map(r=>r.id),['d','c','a','b']);
 assert.deepEqual(M.filterTab(list,'todo',{nowMs:NOW}).map(r=>r.id),['d','c','a','b']);
 assert.deepEqual(M.filterTab(list,'hold',{nowMs:NOW}).map(r=>r.id),['e']);
 assert.deepEqual(M.filterTab(list,'shipped',{nowMs:NOW}).map(r=>r.id),['f']);
 assert.deepEqual(M.filterTab(list,'canceled',{nowMs:NOW}).map(r=>r.id),['h']);
 assert.deepEqual(M.filterTab(list,'mine',{email:'ME@entropymakeup.com',nowMs:NOW}).map(r=>r.id),['h']);
 assert.deepEqual(M.search(list,'5551').map(r=>r.id),['f']);
 assert.deepEqual(M.search(list,'  ').length,8);
});

test('파일 이름·이스케이프·오류 문구',()=>{
 assert.equal(M.safeFileName('a/b\\c\u0001.xlsx'),'a_b_c_.xlsx');
 assert.equal(M.safeFileName('가'.repeat(200)+'.xlsx').length,120);
 assert.ok(M.safeFileName('가'.repeat(200)+'.xlsx').endsWith('.xlsx'));
 assert.equal(M.safeFileName(''),'file');
 assert.equal(M.esc('<b>"&\''),'&lt;b&gt;&quot;&amp;&#39;');
 assert.equal(M.errorMessage({message:'LOGISTICS_FORBIDDEN'}),'이 요청을 바꿀 권한이 없어요.');
 assert.equal(M.errorMessage(new Error('STALE')),'다른 사람이 먼저 바꿨어요. 새로고침한 뒤 다시 해 주세요.');
 assert.equal(M.errorMessage({message:'boom'}),'저장하지 못했어요: boom');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/logistics-model.test.cjs`
Expected: FAIL with `Cannot find module '../logistics-model.js'`

- [ ] **Step 3: Write minimal implementation**

`logistics-model.js`:

```js
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.LogisticsModel=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
'use strict';
// 물류 요청 대시보드의 상태 규칙과 입력 검증. 같은 규칙을 DB 트리거(sql/logistics.sql)가 최종 판정한다.

const TYPES={b2b:'B2B출고',sample:'샘플',quick:'퀵',seeding:'마케팅·시딩',cs:'CS·교체',return:'회송·재입고',etc:'기타'};
const TEAMS={global:'글로벌',domestic:'국내',marketing:'마케팅·크리에이티브',cs:'CS',etc:'기타'};
const SHIP_MODES={parcel:'택배',quick:'퀵',air:'Air',ocean:'Ocean',direct:'직납',express:'해외특송',etc:'기타'};
const STATUSES={requested:'요청',accepted:'접수',preparing:'준비중',shipped:'출고완료',on_hold:'보류',canceled:'취소'};
const PACKING={waiting:'대기',done:'작성완료',replied:'거래처회신'};
const FILE_KINDS={request:'출고요청서',packing:'패킹리스트',receipt:'입고증',etc:'기타'};
const OPEN=['requested','accepted','preparing','on_hold'];
const CLOSED=['shipped','canceled'];
const LIMITS={title:80,counterparty:120,qty:300,note:1000,result:500,statusNote:300,forwarder:120,comment:1000,fileBytes:20971520,filesPerRequest:10,fileName:120};
const STATUS_ORDER=['requested','accepted','preparing','shipped'];
const STATUS_LIST=Object.keys(STATUSES);
const KST=9*60*60*1000,DAY=24*60*60*1000;
const ERRORS={
 LOGISTICS_FORBIDDEN:'이 요청을 바꿀 권한이 없어요.',
 LOGISTICS_CLOSED:'닫힌 요청은 요약 내용을 바꿀 수 없어요.',
 LOGISTICS_BAD_TRANSITION:'그 상태로는 바꿀 수 없어요.',
 LOGISTICS_RESULT_REQUIRED:'출고완료에는 송장·배차·BL과 출고일이 필요해요.',
 LOGISTICS_NOTE_REQUIRED:'보류나 되돌리기에는 사유가 필요해요.',
 LOGISTICS_FILE_LIMIT:'첨부는 요청당 10개까지예요.',
 LOGISTICS_LOGIN_REQUIRED:'회사 계정으로 로그인해 주세요.',
 STALE:'다른 사람이 먼저 바꿨어요. 새로고침한 뒤 다시 해 주세요.',
 UNCONFIRMED:'저장 결과를 확인하지 못했어요. 새로고침해서 저장됐는지 확인해 주세요.'
};

const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const trim=v=>String(v??'').trim();
const kstToday=nowMs=>new Date(nowMs+KST).toISOString().slice(0,10);
const isDate=v=>{if(!/^\d{4}-\d{2}-\d{2}$/.test(String(v||'')))return false;const [y,m,d]=v.split('-').map(Number);const t=new Date(Date.UTC(y,m-1,d));return t.getUTCFullYear()===y&&t.getUTCMonth()===m-1&&t.getUTCDate()===d;};
const isHandler=(email,handlers)=>{const e=trim(email).toLowerCase();return Boolean(e)&&(handlers||[]).some(h=>h.is_active!==false&&String(h.email||'').toLowerCase()===e);};

function transitionAllowed(from,to){
 if(from===to)return false;
 const fi=STATUS_ORDER.indexOf(from),ti=STATUS_ORDER.indexOf(to);
 if(fi>=0&&ti>fi&&from!=='shipped')return true;                       // 앞으로(건너뛰기 허용)
 if(['requested','accepted','preparing'].includes(from)&&(to==='on_hold'||to==='canceled'))return true;
 if(from==='on_hold'&&['requested','accepted','preparing','canceled'].includes(to))return true;
 if(from==='shipped'&&to==='preparing')return true;                    // 출고완료 되돌리기(사유 필수)
 return false;
}
function needsNote(from,to){return to==='on_hold'||(from==='shipped'&&to==='preparing');}
function checkTransition({isHandler:h,isOwner,from,to,fields}){
 const f=fields||{};
 if(!transitionAllowed(from,to))return {ok:false,reason:ERRORS.LOGISTICS_BAD_TRANSITION};
 if(!h&&!(isOwner&&from==='requested'&&to==='canceled'))return {ok:false,reason:ERRORS.LOGISTICS_FORBIDDEN};
 if(to==='shipped'&&(!trim(f.result_text)||!isDate(f.shipped_on)))return {ok:false,reason:ERRORS.LOGISTICS_RESULT_REQUIRED};
 if(needsNote(from,to)&&!trim(f.status_note_text))return {ok:false,reason:ERRORS.LOGISTICS_NOTE_REQUIRED};
 return {ok:true};
}
function allowedNext({isHandler:h,isOwner,from}){
 if(!h)return isOwner&&from==='requested'?['canceled']:[];
 return STATUS_LIST.filter(to=>transitionAllowed(from,to));
}

function validateDraft(d){
 const e=[];
 if(!TYPES[d.type_code])e.push('유형을 골라 주세요.');
 const title=trim(d.title_text);if(!title||title.length>LIMITS.title)e.push('제목을 1~80자로 적어 주세요.');
 if(!TEAMS[d.team_code])e.push('요청팀을 골라 주세요.');
 const cp=trim(d.counterparty_text);if(!cp||cp.length>LIMITS.counterparty)e.push('거래처·수신처를 1~120자로 적어 주세요.');
 if(d.want_date&&!isDate(d.want_date))e.push('희망 출고일이 올바른 날짜가 아니에요.');
 if(!SHIP_MODES[d.ship_mode_code])e.push('운송 방식을 골라 주세요.');
 if(trim(d.qty_summary_text).length>LIMITS.qty)e.push('수량 요약은 300자 이하로 적어 주세요.');
 if(trim(d.note_text).length>LIMITS.note)e.push('특이사항은 1000자 이하로 적어 주세요.');
 if(trim(d.forwarder_text).length>LIMITS.forwarder)e.push('포워더는 120자 이하로 적어 주세요.');
 if(d.etd_on&&!isDate(d.etd_on))e.push('ETD가 올바른 날짜가 아니에요.');
 if(d.packing_code&&!PACKING[d.packing_code])e.push('패킹리스트 상태를 다시 골라 주세요.');
 return e;
}
const needsOverseas=d=>d.type_code==='b2b'||d.ship_mode_code==='air'||d.ship_mode_code==='ocean';
function toInsertRow(d){
 const overseas=needsOverseas(d);
 return {type_code:d.type_code,title_text:trim(d.title_text),team_code:d.team_code,counterparty_text:trim(d.counterparty_text),
  want_date:d.want_date||null,ship_mode_code:d.ship_mode_code,qty_summary_text:trim(d.qty_summary_text),note_text:trim(d.note_text),
  invoice_id:d.invoice_id||null,packing_code:overseas&&d.packing_code?d.packing_code:null,etd_on:overseas&&d.etd_on?d.etd_on:null,
  forwarder_text:overseas?trim(d.forwarder_text):''};
}

const isLate=(r,nowMs)=>OPEN.includes(r?.status_code)&&Boolean(r.want_date)&&r.want_date<kstToday(nowMs);
const sortRequests=list=>[...list].sort((a,b)=>String(a.want_date||'9999').localeCompare(String(b.want_date||'9999'))||String(a.created_at||'').localeCompare(String(b.created_at||'')));
function filterTab(list,tab,{email,nowMs}={}){
 const since=kstToday(nowMs-30*DAY),me=trim(email).toLowerCase();
 const pick={todo:r=>['requested','accepted','preparing'].includes(r.status_code),hold:r=>r.status_code==='on_hold',
  shipped:r=>r.status_code==='shipped'&&String(r.shipped_on||'')>=since,canceled:r=>r.status_code==='canceled',
  mine:r=>String(r.requester_email||'').toLowerCase()===me}[tab];
 if(!pick)return [];
 const out=list.filter(pick);
 return tab==='shipped'?out.sort((a,b)=>String(b.shipped_on).localeCompare(String(a.shipped_on))):sortRequests(out);
}
function search(list,q){const s=trim(q).toLowerCase();if(!s)return list;return list.filter(r=>[r.title_text,r.counterparty_text,r.result_text].some(v=>String(v||'').toLowerCase().includes(s)));}

function safeFileName(name){
 let n=String(name||'').replace(/[\/\\\u0000-\u001f\u007f]/g,'_').trim();
 if(!n)return 'file';
 if(n.length<=LIMITS.fileName)return n;
 const dot=n.lastIndexOf('.'),ext=dot>0&&n.length-dot<=10?n.slice(dot):'';
 return n.slice(0,LIMITS.fileName-ext.length)+ext;
}
function errorMessage(err){
 const msg=String(err?.message||err||'');
 const code=Object.keys(ERRORS).find(k=>msg.includes(k));
 return code?ERRORS[code]:'저장하지 못했어요: '+msg;
}

return {TYPES,TEAMS,SHIP_MODES,STATUSES,PACKING,FILE_KINDS,OPEN,CLOSED,LIMITS,esc,kstToday,isDate,isHandler,transitionAllowed,checkTransition,allowedNext,
 validateDraft,toInsertRow,needsOverseas,isLate,sortRequests,filterTab,search,safeFileName,errorMessage};
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/logistics-model.test.cjs`
Expected: PASS (8 tests)

- [ ] **Step 5: 스펙에 건너뛰기 규칙 한 줄 반영**

스펙 4절의 "이 규칙은 화면(...)과 DB 트리거 양쪽에서 검사한다" 줄 바로 위에 추가:

```markdown
- 담당자는 앞 단계를 건너뛸 수 있다(예: 퀵은 requested→shipped). 보류에서 돌아갈 때는 requested·accepted·preparing 중에서 고른다.
```

- [ ] **Step 6: Commit**

```bash
git add logistics-model.js tests/logistics-model.test.cjs docs/superpowers/specs/2026-11-19-logistics-dashboard-design.md
GIT_AUTHOR_NAME=sylee GIT_AUTHOR_EMAIL=sylee@entropymakeup.com GIT_COMMITTER_NAME=sylee GIT_COMMITTER_EMAIL=sylee@entropymakeup.com git commit -m "물류 요청: 상태 규칙과 입력 검증 모델

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: 표·트리거·권한 (`sql/logistics.sql`)

**Files:**
- Create: `sql/logistics.sql`
- Test: `tests/logistics-db.test.cjs`

**Interfaces:**
- Consumes: 기존 `approval_private.is_company_member()`, `approval_private.current_email()` (테스트에서는 `sql/team-tasks.sql` 앞부분이 이 함수를 만든다)
- Produces:
  - 표 `public.logistics_handlers(email, display_name, is_active)`, `public.logistics_people(email, display_name, slack_user_id)`
  - 표 `public.logistics_requests` (칸 이름은 Task 1 `toInsertRow` 키 + `id, requester_email, status_code, status_note_text, result_text, shipped_on, quick_fee_krw, slack_ts, slack_state_code, created_at, updated_at, updated_by_text`)
  - 표 `public.logistics_request_files(id, request_id, kind_code, storage_path, name_text, size_bytes, created_by, created_at)`
  - 표 `public.logistics_request_comments(id, request_id, body_text, author_email, created_at)`
  - 표 `public.logistics_request_history(id, request_id, field_code, from_text, to_text, changed_by_text, changed_at)`
  - 표 `public.logistics_slack_outbox(id, request_id, event_code, payload, state_code, attempts, net_request_id, last_error_text, created_at, sent_at)`
  - 함수 `approval_private.logistics_is_handler() → boolean`, `approval_private.logistics_transition_ok(text,text) → boolean`
  - 오류 코드 문자열: `LOGISTICS_FORBIDDEN, LOGISTICS_CLOSED, LOGISTICS_BAD_TRANSITION, LOGISTICS_RESULT_REQUIRED, LOGISTICS_NOTE_REQUIRED, LOGISTICS_FILE_LIMIT, LOGISTICS_LOGIN_REQUIRED`

- [ ] **Step 1: Write the failing test**

`tests/logistics-db.test.cjs`:

```js
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const {PGlite}=require('@electric-sql/pglite');
const read=f=>fs.readFileSync(path.join(__dirname,'../sql',f),'utf8');
const id=n=>'00000000-0000-0000-0000-'+String(n).padStart(12,'0');

async function setup({storage=false}={}){
 const db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create schema auth;create schema approval_private;
 create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz);
 create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz);
 create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create function auth.jwt() returns jsonb language sql as $$select jsonb_build_object('session_id',current_setting('request.jwt.claim.session_id',true),'email',(select email from auth.users where id=nullif(current_setting('request.jwt.claim.sub',true),'')::uuid))$$;
 grant usage on schema public,auth,approval_private to anon,authenticated;
 insert into auth.users values ('${id(1)}','req@entropymakeup.com',now(),null),('${id(2)}','outsider@example.com',now(),null),('${id(3)}','handler@entropymakeup.com',now(),null),('${id(4)}','other@entropymakeup.com',now(),null);
 insert into auth.sessions select id,id,null from auth.users;
 create table public.invoices(id uuid primary key default gen_random_uuid(),no text);grant select,delete on public.invoices to authenticated;`);
 await db.exec(read('team-tasks.sql')); // is_company_member(), current_email()
 if(storage){
  await db.exec(`create schema storage;grant usage on schema storage to authenticated;
  create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint);
  create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,owner_id text);
  alter table storage.objects enable row level security;grant select,insert,update,delete on storage.objects to authenticated;
  create policy "authenticated storage" on storage.objects to authenticated using (split_part(auth.jwt()->>'email','@',2)='entropymakeup.com') with check (split_part(auth.jwt()->>'email','@',2)='entropymakeup.com');`);
 }
 const sql=read('logistics.sql');await db.exec(sql);await db.exec(sql); // 다시 실행해도 안전
 if(storage){const s=read('logistics-storage.sql');await db.exec(s);await db.exec(s);}
 await db.exec(`insert into logistics_handlers(email,display_name) values ('handler@entropymakeup.com','가짜 담당')`);
 const login=async n=>{await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.session_id',$1,false)",[id(n)]);await db.exec('set role authenticated');};
 const asSystem=async()=>{await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub','',false)");};
 const create=async(o={})=>(await db.query(`insert into logistics_requests(type_code,title_text,team_code,counterparty_text,want_date,ship_mode_code)
  values ($1,$2,'global','예스스타일','2026-11-24',$3) returning *`,[o.type||'b2b',o.title||'예스스타일 Air',o.mode||'air'])).rows[0];
 return {db,login,asSystem,create};
}

test('회사 계정만 읽고 등록하며, 요청자와 첫 상태는 DB가 정한다',async()=>{
 const {db,login,create}=await setup();
 try{
  await db.exec('set role anon');
  await assert.rejects(()=>db.query('select * from logistics_requests'),/permission denied/);
  await login(1);
  const r=(await db.query(`insert into logistics_requests(type_code,title_text,team_code,counterparty_text,ship_mode_code,requester_email,status_code,result_text,slack_ts)
   values ('sample',' 샘플 ','global',' NOVI ','express','fake@entropymakeup.com','shipped','위조','1.1') returning *`)).rows[0];
  assert.equal(r.requester_email,'req@entropymakeup.com');
  assert.equal(r.status_code,'requested');
  assert.equal(r.title_text,'샘플');
  assert.equal(r.result_text,'');
  assert.equal(r.slack_ts,null);
  assert.equal(r.slack_state_code,'pending');
  await assert.rejects(()=>db.query('delete from logistics_requests'),/permission denied/);
  await assert.rejects(()=>db.query(`insert into logistics_request_history(request_id,field_code) values ($1,'status')`,[r.id]),/permission denied/);
  await assert.rejects(()=>db.query('select * from logistics_slack_outbox'),/permission denied/);
  await assert.rejects(()=>db.query(`insert into logistics_handlers(email,display_name) values ('req@entropymakeup.com','나')`),/permission denied/);
  assert.equal((await db.query('select * from logistics_handlers')).rows.length,1);
  await login(2);
  assert.equal((await db.query('select * from logistics_requests')).rows.length,0);
  await assert.rejects(()=>create(),/row-level security/);
 }finally{await db.close();}
});

test('요청자는 요청 상태에서만 요약 수정과 취소를 할 수 있다',async()=>{
 const {db,login,create}=await setup();
 try{
  await login(1);const r=await create();
  await db.query(`update logistics_requests set title_text='수정' where id=$1`,[r.id]);
  await assert.rejects(()=>db.query(`update logistics_requests set status_code='accepted' where id=$1`,[r.id]),/LOGISTICS_FORBIDDEN/);
  await assert.rejects(()=>db.query(`update logistics_requests set result_text='x' where id=$1`,[r.id]),/LOGISTICS_FORBIDDEN/);
  await login(4);
  await assert.rejects(()=>db.query(`update logistics_requests set title_text='남의 것' where id=$1`,[r.id]),/LOGISTICS_FORBIDDEN/);
  await login(3);
  await db.query(`update logistics_requests set status_code='accepted' where id=$1`,[r.id]);
  await login(1);
  await assert.rejects(()=>db.query(`update logistics_requests set status_code='canceled' where id=$1`,[r.id]),/LOGISTICS_FORBIDDEN/);
  const r2=await create({title:'두 번째'});
  await db.query(`update logistics_requests set status_code='canceled' where id=$1`,[r2.id]);
  assert.equal((await db.query('select status_code from logistics_requests where id=$1',[r2.id])).rows[0].status_code,'canceled');
 }finally{await db.close();}
});

test('담당자 전환 규칙: 건너뛰기, 결과·사유 필수, 닫힌 요청 보호',async()=>{
 const {db,login,create}=await setup();
 try{
  await login(1);const r=await create();
  await login(3);
  await assert.rejects(()=>db.query(`update logistics_requests set status_code='shipped' where id=$1`,[r.id]),/LOGISTICS_RESULT_REQUIRED/);
  await assert.rejects(()=>db.query(`update logistics_requests set status_code='on_hold' where id=$1`,[r.id]),/LOGISTICS_NOTE_REQUIRED/);
  await db.query(`update logistics_requests set status_code='on_hold',status_note_text='재고 이동 중' where id=$1`,[r.id]);
  await assert.rejects(()=>db.query(`update logistics_requests set status_code='shipped',result_text='CJ 1',shipped_on='2026-11-24' where id=$1`,[r.id]),/LOGISTICS_BAD_TRANSITION/);
  await db.query(`update logistics_requests set status_code='preparing' where id=$1`,[r.id]);
  await db.query(`update logistics_requests set status_code='shipped',result_text='배차 경기94자6172',shipped_on='2026-11-24' where id=$1`,[r.id]);
  await assert.rejects(()=>db.query(`update logistics_requests set title_text='닫힌 뒤' where id=$1`,[r.id]),/LOGISTICS_CLOSED/);
  await db.query(`update logistics_requests set result_text='배차 경기94자6172 / 송장 123' where id=$1`,[r.id]); // 결과 정정은 가능
  await assert.rejects(()=>db.query(`update logistics_requests set status_code='preparing' where id=$1`,[r.id]),/LOGISTICS_NOTE_REQUIRED/);
  await assert.rejects(()=>db.query(`update logistics_requests set status_code='canceled' where id=$1`,[r.id]),/LOGISTICS_BAD_TRANSITION/);
  await db.query(`update logistics_requests set status_code='preparing',status_note_text='송장 오기' where id=$1`,[r.id]);
  await db.query(`update logistics_requests set status_code='canceled' where id=$1`,[r.id]);
  await assert.rejects(()=>db.query(`update logistics_requests set result_text='x' where id=$1`,[r.id]),/LOGISTICS_CLOSED/);
  await db.query(`update logistics_requests set slack_ts='9.9' where id=$1`,[r.id]); // 담당자의 슬랙 칸 변경은 조용히 무시
  assert.equal((await db.query('select slack_ts from logistics_requests where id=$1',[r.id])).rows[0].slack_ts,null);
  const q=await create({type:'quick',mode:'quick',title:'퀵'});
  await db.query(`update logistics_requests set status_code='shipped',result_text='기사 010',shipped_on='2026-11-20',slack_ts='9.9',slack_state_code='sent' where id=$1`,[q.id]);
  const after=(await db.query('select slack_ts,slack_state_code from logistics_requests where id=$1',[q.id])).rows[0];
  assert.deepEqual([after.slack_ts,after.slack_state_code],[null,'pending']); // 슬랙 칸은 시스템만 바꾼다
 }finally{await db.close();}
});

test('이력과 슬랙 대기열은 트리거가 남긴다',async()=>{
 const {db,login,asSystem,create}=await setup();
 try{
  await login(1);const r=await create();
  await login(3);
  await db.query(`update logistics_requests set status_code='accepted',want_date='2026-11-25',packing_code='waiting' where id=$1`,[r.id]);
  await db.query(`update logistics_requests set status_code='on_hold',status_note_text='거래처 회신 대기' where id=$1`,[r.id]);
  await db.query(`update logistics_requests set status_code='preparing' where id=$1`,[r.id]);
  await db.query(`update logistics_requests set status_code='shipped',result_text='BL 1',shipped_on='2026-11-26' where id=$1`,[r.id]);
  await db.query(`update logistics_requests set status_code='preparing',status_note_text='BL 정정' where id=$1`,[r.id]);
  const h=(await db.query('select field_code,from_text,to_text,changed_by_text from logistics_request_history where request_id=$1 order by id',[r.id])).rows;
  assert.deepEqual(h.map(x=>x.field_code),['created','status','want_date','packing','status','status','status','result','status']);
  assert.deepEqual([h[1].from_text,h[1].to_text,h[1].changed_by_text],['requested','accepted','handler@entropymakeup.com']);
  await asSystem();
  const o=(await db.query('select event_code,state_code,payload from logistics_slack_outbox where request_id=$1 order by id',[r.id])).rows;
  assert.deepEqual(o.map(x=>x.event_code),['created','on_hold','shipped','reopened']);
  assert.ok(o.every(x=>x.state_code==='pending'));
  assert.equal(o[1].payload.status_note_text,'거래처 회신 대기');
  assert.equal(o[2].payload.result_text,'BL 1');
  assert.equal(o[0].payload.requester_email,'req@entropymakeup.com');
 }finally{await db.close();}
});

test('연결 주문이 지워지면 출고완료 요청이어도 연결만 비워진다',async()=>{
 const {db,login,create}=await setup();
 try{
  await db.exec('reset role');
  const inv=(await db.query(`insert into public.invoices(no) values ('TEST_001') returning id`)).rows[0].id;
  await login(1);const r=await create();
  await db.query(`update logistics_requests set invoice_id=$2 where id=$1`,[r.id,inv]);
  await login(3);
  await db.query(`update logistics_requests set status_code='shipped',result_text='BL 1',shipped_on='2026-11-24' where id=$1`,[r.id]);
  await login(4); // 담당자가 아닌 사람이 주문을 지워도
  await db.query('delete from public.invoices where id=$1',[inv]);
  const q=(await db.query('select invoice_id,status_code from logistics_requests where id=$1',[r.id])).rows[0];
  assert.deepEqual([q.invoice_id,q.status_code],[null,'shipped']);
 }finally{await db.close();}
});

test('첨부·댓글: 작성자는 DB가 정하고, 닫힌 요청과 10개 초과는 막는다',async()=>{
 const {db,login,create}=await setup();
 try{
  await login(1);const r=await create();
  const path0=`${r.id}/${id(9)}-출고요청서.xlsx`;
  const f=(await db.query(`insert into logistics_request_files(request_id,kind_code,storage_path,name_text,size_bytes,created_by) values ($1,'request',$2,'출고요청서.xlsx',100,'fake@x.com') returning *`,[r.id,path0])).rows[0];
  assert.equal(f.created_by,'req@entropymakeup.com');
  await assert.rejects(()=>db.query(`insert into logistics_request_files(request_id,kind_code,storage_path,name_text,size_bytes) values ($1,'request','other/x.xlsx','x',1)`,[r.id]),/check constraint|LOGISTICS_FORBIDDEN/);
  await assert.rejects(()=>db.query(`insert into logistics_request_files(request_id,kind_code,storage_path,name_text,size_bytes) values ($1,'request',$2,'x',20971521)`,[r.id,`${r.id}/${id(8)}-x`]),/check constraint/);
  for(let i=10;i<19;i++)await db.query(`insert into logistics_request_files(request_id,kind_code,storage_path,name_text,size_bytes) values ($1,'etc',$2,'x',1)`,[r.id,`${r.id}/${id(i)}-x`]);
  await assert.rejects(()=>db.query(`insert into logistics_request_files(request_id,kind_code,storage_path,name_text,size_bytes) values ($1,'etc',$2,'x',1)`,[r.id,`${r.id}/${id(30)}-x`]),/LOGISTICS_FILE_LIMIT/);
  const c=(await db.query(`insert into logistics_request_comments(request_id,body_text,author_email) values ($1,' 주소 확인 ','fake@x.com') returning *`,[r.id])).rows[0];
  assert.deepEqual([c.author_email,c.body_text],['req@entropymakeup.com','주소 확인']);
  await assert.rejects(()=>db.query(`update logistics_request_comments set body_text='x'`),/permission denied/);
  await login(4);
  assert.equal((await db.query('delete from logistics_request_comments returning id')).rows.length,0);
  assert.equal((await db.query('delete from logistics_request_files returning id')).rows.length,0);
  await login(1);
  assert.equal((await db.query('delete from logistics_request_comments returning id')).rows.length,1);
  await login(3);
  assert.equal((await db.query(`delete from logistics_request_files where storage_path=$1 returning id`,[path0])).rows.length,1); // 담당자는 지울 수 있다
  await db.query(`update logistics_requests set status_code='canceled' where id=$1`,[r.id]);
  await assert.rejects(()=>db.query(`insert into logistics_request_files(request_id,kind_code,storage_path,name_text,size_bytes) values ($1,'etc',$2,'x',1)`,[r.id,`${r.id}/${id(31)}-x`]),/LOGISTICS_CLOSED/);
 }finally{await db.close();}
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/logistics-db.test.cjs`
Expected: FAIL with `ENOENT ... sql/logistics.sql`

- [ ] **Step 3: Write minimal implementation**

`sql/logistics.sql`:

```sql
-- 물류 요청 대시보드(logistics.html). 새 표만 만들고 기존 주문·재고·승인 표는 바꾸지 않는다.
-- 상태 규칙은 logistics-model.js와 같고 최종 판정은 이 트리거가 한다. 명단 실제 값은 저장소에 넣지 않는다.
begin;

create table if not exists public.logistics_handlers (
 email text primary key check (email ~ '^[a-z0-9._%+-]+@entropymakeup\.com$'),
 display_name text not null check (length(btrim(display_name)) between 1 and 40),
 is_active boolean not null default true
);
create table if not exists public.logistics_people (
 email text primary key check (email ~ '^[a-z0-9._%+-]+@entropymakeup\.com$'),
 display_name text not null check (length(btrim(display_name)) between 1 and 40),
 slack_user_id text check (slack_user_id is null or slack_user_id ~ '^U[A-Z0-9]{6,20}$')
);

create table if not exists public.logistics_requests (
 id uuid primary key default gen_random_uuid(),
 type_code text not null check (type_code in ('b2b','sample','quick','seeding','cs','return','etc')),
 title_text text not null check (length(btrim(title_text)) between 1 and 80),
 team_code text not null check (team_code in ('global','domestic','marketing','cs','etc')),
 requester_email text not null,
 counterparty_text text not null check (length(btrim(counterparty_text)) between 1 and 120),
 want_date date,
 ship_mode_code text not null check (ship_mode_code in ('parcel','quick','air','ocean','direct','express','etc')),
 qty_summary_text text not null default '' check (length(qty_summary_text) <= 300),
 note_text text not null default '' check (length(note_text) <= 1000),
 invoice_id uuid references public.invoices(id) on delete set null,
 status_code text not null default 'requested' check (status_code in ('requested','accepted','preparing','shipped','on_hold','canceled')),
 status_note_text text not null default '' check (length(status_note_text) <= 300),
 result_text text not null default '' check (length(result_text) <= 500),
 shipped_on date,
 quick_fee_krw integer check (quick_fee_krw is null or quick_fee_krw >= 0),
 packing_code text check (packing_code is null or packing_code in ('waiting','done','replied')),
 etd_on date,
 forwarder_text text not null default '' check (length(forwarder_text) <= 120),
 slack_ts text,
 slack_state_code text not null default 'pending' check (slack_state_code in ('pending','sent','failed','none')),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 updated_by_text text not null default '',
 check (status_code <> 'shipped' or (length(btrim(result_text)) > 0 and shipped_on is not null))
);
create index if not exists logistics_requests_status_idx on public.logistics_requests(status_code, want_date);
create index if not exists logistics_requests_requester_idx on public.logistics_requests(requester_email);

create table if not exists public.logistics_request_files (
 id uuid primary key default gen_random_uuid(),
 request_id uuid not null references public.logistics_requests(id) on delete cascade,
 kind_code text not null check (kind_code in ('request','packing','receipt','etc')),
 storage_path text not null unique check (storage_path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}-[^/]{1,120}$'),
 name_text text not null check (length(name_text) between 1 and 200),
 size_bytes bigint not null check (size_bytes between 0 and 20971520),
 created_by text not null default '',
 created_at timestamptz not null default now()
);
create index if not exists logistics_request_files_req_idx on public.logistics_request_files(request_id);

create table if not exists public.logistics_request_comments (
 id uuid primary key default gen_random_uuid(),
 request_id uuid not null references public.logistics_requests(id) on delete cascade,
 body_text text not null check (length(btrim(body_text)) between 1 and 1000),
 author_email text not null default '',
 created_at timestamptz not null default now()
);
create index if not exists logistics_request_comments_req_idx on public.logistics_request_comments(request_id, created_at);

create table if not exists public.logistics_request_history (
 id bigint generated always as identity primary key,
 request_id uuid not null references public.logistics_requests(id) on delete cascade,
 field_code text not null check (field_code in ('created','status','want_date','result','packing','invoice')),
 from_text text not null default '',
 to_text text not null default '',
 changed_by_text text not null default '',
 changed_at timestamptz not null default now()
);
create index if not exists logistics_request_history_req_idx on public.logistics_request_history(request_id, changed_at);

create table if not exists public.logistics_slack_outbox (
 id bigint generated always as identity primary key,
 request_id uuid not null references public.logistics_requests(id) on delete cascade,
 event_code text not null check (event_code in ('created','shipped','on_hold','canceled','reopened')),
 payload jsonb not null default '{}'::jsonb,
 state_code text not null default 'pending' check (state_code in ('pending','sending','sent','failed')),
 attempts integer not null default 0,
 net_request_id bigint,
 last_error_text text not null default '',
 created_at timestamptz not null default now(),
 sent_at timestamptz
);
create index if not exists logistics_slack_outbox_state_idx on public.logistics_slack_outbox(state_code, id);

create or replace function approval_private.logistics_is_handler() returns boolean
language sql stable security definer set search_path='' as $$
 select (select approval_private.is_company_member()) and exists(
  select 1 from public.logistics_handlers h where h.email=(select approval_private.current_email()) and h.is_active);
$$;

create or replace function approval_private.logistics_transition_ok(f text, t text) returns boolean
language sql immutable set search_path='' as $$
 select (f,t) in (values
  ('requested','accepted'),('requested','preparing'),('requested','shipped'),('accepted','preparing'),('accepted','shipped'),('preparing','shipped'),
  ('requested','on_hold'),('accepted','on_hold'),('preparing','on_hold'),
  ('on_hold','requested'),('on_hold','accepted'),('on_hold','preparing'),
  ('requested','canceled'),('accepted','canceled'),('preparing','canceled'),('on_hold','canceled'),
  ('shipped','preparing'));
$$;

-- 등록·수정 규칙. auth.uid()가 없으면(예약 작업·SQL 편집기) 시스템으로 보고 권한 검사를 건너뛰지만 상태 규칙은 지킨다.
create or replace function approval_private.logistics_requests_stamp() returns trigger
language plpgsql security definer set search_path='' as $$
declare
 actor text := (select approval_private.current_email());
 is_system boolean := (select auth.uid()) is null;
 is_h boolean := (select approval_private.logistics_is_handler());
 summary_changed boolean; result_changed boolean; status_changed boolean;
begin
 new.title_text := btrim(new.title_text);
 new.counterparty_text := btrim(new.counterparty_text);
 new.qty_summary_text := btrim(new.qty_summary_text);
 new.note_text := btrim(new.note_text);
 new.status_note_text := btrim(new.status_note_text);
 new.result_text := btrim(new.result_text);
 new.forwarder_text := btrim(new.forwarder_text);
 new.updated_at := clock_timestamp();
 new.updated_by_text := coalesce(actor, 'system');
 if tg_op = 'INSERT' then
  if not is_system then
   if actor is null then raise exception 'LOGISTICS_LOGIN_REQUIRED'; end if;
   new.requester_email := actor;
  else
   new.requester_email := lower(btrim(coalesce(new.requester_email, '')));
   if new.requester_email = '' then raise exception 'LOGISTICS_LOGIN_REQUIRED'; end if;
  end if;
  new.status_code := 'requested'; new.status_note_text := ''; new.result_text := ''; new.shipped_on := null;
  new.slack_ts := null; new.slack_state_code := 'pending'; new.created_at := now();
  return new;
 end if;

 new.id := old.id; new.requester_email := old.requester_email; new.created_at := old.created_at;
 -- 주문 삭제 시 FK(on delete set null)가 invoice_id만 비우는 경우. 권한·닫힘 검사 없이 통과시킨다.
 if pg_trigger_depth() > 1 then return new; end if;
 if not is_system then new.slack_ts := old.slack_ts; new.slack_state_code := old.slack_state_code; end if;
 -- 사유는 그 전환에 딸린 값이다. 상태가 바뀌는데 사유를 새로 적지 않았으면 비운다.
 if new.status_code is distinct from old.status_code and new.status_note_text = old.status_note_text then new.status_note_text := ''; end if;
 summary_changed := (new.type_code,new.title_text,new.team_code,new.counterparty_text,new.want_date,new.ship_mode_code,new.qty_summary_text,new.note_text,new.invoice_id)
  is distinct from (old.type_code,old.title_text,old.team_code,old.counterparty_text,old.want_date,old.ship_mode_code,old.qty_summary_text,old.note_text,old.invoice_id);
 result_changed := (new.result_text,new.shipped_on,new.quick_fee_krw,new.packing_code,new.etd_on,new.forwarder_text)
  is distinct from (old.result_text,old.shipped_on,old.quick_fee_krw,old.packing_code,old.etd_on,old.forwarder_text);
 status_changed := new.status_code is distinct from old.status_code;

 if old.status_code = 'canceled' and (summary_changed or result_changed or status_changed) then
  raise exception 'LOGISTICS_CLOSED';
 end if;
 if not is_system and not is_h then
  if actor is distinct from old.requester_email or old.status_code <> 'requested' or result_changed
     or (status_changed and new.status_code <> 'canceled') then
   raise exception 'LOGISTICS_FORBIDDEN';
  end if;
 end if;
 if old.status_code = 'shipped' and summary_changed then raise exception 'LOGISTICS_CLOSED'; end if;
 if status_changed then
  if not approval_private.logistics_transition_ok(old.status_code, new.status_code) then raise exception 'LOGISTICS_BAD_TRANSITION'; end if;
  if (new.status_code = 'on_hold' or (old.status_code = 'shipped' and new.status_code = 'preparing')) and new.status_note_text = '' then
   raise exception 'LOGISTICS_NOTE_REQUIRED';
  end if;
 end if;
 if new.status_code = 'shipped' and (new.result_text = '' or new.shipped_on is null) then raise exception 'LOGISTICS_RESULT_REQUIRED'; end if;
 return new;
end $$;

create or replace function approval_private.logistics_requests_log() returns trigger
language plpgsql security definer set search_path='' as $$
declare actor text := coalesce((select approval_private.current_email()), 'system'); ev text;
begin
 if tg_op = 'INSERT' then
  insert into public.logistics_request_history(request_id,field_code,to_text,changed_by_text) values (new.id,'created',new.title_text,actor);
  ev := 'created';
 else
  if new.status_code is distinct from old.status_code then
   insert into public.logistics_request_history(request_id,field_code,from_text,to_text,changed_by_text) values (new.id,'status',old.status_code,new.status_code,actor);
   ev := case when new.status_code='shipped' then 'shipped' when new.status_code='on_hold' then 'on_hold' when new.status_code='canceled' then 'canceled'
              when old.status_code='shipped' then 'reopened' end;
  end if;
  if new.want_date is distinct from old.want_date then
   insert into public.logistics_request_history(request_id,field_code,from_text,to_text,changed_by_text) values (new.id,'want_date',coalesce(old.want_date::text,''),coalesce(new.want_date::text,''),actor);
  end if;
  if (new.result_text,new.shipped_on) is distinct from (old.result_text,old.shipped_on) then
   insert into public.logistics_request_history(request_id,field_code,from_text,to_text,changed_by_text)
    values (new.id,'result',btrim(old.result_text||' '||coalesce(old.shipped_on::text,'')),btrim(new.result_text||' '||coalesce(new.shipped_on::text,'')),actor);
  end if;
  if new.packing_code is distinct from old.packing_code then
   insert into public.logistics_request_history(request_id,field_code,from_text,to_text,changed_by_text) values (new.id,'packing',coalesce(old.packing_code,''),coalesce(new.packing_code,''),actor);
  end if;
  if new.invoice_id is distinct from old.invoice_id then
   insert into public.logistics_request_history(request_id,field_code,from_text,to_text,changed_by_text) values (new.id,'invoice',coalesce(old.invoice_id::text,''),coalesce(new.invoice_id::text,''),actor);
  end if;
 end if;
 if ev is not null then
  insert into public.logistics_slack_outbox(request_id,event_code,payload) values (new.id, ev, jsonb_build_object(
   'title_text',new.title_text,'type_code',new.type_code,'ship_mode_code',new.ship_mode_code,'want_date',new.want_date,
   'requester_email',new.requester_email,'status_note_text',new.status_note_text,'result_text',new.result_text,'shipped_on',new.shipped_on,'actor',actor));
 end if;
 return null;
end $$;

drop trigger if exists logistics_requests_stamp on public.logistics_requests;
create trigger logistics_requests_stamp before insert or update on public.logistics_requests for each row execute function approval_private.logistics_requests_stamp();
drop trigger if exists logistics_requests_log on public.logistics_requests;
create trigger logistics_requests_log after insert or update on public.logistics_requests for each row execute function approval_private.logistics_requests_log();

create or replace function approval_private.logistics_files_stamp() returns trigger
language plpgsql security definer set search_path='' as $$
declare st text;
begin
 select status_code into st from public.logistics_requests where id=new.request_id for update;
 if st in ('shipped','canceled') then raise exception 'LOGISTICS_CLOSED'; end if;
 if split_part(new.storage_path,'/',1) <> new.request_id::text then raise exception 'LOGISTICS_FORBIDDEN'; end if;
 if (select count(*) from public.logistics_request_files where request_id=new.request_id) >= 10 then raise exception 'LOGISTICS_FILE_LIMIT'; end if;
 new.created_by := coalesce((select approval_private.current_email()), nullif(new.created_by,''), 'system');
 new.created_at := now();
 return new;
end $$;
drop trigger if exists logistics_files_stamp on public.logistics_request_files;
create trigger logistics_files_stamp before insert on public.logistics_request_files for each row execute function approval_private.logistics_files_stamp();

create or replace function approval_private.logistics_comments_stamp() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 new.body_text := btrim(new.body_text);
 new.author_email := coalesce((select approval_private.current_email()), nullif(new.author_email,''), 'system');
 new.created_at := now();
 return new;
end $$;
drop trigger if exists logistics_comments_stamp on public.logistics_request_comments;
create trigger logistics_comments_stamp before insert on public.logistics_request_comments for each row execute function approval_private.logistics_comments_stamp();

revoke all on function approval_private.logistics_is_handler() from public,anon;
grant execute on function approval_private.logistics_is_handler() to authenticated;
revoke all on function approval_private.logistics_requests_stamp(),approval_private.logistics_requests_log(),approval_private.logistics_files_stamp(),approval_private.logistics_comments_stamp() from public,anon,authenticated;

alter table public.logistics_handlers enable row level security;
alter table public.logistics_people enable row level security;
alter table public.logistics_requests enable row level security;
alter table public.logistics_request_files enable row level security;
alter table public.logistics_request_comments enable row level security;
alter table public.logistics_request_history enable row level security;
alter table public.logistics_slack_outbox enable row level security;

revoke all on public.logistics_handlers,public.logistics_people,public.logistics_requests,public.logistics_request_files,
 public.logistics_request_comments,public.logistics_request_history,public.logistics_slack_outbox from public,anon,authenticated;
grant select on public.logistics_handlers,public.logistics_people,public.logistics_request_history to authenticated;
grant select,insert,update on public.logistics_requests to authenticated;
grant select,insert,delete on public.logistics_request_files,public.logistics_request_comments to authenticated;

drop policy if exists logistics_handlers_read on public.logistics_handlers;
create policy logistics_handlers_read on public.logistics_handlers for select to authenticated using ((select approval_private.is_company_member()));
drop policy if exists logistics_people_read on public.logistics_people;
create policy logistics_people_read on public.logistics_people for select to authenticated using ((select approval_private.is_company_member()));
drop policy if exists logistics_requests_read on public.logistics_requests;
create policy logistics_requests_read on public.logistics_requests for select to authenticated using ((select approval_private.is_company_member()));
drop policy if exists logistics_requests_insert on public.logistics_requests;
create policy logistics_requests_insert on public.logistics_requests for insert to authenticated with check ((select approval_private.is_company_member()));
drop policy if exists logistics_requests_update on public.logistics_requests;
create policy logistics_requests_update on public.logistics_requests for update to authenticated
 using ((select approval_private.is_company_member())) with check ((select approval_private.is_company_member()));
drop policy if exists logistics_files_read on public.logistics_request_files;
create policy logistics_files_read on public.logistics_request_files for select to authenticated using ((select approval_private.is_company_member()));
drop policy if exists logistics_files_insert on public.logistics_request_files;
create policy logistics_files_insert on public.logistics_request_files for insert to authenticated with check ((select approval_private.is_company_member()));
drop policy if exists logistics_files_delete on public.logistics_request_files;
create policy logistics_files_delete on public.logistics_request_files for delete to authenticated
 using ((select approval_private.is_company_member()) and (created_by=(select approval_private.current_email()) or (select approval_private.logistics_is_handler())));
drop policy if exists logistics_comments_read on public.logistics_request_comments;
create policy logistics_comments_read on public.logistics_request_comments for select to authenticated using ((select approval_private.is_company_member()));
drop policy if exists logistics_comments_insert on public.logistics_request_comments;
create policy logistics_comments_insert on public.logistics_request_comments for insert to authenticated with check ((select approval_private.is_company_member()));
drop policy if exists logistics_comments_delete on public.logistics_request_comments;
create policy logistics_comments_delete on public.logistics_request_comments for delete to authenticated
 using ((select approval_private.is_company_member()) and author_email=(select approval_private.current_email()) and created_at > now() - interval '24 hours');
drop policy if exists logistics_history_read on public.logistics_request_history;
create policy logistics_history_read on public.logistics_request_history for select to authenticated using ((select approval_private.is_company_member()));
commit;
```

주의:
- 담당자가 `slack_ts`·`slack_state_code`를 바꾸려 하면 트리거가 조용히 이전 값으로 되돌린다(오류 아님). 이 두 칸은 시스템(Task 4 flush)만 바꾼다. 취소된 요청이어도 시스템은 슬랙 칸을 바꿀 수 있다(취소 알림의 원글 ts 저장에 필요).
- `pg_trigger_depth() > 1`은 FK 동작(주문 삭제 → invoice_id 비우기)에서만 생긴다. flush가 직접 하는 UPDATE는 깊이 1이라 일반 검사를 거친다.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/logistics-db.test.cjs`
Expected: PASS (6 tests). 실패하면 오류 문구가 테스트의 정규식과 맞는지부터 확인한다.

- [ ] **Step 5: Commit**

```bash
git add sql/logistics.sql tests/logistics-db.test.cjs
GIT_AUTHOR_NAME=sylee GIT_AUTHOR_EMAIL=sylee@entropymakeup.com GIT_COMMITTER_NAME=sylee GIT_COMMITTER_EMAIL=sylee@entropymakeup.com git commit -m "물류 요청: 표·트리거·권한 SQL

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: 첨부 버킷과 Storage 정책 (`sql/logistics-storage.sql`)

운영 DB의 `storage.objects`에는 회사 계정이면 모든 버킷을 읽고 쓰는 허용 정책 `authenticated storage`가 이미 있다(2026-11-19 읽기 확인). 그래서 이 파일은 **제한(restrictive) 정책**으로 `logistics-docs` 버킷만 좁힌다. 다른 버킷에는 영향이 없다.

**Files:**
- Create: `sql/logistics-storage.sql`
- Modify: `tests/logistics-db.test.cjs` (테스트 추가)

**Interfaces:**
- Consumes: Task 2의 `logistics_requests`, `logistics_request_files`, `approval_private.logistics_is_handler()`
- Produces: 버킷 `logistics-docs`(비공개, 20MB). 객체 이름 규칙 `^[0-9a-f-]{36}/[0-9a-f-]{36}-[^/]{1,120}$`, 첫 칸은 열린 요청의 id

- [ ] **Step 1: Write the failing test** (`tests/logistics-db.test.cjs` 끝에 추가)

```js
test('첨부 버킷: 열린 요청 경로에만 올리고, 수정은 막고, 올린 사람이나 담당자만 지운다',async()=>{
 const {db,login,create}=await setup({storage:true});
 try{
  await db.exec('reset role');
  const b=(await db.query(`select public,file_size_limit from storage.buckets where id='logistics-docs'`)).rows[0];
  assert.deepEqual([b.public,Number(b.file_size_limit)],[false,20971520]);
  await login(1);const r=await create();
  const name=`${r.id}/${id(9)}-출고요청서.xlsx`;
  await db.query(`insert into storage.objects(bucket_id,name) values ('logistics-docs',$1)`,[name]);
  await assert.rejects(()=>db.query(`insert into storage.objects(bucket_id,name) values ('logistics-docs','../x')`),/row-level security/);
  await assert.rejects(()=>db.query(`insert into storage.objects(bucket_id,name) values ('logistics-docs',$1)`,[`${id(77)}/${id(9)}-x`]),/row-level security/);
  assert.equal((await db.query(`update storage.objects set name=name||'x' where bucket_id='logistics-docs' returning id`)).rows.length,0);
  await db.query(`insert into logistics_request_files(request_id,kind_code,storage_path,name_text,size_bytes) values ($1,'request',$2,'출고요청서.xlsx',1)`,[r.id,name]);
  await login(4);
  assert.equal((await db.query(`delete from storage.objects where name=$1 returning id`,[name])).rows.length,0);
  await db.query(`insert into storage.objects(bucket_id,name) values ('other-bucket','free')`); // 다른 버킷은 그대로
  await login(3);
  assert.equal((await db.query(`delete from storage.objects where name=$1 returning id`,[name])).rows.length,1);
  await db.query(`update logistics_requests set status_code='canceled' where id=$1`,[r.id]);
  await assert.rejects(()=>db.query(`insert into storage.objects(bucket_id,name) values ('logistics-docs',$1)`,[`${r.id}/${id(10)}-x`]),/row-level security/);
 }finally{await db.close();}
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/logistics-db.test.cjs`
Expected: 새 테스트만 FAIL with `ENOENT ... sql/logistics-storage.sql`

- [ ] **Step 3: Write minimal implementation**

`sql/logistics-storage.sql`:

```sql
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
 using (bucket_id <> 'logistics-docs' or (select approval_private.logistics_is_handler()) or exists(
  select 1 from public.logistics_request_files f where f.storage_path=name and f.created_by=(select approval_private.current_email())));
commit;
```

화면은 파일을 지울 때 **storage 객체를 먼저 지우고 그다음 `logistics_request_files` 행을 지운다**(삭제 정책이 행을 확인하기 때문). 올리기 직후 행 저장이 실패한 경우에는 행이 없으므로 올린 사람이 지울 수 없다. 이런 고아 파일은 담당자만 지울 수 있고, LOGISTICS.md에 정리 쿼리를 적는다(Task 7).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/logistics-db.test.cjs`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add sql/logistics-storage.sql tests/logistics-db.test.cjs
GIT_AUTHOR_NAME=sylee GIT_AUTHOR_EMAIL=sylee@entropymakeup.com GIT_COMMITTER_NAME=sylee GIT_COMMITTER_EMAIL=sylee@entropymakeup.com git commit -m "물류 요청: 첨부 버킷과 제한 정책

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: 슬랙 알림 발송 (`sql/logistics-slack.sql`)

**Files:**
- Create: `sql/logistics-slack.sql`
- Test: `tests/logistics-slack-db.test.cjs`

**Interfaces:**
- Consumes: Task 2의 `logistics_slack_outbox`, `logistics_requests`, `logistics_people`, `logistics_handlers`. pg_net `net.http_post(url text, body jsonb, params jsonb, headers jsonb, timeout_milliseconds int) → bigint`, `net._http_response(id, status_code, content, error_msg, timed_out)`. Vault `vault.decrypted_secrets(name, decrypted_secret)`. pg_cron `cron.schedule(text,text,text)`, `cron.unschedule(bigint)`, `cron.job(jobid, jobname)`
- Produces:
  - `approval_private.logistics_slack_text(p_request uuid, p_event text, p_payload jsonb) → text`
  - `approval_private.logistics_slack_flush() → void` (pg_cron 작업 이름 `logistics-slack-send`, 매분)
  - Vault 이름: `logistics_slack_bot_token`, `logistics_slack_channel`

- [ ] **Step 1: Write the failing test**

`tests/logistics-slack-db.test.cjs`:

```js
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const {PGlite}=require('@electric-sql/pglite');
const read=f=>fs.readFileSync(path.join(__dirname,'../sql',f),'utf8');
const id=n=>'00000000-0000-0000-0000-'+String(n).padStart(12,'0');

async function setup({secrets=true}={}){
 const db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create schema auth;create schema approval_private;
 create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz);
 create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz);
 create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create function auth.jwt() returns jsonb language sql as $$select jsonb_build_object('session_id',current_setting('request.jwt.claim.session_id',true))$$;
 grant usage on schema public,auth,approval_private to anon,authenticated;
 insert into auth.users values ('${id(1)}','req@entropymakeup.com',now(),null),('${id(3)}','handler@entropymakeup.com',now(),null);
 insert into auth.sessions select id,id,null from auth.users;
 create table public.invoices(id uuid primary key default gen_random_uuid(),no text);
 create schema net;
 create table net._http_response(id bigint primary key,status_code integer,content text,error_msg text,timed_out boolean);
 create table net.calls(id bigserial primary key,url text,body jsonb,headers jsonb);
 create function net.http_post(url text,body jsonb default '{}',params jsonb default '{}',headers jsonb default '{}',timeout_milliseconds integer default 5000) returns bigint
  language sql as $$insert into net.calls(url,body,headers) values (url,body,headers) returning id$$;
 create schema vault;create table vault.decrypted_secrets(name text primary key,decrypted_secret text);
 create schema cron;create table cron.job(jobid bigserial primary key,jobname text,schedule text,command text);
 create function cron.schedule(n text,s text,c text) returns bigint language sql as $$insert into cron.job(jobname,schedule,command) values (n,s,c) returning jobid$$;
 create function cron.unschedule(j bigint) returns boolean language sql as $$delete from cron.job where jobid=j returning true$$;`);
 if(secrets)await db.exec(`insert into vault.decrypted_secrets values ('logistics_slack_bot_token','xoxb-test'),('logistics_slack_channel','C08MUA6K4D6')`);
 await db.exec(read('team-tasks.sql'));
 await db.exec(read('logistics.sql'));
 const s=read('logistics-slack.sql');await db.exec(s);await db.exec(s);
 await db.exec(`insert into logistics_handlers(email,display_name) values ('handler@entropymakeup.com','가짜 담당');
  insert into logistics_people(email,display_name,slack_user_id) values ('req@entropymakeup.com','가짜 요청자','UREQ0001'),('handler@entropymakeup.com','가짜 담당','UHND0001');`);
 const login=async n=>{await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.session_id',$1,false)",[id(n)]);await db.exec('set role authenticated');};
 const system=async()=>{await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub','',false)");};
 const flush=async()=>{await system();await db.query('select approval_private.logistics_slack_flush()');};
 const calls=async()=>{await system();return (await db.query('select * from net.calls order by id')).rows;};
 const respond=async(callId,obj,status=200)=>{await system();await db.query('insert into net._http_response(id,status_code,content) values ($1,$2,$3)',[callId,status,JSON.stringify(obj)]);};
 const create=async(title='예스스타일 <Air> & 11월')=>{await login(1);return (await db.query(`insert into logistics_requests(type_code,title_text,team_code,counterparty_text,want_date,ship_mode_code) values ('b2b',$1,'global','예스스타일','2026-11-24','air') returning *`,[title])).rows[0];};
 return {db,login,system,flush,calls,respond,create};
}

test('새 요청은 채널에 새 글로 보내고 ts를 저장한다',async()=>{
 const t=await setup();
 try{
  const r=await t.create();
  await t.flush();
  const [c]=await t.calls();
  assert.equal(c.url,'https://slack.com/api/chat.postMessage');
  assert.equal(c.headers.Authorization,'Bearer xoxb-test');
  assert.equal(c.body.channel,'C08MUA6K4D6');
  assert.equal(c.body.thread_ts,undefined);
  assert.match(c.body.text,/\[B2B출고\] 예스스타일 &lt;Air&gt; &amp; 11월/);
  assert.match(c.body.text,/희망 11\/24 · Air/);
  assert.match(c.body.text,/요청 <@UREQ0001> → <@UHND0001>/);
  assert.match(c.body.text,new RegExp(`logistics\\.html\\?id=${r.id}`));
  await t.flush(); // 응답 전에는 다시 보내지 않는다
  assert.equal((await t.calls()).length,1);
  await t.respond(c.id,{ok:true,ts:'1795000000.000100'});
  await t.flush();
  const q=(await t.db.query('select slack_ts,slack_state_code from logistics_requests where id=$1',[r.id])).rows[0];
  assert.deepEqual([q.slack_ts,q.slack_state_code],['1795000000.000100','sent']);
  assert.equal((await t.db.query(`select state_code from logistics_slack_outbox where request_id=$1`,[r.id])).rows[0].state_code,'sent');
 }finally{await t.db.close();}
});

test('출고완료·보류는 원래 글의 스레드 답글로 보내고, 원글이 끝나기 전에는 기다린다',async()=>{
 const t=await setup();
 try{
  const r=await t.create('퀵 샘플');
  await t.login(3);
  await t.db.query(`update logistics_requests set status_code='on_hold',status_note_text='주소 확인' where id=$1`,[r.id]);
  await t.flush();
  assert.equal((await t.calls()).length,1); // 원글만 보냄, 답글은 대기
  await t.respond(1,{ok:true,ts:'1795000000.000200'});
  await t.flush();
  const cs=await t.calls();
  assert.equal(cs.length,2);
  assert.equal(cs[1].body.thread_ts,'1795000000.000200');
  assert.match(cs[1].body.text,/보류: 주소 확인/);
  assert.match(cs[1].body.text,/<@UREQ0001>/);
  await t.login(3);
  await t.db.query(`update logistics_requests set status_code='preparing' where id=$1`,[r.id]);
  await t.db.query(`update logistics_requests set status_code='shipped',result_text='배차 경기94자6172',shipped_on='2026-11-20' where id=$1`,[r.id]);
  await t.flush();
  const last=(await t.calls()).at(-1);
  assert.match(last.body.text,/출고완료 11\/20 · 배차 경기94자6172/);
 }finally{await t.db.close();}
});

test('실패는 5번까지 다시 보내고 그 뒤에는 실패로 표시한다. 원글이 실패하면 답글은 새 글로 보낸다',async()=>{
 const t=await setup();
 try{
  const r=await t.create();
  await t.login(3);
  await t.db.query(`update logistics_requests set status_code='canceled' where id=$1`,[r.id]);
  for(let i=1;i<=5;i++){await t.flush();const c=(await t.calls()).at(-1);await t.respond(c.id,{ok:false,error:'channel_not_found'});}
  await t.flush();
  const o=(await t.db.query(`select event_code,state_code,attempts,last_error_text from logistics_slack_outbox where request_id=$1 order by id`,[r.id])).rows;
  assert.deepEqual([o[0].state_code,o[0].attempts],['failed',5]);
  assert.match(o[0].last_error_text,/channel_not_found/);
  assert.equal((await t.db.query('select slack_state_code from logistics_requests where id=$1',[r.id])).rows[0].slack_state_code,'failed');
  const last=(await t.calls()).at(-1);
  assert.match(last.body.text,/취소/);
  assert.equal(last.body.thread_ts,undefined);
 }finally{await t.db.close();}
});

test('토큰이 없으면 아무것도 보내지 않고, 예약 작업은 하나만 등록되고, 클라이언트는 실행할 수 없다',async()=>{
 const t=await setup({secrets:false});
 try{
  await t.create();
  await t.flush();
  assert.equal((await t.calls()).length,0);
  await t.system();
  const jobs=(await t.db.query(`select jobname,schedule,command from cron.job`)).rows;
  assert.deepEqual(jobs,[{jobname:'logistics-slack-send',schedule:'* * * * *',command:'select approval_private.logistics_slack_flush()'}]);
  await t.login(1);
  await assert.rejects(()=>t.db.query('select approval_private.logistics_slack_flush()'),/permission denied/);
 }finally{await t.db.close();}
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/logistics-slack-db.test.cjs`
Expected: FAIL with `ENOENT ... sql/logistics-slack.sql`

- [ ] **Step 3: Write minimal implementation**

`sql/logistics-slack.sql`:

```sql
-- 물류 요청 슬랙 알림. 트리거가 넣은 logistics_slack_outbox를 pg_cron이 매분 pg_net으로 보낸다.
-- 봇 토큰과 채널은 Vault(logistics_slack_bot_token, logistics_slack_channel)에만 둔다. 없으면 아무것도 보내지 않는다.
begin;

create or replace function approval_private.logistics_slack_escape(t text) returns text
language sql immutable set search_path='' as $$ select replace(replace(replace(coalesce(t,''),'&','&amp;'),'<','&lt;'),'>','&gt;') $$;

create or replace function approval_private.logistics_slack_who(p_email text) returns text
language sql stable security definer set search_path='' as $$
 select coalesce(
  (select '<@'||p.slack_user_id||'>' from public.logistics_people p where p.email=lower(p_email) and p.slack_user_id is not null),
  (select approval_private.logistics_slack_escape(p.display_name) from public.logistics_people p where p.email=lower(p_email)),
  (select approval_private.logistics_slack_escape(h.display_name) from public.logistics_handlers h where h.email=lower(p_email)),
  approval_private.logistics_slack_escape(split_part(coalesce(p_email,''),'@',1)));
$$;

create or replace function approval_private.logistics_slack_text(p_request uuid, p_event text, p_payload jsonb) returns text
language plpgsql stable security definer set search_path='' as $$
declare
 v_type text := case p_payload->>'type_code' when 'b2b' then 'B2B출고' when 'sample' then '샘플' when 'quick' then '퀵' when 'seeding' then '마케팅·시딩'
  when 'cs' then 'CS·교체' when 'return' then '회송·재입고' else '기타' end;
 v_mode text := case p_payload->>'ship_mode_code' when 'parcel' then '택배' when 'quick' then '퀵' when 'air' then 'Air' when 'ocean' then 'Ocean'
  when 'direct' then '직납' when 'express' then '해외특송' else '기타' end;
 v_want text := coalesce(to_char((p_payload->>'want_date')::date,'FMMM/FMDD'),'미정');
 v_title text := approval_private.logistics_slack_escape(p_payload->>'title_text');
 v_req text := approval_private.logistics_slack_who(p_payload->>'requester_email');
 v_link text := 'https://entropymakeup-official.github.io/entropysales/logistics.html?id='||p_request::text;
 v_handlers text;
begin
 if p_event = 'created' then
  select string_agg(approval_private.logistics_slack_who(h.email), ' ' order by h.email) into v_handlers from public.logistics_handlers h where h.is_active;
  return format(E'*[%s] %s*\n희망 %s · %s\n요청 %s → %s\n%s', v_type, v_title, v_want, v_mode, v_req, coalesce(v_handlers,'물류 담당'), v_link);
 elsif p_event = 'shipped' then
  return format(E'출고완료 %s · %s\n%s', coalesce(to_char((p_payload->>'shipped_on')::date,'FMMM/FMDD'),''), approval_private.logistics_slack_escape(p_payload->>'result_text'), v_req);
 elsif p_event = 'on_hold' then
  return format(E'보류: %s\n%s', approval_private.logistics_slack_escape(p_payload->>'status_note_text'), v_req);
 elsif p_event = 'canceled' then
  return format(E'취소: *[%s] %s*%s\n%s', v_type, v_title,
   case when coalesce(p_payload->>'status_note_text','')<>'' then ' · '||approval_private.logistics_slack_escape(p_payload->>'status_note_text') else '' end, v_req);
 else
  return format(E'출고완료를 되돌려 준비중으로 바꿈: %s\n%s', approval_private.logistics_slack_escape(p_payload->>'status_note_text'), v_req);
 end if;
end $$;

create or replace function approval_private.logistics_slack_flush() returns void
language plpgsql security definer set search_path='' as $$
declare
 v_token text; v_channel text; r record; resp record; v_ok boolean; v_body jsonb; v_parent text; v_err text;
begin
 select decrypted_secret into v_token from vault.decrypted_secrets where name='logistics_slack_bot_token';
 select decrypted_secret into v_channel from vault.decrypted_secrets where name='logistics_slack_channel';
 if coalesce(v_token,'')='' or coalesce(v_channel,'')='' then return; end if;

 -- 1) 보낸 건의 응답 확인
 for r in select * from public.logistics_slack_outbox where state_code='sending' order by id for update skip locked loop
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
   update public.logistics_slack_outbox set state_code='sent', last_error_text='' where id=r.id;
   if r.event_code='created' then
    update public.logistics_requests set slack_ts=resp.content::jsonb->>'ts', slack_state_code='sent' where id=r.request_id;
   end if;
  else
   update public.logistics_slack_outbox set state_code=case when r.attempts>=5 then 'failed' else 'pending' end, last_error_text=v_err where id=r.id;
   if r.attempts>=5 then
    update public.logistics_requests set slack_state_code='failed' where id=r.request_id;
   end if;
  end if;
 end loop;

 -- 2) 대기 중인 건 보내기
 for r in select o.*, q.slack_ts as parent_ts from public.logistics_slack_outbox o join public.logistics_requests q on q.id=o.request_id
          where o.state_code='pending' order by o.id limit 20 for update of o skip locked loop
  if r.event_code<>'created' and r.parent_ts is null and exists(
     select 1 from public.logistics_slack_outbox p where p.request_id=r.request_id and p.event_code='created' and p.state_code in ('pending','sending')) then
   continue; -- 원글이 끝나기를 기다린다
  end if;
  v_body := jsonb_build_object('channel',v_channel,'text',approval_private.logistics_slack_text(r.request_id,r.event_code,r.payload),'unfurl_links',false,'unfurl_media',false);
  if r.event_code<>'created' and r.parent_ts is not null then v_body := v_body || jsonb_build_object('thread_ts',r.parent_ts); end if;
  update public.logistics_slack_outbox set state_code='sending', attempts=attempts+1, sent_at=now(),
   net_request_id=net.http_post(url:='https://slack.com/api/chat.postMessage', body:=v_body,
    headers:=jsonb_build_object('Content-Type','application/json; charset=utf-8','Authorization','Bearer '||v_token), timeout_milliseconds:=10000)
   where id=r.id;
 end loop;
end $$;

revoke all on function approval_private.logistics_slack_escape(text),approval_private.logistics_slack_who(text),
 approval_private.logistics_slack_text(uuid,text,jsonb),approval_private.logistics_slack_flush() from public,anon,authenticated;

do $$ begin
 perform cron.unschedule(jobid) from cron.job where jobname='logistics-slack-send';
 perform cron.schedule('logistics-slack-send','* * * * *','select approval_private.logistics_slack_flush()');
end $$;
commit;
```

구현 메모: flush가 요청 행의 `slack_ts`·`slack_state_code`를 바꾸는 UPDATE는 `auth.uid()`가 없는 시스템 실행이라, Task 2 트리거가 취소된 요청이어도 허용한다(요약·결과·상태가 그대로이므로 `LOGISTICS_CLOSED`에 걸리지 않음).

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/logistics-slack-db.test.cjs tests/logistics-db.test.cjs`
Expected: PASS (4 + 7 tests)

- [ ] **Step 5: Commit**

```bash
git add sql/logistics-slack.sql tests/logistics-slack-db.test.cjs
GIT_AUTHOR_NAME=sylee GIT_AUTHOR_EMAIL=sylee@entropymakeup.com GIT_COMMITTER_NAME=sylee GIT_COMMITTER_EMAIL=sylee@entropymakeup.com git commit -m "물류 요청: 슬랙 알림 발송(outbox, pg_net, pg_cron)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: 데이터 계층과 HTML 렌더링 (`logistics.js` 앞부분)

**Files:**
- Create: `logistics.js` (이 Task에서는 `createApi`와 `render*`만. `mount`는 Task 6)
- Test: `tests/logistics-ui.test.cjs`

**Interfaces:**
- Consumes: Task 1 `LogisticsModel`(브라우저 전역, Node에서는 require)
- Produces (`LogisticsPage.*`):
  - `createApi(client, {uuid}) → {loadAll(), loadDetail(id), create(draft), update(id, fromStatus, patch), uploadFile(requestId, file, kind), removeFile(fileRow), fileUrl(path), addComment(requestId, body), deleteComment(id)}`
    - `loadAll() → {requests, files, handlers, people, invoices}`
    - `loadDetail(id) → {comments, history}`
    - 나머지는 확인된 행을 돌려주고, 아니면 `Error('STALE'|'UNCONFIRMED'|DB 메시지)`를 던진다.
  - `renderList(rows, ctx) → string`, `renderDetail(req, ctx) → string`, `renderForm(draft, ctx) → string`
    - ctx: `{email, isHandler, nowMs, files, people, invoices, comments, history}`

- [ ] **Step 1: Write the failing test**

`tests/logistics-ui.test.cjs`:

```js
const {test}=require('node:test');const assert=require('node:assert/strict');
global.LogisticsModel=require('../logistics-model.js');
const P=require('../logistics.js');
const NOW=Date.UTC(2026,10,20,1);

// 아주 작은 가짜 supabase client. 호출을 기록하고 handler가 결과를 돌려준다.
function fakeClient(handler){
 const calls=[];
 const builder=(table)=>{const q={table,ops:[]};const chain={};
  for(const m of ['select','insert','update','delete','eq','order','limit','in'])chain[m]=(...a)=>{q.ops.push([m,...a]);return chain;};
  chain.single=()=>{q.ops.push(['single']);return chain;};
  chain.then=(res,rej)=>{calls.push(q);return Promise.resolve(handler(q)).then(res,rej);};
  return chain;};
 const storage={from:bucket=>({
  upload:async(p,f,o)=>{calls.push({table:'storage:'+bucket,ops:[['upload',p,o]]});return handler({table:'storage:'+bucket,ops:[['upload',p]]});},
  remove:async ps=>{calls.push({table:'storage:'+bucket,ops:[['remove',ps]]});return handler({table:'storage:'+bucket,ops:[['remove',ps]]});},
  createSignedUrl:async(p,s)=>handler({table:'storage:'+bucket,ops:[['sign',p,s]]})})};
 return {client:{from:builder,storage},calls};
}
const draft={type_code:'quick',title_text:'퀵',team_code:'global',counterparty_text:'비주그룹',want_date:'2026-11-20',ship_mode_code:'quick'};

test('등록은 검증을 통과해야 하고, 반환 행이 있어야 성공이다',async()=>{
 const {client,calls}=fakeClient(q=>q.table==='logistics_requests'?{data:{id:'r1',...draft},error:null}:{data:null,error:null});
 const api=P.createApi(client,{uuid:()=>'u1'});
 await assert.rejects(()=>api.create({...draft,title_text:''}),/제목을/);
 assert.equal(calls.length,0);
 const row=await api.create(draft);
 assert.equal(row.id,'r1');
 assert.deepEqual(calls[0].ops[0][0],'insert');
 const none=fakeClient(()=>({data:null,error:null}));
 await assert.rejects(()=>P.createApi(none.client).create(draft),/UNCONFIRMED/);
});

test('상태 변경은 이전 상태 조건으로 하고, 0행이면 STALE',async()=>{
 const {client,calls}=fakeClient(()=>({data:[],error:null}));
 await assert.rejects(()=>P.createApi(client).update('r1','requested',{status_code:'accepted'}),/STALE/);
 assert.deepEqual(calls[0].ops.filter(o=>o[0]==='eq'),[['eq','id','r1'],['eq','status_code','requested']]);
 const ok=fakeClient(()=>({data:[{id:'r1',status_code:'accepted'}],error:null}));
 assert.equal((await P.createApi(ok.client).update('r1','requested',{status_code:'accepted'})).status_code,'accepted');
 const err=fakeClient(()=>({data:null,error:{message:'LOGISTICS_FORBIDDEN'}}));
 await assert.rejects(()=>P.createApi(err.client).update('r1','requested',{}),/LOGISTICS_FORBIDDEN/);
});

test('첨부: 크기 제한, 경로 규칙, 행 저장 실패 시 올린 파일 정리, 지울 때는 파일 먼저',async()=>{
 let failRow=true;
 const {client,calls}=fakeClient(q=>{
  if(q.table==='logistics_request_files')return failRow?{data:null,error:{message:'LOGISTICS_FILE_LIMIT'}}:{data:{id:'f1'},error:null};
  return {data:{},error:null};});
 const api=P.createApi(client,{uuid:()=>'11111111-1111-1111-1111-111111111111'});
 const rid='22222222-2222-2222-2222-222222222222';
 await assert.rejects(()=>api.uploadFile(rid,{name:'big.pdf',size:20971521},'etc'),/20MB/);
 await assert.rejects(()=>api.uploadFile(rid,{name:'a/b.xlsx',size:10},'request'),/LOGISTICS_FILE_LIMIT/);
 const up=calls.find(c=>c.table==='storage:logistics-docs'&&c.ops[0][0]==='upload');
 assert.equal(up.ops[0][1],`${rid}/11111111-1111-1111-1111-111111111111-a_b.xlsx`);
 assert.ok(calls.some(c=>c.ops[0][0]==='remove'));
 failRow=false;calls.length=0;
 await api.removeFile({id:'f1',storage_path:'p/x'});
 assert.deepEqual(calls.map(c=>c.table),['storage:logistics-docs','logistics_request_files']);
});

test('목록 렌더링: 이스케이프, 지연 표시, 알림 실패 표시',()=>{
 const rows=[{id:'a',type_code:'b2b',title_text:'<img src=x>',counterparty_text:'A&B',status_code:'accepted',want_date:'2026-11-19',ship_mode_code:'air',requester_email:'req@entropymakeup.com',slack_state_code:'failed',created_at:'2026-11-18T00:00:00Z'}];
 const html=P.renderList(rows,{nowMs:NOW,files:[{request_id:'a'}],people:[{email:'req@entropymakeup.com',display_name:'가짜 요청자'}]});
 assert.ok(!html.includes('<img'));
 assert.ok(html.includes('&lt;img src=x&gt;'));
 assert.ok(html.includes('A&amp;B'));
 assert.ok(html.includes('class="lg-row late"'));
 assert.ok(html.includes('알림 실패'));
 assert.ok(html.includes('가짜 요청자'));
 assert.ok(html.includes('📎 1'));
 assert.ok(P.renderList([],{nowMs:NOW}).includes('요청이 없어요'));
});

test('상세 렌더링: 담당자에게만 상태 버튼, 요청자에게는 취소만',()=>{
 const req={id:'a',type_code:'quick',title_text:'퀵',counterparty_text:'c',status_code:'requested',ship_mode_code:'quick',requester_email:'req@entropymakeup.com',result_text:'',status_note_text:''};
 const base={nowMs:NOW,files:[],people:[],invoices:[],comments:[],history:[]};
 const h=P.renderDetail(req,{...base,email:'handler@entropymakeup.com',isHandler:true});
 assert.ok(h.includes('data-to="accepted"'));
 assert.ok(h.includes('data-to="shipped"'));
 const o=P.renderDetail(req,{...base,email:'req@entropymakeup.com',isHandler:false});
 assert.ok(o.includes('data-to="canceled"'));
 assert.ok(!o.includes('data-to="accepted"'));
 const x=P.renderDetail(req,{...base,email:'other@entropymakeup.com',isHandler:false});
 assert.ok(!x.includes('data-to='));
});

test('등록 폼: 해외 칸은 해외 건일 때만 보인다',()=>{
 assert.ok(P.renderForm({type_code:'b2b',ship_mode_code:'air'},{invoices:[]}).includes('name="packing_code"'));
 assert.ok(!P.renderForm({type_code:'quick',ship_mode_code:'quick'},{invoices:[]}).includes('name="packing_code"'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/logistics-ui.test.cjs`
Expected: FAIL with `Cannot find module '../logistics.js'`

- [ ] **Step 3: Write minimal implementation**

`logistics.js`:

```js
(function(root,factory){const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;else root.LogisticsPage=api;})(typeof globalThis!=='undefined'?globalThis:this,function(root){
'use strict';
// 물류 요청 페이지. 데이터 계층(createApi), HTML 렌더링(render*), 화면 연결(mount). 규칙은 logistics-model.js.
const M=root.LogisticsModel||(typeof require==='function'?require('./logistics-model.js'):null);
const {esc}=M;
const BUCKET='logistics-docs',T='logistics_requests';
const opt=(map,sel)=>Object.entries(map).map(([k,v])=>`<option value="${esc(k)}"${k===sel?' selected':''}>${esc(v)}</option>`).join('');
const nameOf=(email,people)=>(people||[]).find(p=>p.email===String(email||'').toLowerCase())?.display_name||String(email||'').split('@')[0];
const fmtDay=d=>d?String(d).slice(5).replace('-','/'):'미정';

function createApi(client,{uuid}={}){
 const newId=uuid||(()=>root.crypto.randomUUID());
 const need=async q=>{const {data,error}=await q;if(error)throw new Error(error.message||String(error));return data;};
 return {
  async loadAll(){
   const [requests,files,handlers,people,invoices]=await Promise.all([
    need(client.from(T).select('*').order('created_at',{ascending:false}).limit(2000)),
    need(client.from('logistics_request_files').select('*').order('created_at')),
    need(client.from('logistics_handlers').select('email,display_name,is_active')),
    need(client.from('logistics_people').select('email,display_name')),
    need(client.from('invoices').select('id,no,customer').order('order_date',{ascending:false}).limit(500))]);
   return {requests:requests||[],files:files||[],handlers:(handlers||[]).filter(h=>h.is_active),people:people||[],invoices:invoices||[]};
  },
  async loadDetail(id){
   const [comments,history]=await Promise.all([
    need(client.from('logistics_request_comments').select('*').eq('request_id',id).order('created_at')),
    need(client.from('logistics_request_history').select('*').eq('request_id',id).order('changed_at'))]);
   return {comments:comments||[],history:history||[]};
  },
  async create(draft){
   const errors=M.validateDraft(draft);if(errors.length)throw new Error(errors.join(' '));
   const row=await need(client.from(T).insert(M.toInsertRow(draft)).select().single());
   if(!row?.id)throw new Error('UNCONFIRMED');return row;
  },
  async update(id,fromStatus,patch){
   const rows=await need(client.from(T).update(patch).eq('id',id).eq('status_code',fromStatus).select());
   if(!Array.isArray(rows)||rows.length!==1)throw new Error('STALE');return rows[0];
  },
  async uploadFile(requestId,file,kind){
   if(!file||file.size>M.LIMITS.fileBytes)throw new Error('파일은 20MB 이하만 올릴 수 있어요.');
   const path=`${requestId}/${newId()}-${M.safeFileName(file.name)}`;
   await need(client.storage.from(BUCKET).upload(path,file,{upsert:false}));
   try{
    const row=await need(client.from('logistics_request_files').insert({request_id:requestId,kind_code:kind,storage_path:path,name_text:String(file.name||'file').slice(0,200),size_bytes:file.size}).select().single());
    if(!row?.id)throw new Error('UNCONFIRMED');return row;
   }catch(e){try{await client.storage.from(BUCKET).remove([path]);}catch(_){} throw e;}
  },
  async removeFile(f){
   await need(client.storage.from(BUCKET).remove([f.storage_path]));
   await need(client.from('logistics_request_files').delete().eq('id',f.id));
  },
  async fileUrl(path){const d=await need(client.storage.from(BUCKET).createSignedUrl(path,300));return d?.signedUrl;},
  async addComment(requestId,body){
   const row=await need(client.from('logistics_request_comments').insert({request_id:requestId,body_text:body}).select().single());
   if(!row?.id)throw new Error('UNCONFIRMED');return row;
  },
  async deleteComment(id){await need(client.from('logistics_request_comments').delete().eq('id',id));}
 };
}

function renderList(rows,ctx){
 if(!rows.length)return '<p class="lg-empty">요청이 없어요.</p>';
 const fileCount=id=>(ctx.files||[]).filter(f=>f.request_id===id).length;
 return `<table class="lg-table"><thead><tr><th>유형</th><th>제목</th><th>거래처·수신처</th><th>요청자</th><th>희망일</th><th>운송</th><th>상태</th><th></th></tr></thead><tbody>${rows.map(r=>{
  const late=M.isLate(r,ctx.nowMs),n=fileCount(r.id);
  return `<tr class="lg-row${late?' late':''}" data-id="${esc(r.id)}"><td>${esc(M.TYPES[r.type_code])}</td><td>${esc(r.title_text)}</td><td>${esc(r.counterparty_text)}</td>
   <td>${esc(nameOf(r.requester_email,ctx.people))}</td><td>${esc(fmtDay(r.want_date))}${late?' <b class="lg-late">지연</b>':''}</td><td>${esc(M.SHIP_MODES[r.ship_mode_code])}</td>
   <td><span class="lg-st st-${esc(r.status_code)}">${esc(M.STATUSES[r.status_code])}</span></td>
   <td>${n?`📎 ${n}`:''}${r.slack_state_code==='failed'?' <span class="lg-warn">알림 실패</span>':''}</td></tr>`;}).join('')}</tbody></table>`;
}

function renderDetail(r,ctx){
 const owner=String(ctx.email||'').toLowerCase()===String(r.requester_email||'').toLowerCase();
 const next=M.allowedNext({isHandler:ctx.isHandler,isOwner:owner,from:r.status_code});
 const files=(ctx.files||[]).filter(f=>f.request_id===r.id);
 const inv=(ctx.invoices||[]).find(i=>i.id===r.invoice_id);
 const overseas=M.needsOverseas(r);
 const field=(label,val)=>`<div class="lg-f"><span>${esc(label)}</span><b>${esc(val||'-')}</b></div>`;
 return `<div class="lg-detail" data-id="${esc(r.id)}">
 <h2>[${esc(M.TYPES[r.type_code])}] ${esc(r.title_text)} <span class="lg-st st-${esc(r.status_code)}">${esc(M.STATUSES[r.status_code])}</span></h2>
 ${field('거래처·수신처',r.counterparty_text)}${field('요청',nameOf(r.requester_email,ctx.people)+' · '+M.TEAMS[r.team_code])}
 ${field('희망 출고일',fmtDay(r.want_date))}${field('운송',M.SHIP_MODES[r.ship_mode_code])}${field('수량',r.qty_summary_text)}
 ${field('특이사항',r.note_text)}${field('연결 주문',inv?`${inv.no} ${inv.customer||''}`:'')}
 ${overseas?field('패킹리스트',M.PACKING[r.packing_code]||'')+field('ETD',r.etd_on)+field('포워더',r.forwarder_text):''}
 ${field('결과(송장·배차·BL)',r.result_text)}${field('출고일',r.shipped_on)}${r.status_note_text?field('사유',r.status_note_text):''}
 ${r.slack_state_code==='failed'?'<p class="lg-warn">슬랙 알림을 보내지 못했어요. 담당자에게 직접 알려 주세요.</p>':''}
 <div class="lg-actions">${next.map(to=>`<button type="button" class="lg-btn" data-to="${esc(to)}">${esc(M.STATUSES[to])}</button>`).join('')}
  ${ctx.isHandler&&r.status_code!=='canceled'?'<button type="button" class="lg-btn ghost" data-act="edit-result">결과 입력</button>':''}</div>
 <h3>첨부</h3><ul class="lg-files">${files.map(f=>`<li><a href="#" data-file="${esc(f.id)}">${esc(M.FILE_KINDS[f.kind_code])} · ${esc(f.name_text)}</a></li>`).join('')||'<li>없음</li>'}</ul>
 ${M.CLOSED.includes(r.status_code)?'':`<label class="lg-upload">파일 올리기 <select data-act="file-kind">${opt(M.FILE_KINDS,'request')}</select><input type="file" data-act="file"></label>`}
 <h3>댓글</h3><ul class="lg-comments">${(ctx.comments||[]).map(c=>`<li><b>${esc(nameOf(c.author_email,ctx.people))}</b> ${esc(c.body_text)} <time>${esc(String(c.created_at).slice(5,16).replace('T',' '))}</time></li>`).join('')}</ul>
 <form data-act="comment"><input name="body" maxlength="1000" placeholder="댓글"><button class="lg-btn ghost">남기기</button></form>
 <details><summary>변경 이력</summary><ul>${(ctx.history||[]).map(h=>`<li>${esc(String(h.changed_at).slice(5,16).replace('T',' '))} ${esc(h.field_code)} ${esc(h.from_text)} → ${esc(h.to_text)} (${esc(nameOf(h.changed_by_text,ctx.people))})</li>`).join('')}</ul></details>
 </div>`;
}

function renderForm(d,ctx){
 const overseas=M.needsOverseas(d);
 return `<form class="lg-form" data-act="create">
 <label>유형<select name="type_code">${opt({'':'선택',...M.TYPES},d.type_code||'')}</select></label>
 <label>제목<input name="title_text" maxlength="80" value="${esc(d.title_text)}"></label>
 <label>요청팀<select name="team_code">${opt({'':'선택',...M.TEAMS},d.team_code||'')}</select></label>
 <label>거래처·수신처<input name="counterparty_text" maxlength="120" value="${esc(d.counterparty_text)}"></label>
 <label>희망 출고일<input type="date" name="want_date" value="${esc(d.want_date)}"> <small>비워 두면 미정</small></label>
 <label>운송 방식<select name="ship_mode_code">${opt({'':'선택',...M.SHIP_MODES},d.ship_mode_code||'')}</select></label>
 <label>수량 요약<input name="qty_summary_text" maxlength="300" value="${esc(d.qty_summary_text)}" placeholder="예: 12 SKU, 3,240ea"></label>
 <label>특이사항<textarea name="note_text" maxlength="1000">${esc(d.note_text)}</textarea></label>
 <label>연결 주문<select name="invoice_id"><option value="">없음</option>${(ctx.invoices||[]).map(i=>`<option value="${esc(i.id)}"${i.id===d.invoice_id?' selected':''}>${esc(i.no)} ${esc(i.customer||'')}</option>`).join('')}</select></label>
 ${overseas?`<fieldset><legend>해외 출고</legend>
  <label>패킹리스트<select name="packing_code">${opt({'':'-',...M.PACKING},d.packing_code||'')}</select></label>
  <label>ETD<input type="date" name="etd_on" value="${esc(d.etd_on)}"></label>
  <label>포워더<input name="forwarder_text" maxlength="120" value="${esc(d.forwarder_text)}"></label></fieldset>`:''}
 <label>첨부(출고요청서 등)<input type="file" name="files" multiple></label>
 <p class="lg-error" role="alert"></p>
 <button class="lg-btn">요청 올리기</button></form>`;
}

return {createApi,renderList,renderDetail,renderForm,mount:(...a)=>mount(...a)};
function mount(){throw new Error('mount는 Task 6에서 구현');}
});
```

(Task 6에서 `function mount(){throw ...}` 한 줄을 실제 구현으로 바꾼다.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/logistics-ui.test.cjs`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add logistics.js tests/logistics-ui.test.cjs
GIT_AUTHOR_NAME=sylee GIT_AUTHOR_EMAIL=sylee@entropymakeup.com GIT_COMMITTER_NAME=sylee GIT_COMMITTER_EMAIL=sylee@entropymakeup.com git commit -m "물류 요청: 데이터 계층과 화면 렌더링

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: 페이지 연결 (`logistics.html`, `logistics.css`, `mount`)

**Files:**
- Create: `logistics.html`, `logistics.css`
- Modify: `logistics.js` (`mount` 구현)
- Modify: `tests/logistics-ui.test.cjs` (mount 테스트 추가)

**Interfaces:**
- Consumes: Task 5 `createApi`, `renderList`, `renderDetail`, `renderForm`
- Produces: `LogisticsPage.mount({document, client, now=()=>Date.now(), confirm, prompt, location}) → {reload(), state}`

화면 동작:
- 시작 시 `client.auth.getSession()`. 세션이 없으면 `#lg-login`을 보이고, "Google로 로그인" 버튼이 `client.auth.signInWithOAuth({provider:'google',options:{redirectTo:location.href,queryParams:{hd:'entropymakeup.com'}}})`를 호출한다(영업 대시보드 `loginWithGoogle`과 같은 방식).
- 세션이 있으면 `loadAll()` 뒤 탭(`todo` 기본, `hold`, `shipped`, `canceled`, `mine`), 검색창, "새 요청" 버튼, 목록을 그린다. 주소에 `?id=`가 있으면 그 상세를 연다(슬랙 링크).
- 줄을 누르면 오른쪽 패널에 `renderDetail`을 그리고 `loadDetail(id)`로 댓글·이력을 채운다.
- 상태 버튼(`data-to`): 출고완료는 결과·출고일 입력 창, 보류와 출고완료 되돌리기는 사유 입력 창을 먼저 띄운다. `M.checkTransition`을 통과하면 `api.update(id, 현재상태, patch)`를 부르고, 성공하면 다시 불러온다. 실패하면 `M.errorMessage(err)`를 보여 준다. 저장 중에는 버튼을 막는다.
- "결과 입력"(담당자): 결과·출고일·퀵비·패킹·ETD·포워더를 `update(id, 현재상태, patch)`로 저장한다.
- 등록 폼: 유형·운송을 바꾸면 폼을 다시 그려 해외 칸을 보이거나 숨긴다(입력값 유지). 제출하면 `create` → 첨부 파일을 차례로 `uploadFile` → 다시 불러온 뒤 새 요청 상세를 연다. 첨부 하나가 실패하면 "요청은 올라갔고, ○○ 파일은 올리지 못했어요"라고 알린다.
- 파일 링크는 `fileUrl` 서명 주소(5분)로 새 탭에서 연다.
- 로그아웃(`onAuthStateChange` SIGNED_OUT)이면 상태를 비우고 로그인 화면으로 돌아간다. 겹친 응답은 세대 번호로 무시한다.

- [ ] **Step 1: Write the failing test** (`tests/logistics-ui.test.cjs` 끝에 추가)

```js
// mount는 최소한의 DOM 대역으로 검사한다: 로그인 분기, 목록 표시, 상태 변경 호출, 슬랙 링크 id
function fakeDom(){
 const els={};const mk=id=>els[id]||(els[id]={id,hidden:false,innerHTML:'',value:'',textContent:'',listeners:{},
  addEventListener(t,f){this.listeners[t]=f;},querySelector:()=>null,querySelectorAll:()=>[]});
 for(const id of ['lg-login','lg-app','lg-list','lg-detail','lg-form','lg-search','lg-tabs','lg-new','lg-google','lg-message','lg-me'])mk(id);
 return {document:{getElementById:mk},els};
}
function fakeAuthClient({session,rows=[],onUpdate}={}){
 const {client}=fakeClient(q=>{
  if(q.table==='logistics_requests'&&q.ops[0][0]==='update')return onUpdate?onUpdate(q):{data:[],error:null};
  if(q.table==='logistics_requests')return {data:rows,error:null};
  if(q.table==='logistics_handlers')return {data:[{email:'handler@entropymakeup.com',display_name:'가짜 담당',is_active:true}],error:null};
  return {data:[],error:null};});
 client.auth={getSession:async()=>({data:{session},error:null}),onAuthStateChange:()=>{},signInWithOAuth:async()=>({error:null})};
 return client;
}

test('mount: 세션이 없으면 로그인 화면, 있으면 목록과 슬랙 링크의 상세를 연다',async()=>{
 const d1=fakeDom();
 await P.mount({document:d1.document,client:fakeAuthClient({session:null}),location:{href:'x',search:''}}).ready;
 assert.equal(d1.els['lg-login'].hidden,false);assert.equal(d1.els['lg-app'].hidden,true);
 const d2=fakeDom();
 const rows=[{id:'r1',type_code:'quick',title_text:'퀵 요청',counterparty_text:'c',status_code:'requested',ship_mode_code:'quick',team_code:'global',requester_email:'req@entropymakeup.com',want_date:null,created_at:'2026-11-19T00:00:00Z'}];
 const page=P.mount({document:d2.document,client:fakeAuthClient({session:{user:{email:'handler@entropymakeup.com'}},rows}),location:{href:'x',search:'?id=r1'},now:()=>NOW});
 await page.ready;
 assert.equal(d2.els['lg-app'].hidden,false);
 assert.ok(d2.els['lg-list'].innerHTML.includes('퀵 요청'));
 assert.ok(d2.els['lg-detail'].innerHTML.includes('data-to="accepted"'));
 assert.equal(page.state.isHandler,true);
});

test('mount: 상태 변경은 이전 상태 조건으로 한 번만 보내고 실패 문구를 보여 준다',async()=>{
 let n=0;const d=fakeDom();
 const rows=[{id:'r1',type_code:'quick',title_text:'퀵',counterparty_text:'c',status_code:'requested',ship_mode_code:'quick',team_code:'global',requester_email:'req@entropymakeup.com',created_at:'2026-11-19T00:00:00Z'}];
 const page=P.mount({document:d.document,client:fakeAuthClient({session:{user:{email:'handler@entropymakeup.com'}},rows,onUpdate:q=>{n++;return {data:[],error:null};}}),location:{href:'x',search:''},now:()=>NOW});
 await page.ready;
 await Promise.all([page.changeStatus('r1','accepted'),page.changeStatus('r1','accepted')]);
 assert.equal(n,1);
 assert.match(d.els['lg-message'].textContent,/다른 사람이 먼저 바꿨어요/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/logistics-ui.test.cjs`
Expected: 새 테스트 2개 FAIL with `mount는 Task 6에서 구현`

- [ ] **Step 3: Write the implementation**

`logistics.js`에서 `function mount(){throw new Error('mount는 Task 6에서 구현');}`를 아래로 바꾼다:

```js
function mount({document,client,now=()=>Date.now(),confirm=(m)=>root.confirm(m),prompt=(m,v)=>root.prompt(m,v),location=root.location,open=(u)=>root.open(u,'_blank','noopener')}){
 const $=id=>document.getElementById(id);
 const api=createApi(client);
 const state={email:'',isHandler:false,data:{requests:[],files:[],handlers:[],people:[],invoices:[]},tab:'todo',q:'',selected:null,detail:{comments:[],history:[]},busy:false,draft:{}};
 let generation=0;
 const say=t=>{$('lg-message').textContent=t||'';};
 const ctx=()=>({email:state.email,isHandler:state.isHandler,nowMs:now(),files:state.data.files,people:state.data.people,invoices:state.data.invoices,...state.detail});
 const current=()=>state.data.requests.find(r=>r.id===state.selected);

 function drawList(){
  const rows=M.search(M.filterTab(state.data.requests,state.tab,{email:state.email,nowMs:now()}),state.q);
  $('lg-list').innerHTML=renderList(rows,ctx());
 }
 function drawDetail(){const r=current();$('lg-detail').innerHTML=r?renderDetail(r,ctx()):'';}
 async function openDetail(id){
  state.selected=id;state.detail={comments:[],history:[]};drawDetail();
  const g=generation;try{const d=await api.loadDetail(id);if(g!==generation||state.selected!==id)return;state.detail=d;drawDetail();}catch(e){say(M.errorMessage(e));}
 }
 async function reload(){
  const g=++generation;
  const data=await api.loadAll();if(g!==generation)return;
  state.data=data;state.isHandler=M.isHandler(state.email,data.handlers);
  $('lg-me').textContent=state.email+(state.isHandler?' · 물류 담당':'');
  drawList();if(state.selected)await openDetail(state.selected);
 }
 async function changeStatus(id,to){
  if(state.busy)return;const r=state.data.requests.find(x=>x.id===id);if(!r)return;
  const owner=state.email===String(r.requester_email||'').toLowerCase();
  const patch={status_code:to};
  if(to==='shipped'){
   const result=prompt('송장번호·배차정보·BL을 적어 주세요.',r.result_text||'');if(result==null)return;
   const day=prompt('출고일(YYYY-MM-DD)',M.kstToday(now()));if(day==null)return;
   Object.assign(patch,{result_text:result.trim(),shipped_on:day.trim()});
  }
  if(to==='on_hold'||(r.status_code==='shipped'&&to==='preparing')||to==='canceled'){
   const note=prompt(to==='canceled'?'취소 사유(선택)':'사유를 적어 주세요.','');if(note==null)return;patch.status_note_text=note.trim();
  }
  const check=M.checkTransition({isHandler:state.isHandler,isOwner:owner,from:r.status_code,to,fields:{...r,...patch}});
  if(!check.ok){say(check.reason);return;}
  state.busy=true;say('저장 중…');
  try{await api.update(id,r.status_code,patch);say('저장했어요.');await reload();}
  catch(e){say(M.errorMessage(e));}
  finally{state.busy=false;}
 }
 async function editResult(id){
  if(state.busy)return;const r=current();if(!r||r.id!==id)return;
  const result=prompt('결과(송장·배차·BL)',r.result_text||'');if(result==null)return;
  const fee=prompt('퀵비(원, 없으면 비움)',r.quick_fee_krw??'');if(fee==null)return;
  const patch={result_text:result.trim(),quick_fee_krw:fee.trim()===''?null:Number(fee.replace(/[^0-9]/g,''))};
  if(M.needsOverseas(r)){
   const etd=prompt('ETD(YYYY-MM-DD, 없으면 비움)',r.etd_on||'');if(etd==null)return;patch.etd_on=etd.trim()||null;
   const pk=prompt('패킹리스트: waiting(대기)/done(작성완료)/replied(거래처회신), 없으면 비움',r.packing_code||'');if(pk==null)return;patch.packing_code=pk.trim()||null;
  }
  state.busy=true;
  try{await api.update(id,r.status_code,patch);say('저장했어요.');await reload();}catch(e){say(M.errorMessage(e));}finally{state.busy=false;}
 }
 function readForm(form){const d={};for(const el of form.querySelectorAll('[name]'))if(el.type!=='file')d[el.name]=el.value;return d;}
 function drawForm(){$('lg-form').innerHTML=renderForm(state.draft,{invoices:state.data.invoices});$('lg-form').hidden=false;}
 async function submitForm(form){
  if(state.busy)return;const draft=readForm(form);const errors=M.validateDraft(draft);
  const errEl=form.querySelector('.lg-error');if(errors.length){if(errEl)errEl.textContent=errors.join(' ');return;}
  state.busy=true;say('요청을 올리는 중…');
  try{
   const row=await api.create(draft);const failed=[];
   const input=form.querySelector('input[type=file]');
   for(const f of Array.from(input?.files||[])){try{await api.uploadFile(row.id,f,'request');}catch(e){failed.push(f.name);}}
   state.draft={};$('lg-form').hidden=true;state.tab='mine';state.selected=row.id;
   say(failed.length?`요청은 올라갔고, ${failed.join(', ')} 파일은 올리지 못했어요. 상세에서 다시 올려 주세요.`:'요청을 올렸어요. 슬랙에도 곧 알림이 가요.');
   await reload();
  }catch(e){if(errEl)errEl.textContent=M.errorMessage(e);say('');}
  finally{state.busy=false;}
 }

 $('lg-list').addEventListener('click',ev=>{const tr=ev.target.closest?.('tr[data-id]');if(tr)openDetail(tr.dataset.id);});
 $('lg-detail').addEventListener('click',async ev=>{
  const t=ev.target;const r=current();if(!r)return;
  if(t.dataset?.to){changeStatus(r.id,t.dataset.to);return;}
  if(t.dataset?.act==='edit-result'){editResult(r.id);return;}
  if(t.dataset?.file){ev.preventDefault();const f=state.data.files.find(x=>x.id===t.dataset.file);if(f){try{open(await api.fileUrl(f.storage_path));}catch(e){say(M.errorMessage(e));}}}
 });
 $('lg-detail').addEventListener('change',async ev=>{
  const t=ev.target;const r=current();if(!r||t.dataset?.act!=='file'||!t.files?.[0])return;
  const kind=t.closest('.lg-upload')?.querySelector('[data-act=file-kind]')?.value||'etc';
  try{await api.uploadFile(r.id,t.files[0],kind);say('파일을 올렸어요.');await reload();}catch(e){say(M.errorMessage(e));}
 });
 $('lg-detail').addEventListener('submit',async ev=>{
  ev.preventDefault();const r=current();const input=ev.target.querySelector('[name=body]');const body=(input?.value||'').trim();
  if(!r||!body)return;try{await api.addComment(r.id,body);input.value='';await openDetail(r.id);}catch(e){say(M.errorMessage(e));}
 });
 $('lg-form').addEventListener('change',ev=>{if(['type_code','ship_mode_code'].includes(ev.target.name)){state.draft=readForm($('lg-form').querySelector('form')||$('lg-form'));drawForm();}});
 $('lg-form').addEventListener('submit',ev=>{ev.preventDefault();submitForm(ev.target);});
 $('lg-new').addEventListener('click',()=>{state.draft={team_code:'',want_date:''};drawForm();});
 $('lg-search').addEventListener('input',ev=>{state.q=ev.target.value;drawList();});
 $('lg-tabs').addEventListener('click',ev=>{const tab=ev.target.dataset?.tab;if(tab){state.tab=tab;drawList();}});
 $('lg-google').addEventListener('click',async()=>{const {error}=await client.auth.signInWithOAuth({provider:'google',options:{redirectTo:location.href,queryParams:{hd:'entropymakeup.com'}}});if(error)say(error.message);});

 async function start(){
  const g=++generation;
  try{
   const {data,error}=await client.auth.getSession();if(g!==generation)return;if(error)throw error;
   const session=data?.session;
   if(!session){$('lg-login').hidden=false;$('lg-app').hidden=true;return;}
   state.email=String(session.user?.email||'').toLowerCase();
   $('lg-login').hidden=true;$('lg-app').hidden=false;
   const id=new URLSearchParams(location.search||'').get('id');if(id)state.selected=id;
   await reload();
  }catch(e){$('lg-login').hidden=false;$('lg-app').hidden=true;say('로그인을 확인하지 못했어요. '+(e.message||''));}
 }
 client.auth.onAuthStateChange(ev=>{if(ev==='SIGNED_OUT'){generation++;state.data={requests:[],files:[],handlers:[],people:[],invoices:[]};state.selected=null;$('lg-list').innerHTML='';$('lg-detail').innerHTML='';$('lg-login').hidden=false;$('lg-app').hidden=true;}else if(ev==='SIGNED_IN')setTimeout(start,0);});
 const ready=start();
 return {ready,state,reload,changeStatus,openDetail};
}
```

주의: 테스트의 가짜 DOM에는 `closest`가 없으므로 위 코드는 `ev.target.closest?.()`처럼 선택적 호출을 쓴다. `changeStatus`의 두 번째 동시 호출은 `state.busy`로 막힌다. 가짜 client는 `prompt`가 필요 없는 `accepted` 전환만 검사한다.

`logistics.html`:

```html
<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>물류 요청 | Entropy Makeup</title>
  <link rel="stylesheet" href="logistics.css?v=20261119-1">
  <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
  <script src="logistics-model.js?v=20261119-1" defer></script>
  <script src="logistics.js?v=20261119-1" defer></script>
</head>
<body>
  <header class="lg-head"><h1>물류 요청</h1><span id="lg-me"></span><a href="index.html">영업 대시보드</a></header>
  <p id="lg-message" role="status"></p>
  <section id="lg-login" hidden><p>회사 Google 계정으로 로그인해 주세요.</p><button type="button" id="lg-google" class="lg-btn">Google로 로그인</button></section>
  <main id="lg-app" hidden>
    <div class="lg-bar">
      <nav id="lg-tabs"><button data-tab="todo">처리할 것</button><button data-tab="hold">보류</button><button data-tab="shipped">출고완료</button><button data-tab="canceled">취소</button><button data-tab="mine">내 요청</button></nav>
      <input id="lg-search" type="search" placeholder="제목·거래처·송장 검색">
      <button type="button" id="lg-new" class="lg-btn">새 요청</button>
    </div>
    <div id="lg-form" hidden></div>
    <div class="lg-cols"><section id="lg-list"></section><aside id="lg-detail"></aside></div>
  </main>
  <script>
    window.addEventListener('DOMContentLoaded',function(){
      if(!window.supabase||!window.LogisticsPage){document.getElementById('lg-message').textContent='페이지 구성 요소를 불러오지 못했어요. 새로고침해 주세요.';return;}
      // 영업 대시보드와 같은 공개 프로젝트 설정(admin.html과 같은 값)
      const client=supabase.createClient('https://qqmhxnwmasamkqsbnrvw.supabase.co','<admin.html 27번째 줄의 anon 키를 그대로 복사>');
      window.logisticsPage=LogisticsPage.mount({document,client});
    });
  </script>
</body>
</html>
```

`<admin.html 27번째 줄의 anon 키를 그대로 복사>`는 자리표시가 아니라 지시다. `admin.html`의 `supabase.createClient(...)` 두 번째 인자 문자열(공개 anon 키)을 그대로 붙인다. 구현 후 `grep -c "eyJhbGciOiJIUzI1NiIs" logistics.html`이 1이어야 한다.

`logistics.css`:

```css
:root{--bg:#f6f7f9;--card:#fff;--ink:#1d2433;--muted:#6b7280;--line:#e5e7eb;--accent:#2f5bea;--late:#c62828;--warn:#b45309}
@media (prefers-color-scheme:dark){:root{--bg:#111418;--card:#1a1f26;--ink:#e6e9ef;--muted:#9aa3b2;--line:#2a313b;--accent:#7b9bff;--late:#ff6b6b;--warn:#f5a524}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 system-ui,-apple-system,"Apple SD Gothic Neo","Malgun Gothic",sans-serif}
.lg-head{display:flex;gap:12px;align-items:center;padding:12px 16px;border-bottom:1px solid var(--line);background:var(--card)}
.lg-head h1{font-size:18px;margin:0}.lg-head a{margin-left:auto;color:var(--accent)}
#lg-message{margin:8px 16px;min-height:1.5em;color:var(--warn)}
#lg-login,#lg-app{padding:0 16px 16px}
.lg-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:12px}
#lg-tabs button{border:1px solid var(--line);background:var(--card);color:var(--ink);padding:6px 10px;border-radius:6px;cursor:pointer}
#lg-search{flex:1;min-width:160px;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--ink)}
.lg-btn{background:var(--accent);color:#fff;border:0;border-radius:6px;padding:6px 12px;cursor:pointer}
.lg-btn.ghost{background:transparent;color:var(--accent);border:1px solid var(--accent)}
.lg-btn:disabled{opacity:.5;cursor:default}
.lg-cols{display:grid;grid-template-columns:minmax(0,3fr) minmax(0,2fr);gap:12px}
@media (max-width:900px){.lg-cols{grid-template-columns:1fr}}
.lg-table{width:100%;border-collapse:collapse;background:var(--card)}
.lg-table th,.lg-table td{padding:6px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
.lg-row{cursor:pointer}.lg-row:hover{background:var(--bg)}
.lg-row.late td:nth-child(5),.lg-late{color:var(--late)}
.lg-st{display:inline-block;padding:1px 6px;border-radius:10px;font-size:12px;border:1px solid var(--line)}
.st-shipped{color:#15803d}.st-on_hold{color:var(--warn)}.st-canceled{color:var(--muted);text-decoration:line-through}
.lg-warn{color:var(--warn);font-size:12px}
.lg-detail{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px}
.lg-detail h2{font-size:16px;margin:0 0 8px}.lg-detail h3{font-size:13px;margin:12px 0 4px;color:var(--muted)}
.lg-f{display:flex;gap:8px;padding:2px 0}.lg-f span{width:120px;color:var(--muted);flex-shrink:0}.lg-f b{font-weight:500;white-space:pre-wrap;word-break:break-word}
.lg-actions{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0}
.lg-form{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:8px;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px;margin-bottom:12px}
.lg-form label{display:flex;flex-direction:column;gap:4px}.lg-form textarea{min-height:60px}
.lg-form input,.lg-form select,.lg-form textarea{padding:6px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--ink)}
.lg-form fieldset{grid-column:1/-1;border:1px dashed var(--line);border-radius:6px;display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px}
.lg-error{grid-column:1/-1;color:var(--late);margin:0}
.lg-empty{color:var(--muted);padding:16px}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/logistics-ui.test.cjs && node --check logistics.js`
Expected: PASS (8 tests), check 오류 없음

- [ ] **Step 5: Commit**

```bash
git add logistics.html logistics.css logistics.js tests/logistics-ui.test.cjs
GIT_AUTHOR_NAME=sylee GIT_AUTHOR_EMAIL=sylee@entropymakeup.com GIT_COMMITTER_NAME=sylee GIT_COMMITTER_EMAIL=sylee@entropymakeup.com git commit -m "물류 요청: 페이지와 화면 연결

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: 메뉴 링크·검사 스크립트·운영 문서

**Files:**
- Modify: `index.html:110` (업무 목록 다음 줄)
- Modify: `package.json` (`check`)
- Create: `LOGISTICS.md`
- Modify: `DEVELOPMENT.md` (배포 파일 문단)
- Test: `tests/logistics-ui.test.cjs` (링크 존재 검사 추가)

**Interfaces:**
- Consumes: Task 2~6의 파일 이름, Vault 이름, pg_cron 작업 이름

- [ ] **Step 1: Write the failing test** (`tests/logistics-ui.test.cjs` 끝에 추가)

```js
test('영업 대시보드 메뉴에 물류 요청 링크가 있고, 검사 스크립트가 새 파일을 포함한다',()=>{
 const fs=require('node:fs'),path=require('node:path');
 const index=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
 assert.match(index,/<a class="ni" href="logistics\.html" id="nav-logistics"/);
 const pkg=JSON.parse(fs.readFileSync(path.join(__dirname,'../package.json'),'utf8'));
 assert.match(pkg.scripts.check,/node --check logistics-model\.js && node --check logistics\.js/);
 assert.ok(fs.existsSync(path.join(__dirname,'../LOGISTICS.md')));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/logistics-ui.test.cjs`
Expected: 새 테스트 FAIL (링크 없음)

- [ ] **Step 3: 변경하기**

`index.html` 110번째 줄(`id="nav-tasks"`) 바로 아래에 추가:

```html
    <a class="ni" href="logistics.html" id="nav-logistics" style="text-decoration:none"><i class="ti ti-truck"></i>물류 요청</a>
```

`package.json`의 `check` 끝 `&& node --check team-tasks.js` 뒤에 ` && node --check logistics-model.js && node --check logistics.js`를 붙인다.

`DEVELOPMENT.md`의 "배포 파일은 ..." 문단 끝에 한 문장 추가:

```markdown
물류 요청 페이지는 logistics.html, logistics.js, logistics-model.js, logistics.css 4개이며 sql/logistics.sql → sql/logistics-storage.sql → sql/logistics-slack.sql 순서로 설치한 뒤 배포합니다. LOGISTICS.md를 참고합니다.
```

`LOGISTICS.md`:

````markdown
# 물류 요청

회사 전체의 출고·샘플·퀵·시딩·CS·회송 요청을 받는 별도 페이지(`logistics.html`)입니다. 설계: `docs/superpowers/specs/2026-11-19-logistics-dashboard-design.md`

## 동작 기준

- 회사 계정이면 누구나 요청을 올리고 볼 수 있습니다. 상태 변경과 결과 입력은 `logistics_handlers` 명단에 있는 사람만 할 수 있습니다.
- 요청자는 자기 요청이 "요청" 상태일 때만 수정하거나 취소할 수 있습니다.
- 출고완료에는 송장·배차·BL과 출고일이, 보류와 출고완료 되돌리기에는 사유가 반드시 필요합니다. DB 트리거가 판정합니다.
- 승인 절차(APPROVALS.md)는 쓰지 않고 바로 저장합니다. 영업 주문의 출고 상태는 바꾸지 않고 연결만 합니다.
- 변경 이력(`logistics_request_history`)과 슬랙 대기열(`logistics_slack_outbox`)은 트리거만 씁니다.

## 설치 순서 (운영 DB, 사용자 승인 후)

1. `sql/logistics.sql`
2. `sql/logistics-storage.sql`
3. `sql/logistics-slack.sql` (pg_net, pg_cron, Vault가 이미 설치돼 있어야 합니다. 2026-11-19 확인)
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
````

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run check && npm test`
Expected: 전체 PASS. 기존 테스트도 깨지지 않아야 한다(특히 `asset-cache.test.cjs`가 index.html의 스크립트 버전 쿼리를 검사하는지 확인한다. 이번에는 `<a>` 한 줄만 추가하므로 버전 변경이 필요 없어야 한다. 실패하면 그 테스트 기준에 맞춰 index.html 버전 쿼리를 갱신한다).

- [ ] **Step 5: Commit**

```bash
git add index.html package.json LOGISTICS.md DEVELOPMENT.md tests/logistics-ui.test.cjs
GIT_AUTHOR_NAME=sylee GIT_AUTHOR_EMAIL=sylee@entropymakeup.com GIT_COMMITTER_NAME=sylee GIT_COMMITTER_EMAIL=sylee@entropymakeup.com git commit -m "물류 요청: 메뉴 링크와 운영 문서

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: 로컬 브라우저 확인과 마무리

**Files:**
- Create: `tools/logistics-preview.html` (커밋하지 않는 확인용. 끝나면 지운다)

- [ ] **Step 1: 가짜 client로 화면 띄우기**

`tools/logistics-preview.html`을 만든다. `logistics.html`과 같은 마크업을 쓰되 supabase CDN 대신 아래 가짜 client를 쓴다. 메모리 배열에 요청 3건(지연 1, 보류 1, 출고완료 1)을 넣고, `from().select/insert/update/eq/order/limit/single`과 `storage.from().upload/remove/createSignedUrl`, `auth.getSession`(담당자 세션)을 흉내 낸다. 그다음 `LogisticsPage.mount({document,client})`를 호출한다.

```html
<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><title>물류 요청 미리보기</title>
<link rel="stylesheet" href="../logistics.css"><script src="../logistics-model.js"></script><script src="../logistics.js"></script></head>
<body>
<header class="lg-head"><h1>물류 요청 (미리보기)</h1><span id="lg-me"></span></header><p id="lg-message"></p>
<section id="lg-login" hidden><button id="lg-google">로그인</button></section>
<main id="lg-app" hidden><div class="lg-bar"><nav id="lg-tabs"><button data-tab="todo">처리할 것</button><button data-tab="hold">보류</button><button data-tab="shipped">출고완료</button><button data-tab="canceled">취소</button><button data-tab="mine">내 요청</button></nav>
<input id="lg-search" type="search"><button id="lg-new" class="lg-btn">새 요청</button></div><div id="lg-form" hidden></div>
<div class="lg-cols"><section id="lg-list"></section><aside id="lg-detail"></aside></div></main>
<script>
const db={logistics_requests:[
 {id:'a1',type_code:'b2b',title_text:'가짜 거래처 Air 11월',team_code:'global',counterparty_text:'가짜 거래처',want_date:'2026-11-18',ship_mode_code:'air',status_code:'accepted',requester_email:'me@entropymakeup.com',result_text:'',status_note_text:'',packing_code:'waiting',slack_state_code:'sent',created_at:'2026-11-17T00:00:00Z'},
 {id:'a2',type_code:'sample',title_text:'가짜 샘플',team_code:'global',counterparty_text:'가짜 바이어',want_date:null,ship_mode_code:'express',status_code:'on_hold',status_note_text:'주소 확인',requester_email:'me@entropymakeup.com',result_text:'',slack_state_code:'failed',created_at:'2026-11-18T00:00:00Z'},
 {id:'a3',type_code:'quick',title_text:'가짜 퀵',team_code:'domestic',counterparty_text:'가짜 매장',want_date:'2026-11-19',ship_mode_code:'quick',status_code:'shipped',result_text:'기사 정보 가짜',shipped_on:'2026-11-19',status_note_text:'',requester_email:'x@entropymakeup.com',slack_state_code:'sent',created_at:'2026-11-19T00:00:00Z'}],
 logistics_request_files:[],logistics_handlers:[{email:'me@entropymakeup.com',display_name:'나',is_active:true}],logistics_people:[],invoices:[],logistics_request_comments:[],logistics_request_history:[]};
function q(table){let rows=db[table]||[],op='select',patch=null,filters=[];const c={
 select(){return c},order(){return c},limit(){return c},single(){c._single=true;return c},
 eq(k,v){filters.push([k,v]);return c},insert(v){op='insert';patch=v;return c},update(v){op='update';patch=v;return c},delete(){op='delete';return c},
 then(res){const hit=r=>filters.every(([k,v])=>r[k]===v);let data;
  if(op==='insert'){const row={id:'n'+Date.now(),status_code:'requested',requester_email:'me@entropymakeup.com',created_at:new Date().toISOString(),slack_state_code:'pending',result_text:'',status_note_text:'',...patch};db[table].push(row);data=c._single?row:[row];}
  else if(op==='update'){data=rows.filter(hit);data.forEach(r=>Object.assign(r,patch));}
  else if(op==='delete'){db[table]=rows.filter(r=>!hit(r));data=[];}
  else data=rows.filter(hit);
  return Promise.resolve({data,error:null}).then(res);}};return c;}
const client={from:q,storage:{from:()=>({upload:async()=>({data:{},error:null}),remove:async()=>({data:{},error:null}),createSignedUrl:async()=>({data:{signedUrl:'about:blank'},error:null})})},
 auth:{getSession:async()=>({data:{session:{user:{email:'me@entropymakeup.com'}}},error:null}),onAuthStateChange(){},signInWithOAuth:async()=>({})}};
LogisticsPage.mount({document,client,location:{href:location.href,search:'?id=a1'}});
</script></body></html>
```

- [ ] **Step 2: 브라우저에서 확인** (Claude Browser `preview_start` + `navigate`로 `file:///.../tools/logistics-preview.html`을 연다. 로컬 파일이 막히면 `npx http-server -p 5178 .`을 백그라운드로 띄운다)

확인 목록:
- 처리할 것 탭에 a1이 빨간 "지연"으로 보이고, 상세가 열려 있다(`?id=a1`).
- 상세에서 "준비중" → "출고완료"를 누르면 결과·출고일 입력 창이 뜨고, 저장 뒤 출고완료 탭으로 옮겨 간다.
- 보류 탭에서 a2에 "알림 실패"가 보인다.
- 새 요청에서 운송을 Air로 바꾸면 해외 칸이 나타나고, 퀵으로 바꾸면 사라진다. 빈 제목으로 제출하면 오류 문구가 보인다.
- 375px 폭(모바일 프리셋)에서 가로 스크롤 없이 목록과 상세가 위아래로 쌓인다. 확인 뒤 데스크톱으로 되돌린다.
- 다크 모드에서 글자가 읽힌다.

- [ ] **Step 3: 확인용 파일 지우고 전체 검사**

```bash
rm tools/logistics-preview.html
npm run check && npm test
git status --short
```
Expected: 검사 통과, `git status`에 남은 변경 없음

- [ ] **Step 4: 코드 리뷰 요청**

superpowers:requesting-code-review로 Task 1~7 변경을 검토받는다. 특히 볼 것: 트리거 권한 구멍(비담당자가 결과 칸이나 슬랙 칸을 바꾸는 경로), storage 제한 정책이 다른 버킷에 영향을 주는지, 화면 문자열 이스케이프 누락.

- [ ] **Step 5: 진행현황 갱신**

`C:/Users/sylee/OneDrive/Desktop/클로드/Codex_계정전환_인수인계_20260908/진행현황/logistics-workflow-20261119.md`에 완료한 Task, 테스트 결과, 남은 운영 단계를 덧붙인다.

## 운영 체크리스트 (이 계획 밖. 사용자 승인을 받은 뒤 진행)

- [ ] PR 생성 → 사용자 검토 → main 병합
- [ ] 운영 DB에 SQL 3개 설치(Supabase MCP `apply_migration`, 설치 전 사용자 확인)
- [ ] 명단 입력: 담당자(김윤래님, 이상윤님), 슬랙 ID(요청자들)
- [ ] 사용자가 슬랙 앱을 만들고 Vault에 토큰·채널을 직접 넣음
- [ ] GitHub Pages 배포 확인, 테스트 요청 1건 → 슬랙 새 글·스레드 답글 확인 → 테스트 건 취소
- [ ] 김윤래님과 사용법 합의 → 글로벌팀 시범 → 다른 팀 안내
