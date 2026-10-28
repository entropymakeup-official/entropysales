const {test}=require('node:test');
const assert=require('node:assert/strict');
const {harness}=require('./helpers/approvals.cjs');

function setup(options){
  const h=harness(options);
  h.ctx.REF_KINDS=['재출고','정정','상계','기타'];h.ctx._savingInvRef=false;
  h.ctx._invoices=[
    {id:'inv-a',no:'A-1',customer:'Demo',order_date:'2026-10-02',note:'before',ref_invoice_id:null,ref_kind:null},
    {id:'inv-b',no:'B-1',customer:'Demo',order_date:'2026-09-01',ref_invoice_id:null,ref_kind:null},
    {id:'inv-c',no:'C-1',customer:'Other',order_date:'2026-10-01',ref_invoice_id:'inv-a',ref_kind:'정정'}
  ];
  // The request reads the current DB row as `before`, independent of the screen cache.
  const dbRow={id:'inv-a',no:'A-1',customer:'Demo',order_date:'2026-10-02',note:'before',ref_invoice_id:null,ref_kind:null,created_at:'2026-10-02T00:00:00Z'};
  h.ctx.sb.from=table=>({select:()=>({eq:(k,v)=>({maybeSingle:async()=>({data:table==='invoices'&&v==='inv-a'?dbRow:null,error:null})})})});
  h.load('openInvRefModal','filterInvRefOptions','saveInvRef','clearInvRef','submitInvRef');
  return h;
}

test('linking submits one generic invoices update with the DB row as before',async()=>{
  const h=setup();
  h.ctx.openInvRefModal('inv-a');
  assert.match(h.element('inv-ref-target').innerHTML,/B-1/);
  assert.doesNotMatch(h.element('inv-ref-target').innerHTML,/A-1 · Demo/,'the invoice itself is not offered');
  h.element('inv-ref-target').value='inv-b';h.element('inv-ref-kind').value='재출고';
  await h.ctx.saveInvRef();
  const ops=h.calls[0].args.p_operations;
  assert.equal(ops.length,1);
  assert.deepEqual({table:ops[0].table,action:ops[0].action,key:ops[0].key,values:ops[0].values},{table:'invoices',action:'update',key:{id:'inv-a'},values:{ref_invoice_id:'inv-b',ref_kind:'재출고'}});
  assert.equal(ops[0].before.created_at,'2026-10-02T00:00:00Z');
  assert.ok(h.closed.includes('m-inv-ref'));
  assert.equal(h.ctx._invoices[0].ref_invoice_id,null,'confirmed data is unchanged until approval');
});

test('same-customer invoices are listed first and search narrows the list',()=>{
  const h=setup();
  h.ctx.openInvRefModal('inv-a');
  const html=h.element('inv-ref-target').innerHTML;
  assert.ok(html.indexOf('B-1')<html.indexOf('C-1'));
  h.element('inv-ref-q').value='c-1';h.ctx.filterInvRefOptions();
  assert.doesNotMatch(h.element('inv-ref-target').innerHTML,/B-1/);
});

test('missing selection or self link is refused before any request',async()=>{
  const h=setup();
  h.ctx.openInvRefModal('inv-a');
  h.element('inv-ref-target').value='';await h.ctx.saveInvRef();
  h.element('inv-ref-target').value='inv-a';await h.ctx.saveInvRef();
  assert.equal(h.calls.length,0);
});

test('clearing a link submits nulls',async()=>{
  const h=setup();
  await h.ctx.clearInvRef('inv-a');
  assert.deepEqual(h.calls[0].args.p_operations[0].values,{ref_invoice_id:null,ref_kind:null});
});

test('detail shows the linked invoice and the invoices that refer to it',()=>{
  const h=setup();
  const el=h.element('view-inv-ref');
  h.ctx.renderInvRef({...h.ctx._invoices[2]});
  assert.match(el.innerHTML,/정정/);assert.match(el.innerHTML,/data-ref-open="inv-a"/);assert.match(el.innerHTML,/연결 해제/);
  h.ctx.renderInvRef({...h.ctx._invoices[0]});
  assert.match(el.innerHTML,/연결 없음/);assert.match(el.innerHTML,/이 인보이스를 참고하는 주문/);assert.match(el.innerHTML,/data-ref-open="inv-c"/);
});
