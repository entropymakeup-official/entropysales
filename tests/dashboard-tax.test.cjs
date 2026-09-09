const {test}=require('node:test');const assert=require('node:assert/strict');
const m=require('../dashboard-model.js');
const customers=[{name:'Zero',tax:'영세'},{name:'Tax',tax:'과세'}];
const inv=[{id:'a',customer:'Zero',order_date:'2026-01-01'},
{id:'b',customer:'Tax',order_date:'2026-01-01'},
{id:'c',customer:'Zero',order_date:'2026-01-01',note:'vat 10% 포함 단가'},
{id:'d',customer:'Zero',order_date:'2026-01-01',status:'Cancelled'},
{id:'e',customer:'Unknown',order_date:'2026-01-01'}];
const items=inv.map(i=>({invoice_id:i.id,sales_type:'Paid',qty:1,price:110}));
items.push({invoice_id:'a',sales_type:'Sample',qty:1,price:12});
const p={start:'2026-01-01',end:'2026-12-31'};
test('zero-rate defaults are usable, taxable/contradictory/missing classifications stay pending',()=>{
 assert.equal(typeof m.summarizeSupply,'function');
 const s=m.summarizeSupply(inv,items,p,customers);
 assert.equal(s.revenue,110);assert.equal(s.pendingRevenue,330);assert.equal(s.recordedRevenue,440);
 assert.equal(s.cancelledCount,1);assert.equal(s.foc,12);
 assert.equal(s.byMonth['2026-01'],110);assert.equal(s.byCustomer.Zero,110);
 assert.equal(m.evidence(s,'revenue').rows.length,1);
 assert.equal(m.evidence(s,'pendingRevenue').rows.length,3);
 assert.match(s.rows.find(r=>r.invoice.id==='c').tax.reason,/비고/);
});
test('customer filter limits pending amounts and duplicate customer names never choose tax arbitrarily',()=>{
 assert.equal(typeof m.summarizeSupply,'function');
 const s=m.summarizeSupply(inv,items,{...p,customer:'Tax'},customers);
 assert.equal(s.revenue,0);assert.equal(s.pendingRevenue,110);
 const dup=m.summarizeSupply(inv,items,{...p,customer:'Zero'},[...customers,{name:'Zero',tax:'과세'}]);
 assert.equal(dup.revenue,0);assert.equal(dup.pendingRevenue,220);
});
test('full Korean VAT names and English tax notes are never silently accepted as zero-rate',()=>{
 for(const note of ['부가가치세 10% 포함','부가 가치 세 별도','tax included','V A T 포함']){
  const s=m.summarizeSupply([{...inv[0],note}],items,p,customers);
  assert.equal(s.revenue,0,note);assert.equal(s.pendingRevenue,110,note);
 }
});
test('cross-card rounding is disclosed without changing recorded amounts',()=>{
 const i=[{invoice_id:'a',sales_type:'Paid',qty:1,price:10.4},{invoice_id:'b',sales_type:'Paid',qty:1,price:10.4}];
 const s=m.summarizeSupply(inv.slice(0,2),i,p,customers);
 assert.equal(s.displayAdjustment,1);assert.equal(s.recordedRevenue,20.8);
 assert.equal(Math.round(s.revenue)+Math.round(s.pendingRevenue)+s.displayAdjustment,Math.round(s.recordedRevenue));
});
