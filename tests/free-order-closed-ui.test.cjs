const test=require('node:test'),assert=require('node:assert/strict');
const {harness}=require('./helpers/approvals.cjs');const A=require('../invoice-amounts.js');
const E=require('../request-editor.js');

// 무상 종결(Closed) 화면 표시: 입금완료·미입금과 구분하고 미입금 목록에서 뺀다.
function fixture(){
 const h=harness();h.ctx.invoiceSheetStatus.refresh=()=>{};Object.assign(h.ctx,{InvoiceAmounts:A,SALES_TYPES:['Paid','FOC','Sample'],MGRS:['Tester'],stBadge:s=>s,statusBadge:s=>s,shipBadge:s=>s,shipModeBadge:()=>'',_invFileCache:{},_invoiceStatusPending:new Set(),invoiceAmounts:{open(){}},updateInvFileIcon(){},loadInvFileIcons(){},loadInvDocs(){},renderDriveDocs(){}});
 h.ctx._invoices=[
  {id:'paid',no:'P-1',customer:'Demo',status:'Paid',pay_date:'2026-10-01',ship_status:'출고완료',foc:0},
  {id:'closed',no:'C-1',customer:'Demo',status:'Closed',pay_date:null,ship_status:'출고완료',foc:0,pay_verified_by:'reviewer@entropymakeup.com',pay_verified_at:'2026-11-10T00:00:00Z'},
  {id:'open',no:'O-1',customer:'Demo',status:'Ordered',ship_status:'준비중',foc:0}];
 h.ctx._items=[
  {id:'1',invoice_id:'paid',name:'Paid item',sales_type:'Paid',qty:1,price:100},
  {id:'2',invoice_id:'closed',name:'Sample item',sales_type:'Sample',qty:5,price:10},
  {id:'3',invoice_id:'open',name:'Paid item',sales_type:'Paid',qty:2,price:50}];
 h.load('fmt','fmtExact','fmtN','itemsByType','itemsQtyByType','verificationMarkup','payStatusLabel','payFilterMatch','invoicePaymentMarkup');
 h.ctx.itemsRev=items=>items.filter(i=>i.sales_type==='Paid').reduce((a,i)=>a+A.amount(i),0);
 return h;
}

test('closed orders show a separate free-close badge with the verifier',()=>{
 const h=fixture();
 const html=h.ctx.invoicePaymentMarkup(h.ctx._invoices[1],0);
 assert.match(html,/무상 종결/);assert.doesNotMatch(html,/미입금|입금완료/);assert.match(html,/검증 reviewer/);
 assert.equal(h.ctx.payStatusLabel('Closed'),'무상 종결');
 assert.equal(h.ctx.payStatusLabel('Paid'),'입금완료');
 assert.equal(h.ctx.payStatusLabel('Ordered'),'미입금');
});

test('payment filter separates paid, unpaid and free-closed orders',()=>{
 const h=fixture();h.load('filterInv');h.ctx.filterInv();
 const pick=v=>{h.element('fi-pay').value=v;h.ctx.filterInv();return h.ctx.window._inv_filtered.map(x=>x.no);};
 assert.deepEqual(pick('미입금'),['O-1']);
 assert.deepEqual(pick('입금완료'),['P-1']);
 assert.deepEqual(pick('무상 종결'),['C-1']);
 assert.deepEqual(pick(''),['P-1','C-1','O-1']);
});

test('closing a free order asks for shipping documents, not payment evidence',()=>{
 const inv={id:'i',no:'INV',status:'Paid',pay_date:null,ship_status:'출고완료',ship_date:'2026-10-01'};
 const draft=E.prepareInvoice(inv,[]);draft.operations[0].values.status='Closed';
 assert.deepEqual(E.settlementNeeds(draft).map(n=>[n.type,n.label]),[['선적서류','무상 종결']]);
 const back=E.prepareInvoice({...inv,status:'Closed'},[]);back.operations[0].values.status='Paid';
 assert.deepEqual(E.settlementNeeds(back).map(n=>n.type),['입금증빙'],'closed to paid needs payment evidence');
});
