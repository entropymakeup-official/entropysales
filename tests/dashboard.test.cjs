const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const file=path.join(__dirname,'../dashboard-model.js');
const invoices=[
 {id:'a',order_date:'2026-01-01',customer:'A',mgr:'M',status:'Ordered',foc:50},
 {id:'b',order_date:'2026-01-31',customer:'B',mgr:'N',status:'Cancelled'},
 {id:'c',order_date:'2025-12-31',customer:'A'},
 {id:'d',order_date:null,customer:'A'},
 {id:'e',order_date:'2026-02-01',customer:'A'}
];
const items=[
 {invoice_id:'a',sales_type:'Paid',qty:3,price:12.5},
 {invoice_id:'a',sales_type:'Sample',qty:2,price:10},
 {invoice_id:'a',sales_type:'GWP',qty:1,price:5},
 {invoice_id:'b',sales_type:'Paid',qty:1,price:100},
 {invoice_id:'b',sales_type:'Lost',qty:2,price:7},
 {invoice_id:'c',sales_type:'Paid',qty:1,price:999},
 {invoice_id:'d',sales_type:'Paid',qty:1,price:888},
 {invoice_id:'e',sales_type:'Paid',qty:1,price:777},
 {invoice_id:'orphan',sales_type:'Paid',qty:1,price:1000}
];
function model(){assert.ok(fs.existsSync(file),'dashboard aggregation model is implemented');return require(file);}
test('customer filter scopes every metric, chart and evidence without changing manager records',()=>{
 const original=JSON.stringify(invoices);
 const m=model(),p={start:'2026-01-01',end:'2026-01-31',customer:'A'};
 const x=m.summarize(invoices,items,p);
 assert.equal(x.revenue,37.5);assert.equal(x.foc,75);assert.equal(x.lost,0);
 assert.deepEqual(x.rows.map(r=>r.invoice.id),['a']);
 assert.equal(x.byMonth['2026-01'],37.5);assert.deepEqual(Object.keys(x.byCustomer),['A']);
 assert.deepEqual(Object.keys(x.byManager),['M']);assert.equal(x.missingDates,1);
 assert.equal(m.evidence(x,'revenue').rows.length,1);
 assert.equal(m.summarize(invoices,items,{...p,customer:'B'}).missingDates,0);
 assert.equal(m.summarize(invoices,items,{...p,customer:'unknown'}).rows.length,0);
 assert.equal(m.summarize(invoices,items,{...p,customer:''}).revenue,137.5);
 assert.equal(JSON.stringify(invoices),original);
});
test('inclusive order dates exclude other periods, missing dates and orphan items',()=>{
 const x=model().summarize(invoices,items,{start:'2026-01-01',end:'2026-01-31'});
 assert.equal(x.revenue,137.5); // Preserve existing Paid-line policy, including Cancelled headers.
 assert.equal(x.foc,75);assert.equal(x.lost,14);assert.equal(x.missingDates,1);
 assert.deepEqual(x.rows.map(r=>r.invoice.id),['a','b']);
 assert.equal(x.rows.reduce((s,r)=>s+r.revenue,0),137.5);
 assert.equal(x.byMonth['2026-01'],137.5);
 assert.equal(x.byCustomer.A,37.5);assert.equal(x.byManager.N,100);
});
test('empty periods return zero and no evidence orders',()=>{
 const x=model().summarize(invoices,items,{start:'2027-01-01',end:'2027-12-31'});
 assert.equal(x.revenue,0);assert.equal(x.rows.length,0);
});
test('invalid or reversed dates are rejected, cross-year months remain distinct',()=>{
 const m=model();
 for(const f of [{start:'2026-02-30',end:'2026-03-01'},{start:'2026-02-01',end:'2026-01-01'}])assert.throws(()=>m.summarize(invoices,items,f));
 const x=m.summarize(invoices,items,{start:'2025-12-01',end:'2026-01-31'});
 assert.deepEqual(x.months,['2025-12','2026-01']);
 assert.equal(x.byMonth['2025-12'],999);
});
test('display rounding adjustment reconciles rounded evidence rows with the KPI',()=>{
 const m=model();assert.equal(typeof m.evidence,'function');
 const inv=[{id:'a',order_date:'2026-01-01'},{id:'b',order_date:'2026-01-02'}];
 for(const [type,metric] of [['Paid','revenue'],['Sample','foc'],['Lost','lost']]){
   const lines=inv.map(v=>({invoice_id:v.id,sales_type:type,qty:1,price:10.4}));
   const e=m.evidence(m.summarize(inv,lines,{start:'2026-01-01',end:'2026-01-31'}),metric);
   assert.equal(e.roundedRows,20);assert.equal(e.displayTotal,21);assert.equal(e.adjustment,1);
 }
});
