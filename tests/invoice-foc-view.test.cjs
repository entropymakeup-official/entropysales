const test=require('node:test'),assert=require('node:assert/strict');
const {harness}=require('./helpers/approvals.cjs');const A=require('../invoice-amounts.js');
function fixture(){
 const h=harness();h.ctx.invoiceSheetStatus.refresh=()=>{};Object.assign(h.ctx,{InvoiceAmounts:A,SALES_TYPES:['Paid','FOC','GWP','Lost'],MGRS:['Tester'],stBadge:s=>s,statusBadge:s=>s,shipBadge:s=>s,shipModeBadge:()=>'',_invFileCache:{},_invoiceStatusPending:new Set(),invoicePaymentMarkup:()=>'',invoiceAmounts:{open(){}},updateInvFileIcon(){},loadInvFileIcons(){},loadInvDocs(){},renderDriveDocs(){},loadDriveDocs(){},setTimeout(){}});
 h.ctx._invoices=[{id:'inv-a',no:'A-1',customer:'Demo',status:'Ordered',ship_status:'준비중',foc:0},{id:'inv-b',no:'B-1',customer:'Other',status:'Ordered',ship_status:'준비중',foc:0}];
 h.ctx._items=[
  {id:'1',invoice_id:'inv-a',name:'Paid item',sales_type:'Paid',qty:3,price:40},
  {id:'2',invoice_id:'inv-a',name:'Free item',sales_type:'FOC',qty:5,price:10},
  {id:'3',invoice_id:'inv-a',name:'Gift item',sales_type:'GWP',qty:2,price:7},
  {id:'4',invoice_id:'inv-b',name:'Only paid',sales_type:'Paid',qty:1,price:100}];
 h.load('fmt','fmtN','itemsByType');h.ctx.itemsRev=items=>items.filter(i=>i.sales_type==='Paid').reduce((a,i)=>a+A.amount(i),0);return h;
}
test('invoice list keeps Paid revenue, shows FOC qty and filters invoices with FOC',()=>{
 const h=fixture();h.load('filterInv');h.ctx.filterInv();
 const rows=h.element('inv-tbody').innerHTML;assert.match(rows,/₩120/);assert.match(rows,/₩50<div[^>]*>5개<\/div>/);
 assert.match(h.element('inv-count').textContent,/총 2건 · FOC 포함 1건 · FOC ₩50 \(5개, 매출 합계 제외\)/);
 h.element('fi-foc').value='FOC 있음';h.ctx.filterInv();assert.deepEqual(h.ctx.window._inv_filtered.map(v=>v.no),['A-1']);
 h.element('fi-foc').value='FOC 없음';h.ctx.filterInv();assert.deepEqual(h.ctx.window._inv_filtered.map(v=>v.no),['B-1']);
 assert.equal(h.element('inv-count').textContent,'총 1건');
});
test('invoice detail splits Paid, FOC and other free lines with subtotals',()=>{
 const h=fixture();h.load('viewInv');h.ctx.viewInv('inv-a');
 const meta=h.element('view-inv-meta').innerHTML;assert.match(meta,/Paid 매출<\/div><div[^>]*>₩120/);assert.match(meta,/FOC \(매출 제외\)<\/div><div[^>]*>₩50<\/div>/);assert.match(meta,/5개 · GWP·Sample ₩14 별도/);
 const body=h.element('view-inv-items').innerHTML;
 assert.match(body,/inv-group-paid"><td colspan="4">Paid 매출<\/td><td[^>]*>3<\/td><td><\/td><td[^>]*>₩120<\/td>/);
 assert.match(body,/inv-group-foc"><td colspan="4">FOC 무상 제공 \(매출 제외\)<\/td><td[^>]*>5<\/td><td><\/td><td[^>]*>₩50<\/td>[\s\S]*Free item/);
 assert.match(body,/inv-group-other[\s\S]*Gift item/);
 h.ctx._invoices[0].foc=30;h.ctx.viewInv('inv-a');assert.match(h.element('view-inv-meta').innerHTML,/₩80<\/div>[\s\S]*수기 FOC ₩30 포함/);
});
test('narrow-screen hidden columns match between list header and rows, and FOC stays visible',()=>{
 const h=fixture();h.load('filterInv','renderInvoices');Object.assign(h.ctx,{loadDriveDocs(){}});h.ctx.renderInvoices();
 const head=h.element('content').innerHTML.match(/<thead>([\s\S]*?)<\/thead>/)[1].match(/<th[^>]*>/g).map(t=>t.includes('inv-hide-mobile'));
 const row=h.element('inv-tbody').innerHTML.split('</tr>')[0].match(/<td\b[^>]*>/g).map(t=>t.includes('inv-hide-mobile'));
 assert.equal(row.length,head.length);assert.deepEqual(row,head);assert.equal(head[5],false);
});
