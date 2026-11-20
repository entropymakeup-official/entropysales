const {test}=require('node:test');const assert=require('node:assert/strict');
global.LogisticsModel=require('../logistics-model.js');
const P=require('../logistics.js');
const NOW=Date.UTC(2026,10,20,1);

// 아주 작은 가짜 supabase client. 호출을 기록하고 handler가 결과를 돌려준다.
function fakeClient(handler){
 const calls=[];
 const builder=(table)=>{const q={table,ops:[]};const chain={};
  for(const m of ['select','insert','update','upsert','delete','eq','order','limit','range','in','gte'])chain[m]=(...a)=>{q.ops.push([m,...a]);return chain;};
  chain.single=()=>{q.ops.push(['single']);return chain;};
  chain.then=(res,rej)=>{calls.push(q);return Promise.resolve(handler(q)).then(res,rej);};
  return chain;};
 const storage={from:bucket=>({
  upload:async(p,f,o)=>{calls.push({table:'storage:'+bucket,ops:[['upload',p,o]]});return handler({table:'storage:'+bucket,ops:[['upload',p]]});},
  remove:async ps=>{calls.push({table:'storage:'+bucket,ops:[['remove',ps]]});return handler({table:'storage:'+bucket,ops:[['remove',ps]]});},
  createSignedUrl:async(p,s)=>handler({table:'storage:'+bucket,ops:[['sign',p,s]]})})};
 const rpc=(fn,args)=>{const q={table:'rpc:'+fn,ops:[['rpc',args]]};calls.push(q);return Promise.resolve(handler(q));};
 return {client:{from:builder,storage,rpc},calls};
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
  if(q.table==='logistics_request_files'&&q.ops.some(o=>o[0]==='delete'))return {data:[{id:'f1'}],error:null};
  if(q.table==='logistics_request_files')return failRow?{data:null,error:{message:'LOGISTICS_FILE_LIMIT'}}:{data:{id:'f1'},error:null};
  if(q.ops.some(o=>o[0]==='remove'))return {data:[{name:'x'}],error:null};
  return {data:{},error:null};});
 const api=P.createApi(client,{uuid:()=>'11111111-1111-1111-1111-111111111111'});
 const rid='22222222-2222-2222-2222-222222222222';
 await assert.rejects(()=>api.uploadFile(rid,{name:'big.pdf',size:20971521},'etc'),/20MB/);
 await assert.rejects(()=>api.uploadFile(rid,{name:'a/b.xlsx',size:10},'request'),/LOGISTICS_FILE_LIMIT/);
 const up=calls.find(c=>c.table==='storage:logistics-docs'&&c.ops[0][0]==='upload');
 assert.equal(up.ops[0][1],`${rid}/11111111-1111-1111-1111-111111111111-a_b.xlsx`);
 assert.ok(calls.some(c=>c.ops[0][0]==='remove'));
 calls.length=0;
 await assert.rejects(()=>api.uploadFile(rid,{name:'출고요청서.xlsx',size:10},'request'),/LOGISTICS_FILE_LIMIT/);
 const kp=calls.find(c=>c.ops[0][0]==='upload').ops[0][1];
 assert.equal(kp,`${rid}/11111111-1111-1111-1111-111111111111-_____.xlsx`);
 assert.ok(/^[ -~]+$/.test(kp));
 const ins=calls.find(c=>c.table==='logistics_request_files').ops.find(o=>o[0]==='insert');
 assert.equal(ins[1].name_text,'출고요청서.xlsx');
 failRow=false;calls.length=0;
 await api.removeFile({id:'f1',storage_path:'p/x'});
 assert.deepEqual(calls.map(c=>c.table),['storage:logistics-docs','logistics_request_files']);
});

test('첨부 삭제: 파일 삭제 미확인이면 행을 지우지 않고, 행 삭제 0건이면 STALE',async()=>{
 const f={id:'f1',storage_path:'p/x'};
 const a=fakeClient(q=>q.table.startsWith('storage:')?{data:[],error:null}:{data:[{id:'f1'}],error:null});
 await assert.rejects(()=>P.createApi(a.client).removeFile(f),/UNCONFIRMED/);
 assert.ok(!a.calls.some(c=>c.table==='logistics_request_files'));
 const b=fakeClient(q=>q.table.startsWith('storage:')?{data:[{name:'x'}],error:null}:{data:[],error:null});
 await assert.rejects(()=>P.createApi(b.client).removeFile(f),/STALE/);
});

test('댓글 삭제: 0건이면 STALE, 1건이면 성공',async()=>{
 await assert.rejects(()=>P.createApi(fakeClient(()=>({data:[],error:null})).client).deleteComment('c1'),/STALE/);
 await P.createApi(fakeClient(()=>({data:[{id:'c1'}],error:null})).client).deleteComment('c1');
});


test('loadAll: 열린 요청과 최근 닫힌 요청을 합치고, 첨부는 요청 id 묶음으로 조회한다',async()=>{
 const reqs=n=>Array.from({length:n},(_,i)=>({id:'r'+i,status_code:'requested'}));
 const {client,calls}=fakeClient(q=>{
  if(q.table==='logistics_requests'){
   const inOp=q.ops.find(o=>o[0]==='in');
   return inOp&&inOp[2].includes('shipped')?{data:[{id:'c1',status_code:'shipped'},{id:'r0',status_code:'requested'}],error:null}:{data:reqs(150),error:null};}
  return {data:[],error:null};});
 const data=await P.createApi(client,{now:()=>NOW}).loadAll();
 assert.equal(data.requests.length,151); // r0..r149 + c1, r0 중복 없음
 const rq=calls.filter(c=>c.table==='logistics_requests');
 assert.equal(rq.length,2);
 assert.ok(rq.every(c=>c.ops.some(o=>o[0]==='limit'&&o[1]===1000)));
 const closed=rq.find(c=>c.ops.some(o=>o[0]==='in'&&o[2].includes('shipped')));
 assert.deepEqual(closed.ops.find(o=>o[0]==='gte'),['gte','created_at',new Date(NOW-180*86400000).toISOString()]);
 const fq=calls.filter(c=>c.table==='logistics_request_files');
 assert.equal(fq.length,2); // 151개 id → 100 + 51
 assert.deepEqual(fq.map(c=>c.ops.find(o=>o[0]==='in')[2].length).sort((a,b)=>a-b),[51,100]);
 assert.ok(fq.every(c=>c.ops.find(o=>o[0]==='in')[1]==='request_id'));
 const none=fakeClient(()=>({data:[],error:null}));
 await P.createApi(none.client,{now:()=>NOW}).loadAll();
 assert.ok(!none.calls.some(c=>c.table==='logistics_request_files')); // id가 없으면 조회하지 않는다
});

// ── 계산·렌더링 ──
// NOW = 2026-11-20(금) 10:00 KST. 이번 주는 11-16(월)~11-22(일).
const R=(id,over)=>({id,type_code:'quick',title_text:'요청 '+id,counterparty_text:'c',status_code:'requested',ship_mode_code:'quick',team_code:'global',requester_email:'req@entropymakeup.com',want_date:null,created_at:'2026-11-18T00:00:00Z',...over});
const KPI_ROWS=[R('a',{want_date:'2026-11-19'}),R('b',{status_code:'accepted',want_date:'2026-11-20'}),R('c',{status_code:'preparing'}),
 R('d',{status_code:'on_hold',want_date:'2026-11-18'}),R('e',{status_code:'shipped',shipped_on:'2026-11-16',want_date:'2026-11-10'}),
 R('f',{status_code:'shipped',shipped_on:'2026-11-15'}),R('g',{status_code:'canceled',want_date:'2026-11-01'})];

test('KPI: 처리할 일·희망일 지남·오늘 출고 예정·이번 주 출고완료를 KST 기준으로 센다',()=>{
 assert.deepEqual(P.kstWeek(NOW),{start:'2026-11-16',end:'2026-11-22'});
 assert.deepEqual(P.kstWeek(Date.UTC(2026,10,22,15)),{start:'2026-11-23',end:'2026-11-29'}); // 일요일 15시 UTC = 월요일 0시 KST
 assert.deepEqual(P.summarize(KPI_ROWS,NOW),{todo:3,late:2,today:1,week:1});
 assert.deepEqual(P.listView(KPI_ROWS,{quick:'late',nowMs:NOW}).map(r=>r.id),['d','a']);
 assert.deepEqual(P.listView(KPI_ROWS,{quick:'today',nowMs:NOW}).map(r=>r.id),['b']);
 assert.deepEqual(P.listView(KPI_ROWS,{quick:'week',nowMs:NOW}).map(r=>r.id),['e']);
 assert.deepEqual(P.listView(KPI_ROWS,{tab:'hold',nowMs:NOW}).map(r=>r.id),['d']);
 assert.deepEqual(P.listView(KPI_ROWS,{tab:'todo',q:'요청 b',nowMs:NOW}).map(r=>r.id),['b']);
 const html=P.renderKpis({todo:3,late:2,today:1,week:1},'late');
 for(const k of ['todo','late','today','week'])assert.ok(html.includes(`data-kpi="${k}"`));
 assert.match(html,/class="kpi lg-kpi on warn" data-kpi="late" aria-pressed="true"/);
});

test('목록 렌더링: 대시보드 표, 이스케이프, 지연 빨간 표시, 알림 실패, 요청자 이름, 빈 화면의 새 요청 버튼',()=>{
 const rows=[{id:'a',type_code:'b2b',title_text:'<img src=x>',counterparty_text:'A&B',status_code:'accepted',want_date:'2026-11-19',ship_mode_code:'air',requester_email:'req@entropymakeup.com',slack_state_code:'failed',created_at:'2026-11-18T00:00:00Z'}];
 const html=P.renderList(rows,{nowMs:NOW,files:[{request_id:'a'}],people:[],handlers:[{email:'req@entropymakeup.com',display_name:'가짜 요청자'}]});
 assert.ok(html.startsWith('<div class="tw"><table'));
 assert.ok(!html.includes('<img'));
 assert.ok(html.includes('&lt;img src=x&gt;'));
 assert.ok(html.includes('A&amp;B'));
 assert.ok(html.includes('class="lg-row late"'));
 assert.ok(html.includes('class="lg-nowrap lg-late"'));
 assert.ok(html.includes('알림 실패'));
 assert.ok(html.includes('가짜 요청자'));
 assert.ok(html.includes('badge lg-st st-accepted bg-teal'));
 assert.ok(html.includes('data-open="a"'));
 const empty=P.renderList([],{nowMs:NOW,view:'todo'});
 assert.ok(empty.includes('처리할 요청이 없어요')&&empty.includes('data-act="new"'));
 const none=P.renderList([],{nowMs:NOW,view:'todo',q:'x'});
 assert.ok(none.includes('검색 결과가 없어요')&&!none.includes('data-act="new"'));
});

const base={nowMs:NOW,files:[],people:[],handlers:[],invoices:[],comments:[],history:[]};
const handlerCtx={...base,email:'handler@entropymakeup.com',isHandler:true},ownerCtx={...base,email:'req@entropymakeup.com',isHandler:false};

test('상세 렌더링: 담당자에게만 상태 버튼, 요청자에게는 취소만',()=>{
 const req=R('a');
 const h=P.renderDetail(req,handlerCtx);
 assert.ok(h.includes('data-to="accepted"'));
 assert.ok(h.includes('data-to="shipped"'));
 const o=P.renderDetail(req,ownerCtx);
 assert.ok(o.includes('data-to="canceled"'));
 assert.ok(!o.includes('data-to="accepted"'));
 const x=P.renderDetail(req,{...base,email:'other@entropymakeup.com',isHandler:false});
 assert.ok(!x.includes('data-to='));
 assert.ok(!x.includes('data-act="edit-result"'));
});

test('상세 렌더링: 요약 수정 버튼은 요청자는 요청 상태에서만, 담당자는 닫히기 전까지',()=>{
 const mk=st=>R('a',{status_code:st});
 assert.ok(P.renderDetail(mk('requested'),ownerCtx).includes('data-act="edit-summary"'));
 assert.ok(!P.renderDetail(mk('accepted'),ownerCtx).includes('data-act="edit-summary"'));
 assert.ok(P.renderDetail(mk('accepted'),handlerCtx).includes('data-act="edit-summary"'));
 assert.ok(!P.renderDetail(mk('shipped'),handlerCtx).includes('data-act="edit-summary"'));
 assert.ok(!P.renderDetail(mk('canceled'),handlerCtx).includes('data-act="edit-summary"'));
});

test('상세 렌더링: 상태별 입력 칸(출고완료는 결과·출고일, 보류·되돌리기는 필수 사유, 취소는 선택 사유, 결과 수정)',()=>{
 const shipped=P.renderDetail(R('a',{status_code:'preparing'}),{...handlerCtx,pending:{kind:'status',to:'shipped'}});
 assert.ok(shipped.includes('data-form="status"'));
 assert.ok(shipped.includes('name="result_text"')&&shipped.includes('name="shipped_on" value="2026-11-20"'));
 assert.ok(!shipped.includes('name="status_note_text"'));
 const hold=P.renderDetail(R('a',{status_code:'accepted'}),{...handlerCtx,pending:{kind:'status',to:'on_hold'}});
 assert.match(hold,/사유 <small>필수<\/small>/);assert.ok(hold.includes('name="status_note_text" maxlength="300" required'));
 const back=P.renderDetail(R('a',{status_code:'shipped',result_text:'CJ 1',shipped_on:'2026-11-19'}),{...handlerCtx,pending:{kind:'status',to:'preparing'}});
 assert.ok(back.includes('name="status_note_text" maxlength="300" required'));
 const cancel=P.renderDetail(R('a'),{...ownerCtx,pending:{kind:'status',to:'canceled'}});
 assert.match(cancel,/취소 사유 <small>선택<\/small>/);assert.ok(!cancel.includes('maxlength="300" required'));
 const result=P.renderDetail(R('a',{type_code:'b2b',ship_mode_code:'air',status_code:'preparing',quick_fee_krw:12000}),{...handlerCtx,pending:{kind:'result'}});
 assert.ok(result.includes('data-form="result"')&&result.includes('name="quick_fee_krw"')&&result.includes('value="12000"'));
 assert.ok(result.includes('name="etd_on"')&&result.includes('name="packing_code"'));
 assert.ok(!P.renderDetail(R('a',{status_code:'preparing'}),{...handlerCtx,pending:{kind:'result'}}).includes('name="etd_on"'));
 const err=P.renderDetail(R('a'),{...handlerCtx,error:'<b>오류</b>'});
 assert.ok(err.includes('class="lg-error" role="alert">&lt;b&gt;오류&lt;/b&gt;'));
});

test('상세 렌더링: 첨부 지우기는 담당자 또는 올린 사람(열린 요청), 댓글 지우기는 내 댓글 24시간 안',()=>{
 const files=[{id:'f1',request_id:'a',created_by:'req@entropymakeup.com',kind_code:'request',name_text:'a.xlsx',storage_path:'p'}];
 assert.ok(P.renderDetail(R('a'),{...ownerCtx,files}).includes('data-file-del="f1"'));
 assert.ok(!P.renderDetail(R('a',{status_code:'shipped'}),{...ownerCtx,files}).includes('data-file-del="f1"'));
 assert.ok(P.renderDetail(R('a',{status_code:'shipped'}),{...handlerCtx,files}).includes('data-file-del="f1"'));
 assert.ok(!P.renderDetail(R('a'),{...base,email:'x@entropymakeup.com',isHandler:false,files}).includes('data-file-del'));
 const comments=[{id:'c1',author_email:'req@entropymakeup.com',body_text:'<i>내 댓글</i>',created_at:new Date(NOW-3600000).toISOString()},
  {id:'c2',author_email:'req@entropymakeup.com',body_text:'옛 댓글',created_at:new Date(NOW-25*3600000).toISOString()},
  {id:'c3',author_email:'handler@entropymakeup.com',body_text:'남 댓글',created_at:new Date(NOW-60000).toISOString()}];
 const html=P.renderDetail(R('a'),{...ownerCtx,comments});
 assert.ok(html.includes('data-comment-del="c1"')&&!html.includes('data-comment-del="c2"')&&!html.includes('data-comment-del="c3"'));
 assert.ok(html.includes('&lt;i&gt;내 댓글&lt;/i&gt;'));
 assert.ok(!P.renderDetail(R('a',{status_code:'shipped'}),handlerCtx).includes('data-act="file"')); // 닫힌 요청에는 올리기 칸이 없다
});

test('입력 폼: 요청자 수정에는 해외 칸과 파일 칸이 없고, 새 요청은 해외 건이 아니면 해외 칸을 숨긴다',()=>{
 const d={type_code:'b2b',ship_mode_code:'air',title_text:'t'};
 const n=P.renderForm(d,{invoices:[],mode:'edit',isHandler:false});
 assert.ok(!n.includes('name="packing_code"')&&!n.includes('type="file"'));
 assert.ok(n.includes('수정 저장')&&n.includes('type="submit"')&&n.includes('data-form="edit"'));
 assert.ok(P.renderForm(d,{invoices:[],mode:'edit',isHandler:true}).includes('name="packing_code"'));
 const c=P.renderForm(d,{invoices:[]});
 assert.ok(c.includes('type="file"')&&c.includes('data-form="create"')&&c.includes('id="lg-f-overseas">'));
 assert.ok(P.renderForm({type_code:'quick',ship_mode_code:'quick'},{invoices:[]}).includes('id="lg-f-overseas" hidden'));
 assert.ok(P.renderForm({title_text:'"><script>'},{invoices:[]}).includes('value="&quot;&gt;&lt;script&gt;"'));
});

// ── mountTab: 가짜 DOM과 가짜 client ──
function fakeDom(){
 const els={};
 const mk=id=>els[id]||(els[id]={id,hidden:false,innerHTML:'',value:'',textContent:'',open:false,buttons:[],
  showModal(){this.open=true;},close(){this.open=false;},querySelector:()=>null,querySelectorAll(){return this.buttons;}});
 return {document:{getElementById:mk},els};
}
// data-* 속성 하나를 가진 클릭 대상. closest('[data-x]')만 흉내 낸다.
const node=(dataset,extra={})=>({dataset,...extra,closest(sel){const m=/^\[data-([a-z-]+)\]$/.exec(sel);if(!m)return null;const k=m[1].replace(/-([a-z])/g,(_,c)=>c.toUpperCase());return k in this.dataset?this:null;}});
const click=(d,dataset)=>d.els.content.onclick({target:node(dataset),preventDefault(){}});
const fakeForm=(vals,form)=>({dataset:{form},querySelector:()=>null,querySelectorAll:()=>Object.entries(vals).map(([name,value])=>({name,value,type:'text'}))});
const submit=(d,vals,form)=>d.els.content.onsubmit({preventDefault(){},target:fakeForm(vals,form)});

function setup({rows=[],email='handler@entropymakeup.com',onUpdate=()=>({data:[{id:'x'}],error:null}),invoices=[],files=[],handler,confirm=()=>true,open,location,history,xlsx,saveWorkbook}={}){
 const d=fakeDom(),messages=[],updates=[];let authCb=null;
 const {client,calls}=fakeClient(q=>{
  if(handler){const v=handler(q);if(v)return v;}
  if(q.table==='logistics_requests'&&q.ops[0][0]==='update'){updates.push(q);return onUpdate(q);}
  if(q.table==='logistics_requests'){const inOp=q.ops.find(o=>o[0]==='in');const closed=inOp&&inOp[2].includes('shipped');return {data:rows.filter(r=>['shipped','canceled'].includes(r.status_code)===Boolean(closed)),error:null};}
  if(q.table==='logistics_handlers')return {data:[{email:'handler@entropymakeup.com',display_name:'담당',is_active:true}],error:null};
  if(q.table==='invoices')return {data:invoices,error:null};
  if(q.table==='logistics_request_files')return {data:files,error:null};
  return {data:[],error:null};});
 client.auth={getSession:async()=>({data:{session:email?{user:{email}}:null},error:null}),onAuthStateChange:cb=>{authCb=cb;}};
 const page=P.mountTab({document:d.document,client,onMessage:m=>messages.push(m),now:()=>NOW,confirm,open,location,history,xlsx,saveWorkbook});
 return {d,page,client,calls,messages,updates,auth:(...a)=>authCb(...a)};
}

test('mountTab: 보이면 상단 버튼·KPI·탭·목록을 그리고, KPI를 누르면 그 목록으로 바꾼다',async()=>{
 const t=setup({rows:KPI_ROWS});
 await t.page.show();
 assert.match(t.d.els['topbar-actions'].innerHTML,/id="lg-new"[^>]*>.*새 요청.*id="lg-refresh"/);
 assert.ok(t.d.els.content.innerHTML.includes('<dialog class="lg-dialog" id="lg-detail"'));
 assert.match(t.d.els['lg-kpis'].innerHTML,/data-kpi="late"[^>]*><span class="lbl">희망일 지남<\/span><span class="val">2</);
 assert.match(t.d.els['lg-tabs'].innerHTML,/data-tab="todo" aria-selected="true">처리할 일 <span class="lg-count">3/);
 assert.ok(t.d.els['lg-list'].innerHTML.includes('요청 a')&&!t.d.els['lg-list'].innerHTML.includes('요청 d'));
 click(t.d,{kpi:'late'});
 assert.equal(t.page.state.quick,'late');
 assert.ok(t.d.els['lg-list'].innerHTML.includes('요청 d')&&t.d.els['lg-list'].innerHTML.includes('희망일 지남'));
 assert.ok(t.d.els['lg-list'].innerHTML.includes('data-act="clear-quick"'));
 click(t.d,{tab:'canceled'});
 assert.equal(t.page.state.quick,'');assert.ok(t.d.els['lg-list'].innerHTML.includes('요청 g'));
 t.d.els.content.oninput({target:{id:'lg-search',value:'없는 말'}});
 assert.ok(t.d.els['lg-list'].innerHTML.includes('검색 결과가 없어요'));
 t.page.hide();
 assert.equal(t.d.els.content.onclick,null);assert.equal(t.page.state.active,false);
});

test('mountTab: 불러오기 실패는 로그인 오류가 아니라 목록 자리에 데이터 오류로 보여 준다',async()=>{
 const t=setup({handler:q=>q.table==='logistics_requests'?{data:null,error:{message:'boom'}}:null});
 await t.page.show();
 assert.match(t.d.els['lg-list'].innerHTML,/물류 요청을 불러오지 못했어요\. boom/);
 assert.ok(t.d.els['lg-list'].innerHTML.includes('data-act="refresh"'));
 assert.ok(!/로그인/.test(t.d.els['lg-list'].innerHTML));
});

test('mountTab: 주소의 logistics 값을 읽어 지우고, 불러오기가 끝나면 그 요청 상세를 연다',async()=>{
 const replaced=[];
 const t=setup({rows:[R('r1',{title_text:'슬랙 링크 요청'})],location:{search:'?logistics=r1&x=1',pathname:'/entropysales-dashboard/index.html',hash:''},history:{state:null,replaceState:(...a)=>replaced.push(a)}});
 assert.equal(t.page.takeUrlRequest(),'r1');
 assert.deepEqual(replaced,[[null,'','/entropysales-dashboard/index.html?x=1']]);
 const ready=t.page.show();await t.page.openRequest('r1');await ready;
 assert.equal(t.d.els['lg-detail'].open,true);
 assert.ok(t.d.els['lg-detail'].innerHTML.includes('슬랙 링크 요청'));
 assert.ok(t.d.els['lg-detail'].innerHTML.includes('data-to="accepted"'));
 assert.equal(setup({location:{search:'?logistics=1',pathname:'/i',hash:''},history:{replaceState(){}}}).page.takeUrlRequest(),'');
 assert.equal(setup({location:{search:'',pathname:'/i',hash:''},history:{replaceState(){throw new Error('no');}}}).page.takeUrlRequest(),null);
 const miss=setup({rows:[]});await miss.page.show();await miss.page.openRequest('nope');
 assert.match(miss.messages.at(-1),/요청을 찾지 못했어요/);assert.equal(miss.d.els['lg-detail'].open,false);
});

test('mountTab: 상태 변경은 이전 상태 조건으로 한 번만 보내고, STALE이면 창 안에 문구를 보여 준다',async()=>{
 const t=setup({rows:[R('r1')],onUpdate:()=>({data:[],error:null})});
 await t.page.show();await t.page.openDetail('r1');
 await Promise.all([t.page.changeStatus('accepted'),t.page.changeStatus('accepted')]);
 assert.equal(t.updates.length,1);
 assert.deepEqual(t.updates[0].ops.filter(o=>o[0]==='eq'),[['eq','id','r1'],['eq','status_code','requested']]);
 assert.match(t.d.els['lg-detail'].innerHTML,/다른 사람이 먼저 바꿨어요/);
});

test('mountTab: 저장하는 동안 상세 창의 버튼을 막고 끝나면 푼다',async()=>{
 let release;const btn={disabled:false};
 const t=setup({rows:[R('r1')],onUpdate:()=>new Promise(r=>{release=()=>r({data:[{id:'r1'}],error:null});})});
 await t.page.show();await t.page.openDetail('r1');
 t.d.els['lg-detail'].buttons=[btn];
 const p=t.page.changeStatus('accepted');
 await new Promise(r=>setImmediate(r));
 assert.equal(btn.disabled,true);assert.equal(t.page.state.busy,true);
 click(t.d,{to:'preparing'});
 release();await p;
 assert.equal(t.updates.length,1);
 assert.equal(btn.disabled,false);
 assert.match(t.messages.join('|'),/접수\(으\)로 바꿨어요/);
});

test('mountTab: 출고완료는 창 안의 결과·출고일 칸으로 받고, 비어 있으면 저장하지 않는다',async()=>{
 const t=setup({rows:[R('r1',{status_code:'preparing'})]});
 await t.page.show();await t.page.openDetail('r1');
 click(t.d,{to:'shipped'});
 assert.equal(t.updates.length,0);
 assert.deepEqual(t.page.state.pending,{kind:'status',to:'shipped'});
 assert.ok(t.d.els['lg-detail'].innerHTML.includes('name="shipped_on" value="2026-11-20"'));
 await submit(t.d,{result_text:'  ',shipped_on:'2026-11-20'},'status');
 assert.equal(t.updates.length,0);assert.match(t.d.els['lg-detail'].innerHTML,/결과\(송장·배차·BL\)를 적어 주세요/);
 await submit(t.d,{result_text:'CJ 123',shipped_on:'2026-13-01'},'status');
 assert.equal(t.updates.length,0);assert.match(t.d.els['lg-detail'].innerHTML,/출고일을 골라 주세요/);
 await submit(t.d,{result_text:' CJ 123 ',shipped_on:'2026-11-20'},'status');
 assert.equal(t.updates.length,1);
 assert.deepEqual(t.updates[0].ops[0][1],{status_code:'shipped',result_text:'CJ 123',shipped_on:'2026-11-20'});
 assert.equal(t.page.state.pending,null);
 click(t.d,{act:'pending-cancel'});
});

test('mountTab: 보류는 사유가 있어야 저장하고, 취소는 사유 없이도 저장한다',async()=>{
 const t=setup({rows:[R('r1',{status_code:'accepted'}),R('r2',{requester_email:'req@entropymakeup.com'})]});
 await t.page.show();await t.page.openDetail('r1');
 click(t.d,{to:'on_hold'});
 await submit(t.d,{status_note_text:''},'status');
 assert.equal(t.updates.length,0);assert.match(t.d.els['lg-detail'].innerHTML,/보류나 되돌리기에는 사유가 필요해요/);
 await submit(t.d,{status_note_text:'거래처 확인 대기'},'status');
 assert.deepEqual(t.updates[0].ops[0][1],{status_code:'on_hold',status_note_text:'거래처 확인 대기'});
 const o=setup({rows:[R('r2')],email:'req@entropymakeup.com'});
 await o.page.show();await o.page.openDetail('r2');
 click(o.d,{to:'canceled'});
 await submit(o.d,{status_note_text:''},'status');
 assert.deepEqual(o.updates[0].ops[0][1],{status_code:'canceled',status_note_text:''});
});

test('mountTab: 결과 수정은 창 안에서 퀵비 숫자와 해외 ETD를 검사해 저장한다',async()=>{
 const t=setup({rows:[R('r1',{type_code:'b2b',ship_mode_code:'air',status_code:'preparing'})]});
 await t.page.show();await t.page.openDetail('r1');
 click(t.d,{act:'edit-result'});
 assert.ok(t.d.els['lg-detail'].innerHTML.includes('data-form="result"'));
 await submit(t.d,{result_text:'BL 1',quick_fee_krw:'만원',etd_on:'',packing_code:''},'result');
 assert.equal(t.updates.length,0);assert.match(t.d.els['lg-detail'].innerHTML,/퀵비는 숫자로/);
 await submit(t.d,{result_text:'BL 1',quick_fee_krw:'12,000',etd_on:'2026-12-01',packing_code:'done'},'result');
 assert.deepEqual(t.updates[0].ops[0][1],{result_text:'BL 1',quick_fee_krw:12000,etd_on:'2026-12-01',packing_code:'done'});
});

test('mountTab: 요약 수정은 담당자면 해외 칸까지, 요청자면 해외 칸 없이 이전 상태 조건으로 저장한다',async()=>{
 const vals={type_code:'b2b',title_text:'새 제목',team_code:'global',counterparty_text:'c',want_date:'',ship_mode_code:'air',qty_summary_text:'',note_text:'',invoice_id:'',packing_code:'done',etd_on:'2026-12-01',forwarder_text:'DHL'};
 const t=setup({rows:[R('r1',{type_code:'b2b',ship_mode_code:'air',status_code:'accepted',title_text:'옛 제목'})]});
 await t.page.show();await t.page.openDetail('r1');
 click(t.d,{act:'edit-summary'});
 assert.equal(t.d.els['lg-form'].open,true);
 assert.ok(t.d.els['lg-form'].innerHTML.includes('value="옛 제목"')&&t.d.els['lg-form'].innerHTML.includes('수정 저장'));
 await submit(t.d,vals,'edit');
 assert.deepEqual(t.updates[0].ops.filter(o=>o[0]==='eq'),[['eq','id','r1'],['eq','status_code','accepted']]);
 const patch=t.updates[0].ops[0][1];
 assert.equal(patch.title_text,'새 제목');assert.equal(patch.packing_code,'done');assert.equal(patch.forwarder_text,'DHL');assert.equal(patch.status_code,undefined);
 assert.equal(t.d.els['lg-form'].open,false);
 assert.match(t.messages.join('|'),/요약을 저장했어요/);
 const o=setup({rows:[R('r1',{type_code:'b2b',ship_mode_code:'air'})],email:'req@entropymakeup.com'});
 await o.page.show();await o.page.openDetail('r1');
 click(o.d,{act:'edit-summary'});
 assert.ok(!o.d.els['lg-form'].innerHTML.includes('name="packing_code"'));
 await submit(o.d,vals,'edit');
 const op=o.updates[0].ops[0][1];
 assert.equal(op.title_text,'새 제목');
 for(const k of ['packing_code','etd_on','forwarder_text'])assert.ok(!(k in op),k);
});

test('mountTab: 요약 수정 폼을 연 뒤 다른 요청을 골라도 폼을 연 요청에 저장한다',async()=>{
 const rows=[R('r1',{type_code:'b2b',ship_mode_code:'air',status_code:'accepted',title_text:'A'}),R('r2',{type_code:'b2b',ship_mode_code:'air',status_code:'preparing',title_text:'B'})];
 const t=setup({rows});
 await t.page.show();await t.page.openDetail('r1');
 click(t.d,{act:'edit-summary'});
 await t.page.openDetail('r2');
 await submit(t.d,{type_code:'b2b',title_text:'A 수정',team_code:'global',counterparty_text:'c',want_date:'',ship_mode_code:'air',qty_summary_text:'',note_text:'',invoice_id:'',packing_code:'',etd_on:'',forwarder_text:''},'edit');
 assert.equal(t.updates.length,1);
 assert.deepEqual(t.updates[0].ops.filter(o=>o[0]==='eq'),[['eq','id','r1'],['eq','status_code','accepted']]);
});

test('mountTab: 새 요청 뒤 일부 파일만 실패하면 요청은 올라갔다고 하고 실패한 파일 이름을 알려 준다',async()=>{
 let created=false;const rows=[];
 const t=setup({rows,handler:q=>{
  if(q.table==='logistics_requests'&&q.ops[0][0]==='insert'){created=true;rows.push(R('new1',{requester_email:'handler@entropymakeup.com'}));return {data:{id:'new1'},error:null};}
  if(q.table==='storage:logistics-docs'&&q.ops[0][0]==='upload')return q.ops[0][1].includes('bad')?{data:null,error:{message:'storage down'}}:{data:{},error:null};
  if(q.table==='logistics_request_files'&&q.ops[0][0]==='insert')return {data:{id:'f1'},error:null};
  return null;}});
 await t.page.show();
 click(t.d,{act:'new'});
 assert.equal(t.d.els['lg-form'].open,true);
 assert.ok(t.d.els['lg-form'].innerHTML.includes('새 물류 요청'));
 t.d.document.getElementById('lg-f-files').files=[{name:'ok.xlsx',size:10},{name:'bad.xlsx',size:10}];
 await submit(t.d,{type_code:'quick',title_text:'퀵',team_code:'global',counterparty_text:'비주그룹',want_date:'',ship_mode_code:'quick',qty_summary_text:'',note_text:'',invoice_id:''},'create');
 assert.equal(created,true);
 assert.match(t.messages.at(-1),/요청은 올라갔고, bad\.xlsx 파일은 올리지 못했어요/);
 assert.ok(!t.messages.at(-1).includes('ok.xlsx'));
 assert.equal(t.d.els['lg-form-error'].textContent,'');
 assert.equal(t.d.els['lg-form'].open,false);
 assert.equal(t.page.state.tab,'mine');
 assert.equal(t.d.els['lg-detail'].open,true); // 올린 요청의 상세를 연다
 assert.match(t.d.els['lg-detail'].innerHTML,/bad.xlsx 파일은 올리지 못했어요/);
 const bad=setup({rows:[]});await bad.page.show();click(bad.d,{act:'new'});
 await submit(bad.d,{type_code:'',title_text:''},'create');
 assert.match(bad.d.els['lg-form-error'].textContent,/유형을 골라 주세요/);
});

test('mountTab: 첨부·댓글 지우기는 먼저 확인하고, 취소하면 아무것도 보내지 않는다',async()=>{
 let ok=false;const asked=[];
 const files=[{id:'f1',request_id:'r1',kind_code:'etc',name_text:'x.pdf',storage_path:'r1/x.pdf',created_by:'handler@entropymakeup.com'}];
 const t=setup({rows:[R('r1')],files,confirm:m=>{asked.push(m);return ok;},handler:q=>{
  if(q.table==='storage:logistics-docs')return {data:[{name:'x'}],error:null};
  if(q.table==='logistics_request_files'&&q.ops.some(o=>o[0]==='delete'))return {data:[{id:'f1'}],error:null};
  if(q.table==='logistics_request_comments'&&q.ops.some(o=>o[0]==='delete'))return {data:[],error:null};
  return null;}});
 await t.page.show();await t.page.openDetail('r1');
 await click(t.d,{fileDel:'f1'});
 assert.equal(asked.length,1);assert.match(asked[0],/x\.pdf/);
 assert.ok(!t.calls.some(c=>c.table==='storage:logistics-docs'));
 ok=true;
 await click(t.d,{fileDel:'f1'});
 assert.ok(t.calls.some(c=>c.table==='storage:logistics-docs'&&c.ops[0][0]==='remove'));
 assert.match(t.messages.join('|'),/파일을 지웠어요/);
 ok=false;await click(t.d,{commentDel:'c1'});
 assert.ok(!t.calls.some(c=>c.table==='logistics_request_comments'&&c.ops.some(o=>o[0]==='delete')));
 ok=true;await click(t.d,{commentDel:'c1'});
 assert.match(t.d.els['lg-detail'].innerHTML,/다른 사람이 먼저 바꿨어요/); // 0건 삭제 → STALE
});

test('mountTab: 파일 링크는 먼저 빈 창을 열고 서명 주소를 받은 뒤 이동시킨다',async()=>{
 const w={location:{href:''},closed:false,close(){this.closed=true;}};const opened=[];
 const t=setup({rows:[R('r1')],files:[{id:'f1',request_id:'r1',storage_path:'p/x',kind_code:'etc',name_text:'x'}],open:u=>{opened.push(u);return w;}});
 await t.page.show();await t.page.openDetail('r1');
 t.client.storage.from=()=>({createSignedUrl:async()=>({data:{signedUrl:'https://signed/x'},error:null})});
 await click(t.d,{file:'f1'});
 assert.deepEqual(opened,['about:blank']);
 assert.equal(w.location.href,'https://signed/x');assert.equal(w.opener,null);
 t.client.storage.from=()=>({createSignedUrl:async()=>({data:null,error:{message:'nope'}})});
 await click(t.d,{file:'f1'});
 assert.equal(w.closed,true);assert.match(t.d.els['lg-detail'].innerHTML,/nope/);
});

test('mountTab: 파일 올리기는 고른 종류로 올린다',async()=>{
 const t=setup({rows:[R('r1')],handler:q=>q.table==='logistics_request_files'&&q.ops[0][0]==='insert'?{data:{id:'f9'},error:null}:null});
 await t.page.show();await t.page.openDetail('r1');
 t.d.document.getElementById('lg-file-kind').value='packing';
 const input={dataset:{act:'file'},files:[{name:'p.xlsx',size:5}],value:'p.xlsx'};
 await t.d.els.content.onchange({target:input});
 const ins=t.calls.find(c=>c.table==='logistics_request_files'&&c.ops[0][0]==='insert');
 assert.equal(ins.ops[0][1].kind_code,'packing');assert.equal(input.value,'');
});

test('mountTab: 연결 주문이 목록에 없으면 상세를 열 때 따로 불러온다',async()=>{
 const t=setup({rows:[R('r1',{invoice_id:'inv9'})]});
 const eqs=[];
 const orig=t.client.from;t.client.from=tb=>{const c=orig(tb);if(tb==='invoices'){const e=c.eq;c.eq=(...a)=>{eqs.push(a);return e(...a);};}return c;};
 await t.page.show();await t.page.openDetail('r1');
 assert.deepEqual(eqs,[['id','inv9']]);
 const {client:c2}=fakeClient(q=>q.table==='invoices'?{data:[{id:'inv9',no:'ORD-9',customer:'고객'}],error:null}:{data:[],error:null});
 assert.equal((await P.createApi(c2).loadInvoice('inv9')).no,'ORD-9');
});

test('mountTab: 로그아웃하면 화면 연결을 풀고 이전 계정의 데이터를 지운다',async()=>{
 const t=setup({rows:[R('r1')]});
 await t.page.show();await t.page.openDetail('r1');
 t.auth('SIGNED_OUT',null);
 assert.equal(t.page.state.active,false);assert.equal(t.page.state.data.requests.length,0);
 assert.equal(t.d.els['lg-detail'].open,false);assert.equal(t.d.els.content.onclick,null);
});

// ── 대시보드 연결 ──
test('대시보드: 메뉴는 go(\'logistics\') 탭이고, 스크립트·스타일·mountTab을 불러오며, 검사 스크립트가 물류 파일을 포함한다',()=>{
 const fs=require('node:fs'),path=require('node:path');
 const index=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
 assert.ok(index.includes(`<div class="ni" onclick="go('logistics')" id="nav-logistics"><i class="ti ti-truck"></i>물류 요청</div>`));
 assert.ok(!index.includes('href="logistics.html"'));
 assert.ok(index.includes('<link rel="stylesheet" href="logistics.css?v=20261120-fassto-1">'));
 const iModel=index.indexOf('<script src="logistics-model.js?v=20261120-fassto-1"></script>'),iForms=index.indexOf('<script src="fassto-forms.js?v=20261120-fassto-1"></script>'),iPage=index.indexOf('<script src="logistics.js?v=20261120-fassto-1"></script>');
 const iXlsx=index.indexOf('<script src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"></script>');
 const iApp=index.indexOf('<script src="app.js?v='),iMount=index.indexOf('globalThis.logistics=LogisticsPage.mountTab({document,client:sb,onMessage:m=>toast(m)});');
 assert.ok(iXlsx>0&&iXlsx<iModel&&iModel<iForms&&iForms<iPage&&iPage<iApp&&iApp<iMount);
 assert.equal((index.match(/xlsx[^"]*\.js/g)||[]).length,1); // 브라우저 엑셀 라이브러리는 기존 SheetJS 0.18.5 하나뿐
 const app=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
 assert.ok(app.includes("if(page!=='logistics')globalThis.logistics?.hide();"));
 assert.ok(app.includes("if(page==='logistics'){document.getElementById('page-title').textContent='물류 요청';globalThis.logistics?.show();return;}"));
 assert.equal((app.match(/if\(!await loadAll\(\)\)return;\n\s*goStartPage\(\);/g)||[]).length,2);
 const pkg=JSON.parse(fs.readFileSync(path.join(__dirname,'../package.json'),'utf8'));
 assert.match(pkg.scripts.check,/node --check logistics-model\.js && node --check logistics\.js && node --check fassto-forms\.js && node --check tools\/fassto-stock-json\.cjs/);
 assert.equal(pkg.devDependencies.xlsx,'0.18.5');
 assert.ok(fs.existsSync(path.join(__dirname,'../LOGISTICS.md')));
});

test('대시보드: 첫 화면은 주소에 logistics가 있으면 물류 요청 탭과 그 요청을 연다',()=>{
 const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
 const app=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
 const start=app.indexOf('function goStartPage(){'),end=app.indexOf('\n}\n',start)+3;
 const run=id=>{const log=[];const c={go:p=>log.push('go:'+p),globalThis:{logistics:{takeUrlRequest:()=>id,openRequest:x=>log.push('open:'+x)}}};vm.createContext(c);vm.runInContext(app.slice(start,end)+';goStartPage();',c);return log;};
 assert.deepEqual(run(null),['go:dash']);
 assert.deepEqual(run(''),['go:logistics']);
 assert.deepEqual(run('r1'),['go:logistics','open:r1']);
});

test('대시보드: 첫 화면 처리는 두 번 불려도 한 번만 한다 (세션 확인과 로그인 이벤트가 겹칠 때)',()=>{
 const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
 const app=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
 const start=app.indexOf('function goStartPage(){'),end=app.indexOf('\n}\n',start)+3;
 const log=[];let ids=['r1',null];
 const c={go:p=>log.push('go:'+p),globalThis:{logistics:{takeUrlRequest:()=>ids.shift(),openRequest:x=>log.push('open:'+x)}}};
 vm.createContext(c);vm.runInContext(app.slice(start,end)+';goStartPage();goStartPage();',c);
 assert.deepEqual(log,['go:logistics','open:r1']);
 // 로그아웃하면 다음 로그인에서 다시 첫 화면을 정한다
 assert.match(app,/function resetApplicationData\(\)\{[^}]*goStartPage\.done=false/);
});

test('logistics.html은 슬랙 링크의 id를 대시보드 탭 주소로 넘긴다',()=>{
 const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
 const html=fs.readFileSync(path.join(__dirname,'../logistics.html'),'utf8');
 const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
 assert.ok(!/supabase|createClient/.test(html));
 const go=search=>{const to=[];const c={URLSearchParams,encodeURIComponent,location:{search,replace:u=>to.push(u)},document:{addEventListener(){}}};vm.createContext(c);vm.runInContext(script,c);return to;};
 assert.deepEqual(go('?id=11111111-2222-3333-4444-555555555555'),['index.html?logistics=11111111-2222-3333-4444-555555555555']);
 assert.deepEqual(go(''),['index.html?logistics=1']);
 assert.deepEqual(go('?id=a&b'),['index.html?logistics=a']);
 assert.ok(html.includes('href="index.html?logistics=1"'));
});

// ── 리뷰 반영 ──
test('mountTab: 검사·저장이 실패해도 상태·결과 입력 칸과 쓰던 댓글을 지우지 않는다',async()=>{
 const t=setup({rows:[R('r1',{status_code:'preparing'})],onUpdate:()=>({data:null,error:{message:'network down'}})});
 await t.page.show();await t.page.openDetail('r1');
 click(t.d,{to:'shipped'});
 await submit(t.d,{result_text:'CJ 9999',shipped_on:''},'status');
 assert.match(t.d.els['lg-detail'].innerHTML,/출고일을 골라 주세요/);
 assert.ok(t.d.els['lg-detail'].innerHTML.includes('>CJ 9999</textarea>'));
 await submit(t.d,{result_text:'CJ 9999',shipped_on:'2026-11-19'},'status');
 assert.equal(t.updates.length,1);
 assert.match(t.d.els['lg-detail'].innerHTML,/network down/);
 assert.ok(t.d.els['lg-detail'].innerHTML.includes('>CJ 9999</textarea>')&&t.d.els['lg-detail'].innerHTML.includes('name="shipped_on" value="2026-11-19"'));
 click(t.d,{act:'edit-result'});
 await submit(t.d,{result_text:'BL 7',quick_fee_krw:'만원'},'result');
 assert.ok(t.d.els['lg-detail'].innerHTML.includes('>BL 7</textarea>')&&t.d.els['lg-detail'].innerHTML.includes('value="만원"'));
 t.d.els['lg-comment-body'].value='쓰는 중인 댓글';
 await t.page.openDetail('r1',{keep:true}); // 댓글을 다시 불러와 다시 그려도
 assert.ok(t.d.els['lg-detail'].innerHTML.includes('value="쓰는 중인 댓글"'));
});

test('mountTab: 저장하는 동안 Esc로 상세·입력 창이 닫히지 않고, 새 요청 첨부는 미리 읽어 둔다',async()=>{
 let release;const rows=[R('r1')];
 const t=setup({rows,onUpdate:()=>new Promise(r=>{release=()=>r({data:[{id:'r1'}],error:null});})});
 await t.page.show();await t.page.openDetail('r1');
 const p=t.page.changeStatus('accepted');await new Promise(r=>setImmediate(r));
 t.d.els['lg-detail'].oncancel({preventDefault(){}});
 click(t.d,{act:'close-detail'});
 assert.equal(t.d.els['lg-detail'].open,true);assert.equal(t.page.state.selected,'r1');
 release();await p;
 t.d.els['lg-detail'].oncancel({preventDefault(){}});
 assert.equal(t.d.els['lg-detail'].open,false); // 저장이 끝나면 Esc로 닫힌다
 let finishCreate;const uploaded=[];
 const c=setup({rows:[],handler:q=>{
  if(q.table==='logistics_requests'&&q.ops[0][0]==='insert')return new Promise(r=>{finishCreate=()=>r({data:{id:'n1'},error:null});});
  if(q.table==='storage:logistics-docs'&&q.ops[0][0]==='upload'){uploaded.push(q.ops[0][1]);return {data:{},error:null};}
  if(q.table==='logistics_request_files'&&q.ops[0][0]==='insert')return {data:{id:'f1'},error:null};
  return null;}});
 await c.page.show();click(c.d,{act:'new'});
 c.d.document.getElementById('lg-f-files').files=[{name:'a.xlsx',size:3}];
 const s=submit(c.d,{type_code:'quick',title_text:'퀵',team_code:'global',counterparty_text:'x',want_date:'',ship_mode_code:'quick'},'create');
 await new Promise(r=>setImmediate(r));
 c.d.els['lg-form'].oncancel({preventDefault(){}});
 assert.equal(c.d.els['lg-form'].open,true);
 c.d.els['lg-f-files'].files=[]; // 기다리는 동안 입력이 바뀌어도
 finishCreate();await s;
 assert.equal(uploaded.length,1);assert.match(uploaded[0],/a\.xlsx$/);
});

test('mountTab: 숨기면 상단 물류 버튼을 지우고, 숨긴 뒤 누른 새 요청은 폼 상태를 남기지 않는다',async()=>{
 const t=setup({rows:[R('r1')]});
 await t.page.show();
 const newBtn=t.d.els['lg-new'].onclick;
 t.page.hide();
 assert.equal(t.d.els['topbar-actions'].innerHTML,'');
 newBtn();assert.equal(t.page.state.form,null);
 t.d.els['topbar-actions'].innerHTML='<button id="other">다른 화면</button>';
 t.page.hide(); // 이미 숨김: 다른 화면 버튼은 건드리지 않는다
 assert.ok(t.d.els['topbar-actions'].innerHTML.includes('other'));
 await t.page.show();await t.page.openDetail('r1');
 t.d.els['lg-detail'].oncancel({preventDefault(){}});
 assert.equal(t.d.els['lg-detail'].open,false); // 돌아와서도 Esc로 상세가 닫힌다
});

test('mountTab: 연결 주문을 못 불러와도 요약 수정이 invoice_id를 지우지 않는다',async()=>{
 const t=setup({rows:[R('r1',{status_code:'accepted',invoice_id:'inv-old'})],handler:q=>q.table==='invoices'&&q.ops.some(o=>o[0]==='eq')?{data:null,error:{message:'timeout'}}:null});
 await t.page.show();await t.page.openDetail('r1');
 click(t.d,{act:'edit-summary'});
 assert.ok(t.d.els['lg-form'].innerHTML.includes('<option value="inv-old" selected>현재 연결 주문(목록에 없음)</option>'));
 await submit(t.d,{type_code:'quick',title_text:'제목만 수정',team_code:'global',counterparty_text:'c',want_date:'',ship_mode_code:'quick',qty_summary_text:'',note_text:'',invoice_id:'inv-old'},'edit');
 assert.equal(t.updates[0].ops[0][1].invoice_id,'inv-old');
 assert.ok(!P.renderForm({invoice_id:'i1'},{invoices:[{id:'i1',no:'N1'}],mode:'edit'}).includes('목록에 없음'));
});

test('mountTab: STALE이면 최신 행을 다시 불러와 창을 새로 그리고, 문구를 남긴 채 다시 시도할 수 있다',async()=>{
 const rows=[R('r1')];let n=0;
 const t=setup({rows,onUpdate:()=>{n++;if(n===1){rows[0]={...rows[0],status_code:'accepted'};return {data:[],error:null};}return {data:[{id:'r1'}],error:null};}});
 await t.page.show();await t.page.openDetail('r1');
 await t.page.changeStatus('accepted');
 const html=t.d.els['lg-detail'].innerHTML;
 assert.match(html,/다른 사람이 먼저 바꿨어요\. 최신 내용을 다시 불러왔으니/);
 assert.ok(html.includes('st-accepted')&&html.includes('data-to="preparing"')&&!html.includes('data-to="accepted"'));
 assert.equal(t.d.els['lg-detail'].open,true);
 await t.page.changeStatus('preparing');
 assert.deepEqual(t.updates[1].ops.filter(o=>o[0]==='eq'),[['eq','id','r1'],['eq','status_code','accepted']]);
 // 요약 수정 STALE: 폼은 열린 채 문구를 보여 주고, 다시 저장하면 최신 상태 조건으로 보낸다
 const rows2=[R('r2',{status_code:'accepted'})];let m=0;
 const e=setup({rows:rows2,onUpdate:()=>{m++;if(m===1){rows2[0]={...rows2[0],status_code:'preparing'};return {data:[],error:null};}return {data:[{id:'r2'}],error:null};}});
 await e.page.show();await e.page.openDetail('r2');click(e.d,{act:'edit-summary'});
 const vals={type_code:'quick',title_text:'t',team_code:'global',counterparty_text:'c',want_date:'',ship_mode_code:'quick',qty_summary_text:'',note_text:'',invoice_id:''};
 await submit(e.d,vals,'edit');
 assert.match(e.d.els['lg-form-error'].textContent,/다른 사람이 먼저 바꿨어요/);assert.equal(e.d.els['lg-form'].open,true);
 await submit(e.d,vals,'edit');
 assert.deepEqual(e.updates[1].ops.filter(o=>o[0]==='eq'),[['eq','id','r2'],['eq','status_code','preparing']]);
});

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

test('요청자 저장 행에는 담당자 전용 칸이 들어가지 않는다(DB 트리거 LOGISTICS_HANDLER_ONLY 방지)',async()=>{
 const F=require('../fassto-forms.js');
 const vals={name_text:'A',courier_text:'FEDEX',incoterms_code:'DAP',sender_name_text:'X'};
 const {client,calls}=fakeClient(q=>q.ops[0][0]==='upsert'?{data:[{request_id:'r1'}],error:null}:{data:[],error:null});
 await P.createApi(client).saveRecipient('r1',F.toRecipientRow(vals,{isHandler:false}));
 const sent=calls.find(c=>c.ops[0][0]==='upsert').ops[0][1];
 for(const k of F.HANDLER_KEYS)assert.equal(k in sent,false,k);
 assert.equal(sent.name_text,'A');
});

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

test('mountTab: 받는 곳·품목을 부르는 동안에는 "입력 안 됨"·"품목이 없어요"를 보이지 않는다',async()=>{
 let release;const gate=new Promise(r=>{release=r;});
 const t=setup({rows:[R('r1',{ship_mode_code:'parcel',requester_email:'req@entropymakeup.com'})],email:'handler@entropymakeup.com',
  handler:q=>{const s=stockHandler(q);if(s)return s;
   if(q.table==='logistics_request_recipients')return gate.then(()=>({data:[],error:null}));
   if(q.table==='logistics_request_items')return gate.then(()=>({data:[],error:null}));
   return null;}});
 await t.page.show();
 const p=t.page.openDetail('r1');
 await new Promise(r=>setImmediate(r));
 const html=t.d.els['lg-detail'].innerHTML;
 assert.ok(html.includes('불러오는 중'));
 assert.ok(!html.includes('입력 안 됨')&&!html.includes('품목이 없어요')&&!html.includes('data-act="fassto-download"'));
 release();await p;
 assert.ok(t.d.els['lg-detail'].innerHTML.includes('입력 안 됨')&&t.d.els['lg-detail'].innerHTML.includes('품목이 없어요'));
 assert.ok(P.renderFasstoSection(R('r1',{ship_mode_code:'parcel'}),{isHandler:true,fassto:{loaded:false,loading:false,items:[],error:''}}).includes('불러오는 중'));
});

test('파스토 목록이 비었거나 못 불러왔으면 품목마다 "목록에 없는 상품"이라고 하지 않는다',()=>{
 assert.ok(!P.renderItems([{product_code:'ZZ',qty:1}],{form:'parcel',groups:[]}).includes('파스토 목록에 없는 상품이에요.'));
 const sec=P.renderFasstoSection(R('r1',{ship_mode_code:'parcel'}),{isHandler:true,groups:[],fassto:{loaded:true,items:[{product_code:'ZZ',product_name_text:'x',qty:1}],recipient:null}});
 assert.ok(!sec.includes('파스토 목록에 없는 상품이에요.'));
});

test('mountTab: 엑셀 도구(XLSX)가 없으면 던지지 않고 한국어로 알리며, 상품 찾기에서 Enter는 요청을 올리지 않는다',async()=>{
 const saved=[];
 const t=setup({rows:[R('r1',{ship_mode_code:'parcel',fassto_order_no:'LG20261120_001'})],
  handler:q=>{const s=stockHandler(q);if(s)return s;
   if(q.table==='logistics_request_recipients')return {data:[{request_id:'r1',name_text:'홍길동',phone_text:'010-0000-0000',address1_text:'가짜시 가짜로 1'}],error:null};
   if(q.table==='logistics_request_items')return {data:[{product_code:'0012345',product_name_text:'가짜 립',qty:2,lot_text:'',expires_on:null,line_no:1}],error:null};
   return null;}});
 await t.page.show();await t.page.openDetail('r1');
 assert.doesNotThrow(()=>click(t.d,{act:'fassto-download'}));
 assert.equal(saved.length,0);
 assert.match(t.d.els['lg-detail'].innerHTML,/엑셀 도구를 불러오지 못했어요/);
 let prevented=0,stopped=0;
 t.d.els['lg-form'].onkeydown({key:'Enter',target:{id:'lg-item-q'},preventDefault(){prevented++;},stopPropagation(){stopped++;}});
 t.d.els['lg-form'].onkeydown({key:'Enter',target:{id:'lg-f-title_text'},preventDefault(){prevented++;},stopPropagation(){stopped++;}});
 assert.deepEqual([prevented,stopped],[1,2]);
});

test('mountTab: 요약 수정을 저장하면 지난 파스토 내려받기 오류 목록은 지워진다',async()=>{
 let recipient={request_id:'r1',name_text:'홍길동',phone_text:'',address1_text:'가짜시 가짜로 1'};
 const t=setup({rows:[R('r1',{ship_mode_code:'parcel',requester_email:'req@entropymakeup.com'})],email:'req@entropymakeup.com',xlsx:require('xlsx'),saveWorkbook:()=>{},
  handler:q=>{const s=stockHandler(q);if(s)return s;
   if(q.table==='logistics_request_recipients'&&q.ops[0][0]==='upsert'){recipient={...recipient,...q.ops[0][1]};return {data:[{request_id:'r1'}],error:null};}
   if(q.table==='logistics_request_recipients')return {data:[recipient],error:null};
   if(q.table==='logistics_request_items')return {data:[{product_code:'0012345',product_name_text:'가짜 립',qty:2,lot_text:'',expires_on:null,line_no:1}],error:null};
   return null;}});
 await t.page.show();await t.page.openDetail('r1');
 click(t.d,{act:'fassto-download'});
 assert.match(t.d.els['lg-detail'].innerHTML,/전화 칸이 비어 있어요/);
 click(t.d,{act:'edit-summary'});
 await submit(t.d,{type_code:'quick',title_text:'요청 r1',team_code:'global',counterparty_text:'c',want_date:'',ship_mode_code:'parcel',qty_summary_text:'',note_text:'',invoice_id:'',
  r_name_text:'홍길동',r_phone_text:'010-0000-0000',r_address1_text:'가짜시 가짜로 1',item_qty_0:'2'},'edit');
 assert.match(t.d.els['lg-detail'].innerHTML,/요약을 저장했어요/);
 assert.ok(!t.d.els['lg-detail'].innerHTML.includes('전화 칸이 비어 있어요')&&!t.d.els['lg-detail'].innerHTML.includes('내려받지 않았어요'));
});
