const test=require('node:test'),assert=require('node:assert/strict');
const {harness}=require('./helpers/approvals.cjs');const A=require('../invoice-amounts.js');
const E=require('../request-editor.js');

// 출고완료(증빙없음): 저장된 새 상태와, 출고완료인데 선적서류가 없는 주문을 같은 '증빙없음'으로 본다.
function fixture({driveState='ready'}={}){
 const h=harness();h.ctx.invoiceSheetStatus.refresh=()=>{};Object.assign(h.ctx,{InvoiceAmounts:A,SALES_TYPES:['Paid','FOC','Sample'],MGRS:['Tester'],stBadge:s=>s,statusBadge:s=>s,shipModeBadge:()=>'',_invFileCache:{},_invoiceStatusPending:new Set(),invoiceAmounts:{open(){}},updateInvFileIcon(){},loadInvFileIcons(){},loadInvDocs(){},renderDriveDocs(){}});
 h.ctx._invoices=[
  {id:'docs',no:'D-1',customer:'Demo',status:'Paid',pay_date:'2026-10-01',ship_status:'출고완료',foc:0},
  {id:'nodoc',no:'N-1',customer:'Demo',status:'Paid',pay_date:'2026-10-01',ship_status:'출고완료',foc:0},
  {id:'stored',no:'S-1',customer:'Demo',status:'Paid',pay_date:'2026-10-01',ship_status:'출고완료(증빙없음)',foc:0},
  {id:'open',no:'O-1',customer:'Demo',status:'Ordered',ship_status:'준비중',foc:0}];
 h.ctx._items=[];
 // 실제 화면처럼 _driveState·_driveRows는 let 전역이다.
 require('node:vm').runInContext(`var _driveState=${JSON.stringify(driveState)};var _driveRows=[{invoice_id:'docs',type:'선적서류'},{invoice_id:'nodoc',type:'입금증빙'},{invoice_id:'stored',type:'입금증빙'}];`,h.ctx);
 h.load('fmt','fmtExact','fmtN','itemsByType','itemsQtyByType','verificationMarkup','payStatusLabel','payFilterMatch','invoicePaymentMarkup','shipBadge');
 h.ctx.itemsRev=()=>0;
 return h;
}

test('stored and derived no-evidence orders are both treated as 출고완료(증빙없음)',()=>{
 const h=fixture(),[docs,nodoc,stored,open]=h.ctx._invoices;
 assert.equal(h.ctx.shipMissingEvidence(docs),false);
 assert.equal(h.ctx.shipMissingEvidence(nodoc),true);
 assert.equal(h.ctx.shipMissingEvidence(stored),true);
 assert.equal(h.ctx.shipMissingEvidence(open),false);
 assert.match(h.ctx.shipBadge(nodoc.ship_status,h.ctx.shipMissingEvidence(nodoc)),/출고완료\(증빙없음\)/);
 assert.match(h.ctx.shipBadge(stored.ship_status,false),/출고완료\(증빙없음\)/);
 assert.match(h.ctx.shipBadge(docs.ship_status,false),/bg-green">출고완료</);
 assert.match(h.ctx.shipEvidenceMarkup(nodoc),/증빙없음/);
 // 저장 상태가 이미 '증빙없음'이면 선택 상자에 보이므로 옆 표시는 붙이지 않는다.
 assert.equal(h.ctx.shipEvidenceMarkup(stored),'');
 assert.equal(h.ctx.shipClass('출고완료(증빙없음)'),'ss s증빙없음');
 assert.equal(h.ctx.shipClass('출고완료'),'ss s출고완료');
});

test('before Drive evidence loads, 출고완료 orders are not marked as missing evidence',()=>{
 const h=fixture({driveState:'loading'}),[,nodoc,stored]=h.ctx._invoices;
 assert.equal(h.ctx.shipMissingEvidence(nodoc),false);
 assert.equal(h.ctx.shipEvidenceMarkup(nodoc),'');
 assert.equal(h.ctx.shipMissingEvidence(stored),true);
});

test('ship filter 출고완료(증빙없음) lists stored and derived orders; list offers the new status',()=>{
 const h=fixture();h.load('filterInv');h.ctx.filterInv();
 const pick=v=>{h.element('fi-sh').value=v;h.ctx.filterInv();return h.ctx.window._inv_filtered.map(x=>x.no);};
 assert.deepEqual(pick('출고완료(증빙없음)'),['N-1','S-1']);
 assert.deepEqual(pick('출고완료'),['D-1','N-1']);
 assert.deepEqual(pick('준비중'),['O-1']);
 pick('');
 const html=h.element('inv-tbody').innerHTML;
 assert.match(html,/<option selected>출고완료\(증빙없음\)<\/option>/);
 assert.match(html,/class="ss s증빙없음"/);
 assert.match(html,/id="inv-ship-ev-nodoc"> <span class="badge bg-gray"[^>]*>증빙없음/);
 assert.doesNotMatch(html,/id="inv-ship-ev-docs"><span/);
});

test('request editor offers the new ship status',()=>{
 const inv={id:'i',no:'INV',status:'Paid',pay_date:'2026-10-01',ship_status:'준비중',ship_date:null};
 const draft=E.prepareInvoice(inv,[]);
 const fields=E.fields(draft);const field=fields.find(f=>f.key==='ship_status');assert.ok(field);
 E.assign(draft,field,'출고완료(증빙없음)');
 assert.equal(draft.operations[0].values.ship_status,'출고완료(증빙없음)');
 // 선적서류 없이 요청할 수 있다(출고완료와 달리 증빙 요구 없음).
 assert.deepEqual(E.settlementNeeds(draft),[]);
});
