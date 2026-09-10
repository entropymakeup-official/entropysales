const {test}=require('node:test'),assert=require('node:assert/strict');
const {harness}=require('./helpers/invoice-delete.cjs');
for(const name of ['delInv','delRawItem']){
 test(name+' sends one parent deletion and removes only the confirmed order',async()=>{
  const h=harness();await h.run(name);
  assert.deepEqual(h.calls,[{table:'invoices',column:'id',id:'inv-a',selection:'id'}]);
  assert.deepEqual(Array.from(h.ctx._invoices,x=>x.id),['inv-b']);
  assert.deepEqual(Array.from(h.ctx._items,x=>x.id),['item-b']);
  assert.equal(h.notified(),1);assert.equal(h.renders.length,1);
  assert.match(h.confirmations[0],/TEST_A/);
 });
 test(name+' keeps cached rows and view when the server rejects deletion',async()=>{
  const h=harness({response:{data:null,error:{message:'rejected'}}});await h.run(name);
  assert.equal(h.ctx._invoices.length,2);assert.equal(h.ctx._items.length,2);
  assert.equal(h.renders.length,0);assert.equal(h.closed.length,0);assert.equal(h.notified(),0);
  assert.ok(h.notices.some(x=>/실패|확인/.test(x)));
 });
 test(name+' never reports success for unconfirmed or unrelated returned rows',async()=>{
  for(const data of [null,[],{},[{id:'inv-b'}],[{id:'inv-a'},{id:'inv-b'}],[{id:['inv-a']}],[{id:{toString:()=> 'inv-a'}}]]){
   const h=harness({response:{data,error:null}});await h.run(name);
   assert.equal(h.ctx._invoices.length,2);assert.equal(h.ctx._items.length,2);
   assert.equal(h.notified(),0);assert.equal(h.renders.length,0);
   assert.ok(h.notices.some(x=>/확인/.test(x)));
  }
 });
 test(name+' handles lost responses without clearing rows or sending an automatic retry',async()=>{
  const h=harness({execute:async()=>{throw Error('connection lost');}});
  await h.run(name);assert.equal(h.calls.length,1);assert.equal(h.ctx._invoices.length,2);
  assert.equal(h.notified(),0);assert.equal(h.renders.length,0);
  assert.ok(h.notices.some(x=>/확인/.test(x)));
  await h.run(name);assert.equal(h.calls.length,2,'a later explicit user action is allowed');
 });
 test(name+' cancellation sends no request and leaves the view open',async()=>{
  const h=harness({confirm:false});await h.run(name);
  assert.equal(h.calls.length,0);assert.equal(h.closed.length,0);assert.equal(h.ctx._items.length,2);
 });
}
test('concurrent deletion from both screens sends only one request',async()=>{
 let resolve;const pending=new Promise(r=>{resolve=r;});const h=harness({execute:()=>pending});
 const first=h.run('delInv'),second=h.run('delRawItem');await new Promise(setImmediate);
 const before=h.ctx._items.length;
 resolve({data:[{id:'inv-a'}],error:null});await Promise.all([first,second]);
 assert.equal(h.calls.length,1);assert.equal(h.confirmations.length,1);assert.equal(before,2);
 assert.equal(h.notified(),1);assert.equal(h.ctx._items.length,1);
});
test('RAW deletion keeps another order editor and updates only the existing table rows',async()=>{
 let resolve;const h=harness({execute:()=>new Promise(r=>{resolve=r;})});
 const pending=h.run('delRawItem');
 h.elements['raw-upload-area']={innerHTML:'Unsaved editor for inv-b'};
 h.ctx.renderRaw=()=>{h.elements['raw-upload-area'].innerHTML='';};
 resolve({data:[{id:'inv-a'}],error:null});await pending;
 assert.equal(h.elements['raw-upload-area'].innerHTML,'Unsaved editor for inv-b');
 assert.deepEqual(Array.from(h.ctx.window._rr,x=>x.invId),['inv-b']);
 assert.equal(h.renders.includes('raw-table'),true);
});
test('a completed deletion does not close a different order detail or replace a newly selected screen',async()=>{
 let resolve;const h=harness({execute:()=>new Promise(r=>{resolve=r;})});
 const pending=h.run('delInv');
 h.elements['m-inv-view'].dataset.invoiceId='inv-b';
 h.elements['nav-invoices'].classList.contains=()=>false;
 resolve({data:[{id:'inv-a'}],error:null});await pending;
 assert.equal(h.closed.length,0);assert.equal(h.renders.length,0);
 assert.equal(h.ctx._invoices[0].id,'inv-b');
});
