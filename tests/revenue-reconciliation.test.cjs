const {test}=require('node:test');
const assert=require('node:assert/strict');
const model=require('../dashboard-model.js');
const period={start:'2026-01-01',end:'2026-12-31'};
const {harness}=require('./helpers/approvals.cjs');
test('tax reconciliation retains renamed/unlinked orders without applying the new customer tax or status',()=>{
 const invoices=[{id:'a',no:'OLD',customer:'Old name',order_date:'2026-01-02'},
 {id:'b',no:'ZERO',customer:'Zero',order_date:'2026-01-03'},
 {id:'c',customer:'Zero',order_date:'2026-01-04',status:'Cancelled'}];
 const items=invoices.map((i,n)=>({invoice_id:i.id,sales_type:'Paid',qty:1,price:100,amount_override:n===0?22.5:100}));
 const customers=[{id:'new',name:'New name',tax:'과세'},{id:'zero',name:'Zero',tax:'영세'}];
 const s=model.summarizeTax(invoices,items,period,customers,[{customer_id:'new',month:'2026-01',status:'발행완료'}]);
 assert.equal(s.recordedRevenue,122.5);assert.equal(s.revenue,100);assert.equal(s.pendingRevenue,22.5);
 const old=s.taxRows.find(r=>r.customer==='Old name');
 assert.equal(old.amt,22.5);assert.equal(old.custId,null);assert.equal(old.taxType,'미확인');assert.equal(old.taxStatus,'연결 확인 필요');
 assert.match(old.reasons.join(' '),/마스터 연결/);
 assert.equal(s.taxRows.reduce((a,r)=>a+r.amt,0),s.recordedRevenue);
});
test('monthly registered, supply and pending views reconcile and exclude cancelled orders',()=>{
 const h=harness();
 h.ctx._invoices=[{id:'z',customer:'Zero',order_date:'2026-03-01'},{id:'old',customer:'Old name',order_date:'2026-03-02'},{id:'cancel',customer:'Zero',order_date:'2026-03-03',status:'Cancelled'}];
 h.ctx._items=h.ctx._invoices.map((i,n)=>({invoice_id:i.id,sales_type:'Paid',qty:1,price:[100,20,999][n]}));
 h.ctx._customers=[{id:'z',name:'Zero',tax:'영세'}];
 h.load('fmt','buildMonthly');h.element('fm-y').value='2026';
 for(const [view,total]of [['revenue',120],['supply',100],['pending',20]]){
  h.element('fm-t').value=view;h.ctx.buildMonthly();
  const html=h.element('monthly-content').innerHTML;
  assert.match(html,new RegExp('₩'+total));assert.doesNotMatch(html,/₩999|₩1,119/);assert.match(html,/취소 제외 1건/);
 }
});
test('tax UI displays unknown customer and reason safely; export uses the same visible rows',()=>{
 const h=harness();
 h.ctx._invoices=[{id:'a',customer:'Old <name>',order_date:'2026-01-01',no:'A'},{id:'b',customer:'Zero',order_date:'2025-01-01',no:'B'}];
 h.ctx._items=h.ctx._invoices.map(i=>({invoice_id:i.id,sales_type:'Paid',qty:1,price:25}));
 h.ctx._customers=[{id:'z',name:'Zero',tax:'영세'}];h.ctx.TAX_ST=['발행예정','발행완료'];
 h.load('esc','fmt','renderTax','filterTax','taxRowHtml','taxVisibleRows','exportTax');
 h.ctx.renderTax();assert.match(h.element('tax-content').innerHTML,/Old &lt;name&gt;/);assert.match(h.element('tax-content').innerHTML,/연결 확인 필요/);
 assert.doesNotMatch(h.element('tax-content').innerHTML,/<select|VAT|₩27.5/);
 let exported;h.ctx.XLSX={utils:{aoa_to_sheet:data=>{exported=data;return {};},book_new:()=>({}),book_append_sheet(){}}};h.ctx.xlsxDownload=()=>{};
 h.ctx.exportTax();assert.equal(exported.length,2);assert.equal(exported[1][0],'2026-01');assert.equal(exported[1][4],25);assert.equal(exported[1][5],0);assert.equal(exported[1][6],25);
});
test('filtered tax reconciliation discloses display rounding adjustment',()=>{
 const h=harness();h.load('fmt','taxVisibleRows','taxRowHtml','filterTax');h.ctx.TAX_ST=[];
 h.ctx.window._taxSummary={taxRows:[
  {month:'2026-01',customer:'A',amt:.005,supplyAmt:.005,pendingAmt:0,reasons:[],invoices:[]},
  {month:'2026-01',customer:'B',amt:.005,supplyAmt:0,pendingAmt:.005,reasons:[],invoices:[]},
  {month:'2025-01',customer:'C',amt:99,supplyAmt:99,pendingAmt:0,reasons:[],invoices:[]} ]};
 h.element('ft-y').value='2026';h.ctx.filterTax();
 assert.match(h.element('tax-reconciliation').textContent,/표시 반올림 차이 ₩-0.01/);
});
test('zero and signed adjustments survive tax rows, duplicate names stay unlinked and taxable amounts stay pending',()=>{
 const invoices=['Zero','Tax','Duplicate','Bad date'].map((customer,n)=>({id:String(n),customer,order_date:n===3?'2026-99-99':'2026-02-01'}));
 const items=invoices.map((i,n)=>({invoice_id:i.id,sales_type:'Paid',qty:1,price:100,amount_override:[0,-10,20,999][n]}));
 const customers=[{id:'z',name:'Zero',tax:'영세'},{id:'t',name:'Tax',tax:'과세'},{name:'Duplicate',tax:'영세'},{name:'Duplicate',tax:'과세'}];
 const s=model.summarizeTax(invoices,items,period,customers,[]);
 assert.equal(s.taxRows.length,3);assert.equal(s.recordedRevenue,10);assert.equal(s.pendingRevenue,10);assert.equal(s.missingDates,1);
 assert.equal(s.taxRows.find(r=>r.customer==='Zero').amt,0);
 assert.equal(s.taxRows.find(r=>r.customer==='Tax').pendingAmt,-10);
 assert.equal(s.taxRows.find(r=>r.customer==='Duplicate').custId,null);
});
