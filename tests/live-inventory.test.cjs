const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const file=path.join(__dirname,'../live-inventory.js');
const inventory=fs.existsSync(file)?require(file):{};
const NOW='2026-09-10T06:00:00.000Z';

function row(extra={}){
  return {name:'제품 <A>',code:'CODE&1',supplier:'공급처 "가"',available:10,safety:2,held:1,defective:0,...extra};
}
function snapshot(extra={}){
  return {version:1,source:'wekeep',collected_at:'2026-09-10T05:55:00.000Z',expected_count:1,rows:[row()],...extra};
}

test('fromCells maps the documented 11-column table without merging duplicate or blank codes',()=>{
  assert.equal(typeof inventory.fromCells,'function');
  const collectedAt=new Date().toISOString();
  const cells=[
    ['제품A','DUP','공급A','','','','1,234','5','-2','0',''],
    ['제품B','DUP','공급B','','','','7','1','0','3',''],
    ['제품C','','공급C','','','','-,128','0','0','0','']
  ];
  const got=inventory.fromCells(cells,collectedAt,3);
  assert.equal(got.rows.length,3);
  assert.deepEqual(got.rows.map(r=>r.code),['DUP','DUP','']);
  assert.deepEqual(got.rows.map(r=>r.available),[1234,7,-128]);
  assert.deepEqual(got.rows[0],{name:'제품A',code:'DUP',supplier:'공급A',available:1234,safety:5,held:-2,defective:0});
});

test('fromCells rejects incomplete captures, short rows, blanks and non-numeric quantities',()=>{
  assert.equal(typeof inventory.fromCells,'function');
  const collectedAt=new Date().toISOString();
  assert.throws(()=>inventory.fromCells([['제품','코드','공급']],collectedAt,1),/11열/);
  assert.throws(()=>inventory.fromCells([['제품','코드','공급','','','','','0','0','0','']],collectedAt,1),/수량/);
  assert.throws(()=>inventory.fromCells([['제품','코드','공급','','','','NaN','0','0','0','']],collectedAt,1),/수량/);
  assert.throws(()=>inventory.fromCells([],collectedAt,1),/건수/);
});

test('validateSnapshot accepts negative quantities and blank codes but rejects invalid quantities and row counts',()=>{
  assert.equal(typeof inventory.validateSnapshot,'function');
  assert.deepEqual(inventory.validateSnapshot(snapshot({rows:[row({code:'',available:-3})]}),NOW),snapshot({rows:[row({code:'',available:-3})]}));
  for(const bad of [
    snapshot({rows:[row({available:1.5})]}),
    snapshot({rows:[row({held:'2'})]}),
    snapshot({rows:[row({available:2147483648})]}),
    snapshot({rows:[row({name:'   '})]}),
    {...snapshot(),unexpected:true},
    snapshot({rows:[{...row(),unexpected:true}]}),
    snapshot({expected_count:2}),
    snapshot({rows:[]}),
    snapshot({expected_count:10001,rows:Array(10001).fill(row())})
  ]) assert.throws(()=>inventory.validateSnapshot(bad,NOW));
});

test('validateSnapshot rejects captures older than 24 hours or more than five minutes in the future',()=>{
  assert.throws(()=>inventory.validateSnapshot(snapshot({collected_at:'2026-09-09T05:59:59.999Z'}),NOW),/24시간/);
  assert.throws(()=>inventory.validateSnapshot(snapshot({collected_at:'2026-09-10T06:05:00.001Z'}),NOW),/미래/);
  assert.doesNotThrow(()=>inventory.validateSnapshot(snapshot({collected_at:'2026-09-09T06:00:00.000Z'}),NOW));
  assert.doesNotThrow(()=>inventory.validateSnapshot(snapshot({collected_at:'2026-09-10T06:05:00.000Z'}),NOW));
});

test('deriveStatus separates uninstalled, empty, failed, expired-session, fresh and stale states',()=>{
  assert.equal(typeof inventory.deriveStatus,'function');
  assert.equal(inventory.deriveStatus({kind:'rpc-missing'},NOW).kind,'uninstalled');
  assert.equal(inventory.deriveStatus({kind:'session-expired'},NOW).kind,'session-expired');
  assert.equal(inventory.deriveStatus({error:new Error('secret')},NOW).kind,'failed');
  assert.equal(inventory.deriveStatus({snapshot:null,checked_at:NOW},NOW).kind,'empty');
  assert.equal(inventory.deriveStatus({snapshot:snapshot(),checked_at:NOW},NOW).kind,'ready');
  assert.equal(inventory.deriveStatus({snapshot:snapshot({collected_at:'2026-09-10T05:44:59.999Z'}),checked_at:NOW},NOW).kind,'stale');
  assert.equal(inventory.deriveStatus({snapshot:snapshot({collected_at:'2026-09-08T05:55:00.000Z'}),checked_at:NOW},NOW).kind,'stale');
  assert.equal(inventory.deriveStatus({snapshot:snapshot(),checked_at:'bad'},NOW).kind,'failed');
});

test('render escapes all source text and labels collection time separately from server check time',()=>{
  assert.equal(typeof inventory.render,'function');
  const html=inventory.render(inventory.deriveStatus({snapshot:snapshot(),checked_at:NOW},NOW));
  assert.doesNotMatch(html,/<A>|CODE&1|공급처 "가"/);
  assert.match(html,/제품 &lt;A&gt;/);
  assert.match(html,/CODE&amp;1/);
  assert.match(html,/마지막 수집/);
  assert.match(html,/서버 확인/);
  assert.match(html,/최신/);
  assert.match(html,/저장 자료를 60초마다 확인/);
  assert.match(html,/전체 가용 합계/);
  assert.match(html,/aria-label="수집 자료"/);
  assert.match(html,/href="https:\/\/fbw\.wekeep\.co\.kr\/fbw\/admin\/v2\/inventory\/search\.do"/);
});

function harness(read,options={}){
  const paints=[],timers=new Map();let timerId=0;
  const controller=inventory.createController({read,render:state=>paints.push(state),now:options.now||(()=>NOW),timeoutMs:options.timeoutMs,
    setTimeout:(fn,ms)=>{timers.set(++timerId,{fn,ms});return timerId;},clearTimeout:id=>timers.delete(id)});
  return {controller,paints,timers};
}

function fireTimer(h,ms){
  const found=[...h.timers.entries()].find(([,timer])=>timer.ms===ms);
  assert.ok(found,`expected ${ms}ms timer`);
  h.timers.delete(found[0]);found[1].fn();
}

test('controller polls every 60 seconds only while shown and ignores an in-flight result after hide',async()=>{
  assert.equal(typeof inventory.createController,'function');
  let finish;
  const h=harness(()=>new Promise(resolve=>finish=resolve));
  const first=h.controller.show();
  assert.equal(h.paints.at(-1).kind,'loading');
  await Promise.resolve();
  h.controller.hide();
  finish({snapshot:snapshot(),checked_at:NOW});
  await first;
  assert.equal(h.paints.at(-1).kind,'loading');
  assert.equal(h.timers.size,0);
  const h2=harness(async()=>({snapshot:null,checked_at:NOW}));
  await h2.controller.show();
  assert.equal(h2.paints.at(-1).kind,'empty');
  assert.ok([...h2.timers.values()].some(t=>t.ms===60000));
  h2.controller.hide();
  assert.equal(h2.timers.size,0);
});

test('an older request finishing late cannot cancel the current page polling timer',async()=>{
  const pending=[];
  const h=harness(()=>new Promise(resolve=>pending.push(resolve)));
  const old=h.controller.show();await Promise.resolve();
  h.controller.hide();
  const current=h.controller.show();await Promise.resolve();
  pending[1]({snapshot:null,checked_at:NOW});await current;
  assert.equal(h.timers.size,1);
  pending[0]({snapshot:snapshot(),checked_at:NOW});await old;
  assert.equal(h.timers.size,1);
  assert.ok([...h.timers.values()].every(timer=>timer.ms===60000));
  h.controller.hide();
});

test('a hanging read times out, ignores its late result and permits the next poll to recover',async()=>{
  let calls=0,finishFirst;
  const h=harness(()=>{calls++;if(calls===1)return new Promise(resolve=>finishFirst=resolve);return Promise.resolve({snapshot:snapshot(),checked_at:NOW});},{timeoutMs:25});
  const first=h.controller.show();await Promise.resolve();
  fireTimer(h,25);await first;
  assert.equal(h.paints.at(-1).kind,'failed');
  assert.ok([...h.timers.values()].some(timer=>timer.ms===60000));
  finishFirst({snapshot:snapshot(),checked_at:NOW});await Promise.resolve();
  assert.equal(h.paints.at(-1).kind,'failed');
  fireTimer(h,60000);await new Promise(setImmediate);
  assert.equal(calls,2);
  assert.equal(h.paints.at(-1).kind,'ready');
  h.controller.hide();
});

test('refresh keeps cached rows visible and recomputes stale status without showing latest during loading or failure',async()=>{
  let current=Date.parse(NOW),rejectRead,readCalls=0;
  const h=harness(()=>++readCalls===1?Promise.resolve({snapshot:snapshot(),checked_at:NOW}):new Promise((resolve,reject)=>{rejectRead=reject;}),{now:()=>current});
  await h.controller.show();
  current+=20*60*1000;
  const refresh=h.controller.refresh();await Promise.resolve();
  const loading=h.paints.at(-1);
  assert.equal(loading.kind,'loading');assert.equal(loading.previous.kind,'stale');
  assert.match(inventory.render(loading),/CODE&amp;1/);assert.doesNotMatch(inventory.render(loading),/>최신</);
  rejectRead(new Error('offline'));await refresh;
  const failed=h.paints.at(-1);
  assert.equal(failed.kind,'failed');assert.equal(failed.previous.kind,'stale');
  assert.match(inventory.render(failed),/지연/);assert.doesNotMatch(inventory.render(failed),/>최신</);
  h.controller.hide();
});

test('controller coalesces refreshes, ignores older navigation generations, and exposes only public errors',async()=>{
  assert.equal(typeof inventory.createController,'function');
  let calls=0,finish;
  const h=harness(()=>{calls++;return new Promise((resolve,reject)=>{finish={resolve,reject};});});
  const a=h.controller.show(),b=h.controller.refresh();
  await Promise.resolve();
  assert.equal(calls,1);
  finish.reject(Object.assign(new Error('token=private'),{code:'PGRST301'}));
  await Promise.all([a,b]);
  assert.equal(h.paints.at(-1).kind,'session-expired');
  assert.doesNotMatch(JSON.stringify(h.paints),/token=private/);
  h.controller.hide();
});

test('a polling failure marks the view failed while retaining the last confirmed snapshot as cached data',async()=>{
  let fail=false;
  const h=harness(async()=>{if(fail)throw new Error('host details');return {snapshot:snapshot(),checked_at:NOW};});
  await h.controller.show();
  fail=true;
  await h.controller.refresh();
  assert.equal(h.paints.at(-1).kind,'failed');
  assert.equal(h.paints.at(-1).previous.snapshot.rows[0].code,'CODE&1');
  const html=inventory.render(h.paints.at(-1));
  assert.match(html,/마지막 확인 성공 자료/);
  assert.doesNotMatch(html,/host details/);
  h.controller.hide();
});

test('save responses must acknowledge the same collection and row count',()=>{
  assert.equal(typeof inventory.validateSaveResult,'function');
  const snap=snapshot();
  assert.deepEqual(inventory.validateSaveResult({saved:true,collected_at:snap.collected_at,row_count:1},snap),{saved:true,collected_at:snap.collected_at,row_count:1});
  for(const result of [null,{saved:false,collected_at:snap.collected_at,row_count:1},{saved:true,collected_at:snap.collected_at,row_count:2},{saved:true,collected_at:NOW,row_count:1}]){
    assert.throws(()=>inventory.validateSaveResult(result,snap),/저장/);
  }
});

test('mount accepts payload JSON and reports success only after write acknowledgement',async()=>{
  const handlers={};let html='';
  const host={addEventListener:(name,fn)=>handlers[name]=fn,querySelector:()=>null,get innerHTML(){return html;},set innerHTML(value){html=value;}};
  const actions={innerHTML:''};
  const payloadNode={id:'inventory-payload',value:''};
  const doc={getElementById:id=>id==='content'?host:id==='topbar-actions'?actions:id==='inventory-payload'?payloadNode:null};
  let written=null;
  const ui=inventory.mount({document:doc,read:async()=>({snapshot:null,checked_at:new Date().toISOString()}),write:async value=>{
    written=value;
    return {saved:true,collected_at:value.collected_at,row_count:value.rows.length};
  }});
  await ui.show();
  const fresh=snapshot({collected_at:new Date().toISOString()});
  payloadNode.value=JSON.stringify(fresh);
  handlers.input({target:payloadNode});
  handlers.click({target:{closest:()=>({dataset:{inventoryAction:'save'}})}});
  await new Promise(setImmediate);
  assert.equal(written.rows[0].code,'CODE&1');
  assert.match(host.innerHTML,/1행 저장 완료/);
  assert.doesNotMatch(host.innerHTML,/CODE&1/,'pasted payload must not be inserted as raw HTML');
  ui.hide();
});

async function pendingSaveHarness(reject){
  const handlers={};let html='';
  const host={addEventListener:(name,fn)=>handlers[name]=fn,querySelector:()=>null,get innerHTML(){return html;},set innerHTML(value){html=value;}};
  const payloadNode={id:'inventory-payload',value:''};
  const doc={activeElement:null,getElementById:id=>id==='content'?host:id==='topbar-actions'?{innerHTML:''}:id==='inventory-payload'?payloadNode:null};
  let settle;
  const ui=inventory.mount({document:doc,read:async()=>({snapshot:null,checked_at:new Date().toISOString()}),write:()=>new Promise((resolve,rejectWrite)=>{settle=reject?()=>rejectWrite(new Error('private')):resolve;})});
  await ui.show();
  const fresh=snapshot({collected_at:new Date().toISOString()});
  payloadNode.value=JSON.stringify(fresh);handlers.input({target:payloadNode});
  handlers.click({target:{closest:()=>({dataset:{inventoryAction:'save'}})}});
  await Promise.resolve();
  assert.match(host.innerHTML,/data-inventory-action="save" disabled/);
  ui.hide();const hiddenHtml=host.innerHTML;
  settle({saved:true,collected_at:fresh.collected_at,row_count:1});
  await new Promise(setImmediate);
  assert.equal(host.innerHTML,hiddenHtml);
  await ui.show();
  assert.doesNotMatch(host.innerHTML,/제품 &lt;A&gt;/,'a new mount must not retain the pasted payload');
  ui.hide();
}

test('pending save completion after hide cannot repaint or retain pasted payload',async()=>pendingSaveHarness(false));
test('pending save rejection after hide cannot repaint or retain pasted payload',async()=>pendingSaveHarness(true));

test('polling repaints preserve search and payload drafts plus the active caret',async()=>{
  const handlers={};let html='';
  const host={addEventListener:(name,fn)=>handlers[name]=fn,querySelector:()=>null,get innerHTML(){return html;},set innerHTML(value){html=value;}};
  const doc={activeElement:null};
  const field=id=>({id,value:'',selectionStart:0,selectionEnd:0,focus(){doc.activeElement=this;},setSelectionRange(start,end){this.selectionStart=start;this.selectionEnd=end;}});
  const search=field('inventory-search'),payload=field('inventory-payload'),actions={innerHTML:''};
  doc.getElementById=id=>id==='content'?host:id==='topbar-actions'?actions:id==='inventory-search'?search:id==='inventory-payload'?payload:null;
  const ui=inventory.mount({document:doc,read:async()=>({snapshot:snapshot({collected_at:new Date().toISOString()}),checked_at:new Date().toISOString()}),write:async()=>null});
  await ui.show();
  search.value='CODE&';search.selectionStart=search.selectionEnd=3;doc.activeElement=search;handlers.input({target:search});
  payload.value='<unsafe draft>';payload.selectionStart=payload.selectionEnd=7;doc.activeElement=payload;handlers.input({target:payload});
  await ui.refresh();
  assert.match(host.innerHTML,/value="CODE&amp;"/);
  assert.match(host.innerHTML,/&lt;unsafe draft&gt;/);
  assert.equal(doc.activeElement.id,'inventory-payload');
  assert.equal(payload.selectionStart,7);
  ui.hide();
});

test('a hanging write times out, checks by bounded read, never resubmits and leaves an uncertain usable form',async()=>{
  const handlers={},timers=new Map();let timerId=0,html='',writeCalls=0,finishWrite;
  const host={addEventListener:(name,fn)=>handlers[name]=fn,querySelector:()=>null,get innerHTML(){return html;},set innerHTML(value){html=value;}};
  const payloadNode={id:'inventory-payload',value:''};
  const doc={activeElement:null,getElementById:id=>id==='content'?host:id==='topbar-actions'?{innerHTML:''}:id==='inventory-payload'?payloadNode:null};
  const ui=inventory.mount({document:doc,timeoutMs:25,setTimeout:(fn,ms)=>{timers.set(++timerId,{fn,ms});return timerId;},clearTimeout:id=>timers.delete(id),
    read:async()=>({snapshot:null,checked_at:new Date().toISOString()}),write:()=>{writeCalls++;return new Promise(resolve=>finishWrite=resolve);}});
  await ui.show();
  const fresh=snapshot({collected_at:new Date().toISOString()});payloadNode.value=JSON.stringify(fresh);handlers.input({target:payloadNode});
  handlers.click({target:{closest:()=>({dataset:{inventoryAction:'save'}})}});await Promise.resolve();
  const deadline=[...timers.entries()].find(([,timer])=>timer.ms===25);assert.ok(deadline);timers.delete(deadline[0]);deadline[1].fn();
  await new Promise(setImmediate);
  assert.equal(writeCalls,1);
  assert.match(host.innerHTML,/자동 재전송하지 않았습니다/);
  assert.doesNotMatch(host.innerHTML,/data-inventory-action="save" disabled/);
  finishWrite({saved:true,collected_at:fresh.collected_at,row_count:1});await new Promise(setImmediate);
  assert.equal(writeCalls,1);assert.match(host.innerHTML,/자동 재전송하지 않았습니다/);
  ui.hide();
});

test('a confirmed save cancels a pre-save read and refreshes from a new authoritative response',async()=>{
  const handlers={};let html='',readCalls=0,finishOld;
  const host={addEventListener:(name,fn)=>handlers[name]=fn,querySelector:()=>null,get innerHTML(){return html;},set innerHTML(value){html=value;}};
  const payloadNode={id:'inventory-payload',value:''};
  const doc={activeElement:null,getElementById:id=>id==='content'?host:id==='topbar-actions'?{innerHTML:''}:id==='inventory-payload'?payloadNode:null};
  const fresh=snapshot({collected_at:new Date().toISOString()});
  const ui=inventory.mount({document:doc,read:()=>{readCalls++;return readCalls===1?new Promise(resolve=>finishOld=resolve):Promise.resolve({snapshot:fresh,checked_at:new Date().toISOString()});},write:async value=>({saved:true,collected_at:value.collected_at,row_count:value.rows.length})});
  const initial=ui.show();await Promise.resolve();
  payloadNode.value=JSON.stringify(fresh);handlers.input({target:payloadNode});handlers.click({target:{closest:()=>({dataset:{inventoryAction:'save'}})}});
  await new Promise(setImmediate);
  assert.equal(readCalls,2);
  assert.match(host.innerHTML,/저장 완료/);
  assert.match(host.innerHTML,/CODE&amp;1/);
  finishOld({snapshot:null,checked_at:new Date().toISOString()});await initial;
  assert.match(host.innerHTML,/CODE&amp;1/,'late pre-save read must not replace the confirmed snapshot');
  ui.hide();
});

async function timeoutReadback(readbackFactory){
  const handlers={},timers=new Map();let timerId=0,html='',reads=0;
  const host={addEventListener:(name,fn)=>handlers[name]=fn,querySelector:()=>null,get innerHTML(){return html;},set innerHTML(value){html=value;}};
  const payloadNode={id:'inventory-payload',value:''};
  const doc={activeElement:null,getElementById:id=>id==='content'?host:id==='topbar-actions'?{innerHTML:''}:id==='inventory-payload'?payloadNode:null};
  const fresh=snapshot({collected_at:new Date().toISOString()});
  const ui=inventory.mount({document:doc,timeoutMs:25,setTimeout:(fn,ms)=>{timers.set(++timerId,{fn,ms});return timerId;},clearTimeout:id=>timers.delete(id),
    read:async()=>++reads===1?{snapshot:null,checked_at:new Date().toISOString()}:{snapshot:readbackFactory(fresh),checked_at:new Date().toISOString()},write:()=>new Promise(()=>{})});
  await ui.show();payloadNode.value=JSON.stringify(fresh);handlers.input({target:payloadNode});handlers.click({target:{closest:()=>({dataset:{inventoryAction:'save'}})}});await Promise.resolve();
  const deadline=[...timers.entries()].find(([,timer])=>timer.ms===25);assert.ok(deadline);timers.delete(deadline[0]);deadline[1].fn();
  await new Promise(setImmediate);
  return {html,ui};
}

test('write timeout readback confirms an identical snapshot regardless of JSON object key order',async()=>{
  const h=await timeoutReadback(fresh=>({rows:fresh.rows.map(item=>({defective:item.defective,held:item.held,safety:item.safety,available:item.available,supplier:item.supplier,code:item.code,name:item.name})),expected_count:fresh.expected_count,collected_at:fresh.collected_at,source:fresh.source,version:fresh.version}));
  assert.match(h.html,/1행 저장 확인 완료/);
  assert.doesNotMatch(h.html,/저장 여부 확인 필요/);
  h.ui.hide();
});

test('write timeout readback stays uncertain when time and count match but row content differs',async()=>{
  const h=await timeoutReadback(fresh=>({...fresh,rows:[{...fresh.rows[0],available:fresh.rows[0].available+1}]}));
  assert.match(h.html,/저장 여부 확인 필요/);
  assert.doesNotMatch(h.html,/저장 확인 완료/);
  h.ui.hide();
});
