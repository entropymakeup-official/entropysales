const {test}=require('node:test');const assert=require('node:assert/strict');
const M=require('../support-model.js');
global.SupportModel=M;
const P=require('../support.js');
const S=require('../logistics-standalone.js');
const NOW=Date.UTC(2026,10,27,1);

function fakeClient(handler){
 const calls=[];
 const builder=(table)=>{const q={table,ops:[]};const chain={};
  for(const m of ['select','insert','update','upsert','delete','eq','order','limit','range','in','gte'])chain[m]=(...a)=>{q.ops.push([m,...a]);return chain;};
  chain.single=()=>{q.ops.push(['single']);return chain;};
  chain.then=(res,rej)=>{calls.push(q);return Promise.resolve(handler(q)).then(res,rej);};
  return chain;};
 const storage={from:bucket=>({
  upload:async(p)=>{calls.push({table:'storage:'+bucket,ops:[['upload',p]]});return handler({table:'storage:'+bucket,ops:[['upload',p]]});},
  remove:async ps=>{calls.push({table:'storage:'+bucket,ops:[['remove',ps]]});return handler({table:'storage:'+bucket,ops:[['remove',ps]]});},
  createSignedUrl:async(p,s)=>handler({table:'storage:'+bucket,ops:[['sign',p,s]]})})};
 return {client:{from:builder,storage},calls};
}
const draft={type_code:'tax_invoice',title_text:'데모 11월 계산서',counterparty_text:'데모거래처',due_date:'2026-11-30',amount_text:' 1,000,000원 ',issue_date:'',note_text:''};
const base={id:'r1',type_code:'tax_invoice',title_text:'데모 <계산서>',counterparty_text:'데모거래처',requester_email:'req@entropymakeup.com',status_code:'in_progress',due_date:'2026-11-26',created_at:'2026-11-25T00:00:00Z'};

test('모델: 전환·완료 조건·요청자 파일 종류·입력 검증',()=>{
 assert.deepEqual(M.allowedNext({isHandler:true,from:'requested'}),['in_progress','done','on_hold','canceled']);
 assert.deepEqual(M.allowedNext({isHandler:false,isOwner:true,from:'requested'}),['canceled']);
 assert.deepEqual(M.allowedNext({isHandler:false,isOwner:true,from:'in_progress'}),[]);
 assert.deepEqual(M.allowedNext({isHandler:true,from:'done'}),['in_progress']);
 assert.equal(M.checkTransition({isHandler:true,from:'in_progress',to:'done',resultFiles:0}).ok,false);
 assert.equal(M.checkTransition({isHandler:true,from:'in_progress',to:'done',resultFiles:1}).ok,true);
 assert.equal(M.checkTransition({isHandler:true,from:'done',to:'in_progress',fields:{}}).reason,M.errorMessage('SUPPORT_NOTE_REQUIRED'));
 assert.deepEqual(Object.keys(M.fileKindsFor(false)),['request','etc']);
 assert.deepEqual(Object.keys(M.fileKindsFor(true)),['request','result','etc']);
 assert.deepEqual(M.validateDraft(draft),[]);
 assert.equal(M.validateDraft({...draft,type_code:'',title_text:''}).length,2);
 assert.equal(M.toInsertRow(draft).amount_text,'1,000,000원');
 assert.equal(M.toInsertRow(draft).issue_date,null);
 assert.equal(M.isLate(base,NOW),true);
 const list=[base,{...base,id:'r2',status_code:'done',done_at:'2026-11-20T00:00:00Z'},{...base,id:'r3',status_code:'on_hold',requester_email:'x@entropymakeup.com'}];
 assert.deepEqual(M.filterTab(list,'todo',{nowMs:NOW}).map(r=>r.id),['r1']);
 assert.deepEqual(M.filterTab(list,'done',{nowMs:NOW}).map(r=>r.id),['r2']);
 assert.deepEqual(M.filterTab(list,'mine',{email:'REQ@entropymakeup.com',nowMs:NOW}).map(r=>r.id),['r1','r2']);
 assert.equal(M.errorMessage(new Error('new row violates row-level security policy')),M.errorMessage('SUPPORT_FORBIDDEN'));
});

test('데이터 계층: 등록 검증, 이전 상태 조건 수정, 첨부 경로·롤백, 지울 때는 행 먼저',async()=>{
 const {client,calls}=fakeClient(q=>q.table==='support_requests'?{data:{id:'r1'},error:null}:{data:null,error:null});
 const api=P.createApi(client,{uuid:()=>'u1'});
 await assert.rejects(()=>api.create({...draft,title_text:''}),/제목을/);
 assert.equal(calls.length,0);
 assert.equal((await api.create(draft)).id,'r1');
 const stale=fakeClient(()=>({data:[],error:null}));
 await assert.rejects(()=>P.createApi(stale.client).update('r1','requested',{status_code:'in_progress'}),/STALE/);
 assert.deepEqual(stale.calls[0].ops.filter(o=>o[0]==='eq'),[['eq','id','r1'],['eq','status_code','requested']]);

 const up=fakeClient(q=>q.table==='support_request_files'?{data:null,error:{message:'SUPPORT_HANDLER_ONLY'}}:{data:[{name:'x'}],error:null});
 await assert.rejects(()=>P.createApi(up.client,{uuid:()=>'u1'}).uploadFile('r1',{name:'발급본 11월.pdf',size:10},'result'),/SUPPORT_HANDLER_ONLY/);
 assert.deepEqual(up.calls.map(c=>[c.table,c.ops[0][0]]),[['storage:support-docs','upload'],['support_request_files','insert'],['storage:support-docs','remove']]);
 assert.match(up.calls[0].ops[0][1],/^r1\/u1-[A-Za-z0-9._-]+\.pdf$/);
 await assert.rejects(()=>P.createApi(up.client).uploadFile('r1',{name:'big',size:30*1024*1024},'request'),/20MB/);

 const del=fakeClient(q=>q.table==='support_request_files'?{data:null,error:{message:'SUPPORT_RESULT_FILE_REQUIRED'}}:{data:[{name:'x'}],error:null});
 await assert.rejects(()=>P.createApi(del.client).removeFile({id:'f1',storage_path:'r1/u1-a.pdf'}),/SUPPORT_RESULT_FILE_REQUIRED/);
 assert.equal(del.calls.some(c=>c.table.startsWith('storage:')),false); // 행을 못 지웠으면 파일은 그대로
});

test('상세: 첨부는 요청자·담당자만 보이고, 발급본이 없으면 완료 안내, 값은 이스케이프',()=>{
 const files=[{id:'f1',request_id:'r1',kind_code:'request',name_text:'발주서.pdf',size_bytes:2048,created_by:'req@entropymakeup.com'}];
 const common={nowMs:NOW,files,people:[],handlers:[{email:'h@entropymakeup.com',display_name:'가짜 경영지원'}],invoices:[]};
 const other=P.renderDetail(base,{...common,email:'other@entropymakeup.com',isHandler:false});
 assert.match(other,/요청자와 경영지원 담당자만 볼 수 있어요/);
 assert.doesNotMatch(other,/발주서\.pdf/);
 assert.doesNotMatch(other,/data-to=/);
 assert.match(other,/데모 &lt;계산서&gt;/);
 const handler=P.renderDetail(base,{...common,email:'h@entropymakeup.com',isHandler:true});
 assert.match(handler,/발주서\.pdf/);
 assert.match(handler,/"발급본"으로 골라/);
 assert.match(handler,/<option value="result" selected>발급본<\/option>/);
 const owner=P.renderDetail({...base,status_code:'requested'},{...common,email:'req@entropymakeup.com',isHandler:false});
 assert.match(owner,/발주서\.pdf/);
 assert.doesNotMatch(owner,/value="result"/);
 assert.match(owner,/data-to="canceled"/);
 const done=P.renderDetail({...base,status_code:'done'},{...common,files:[...files,{id:'f2',request_id:'r1',kind_code:'result',name_text:'세금계산서.pdf',size_bytes:1,created_by:'h@entropymakeup.com'}],email:'req@entropymakeup.com',isHandler:false});
 assert.match(done,/발급본 · 세금계산서\.pdf/);
 assert.doesNotMatch(done,/파일 올리기/);
});

test('목록·입력 창: 기한 지남 표시, 발급본 수, 새 요청 창 칸',()=>{
 const list=P.renderList([base],{nowMs:NOW,files:[{request_id:'r1',kind_code:'result'}],people:[],handlers:[],tab:'todo'});
 assert.match(list,/class="lg-row late"/);
 assert.match(list,/발급본 1개/);
 assert.match(P.renderList([],{tab:'todo'}),/처리할 요청이 없어요/);
 const form=P.renderForm({},{mode:'create',invoices:[{id:'i1',no:'RE_1',customer:'데모'}]});
 for(const n of ['type_code','due_date','title_text','counterparty_text','amount_text','issue_date','note_text','invoice_id','sp-f-files'])assert.match(form,new RegExp(n));
 assert.doesNotMatch(P.renderForm({},{mode:'edit'}),/sp-f-files/);
});

test('단독 페이지: title을 주면 그 제목으로 연다',async()=>{
 const els={};const el=id=>els[id]||(els[id]={id,hidden:false,textContent:'',onclick:null});
 const document={getElementById:el};
 let shown=0;
 const client={auth:{getSession:async()=>({data:{session:{user:{email:'req@entropymakeup.com'}}}}),onAuthStateChange(){},signOut:async()=>{}}};
 await S.boot({document,client,mountTab:()=>({show:async()=>{shown++;},openRequest:async()=>{}}),location:{search:'',pathname:'/support.html',hash:'',href:''},history:{replaceState(){}},title:'경영지원'});
 assert.equal(el('page-title').textContent,'경영지원');
 assert.equal(shown,1);
});
