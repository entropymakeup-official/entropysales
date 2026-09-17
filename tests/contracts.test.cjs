const {test}=require('node:test');
const assert=require('node:assert/strict');
let C;try{C=require('../contracts.js');}catch(e){if(e.code!=='MODULE_NOT_FOUND')throw e;C={};}
const customer='10000000-0000-0000-0000-000000000001';
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
