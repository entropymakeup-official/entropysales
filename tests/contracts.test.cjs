const {test}=require('node:test');
const assert=require('node:assert/strict');
let C;try{C=require('../contracts.js');}catch(e){if(e.code!=='MODULE_NOT_FOUND')throw e;C={};}
const customer='10000000-0000-0000-0000-000000000001';
test('commercial clause review preserves evidence and distinguishes partial and missing clauses',()=>{
 const topics=['kol_support','vmd_support','logistics','certification','document_handover','sns_handover'];
 const raw={customer_id:customer,name:'검토 계약'};
 for(const topic of topics){raw[topic+'_status']='일부명시';raw[topic+'_terms']='제7조: 범위 일부만 확인 <원문>';}
 const value=C.normalize(raw);
 for(const topic of topics){assert.equal(value[topic+'_status'],'일부명시');assert.equal(value[topic+'_terms'],raw[topic+'_terms']);}
 assert.throws(()=>C.normalize({...raw,kol_support_status:'없음'}));
 assert.throws(()=>C.normalize({...raw,sns_handover_status:'명시',sns_handover_terms:''}));
 assert.equal(C.normalize({customer_id:customer,name:'기존 계약'}).kol_support_status,'미확인');
 const html=C.renderList({rows:[{...value,id:'review'}],today:'2026-09-17'});
 for(const title of ['마케팅 지원','물류 · 선적','수출 인증','계약 종료 · 이관'])assert.ok(html.includes(title));
 assert.match(html,/&lt;원문&gt;/);assert.match(html,/일부명시/);
});
test('customer header flags blanks across contracts without opening rows and excludes inapplicable fields',()=>{
 const complete=Object.fromEntries(C.fields.map(([key])=>[key,'값']));
 Object.assign(complete,{id:'complete',customer_id:customer,name:'완료계약',status:'초안',foc_status:'없음',foc_terms:'',foc_products:null,foc_limit:'',auto_renewal:'없음',notice_date:null,renewal_terms:'',exclusive:'없음',exclusivity_terms:''});
 const render=rows=>C.renderList({rows,customers:[{id:customer,name:'거래처 A'}],today:'2026-09-17',filter:{q:'완료계약'}});
 assert.doesNotMatch(render([complete]),/data-contract-customer-missing/);
 const html=render([complete,{...complete,id:'incomplete',name:'다른 계약',currency:'  '}]);
 assert.match(html,/<h3>거래처 A<\/h3><span class="contract-missing" data-contract-customer-missing>입력 필요<\/span>/);
 assert.equal((html.match(/data-contract-customer-missing/g)||[]).length,1);
 assert.doesNotMatch(html,/data-contract-row="complete" open/);
});
test('missing terms remain visible, unresolved terms need review and zero is preserved',()=>{
 const row={id:'missing',customer_id:customer,name:'확인 계약',manager:'  ',foc_status:'미확정',deposit_pct:0};
 const before=JSON.stringify(row);
 const html=C.renderList({rows:[row],today:'2026-09-17'});
 assert.match(html,/<dt>내부 담당자<\/dt><dd><span class="contract-missing">입력 필요<\/span>/);
 assert.match(html,/<dt>FOC 유무<\/dt><dd>미확정 <span class="contract-missing">확인 필요<\/span>/);
 assert.match(html,/<dt>선금 비율 \(%\)<\/dt><dd>0%<\/dd>/);
 assert.match(html,/<dt>계약서 서명본<\/dt><dd><span class="contract-missing">입력 필요<\/span>/);
 assert.equal(JSON.stringify(row),before);
 const no=C.renderList({rows:[{...row,foc_status:'없음',auto_renewal:'없음',exclusive:'없음'}],today:'2026-09-17'});
 assert.match(no,/<dt>대상 제품<\/dt><dd><span class="contract-not-applicable">해당 없음<\/span>/);
 assert.match(no,/<dt>갱신 조건<\/dt><dd><span class="contract-not-applicable">해당 없음<\/span>/);
 assert.match(no,/<dt>독점 유지 조건<\/dt><dd><span class="contract-not-applicable">해당 없음<\/span>/);
});
test('expired effective status agrees in summary and read-only detail',()=>{
 const html=C.renderList({rows:[{id:'old',customer_id:customer,name:'만료계약',status:'유효',end_date:'2026-09-01'}],today:'2026-09-17'});
 assert.match(html,/<dt>계약 상태<\/dt><dd>만료<\/dd>/);
 assert.doesNotMatch(html,/<dt>계약 상태<\/dt><dd>유효<\/dd>/);
});
test('contract browser groups customers, keeps drafts explicit and exposes safe source links',()=>{
 const rows=[{id:'one',customer_id:customer,name:'기존 계약',status:'만료',payment_type:'후불',balance_due:'30일',foc_status:'미확정'},{id:'two',customer_id:customer,name:'갱신 초안',status:'초안',special_terms:'원문 https://drive.google.com/file/d/example/view javascript:alert(1)'}];
 const html=C.renderList({rows,customers:[{id:customer,name:'거래처 A'}],today:'2026-09-17'});
 assert.equal((html.match(/class="contract-customer-group"/g)||[]).length,1);
 assert.equal((html.match(/class="contract-row"/g)||[]).length,2);
 assert.match(html,/등록 계약/);assert.match(html,/초안/);assert.match(html,/30일/);
 assert.match(html,/href="https:\/\/drive.google.com\/file\/d\/example\/view"/);
 assert.doesNotMatch(html,/href="javascript:/);
 assert.match(C.renderList({rows,customers:[],today:'2026-09-17',filter:{q:'갱신'}}),/현재 표시 1건/);
 assert.match(C.renderList({rows,customers:[],today:'2026-09-17',expanded:{two:true}}),/data-contract-row="two" open/);
});
const base=()=>({customer_id:customer,name:'2026 공급계약',status:'유효',start_date:'2026-01-01',end_date:'2026-12-31',payment_type:'분할',deposit_pct:'30',balance_pct:'70',deposit_due:'발주 시',balance_due:'선적 전',foc_status:'없음'});
test('payment percentages remain numeric and incomplete split terms cannot be submitted',()=>{
 assert.equal(typeof C.normalize,'function');const value=C.normalize(base());assert.equal(value.deposit_pct,30);assert.equal(value.balance_pct,70);
 for(const patch of [{balance_pct:'60'},{deposit_pct:'-1',balance_pct:'101'},{deposit_pct:'abc'},{balance_due:''}])assert.throws(()=>C.normalize({...base(),...patch}));
});
test('dates reject impossible days and reversed periods; expiry is inclusive and notices are independent',()=>{
 assert.equal(typeof C.normalize,'function');
 for(const patch of [{end_date:'2026-02-30'},{end_date:'2025-12-31'},{start_date:''}])assert.throws(()=>C.normalize({...base(),...patch}));
 assert.equal(C.effectiveStatus(base(),'2026-12-31'),'유효');assert.equal(C.effectiveStatus(base(),'2027-01-01'),'만료');
 assert.equal(C.effectiveStatus({...base(),status:'해지'},'2027-01-01'),'해지');
 assert.deepEqual(C.alerts({...base(),notice_date:'2026-09-20'},'2026-09-17').map(x=>x.kind),['notice']);
 assert.equal(C.daysUntil('2026-09-18','2026-09-17'),1);
});
test('FOC details and same-customer predecessor/document associations are required',()=>{
 assert.equal(typeof C.normalize,'function');
 assert.throws(()=>C.normalize({...base(),foc_status:'있음'}));
 const v=C.normalize({...base(),foc_status:'있음',foc_terms:'매 발주 수량 10%, 동일 SKU, 최대 100개'});assert.match(v.foc_terms,/10%/);
 assert.throws(()=>C.normalize({...base(),customer_id:'bad'}));
});
test('list shows payment conditions and escapes contract names and document labels',()=>{
 assert.equal(typeof C.renderList,'function');
 const html=C.renderList({rows:[{...base(),id:customer,name:'<img src=x onerror=alert(1)>'}],customers:[{id:customer,name:'거래처 A'}],today:'2026-09-17'});
 assert.match(html,/30%/);assert.match(html,/70%/);assert.match(html,/선적 전/);assert.match(html,/&lt;img/);assert.doesNotMatch(html,/<img/);
});
test('submission failure preserves loaded contract and retry uses the same before snapshot',async()=>{
 assert.equal(typeof C.createController,'function');const before={...C.normalize(base()),id:customer,created_at:'2026-01-01T00:00:00Z'};let calls=[],fail=true;
 const ctrl=C.createController({read:async()=>[before],submit:async op=>{calls.push(op);if(fail)throw Error('offline');return {id:'request',status:'pending'};}});
 await ctrl.load();const changed={...base(),name:'수정 계약'};
 assert.equal(await ctrl.save(changed,before),null);assert.equal(ctrl.state.rows[0].name,'2026 공급계약');assert.match(ctrl.state.error,/offline/);
 fail=false;assert.equal((await ctrl.save(changed,before)).status,'pending');assert.equal(ctrl.state.rows[0].name,'2026 공급계약');assert.deepEqual(calls[1].before,before);
});
test('stale loads and logout cannot repopulate another account contract list',async()=>{
 assert.equal(typeof C.createController,'function');let resolves=[];const ctrl=C.createController({read:()=>new Promise(r=>resolves.push(r)),submit:async()=>null});
 const p=ctrl.load();ctrl.reset();resolves[0]([base()]);await p;assert.deepEqual(ctrl.state.rows,[]);
});

test('return review requires evidence and keeps negotiation preference separate',()=>{
 for(const topic of ['returns','defect_liability','unclear_cause']){
  assert.equal(C.normalize(base())[topic+'_status'],'미확인');
  assert.throws(()=>C.normalize({...base(),[topic+'_status']:'명시'}));
  assert.equal(C.normalize({...base(),[topic+'_status']:'일부명시',[topic+'_terms']:'제10조 검사 후 협의'})[topic+'_terms'],'제10조 검사 후 협의');
 }
 const html=C.renderList({rows:[{...base(),id:customer}],customers:[],today:'2026-09-17'});
 for(const text of ['교환 · 반품','하자 책임','원인 불명 처리','협상 희망 조건','기존 계약의 합의 내용과 별도'])assert.ok(html.includes(text),text);
});

test('renewal readiness derives targets from contract dates and never invents progress dates',()=>{
 const row={...base(),id:'renewal-one',manager:'Grace',currency:'USD',payment_method:'T/T',document_id:customer,auto_renewal:'있음',renewal_terms:'종료 전 서면 협의',special_terms:'[갱신 협상안]\n표준 계약기간 1년으로 전환'};
 for(const topic of ['kol_support','vmd_support','logistics','certification','document_handover','sns_handover','returns','defect_liability','unclear_cause']){
  row[topic+'_status']='미기재';row[topic+'_terms']='원문 검토 결과 조항 없음';
 }
 const html=C.renderList({rows:[row],customers:[{id:customer,name:'거래처 A'}],today:'2026-09-17'});
 assert.match(html,/갱신 준비 현황/);
 assert.match(html,/빠르면 2026-10-01 소급/);
 assert.match(html,/2026-10-31<small>논의 목표일/);
 assert.match(html,/확정 목표일<\/dt><dd>2026-12-01/);
 assert.match(html,/회신일<\/dt><dd><span class="contract-missing">입력 필요<\/span>/);
 assert.match(html,/표준 계약기간 1년으로 전환/);
 assert.doesNotMatch(html,/2026-09-24|2026-09-25|2026-09-28|2026-09-30/);
});

test('renewal readiness counts missing areas, supports priority sorting and status filtering',()=>{
 const complete={...base(),id:'ready',name:'가 계약',manager:'담당자',currency:'USD',payment_method:'T/T',document_id:customer,auto_renewal:'있음',renewal_terms:'서면 협의'};
 for(const topic of ['kol_support','vmd_support','logistics','certification','document_handover','sns_handover','returns','defect_liability','unclear_cause']){
  complete[topic+'_status']='미기재';complete[topic+'_terms']='원문 검토 결과 조항 없음';
 }
 const incomplete={...complete,id:'urgent',name:'나 계약',end_date:null,payment_type:'미확정',currency:'',foc_status:'미확정',document_id:null};
 const priority=C.renderList({rows:[complete,incomplete],customers:[{id:customer,name:'거래처 A'}],today:'2026-09-17',filter:{renewalSort:'priority'}});
 assert.ok(priority.indexOf('data-renewal-row="urgent"')<priority.indexOf('data-renewal-row="ready"'));
 assert.match(priority,/우선 확인<\/span><strong>1건/);
 assert.match(priority,/협의 준비 완료<\/span><strong>1건/);
 assert.match(priority,/확인 필요 4/);
 const filtered=C.renderList({rows:[complete,incomplete],customers:[{id:customer,name:'거래처 A'}],today:'2026-09-17',filter:{renewalState:'ready'}});
 assert.match(filtered,/data-renewal-row="ready"/);
 assert.doesNotMatch(filtered,/data-renewal-row="urgent"/);
 assert.match(filtered,/표준 협상안<\/strong> · 계약기간 1년 · 종료 2개월 전 논의 · 30일 전 서면 확정/);
 assert.match(filtered,/협상 메모<\/h4><p><span class="contract-missing">입력 필요<\/span>/);
});

test('shared contract filters also scope renewal readiness rows and metrics',()=>{
 const other='20000000-0000-0000-0000-000000000002';
 const rows=[{...base(),id:'one',customer_id:customer,name:'A 계약'},{...base(),id:'two',customer_id:other,name:'B 계약'}];
 const html=C.renderList({rows,customers:[{id:customer,name:'A사'},{id:other,name:'B사'}],today:'2026-09-17',filter:{customer}});
 const readiness=html.slice(0,html.indexOf('<div class="contract-metrics"'));
 assert.match(readiness,/data-renewal-row="one"/);
 assert.doesNotMatch(readiness,/data-renewal-row="two"/);
 assert.match(readiness,/대상 계약<\/span><strong>1건/);
 assert.match(readiness,/대상 거래처<\/span><strong>1곳/);
});
