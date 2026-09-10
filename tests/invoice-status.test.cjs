const {test}=require('node:test'),assert=require('node:assert/strict');
const {harness}=require('./helpers/invoice-status.cjs');
for(const kind of ['pay','ship']){
 test(kind+' status only changes after a matching server row is confirmed',async()=>{
  let resolve;const h=harness({execute:()=>new Promise(r=>{resolve=r;})});
  const pending=h.run(kind);await new Promise(setImmediate);
  assert.equal(h.inv.status,'Ordered');assert.equal(h.inv.ship_status,'준비중');
  assert.equal(h.elements['inv-ship-inv-a'].disabled,true);
  resolve({data:[{id:'inv-a',...h.calls[0].patch}],error:null});await pending;
  assert.equal(h.calls.length,1);assert.equal(h.calls[0].table,'invoices');
  assert.ok(h.calls[0].filters.some(x=>x[1]==='id'&&x[2]==='inv-a'));
  assert.equal(kind==='pay'?h.inv.status:h.inv.ship_status,kind==='pay'?'Paid':'출고완료');
  assert.equal(h.notified(),1);assert.equal(h.renders.length,1);assert.equal(h.elements['inv-ship-inv-a'].disabled,false);
  assert.equal(h.ctx._invoices[1].tracking_num,'OTHER');
 });
 test(kind+' rejection, missing rows, malformed values and lost responses keep the prior state',async()=>{
  const patch=kind==='pay'?{status:'Paid',pay_date:'2026-09-10'}:{ship_status:'출고완료'};
  for(const response of [{data:null,error:{message:'rejected'}},{data:[]},{data:null},{data:{}},
   {data:[{id:'inv-b',...patch}]},{data:[{id:['inv-a'],...patch}]},{data:[{id:'inv-a'}]},
   {data:[{id:'inv-a',...patch},{id:'inv-a',...patch}]}]){
   const h=harness({response});await h.run(kind);
   assert.equal(h.inv.status,'Ordered');assert.equal(h.inv.ship_status,'준비중');
   assert.equal(h.notified(),0);assert.equal(h.renders.length,0);
   assert.equal(h.elements['inv-ship-inv-a'].value,'준비중');assert.equal(h.elements['inv-ship-inv-a'].disabled,false);
   assert.ok(h.notices.some(x=>/실패|확인|새로고침/.test(x)));
  }
  const h=harness({execute:async()=>{throw Error('lost response');}});await h.run(kind);
  assert.equal(h.calls.length,1);assert.equal(h.notified(),0);assert.equal(h.inv.status,'Ordered');
  await h.run(kind);assert.equal(h.calls.length,2,'only a later explicit action retries');
 });
 test(kind+' comparison uses the previous changed fields, including SQL null',async()=>{
  const h=harness();await h.run(kind);
  assert.deepEqual(h.calls[0].filters,kind==='pay'?[['eq','id','inv-a'],['eq','status','Ordered'],['is','pay_date',null]]:[['eq','id','inv-a'],['eq','ship_status','준비중']]);
  assert.equal(h.calls[0].selection,kind==='pay'?'id,status,pay_date':'id,ship_status');
 });
}
test('invalid payment dates and cancelled dialogs never send an update',async()=>{
 for(const date of ['2026-02-29','2026-13-01','2026-9-1','tomorrow',null,'']){
  const h=harness({date});await h.run();assert.equal(h.calls.length,0);
 }
 const h=harness({invoice:{status:'Paid',pay_date:'2026-09-01'},confirm:false});await h.run();assert.equal(h.calls.length,0);
});
test('payment reversal atomically clears its date and ignores stale inline arguments',async()=>{
 const h=harness({invoice:{status:'Paid',pay_date:'2026-09-01'}});
 await h.ctx.togglePayStatus('inv-a','', 'Ordered');
 assert.equal(h.inv.status,'Ordered');assert.equal(h.inv.pay_date,null);
 assert.deepEqual(h.calls[0].patch,{status:'Ordered',pay_date:null});
 assert.ok(h.calls[0].filters.some(x=>x[1]==='pay_date'&&x[2]==='2026-09-01'));
});
test('pending status requests block duplicate prompts and conflicting controls on the same order',async()=>{
 let resolve;const h=harness({execute:()=>new Promise(r=>{resolve=r;})});
 const a=h.run(),b=h.run(),c=h.run('ship');await new Promise(setImmediate);
 assert.equal(h.calls.length,1);assert.equal(h.dialogs.length,1);
 resolve({data:[{id:'inv-a',status:'Paid',pay_date:'2026-09-10'}],error:null});await Promise.all([a,b,c]);
 assert.equal(h.notified(),1);assert.equal(h.inv.ship_status,'준비중');
});
test('invalid shipping state and an unchanged selection never issue requests',async()=>{
 const h=harness();await h.ctx.updShipSt('inv-a','unexpected',h.elements['inv-ship-inv-a']);
 await h.ctx.updShipSt('inv-a','준비중',h.elements['inv-ship-inv-a']);assert.equal(h.calls.length,0);
});
test('a status response cannot replace another page or erase a tracking draft',async()=>{
 const h=harness();const draft={value:'UNSAVED-TRACKING',defaultValue:'',matches:()=>true};
 h.elements['inv-tbody'].querySelectorAll=()=>[draft];h.ctx.document.activeElement=draft;
 await h.run();assert.equal(draft.value,'UNSAVED-TRACKING');assert.equal(h.renders.length,0);
 assert.match(h.elements['inv-pay-inv-a'].innerHTML,/입금완료/);
 const other=harness();other.elements['nav-invoices'].classList.contains=()=>false;
 await other.run();assert.equal(other.renders.length,0);
});
test('a replaced local order is not overwritten by an older pending response',async()=>{
 let resolve;const h=harness({execute:()=>new Promise(r=>{resolve=r;})});const p=h.run();await new Promise(setImmediate);
 h.ctx._invoices[0]={...h.inv,status:'Paid',pay_date:'2026-09-09'};
 resolve({data:[{id:'inv-a',status:'Paid',pay_date:'2026-09-10'}],error:null});await p;
 assert.equal(h.ctx._invoices[0].pay_date,'2026-09-09');assert.ok(h.notices.some(x=>/새로고침/.test(x)));
});
test('restoring a previously saved tracking value while it is pending cannot be overwritten by another status response',async()=>{
 let resolveTrack,resolveShip;
 const h=harness({execute:request=>{
  if(request.patch.tracking_num==='B')return Promise.resolve({data:null,error:null});
  if(request.patch.tracking_num==='A')return new Promise(r=>{resolveTrack=r;});
  return new Promise(r=>{resolveShip=r;});
 }});
 const other=h.ctx._invoices[1];other.tracking_num='A';
 const input={value:'B',defaultValue:'A',dataset:{invoiceTracking:'inv-b'}};
 h.elements['inv-tbody'].querySelectorAll=()=>[input];
 h.ctx.filterInv=()=>{input.value=other.tracking_num;};
 await h.ctx.updTracking('inv-b','B');assert.equal(other.tracking_num,'B');
 input.value='A';const tracking=h.ctx.updTracking('inv-b','A'),shipping=h.run('ship');
 await new Promise(setImmediate);
 resolveShip({data:[{id:'inv-a',ship_status:'출고완료'}],error:null});await shipping;
 assert.equal(input.value,'A','the current input must survive the unrelated status refresh');
 resolveTrack({data:null,error:null});await tracking;assert.equal(other.tracking_num,'A');
});
