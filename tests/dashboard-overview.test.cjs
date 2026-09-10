const {test}=require('node:test');
const assert=require('node:assert/strict');
const model=require('../dashboard-model.js');

test('registered total evidence includes pending tax amounts and excludes cancelled orders',()=>{
 const invoices=[
  {id:'a',customer:'Zero',order_date:'2026-01-01'},
  {id:'b',customer:'Tax',order_date:'2026-02-01'},
  {id:'c',customer:'Zero',order_date:'2026-03-01',status:'Cancelled'}
 ];
 const items=invoices.map((v,i)=>({invoice_id:v.id,sales_type:'Paid',qty:1,price:[100.4,200.4,900][i]}));
 const result=model.summarizeSupply(invoices,items,{start:'2026-01-01',end:'2026-12-31'},[{name:'Zero',tax:'영세'},{name:'Tax',tax:'과세'}]);
 const evidence=model.evidence(result,'recordedRevenue');
 assert.deepEqual(evidence.rows.map(r=>r.invoice.id),['a','b']);
 assert.deepEqual(evidence.rows.map(r=>r.recordedRevenue),[100.4,200.4]);
 assert.equal(evidence.displayTotal,301);assert.equal(evidence.adjustment,1);
 assert.equal(result.revenue,100.4);assert.equal(result.pendingRevenue,200.4);
});

test('all-time range covers every valid order date and handles an empty or invalid-only dataset',()=>{
 assert.equal(typeof model.allTimePeriod,'function');
 assert.deepEqual(model.allTimePeriod([{order_date:'2026-09-01'},{order_date:'2025-02-03'},{order_date:''},{order_date:'2025-02-30'}],'2026-09-10'),{start:'2025-02-03',end:'2026-09-01'});
 assert.deepEqual(model.allTimePeriod([],'2026-09-10'),{start:'2026-01-01',end:'2026-12-31'});
 assert.deepEqual(model.allTimePeriod([{order_date:'invalid'}],'2026-09-10'),{start:'2026-01-01',end:'2026-12-31'});
});
