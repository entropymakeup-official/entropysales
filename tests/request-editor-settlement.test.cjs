const test=require('node:test'),assert=require('node:assert/strict');
const E=require('../request-editor.js');
const inv={id:'i',no:'INV',status:'Ordered',pay_date:null,ship_status:'준비중',ship_date:null};
const prepare=form=>({invoice_id:form.invoice_id,drive_file_id:'file_'+form.type,resource_key:null,name:form.name,type:form.type});
const none=()=>false;

test('settlement needs are detected only when a status becomes paid or shipped',()=>{
 const draft=E.prepareInvoice(inv,[]);
 assert.deepEqual(E.settlementNeeds(draft),[]);
 draft.operations[0].values.status='Paid';draft.operations[0].values.ship_status='출고완료';
 assert.deepEqual(E.settlementNeeds(draft).map(n=>n.type),['입금증빙','선적서류']);
 const paid=E.prepareInvoice({...inv,status:'Paid',ship_status:'출고완료'},[]);
 paid.operations[0].values.status='Closed';
 assert.deepEqual(E.settlementNeeds(paid),[],'paid to closed and unchanged shipment need nothing');
});

test('evidence links are required and placed before the status change',()=>{
 const draft=E.prepareInvoice(inv,[]);draft.operations[0].values.status='Paid';
 assert.throws(()=>E.attachEvidence(draft,{},none,prepare),/입금증빙/);
 const done=E.attachEvidence(draft,{pay:{url:'https://drive.google.com/file/d/x/view',name:'입금 내역'}},none,prepare);
 assert.equal(done.operations.length,2);
 assert.deepEqual(done.operations[0],{table:'invoice_drive_documents',action:'insert',key:{},before:null,
  values:{invoice_id:'i',drive_file_id:'file_입금증빙',resource_key:null,name:'입금 내역',type:'입금증빙'}});
 assert.equal(done.operations[1].table,'invoices');
});

test('existing evidence on the invoice or in the pending draft is reused',()=>{
 const draft=E.prepareInvoice(inv,[]);draft.operations[0].values.ship_status='출고완료';
 const reused=E.attachEvidence(draft,{},(id,type)=>id==='i'&&type==='선적서류',prepare);
 assert.equal(reused.operations.length,1);
 const withDraft=E.attachEvidence(draft,{ship:{url:'u',name:'B/L'}},none,prepare);
 const again=E.attachEvidence(withDraft,{},none,prepare);
 assert.equal(again.operations.filter(op=>op.table==='invoice_drive_documents').length,1,'revising keeps one evidence operation');
 const replaced=E.attachEvidence(withDraft,{ship:{url:'u2',name:'AWB'}},none,prepare);
 const docs=replaced.operations.filter(op=>op.table==='invoice_drive_documents');
 assert.equal(docs.length,1);assert.equal(docs[0].values.name,'AWB');
});

test('admin page disables approving your own paid/shipped request but not others',()=>{
 const UI=require('../admin-approvals.js');
 const op={table:'invoices',action:'update',key:{id:'i'},before:{id:'i',status:'Ordered',ship_status:'준비중'},values:{status:'Paid'}};
 assert.equal(UI.hasSettlementChange([op]),true);
 assert.equal(UI.hasSettlementChange([{...op,values:{note:'x'}}]),false);
 const base={id:'00000000-0000-4000-8000-000000000001',status:'pending',operations:[op],requester_email:'a@entropymakeup.com',created_at:'2026-10-27T00:00:00Z',revision:1};
 const approve=html=>html.match(/<button type="button" class="approve"[^>]*>/)[0];
 const own=UI.render({requests:[{...base,can_edit:true}],isAdmin:true});
 assert.match(approve(own),/disabled/);assert.match(own,/다른 관리자가 승인/);
 const other=UI.render({requests:[{...base,can_edit:false}],isAdmin:true});
 assert.doesNotMatch(approve(other),/disabled/);
});

test('evidence operations are not shown as editable fields',()=>{
 const draft=E.prepareInvoice(inv,[]);draft.operations[0].values.status='Paid';
 const done=E.attachEvidence(draft,{pay:{url:'u',name:'입금'}},none,prepare);
 assert.ok(!E.fields(done).some(f=>['drive_file_id','type','resource_key'].includes(f.key)));
});
