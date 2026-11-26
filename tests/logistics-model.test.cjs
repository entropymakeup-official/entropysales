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
 const ok={type_code:'b2b',title_text:'데모거래처 Air',team_code:'global',counterparty_text:'데모거래처',want_date:'2026-11-24',ship_mode_code:'air',qty_summary_text:'',note_text:''};
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

test('파스토 오류 코드도 한국어 문구로 바꾼다',()=>{
 assert.equal(M.errorMessage({message:'LOGISTICS_HANDLER_ONLY'}),'운송사·Incoterms·발송인은 물류 담당자만 정할 수 있어요.');
 assert.equal(M.errorMessage({message:'LOGISTICS_ITEM_LIMIT'}),'품목은 요청당 50줄까지예요.');
 assert.equal(M.errorMessage(new Error('LOGISTICS_ITEM_BAD')),'품목을 확인해 주세요. 상품코드는 문자, 수량은 1 이상이어야 해요.');
});

test('DB가 돌려준 입력값 오류(정수·날짜·check)는 읽기 쉬운 문구로 바꾼다',()=>{
 const want='입력값을 확인해 주세요. 숫자·날짜 형식이나 허용 범위가 맞지 않아요.';
 assert.equal(M.errorMessage({message:'invalid input syntax for type integer: "abc"'}),want);
 assert.equal(M.errorMessage({message:'date/time field value out of range: "2026-13-40"'}),want);
 assert.equal(M.errorMessage({message:'new row for relation "logistics_request_items" violates check constraint "x"'}),want);
 assert.equal(M.errorMessage({message:'boom'}),'저장하지 못했어요: boom');
});
