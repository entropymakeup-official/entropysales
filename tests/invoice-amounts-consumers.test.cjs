const test=require('node:test'),assert=require('node:assert/strict');
const {harness}=require('./helpers/approvals.cjs');const A=require('../invoice-amounts.js');
function fixture(){
 const h=harness();h.ctx.invoiceSheetStatus.refresh=()=>{};Object.assign(h.ctx,{InvoiceAmounts:A,SALES_TYPES:['Paid','FOC'],MGRS:['Tester'],stBadge:s=>s,statusBadge:s=>s,shipBadge:s=>s,_invFileCache:{},loadInvDocs(){},renderDriveDocs(){},loadDriveDocs(){},setTimeout(){},_caSelected:'Demo',_caChart:null});
 h.ctx._invoices[0].order_date='2026-01-02';h.ctx._items=[{id:'item-a',invoice_id:'inv-a',barcode:'SYNTHETIC',name:'Synthetic item',sales_type:'Paid',qty:3,price:40,amount_override:91.25,amount_reference:'Proof'}];
 const sheets=[],printed=[];h.ctx.XLSX={utils:{book_new:()=>({}),aoa_to_sheet:rows=>{sheets.push(rows);return {};},book_append_sheet(){}}};h.ctx.xlsxDownload=()=>{};
 h.ctx.window.open=()=>({document:{write:html=>printed.push(html),close(){}},focus(){},print(){}});
 h.load('fmt','fmtN','itemsRev','itemsByType');return {...h,sheets,printed};
}
test('invoice details and both Excel exports use effective stored amounts with original qty and price',()=>{
 const h=fixture();h.load('viewInv','exportInvoices','renderRaw','exportRaw');h.ctx.viewInv('inv-a');assert.match(h.element('view-inv-items').innerHTML,/₩91\.25/);
 h.ctx.exportInvoices();assert.equal(h.sheets[0][1][6],91.25);h.ctx.renderRaw();assert.equal(h.ctx.window._rr[0].amount,91.25);h.ctx.exportRaw();assert.equal(h.sheets[1][1].at(-1),91.25);assert.equal(h.ctx.window._rr[0].qty,3);assert.equal(h.ctx.window._rr[0].price,40);
});
test('printable invoice and customer report use proof amounts in lines and totals',()=>{
 const h=fixture();h.load('downloadMeongse','printCustReport');h.ctx.downloadMeongse(h.ctx._invoices[0]);assert.match(h.printed[0],/₩91\.25/);assert.doesNotMatch(h.printed[0],/₩120</);
 h.ctx.printCustReport();assert.match(h.printed[1],/₩91\.25/);assert.doesNotMatch(h.printed[1],/₩120</);
});
test('customer analysis and product sales use proof revenue and original quantities',()=>{
 const h=fixture();h.load('buildCustAnalysis','pdBase','pdSales');h.ctx.buildCustAnalysis('Demo');assert.match(h.element('ca-body').innerHTML,/₩91\.25/);assert.doesNotMatch(h.element('ca-body').innerHTML,/₩120</);
 const s=h.ctx.pdSales('SYNTHETIC');assert.equal(s.rev,91.25);assert.equal(s.qty,3);assert.equal(s.avg,91.25/3);
});
test('whole invoice editor previews unchanged proof and new entry uses qty times price',()=>{
 const h=fixture();h.load('calcInvTotal');const inputs=['Synthetic item','SYNTHETIC','3','40'].map(value=>({value})),cell={};const tr={querySelectorAll:s=>s==='input'?inputs:[{},{},{},{},{},cell],querySelector:()=>({value:'Paid'})};h.ctx.document.querySelectorAll=()=>[tr];h.ctx._editInv=h.ctx._invoices[0];h.ctx._editInvBefore={items:h.ctx._items};
 h.ctx.calcInvTotal();assert.equal(h.element('inv-total').textContent,'₩91.25');inputs[2].value='4';h.ctx.calcInvTotal();assert.match(h.element('inv-proof-warning').textContent,/해제/);assert.match(h.element('inv-proof-warning').textContent,/미리보기|승인/);
 h.ctx._editInv=null;h.ctx.calcInvTotal();assert.equal(h.element('inv-total').textContent,'₩160');
});
test('RAW confirmation keeps effective proof for unchanged existing lines and arithmetic for new entry',()=>{
 const h=fixture();h.load('_showRawConfirmModal');const line=h.ctx._items[0];h.ctx.window._editRawInvId='inv-a';h.ctx.window._editRawBefore={items:[line]};h.ctx.window._pendingRaw={cust:'Demo',invNo:'SYNTHETIC',odate:'2026-01-02',items:[{...line,salesType:'Paid'}]};
 h.ctx._showRawConfirmModal();assert.equal(h.element('raw-confirm-paid').textContent,'₩91.25');h.ctx.window._editRawInvId=null;h.ctx._showRawConfirmModal();assert.equal(h.element('raw-confirm-paid').textContent,'₩120');
});
test('RAW live editor recalculates all correspondences when a line becomes ambiguous',()=>{
 const h=fixture();h.load('xgCalcAmt');const line=h.ctx._items[0];h.ctx.window._editRawInvId='inv-a';h.ctx.window._editRawBefore={items:[line]};
 const makeRow=()=>{const cells=Object.fromEntries([['0',line.barcode],['1',line.name],['3','Paid'],['4','3'],['5','40']].map(([i,value])=>[i,{value}]));const amount={};return {cells,amount,querySelector:s=>s==='[data-col="6"]'?amount:cells[s.match(/data-col="(\d)"/)[1]]};};
 const row=makeRow();h.ctx.document.querySelectorAll=()=>[row];h.ctx.xgCalcAmt(row);assert.equal(row.amount.textContent,'₩91.25');
 const copy=makeRow();h.ctx.document.querySelectorAll=()=>[row,copy];h.ctx.xgCalcAmt(copy);assert.equal(row.amount.textContent,'₩120');assert.equal(copy.amount.textContent,'₩120');
 h.ctx.window._editRawInvId=null;h.ctx.document.querySelectorAll=()=>[row];h.ctx.xgCalcAmt(row);assert.equal(row.amount.textContent,'₩120');
});
