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

test('mount: 세션이 있는데 불러오기가 실패하면 앱 화면을 유지하고 오류를 보여 준다',async()=>{
 const d=fakeDom();
 const {client}=fakeClient(q=>q.table==='logistics_requests'?{data:null,error:{message:'boom'}}:{data:[],error:null});
 client.auth={getSession:async()=>({data:{session:{user:{email:'a@entropymakeup.com'}}},error:null}),onAuthStateChange:()=>{},signInWithOAuth:async()=>({error:null})};
 await P.mount({document:d.document,client,location:{href:'x',search:''},now:()=>NOW}).ready;
 assert.equal(d.els['lg-app'].hidden,false);
 assert.equal(d.els['lg-login'].hidden,true);
 assert.match(d.els['lg-message'].textContent,/boom/);
});
