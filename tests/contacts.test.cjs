const {test}=require('node:test');
const assert=require('node:assert/strict');
const C=require('../contacts.js');
const row=(n=1)=>({company:'업체 '+n,person:'담당자',email:`p${n}@example.test`,phone:'010-0012-0345'});
test('normalize validates required contact, status, email and preserves phones',()=>{
 assert.throws(()=>C.normalize({company:'A',person:'B'}),/연락/);
 assert.throws(()=>C.normalize({...row(),status:'invalid'}),/상태/);
 assert.throws(()=>C.normalize({...row(),email:'oops'}),/이메일/);
 assert.throws(()=>C.normalize({...row(),email:'x@domain..test'}),/이메일/);
 assert.equal(C.normalize({...row(),company:'  A  '}).company,'A');
 assert.equal(C.normalize(row()).phone,'010-0012-0345');
 assert.equal(C.normalize(row()).customer_id,null);
});
test('duplicates compare email or company/person; rendering escapes and filters',()=>{
 assert.ok(C.isDuplicate(row(),{...row(2),email:' P1@EXAMPLE.TEST '}));
 assert.ok(C.isDuplicate(row(),{...row(),email:'x@example.test'}));
 assert.ok(!C.isDuplicate(row(),row(2)));
 const html=C.renderList({rows:[{...row(),id:'x',company:'<script>A</script>'},row(2)],filter:{q:'<script>'}});
 assert.ok(html.includes('&lt;script&gt;'));assert.ok(!html.includes('<script>'));assert.ok(!html.includes('p2@example.test'));
});
test('pending saves never become approved; existing and pending duplicate blocked',async()=>{
 let calls=0;const c=C.createController({read:async()=>[],readPending:async()=>[],submit:async()=>({id:String(++calls),status:'pending'})});
 assert.ok(await c.save(row(),null,'추가'));assert.equal(c.state.rows.length,0);assert.equal(c.state.pending.length,1);
 assert.equal(c.duplicateRows()[0]._pending,true);
 await c.load();assert.equal(c.state.pending.length,1);
 assert.equal(await c.save(row(),null,'추가'),null);assert.equal(calls,1);
});
test('previously approved retry is not mislabelled as pending',async()=>{
 const c=C.createController({read:async()=>[],submit:async()=>({id:'approved',status:'approved'})});
 assert.ok(await c.save(row(),null,'추가'));assert.equal(c.state.pending.length,0);assert.match(c.state.message,/승인된/);
});
test('bulk partial failures preserve accepted rows and permit failure-only retry',async()=>{
 let calls=0;const c=C.createController({read:async()=>[],readPending:async()=>[],submit:async()=>{if(++calls===2)throw Error('offline');return{id:String(calls),status:'pending'};}});
 const input=Array.from({length:1001},(_,i)=>row(i));const out=await c.saveMany(input,{reason:'가져오기'});
 assert.equal(out.done.length,1000);assert.equal(out.failed.length,1);
 const retry=await c.saveMany(out.failed.map(x=>x.row),{reason:'재시도'});assert.equal(retry.done.length,1);assert.equal(calls,3);
});
test('auth reset invalidates in-flight saves without leaking accepted rows',async()=>{
 let resolve;const c=C.createController({read:async()=>[],readPending:async()=>[],submit:()=>new Promise(r=>resolve=r)});
 const task=c.saveMany([row()],{reason:'추가'});while(!resolve)await new Promise(r=>setImmediate(r));c.reset();resolve({id:'x',status:'pending'});
 const out=await task;assert.equal(out.cancelled,true);assert.equal(out.done.length,0);assert.equal(c.state.pending.length,0);
});
test('rejected results fail; updates exclude own approved row but pending update blocks',async()=>{
 const before={...C.normalize(row()),id:'a'};let rejected=true;
 const c=C.createController({read:async()=>[before],readPending:async()=>[],submit:async()=>({id:'r',status:rejected?'rejected':'pending'})});
 await c.load();assert.equal(await c.save(row(),before,'수정'),null);rejected=false;assert.ok(await c.save(row(),before,'수정'));
 assert.equal(await c.save(row(),before,'수정'),null);
});
test('pending requests from other sessions block duplicates; resolved requests leave local pending',async()=>{
 let pending=[{...row(),_requestId:'existing'}];const c=C.createController({read:async()=>[],readPending:async()=>pending,submit:async()=>({id:'new',status:'pending'})});
 assert.equal(await c.save(row(),null,'추가'),null);assert.ok(await c.save(row(2),null,'추가'));
 pending={rows:[],resolvedIds:['new']};await c.load();assert.equal(c.state.pending.length,0);
});
test('explicit cancellation finishes accepted batch and stops before next request',async()=>{
 let calls=0;let c;c=C.createController({read:async()=>[],readPending:async()=>[],submit:async()=>{calls++;c.cancel();return{id:'batch',status:'pending'};}});
 const out=await c.saveMany(Array.from({length:1001},(_,i)=>row(i)),{reason:'추가'});assert.equal(calls,1);assert.equal(out.done.length,1000);assert.equal(out.cancelled,true);
});
test('byte batching accounts for server JSONB spaces at 5MB boundary',async()=>{
 let batches=0;const c=C.createController({read:async()=>[],submit:async ops=>{batches++;const serverJSON=JSON.stringify(ops).replace(/":/g,'": ').replace(/","/g,'", "');assert.ok(Buffer.byteLength(serverJSON)<=5*1024*1024);return{id:String(batches),status:'pending'};}});
 const large=Array.from({length:1000},(_,i)=>({...row(i),note:'a'.repeat(4000)}));
 const op=r=>({table:'contacts',action:'insert',key:{},before:null,values:C.normalize(r)});
 const remaining=5*1024*1024-20-Buffer.byteLength(JSON.stringify(large.map(op)));
 large.forEach((r,i)=>{r.address='b'.repeat(Math.floor(remaining/1000)+(i<remaining%1000?1:0));});
 const out=await c.saveMany(large,{reason:'가져오기'});assert.equal(out.done.length,1000);assert.ok(batches>1);
});
test('load response arriving after reset never restores old account rows',async()=>{
 let resolve;const c=C.createController({read:()=>new Promise(r=>resolve=r),submit:async()=>null});const loading=c.load();c.reset();resolve([row()]);assert.equal(await loading,false);assert.equal(c.state.rows.length,0);
});
test('mount paginates approved and requests; auth changes clear rows and importer',async()=>{
 let auth,resetCount=0;const ranges=[],pages=[];
 const sb={auth:{onAuthStateChange:fn=>{auth=fn;}},from:()=>({select(){return this;},order(){return this;},async range(start,end){ranges.push([start,end]);return{data:start===0?Array.from({length:1000},(_,i)=>({...row(i),id:String(i)})):[{...row(1000),id:'1000'}]};}})};
 const client={list:async(limit,offset)=>{pages.push([limit,offset]);return{requests:offset===0?Array.from({length:100},(_,i)=>({id:'old'+i,status:'approved'})):[{id:'pending',status:'pending',operations:[{table:'contacts',action:'insert',values:row(2000)}]}]};},submit:async()=>null};
 const mounted=C.mount({document:{},sb,client});mounted.setImporter({reset:()=>resetCount++});await mounted.reload();
 assert.equal(mounted.rows().length,1002);assert.equal(mounted.rows().at(-1)._pending,true);assert.deepEqual(ranges,[[0,999],[1000,1999]]);assert.deepEqual(pages,[[100,0],[100,100]]);
 auth('SIGNED_IN',{user:{id:'next'}});assert.equal(mounted.rows().length,0);assert.equal(resetCount,1);
 auth('TOKEN_REFRESHED',{user:{id:'next'}});assert.equal(resetCount,1);
});
test('partial pending update retains prior identity and contact data for search and duplicate checks',async()=>{
 const before={...C.normalize(row()),id:'existing',title:'Staff'};let submitted=0;
 const sb={from:()=>({select(){return this;},order(){return this;},range:async()=>({data:[before]})})};
 const client={list:async()=>({requests:[{id:'change',status:'pending',operations:[{table:'contacts',action:'update',key:{id:before.id},before,values:{title:'Manager'}}]}]}),submit:async()=>{submitted++;return{id:'new',status:'pending'};}};
 const mounted=C.mount({document:{},sb,client});await mounted.reload();const pending=mounted.rows().find(r=>r._pending);
 assert.equal(pending.company,before.company);assert.equal(pending.person,before.person);assert.equal(pending.email,before.email);assert.equal(pending.status,'활성');assert.equal(pending.title,'Manager');assert.equal(pending.id,before.id);
 assert.equal(C.filterRows([pending],{company:before.company,status:'활성',q:before.email}).length,1);assert.ok(C.isDuplicate(row(),pending));
 assert.equal(await mounted.controller.save(row(),null,'중복 등록'),null);assert.match(mounted.controller.state.error,/승인 대기/);assert.equal(submitted,0);
});
