const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const ledger=fs.existsSync(require('node:path').join(__dirname,'../tax-ledger.js'))?require('../tax-ledger.js'):{};
const customers=[{id:'c1',name:'일반 채널',code:'A'},{id:'c2',name:'리셀 채널',code:'B'}];
const period={start:'2026-04-01',end:'2026-04-30'};
const row=(x={})=>({approval_number:'TEST-001',customer_id:'c2',written_date:'2026-04-30',issued_date:'2026-05-08',
 currency:'KRW',record_kind:'original',supply_amount:'1000',vat_amount:'100',gross_amount:'1100',
 evidence:{tax_sheet_url:'https://docs.google.com/spreadsheets/d/fixture/edit',flex_url:'https://flex.team/workflow/archive/my?workflow-task-key=fixture'},...x});
function client(pages){
 let calls=[];return {calls,from(table){assert.equal(table,'tax_invoice_amounts');let selected=false,sort=[];
 return {select(columns,options){assert.equal(options.count,'exact');assert.match(columns,/approval_number/);selected=true;return this;},
 order(key){sort.push(key);return this;},range(from,to){assert.ok(selected);assert.deepEqual(sort,['written_date','approval_number']);calls.push([from,to]);
 const page=pages[calls.length-1];if(page instanceof Error)return Promise.reject(page);return page;}};}};
}
test('tax amounts use written date and customer identity, preserve signed corrections and inputs',()=>{
 assert.equal(typeof ledger.summarize,'function');
 const rows=[row(),row({approval_number:'CREDIT',record_kind:'correction',supply_amount:-200,vat_amount:-20,gross_amount:-220}),
 row({approval_number:'OTHER',customer_id:'c1',supply_amount:500,vat_amount:0,gross_amount:500}),row({approval_number:'MAY',written_date:'2026-05-01'})];
 const before=JSON.stringify(rows),s=ledger.summarize(rows,period,customers);
 assert.equal(s.supply,1300);assert.equal(s.vat,80);assert.equal(s.gross,1380);assert.equal(s.rows.length,3);
 const resell=ledger.summarize(rows,{...period,customer:'리셀 채널'},customers);
 assert.equal(resell.supply,800);assert.equal(resell.rows.length,2);
 assert.equal(ledger.summarize(rows,{...period,end:'2026-04-29'},customers).rows.length,0);
 assert.equal(JSON.stringify(rows),before);
});
test('duplicate approvals and malformed amount or date do not create plausible totals',()=>{
 assert.equal(typeof ledger.summarize,'function');
 for(const bad of [row({supply_amount:null}),row({vat_amount:''}),row({gross_amount:123}),row({written_date:'2026-02-30'}),row({currency:'USD'}),row({supply_amount:true})])
   assert.throws(()=>ledger.summarize([bad],period,customers));
 assert.throws(()=>ledger.summarize([row(),row()],period,customers),/중복/);
 assert.throws(()=>ledger.summarize([row()],{start:'bad',end:'2026-04-30'},customers));
});
test('read follows actual returned count through all pages including server page caps',async()=>{
 assert.equal(typeof ledger.load,'function');
 const pages=[{data:[row()],count:2,error:null},{data:[row({approval_number:'TWO'})],count:2,error:null}];
 const c=client([...pages,...pages]);
 const state=await ledger.load(c);assert.equal(state.status,'ready');assert.equal(state.rows.length,2);
 assert.equal(c.calls[1][0],1);
});
test('constant-count deletion/insertion or edits between pages never publish a mixed total',async()=>{
 const page=r=>({data:[r],count:2,error:null});
 const a=row({approval_number:'A'}),b=row({approval_number:'B'}),c=row({approval_number:'C'});
 // First range reads A from [A,B]; A is then replaced by C, so the second range reads C from [B,C].
 const mixed=await ledger.load(client([page(a),page(c),page(b),page(c)]));
 assert.equal(mixed.status,'error');assert.deepEqual(mixed.rows,[]);
 const edited={...b,supply_amount:2000,vat_amount:200,gross_amount:2200};
 const changed=await ledger.load(client([page(a),page(b),page(a),page(edited)]));
 assert.equal(changed.status,'error');assert.deepEqual(changed.rows,[]);
});
test('partial reads, changed counts, duplicate pages and denied queries produce an error without partial totals',async()=>{
 assert.equal(typeof ledger.load,'function');
 for(const pages of [
 [{data:[row()],count:2,error:null},{data:null,count:null,error:{code:'42501',message:'private raw error'}}],
 [{data:[row()],count:2,error:null},{data:[],count:2,error:null}],
 [{data:[row()],count:2,error:null},{data:[row({approval_number:'TWO'})],count:3,error:null}],
 [{data:[row()],count:2,error:null},{data:[row()],count:2,error:null}],
 [{data:[],count:null,error:null}],
 [new Error('private raw error')]
 ]) {const s=await ledger.load(client(pages));assert.equal(s.status,'error');assert.deepEqual(s.rows,[]);assert.doesNotMatch(JSON.stringify(s),/private raw error/);}
});
test('a stalled read times out and an empty successful read remains distinct',async()=>{
 assert.equal(typeof ledger.load,'function');
 const stalled=await ledger.load(client([new Promise(()=>{})]),{timeoutMs:10});assert.equal(stalled.status,'error');
 const empty=await ledger.load(client([{data:[],count:0,error:null}]));assert.equal(empty.status,'ready');assert.equal(empty.rows.length,0);
});
test('panel shows partial coverage and safe evidence links, while unavailable and empty never show zero revenue',()=>{
 assert.equal(typeof ledger.render,'function');
 const dangerous=row({approval_number:'<script>bad</script>',evidence:{tax_sheet_url:'javascript:alert(1)',flex_url:'https://flex.team.evil.example/file'}});
 const html=ledger.render({status:'ready',rows:[row(),{...dangerous,approval_number:'<img src=x onerror=bad>'}]},period,customers);
 assert.match(html,/일부 자료/);assert.match(html,/작성일/);assert.match(html,/2,000/);assert.match(html,/전체 매출/);
 assert.match(html,/href="https:\/\/docs.google.com\/spreadsheets\/d\/fixture\/edit"/);
 assert.doesNotMatch(html,/<img|javascript:|flex.team.evil/);assert.match(html,/&lt;img/);
 for(const state of [{status:'error',rows:[]},{status:'loading',rows:[]},{status:'ready',rows:[]}]){
   const rendered=ledger.render(state,period,customers);assert.doesNotMatch(rendered,/₩0/);
 }
 assert.match(ledger.render({status:'ready',rows:[]},period,customers),/0원.*뜻하지/);
});
