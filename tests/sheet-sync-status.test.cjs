const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const file=path.join(__dirname,'../sheet-sync-status.js');
const status=fs.existsSync(file)?require(file):{};
const snapshot=(extra={})=>({enabled:true,pending_count:0,failed_count:0,delayed_count:0,missing_count:0,last_synced_at:'2026-09-10T03:00:00Z',checked_at:'2026-09-10T03:01:00Z',problems:[],...extra});

test('only a valid acknowledged snapshot can show completion',()=>{
 assert.equal(typeof status.describe,'function');
 assert.equal(status.describe(snapshot()).kind,'complete');
 for(const data of [null,{},snapshot({pending_count:-1}),snapshot({failed_count:1}),snapshot({checked_at:'bad'}),snapshot({enabled:'true'})]){
  assert.equal(status.describe(data).kind,'unavailable');
 }
 assert.equal(status.describe(snapshot({last_synced_at:null})).kind,'empty');
 assert.equal(status.describe(snapshot({enabled:false})).kind,'paused');
});

test('unacknowledged changes, missing captures, delays and errors override old successes',()=>{
 assert.equal(typeof status.describe,'function');
 assert.equal(status.describe(snapshot({pending_count:2})).kind,'pending');
 assert.equal(status.describe(snapshot({pending_count:2,delayed_count:1})).kind,'delayed');
 assert.equal(status.describe(snapshot({pending_count:2,missing_count:1})).kind,'missing');
 assert.equal(status.describe(snapshot({pending_count:2,failed_count:1})).kind,'error');
});

test('problem names are escaped and raw server errors never become HTML',()=>{
 assert.equal(typeof status.renderPanel,'function');
 const html=status.renderPanel(status.describe(snapshot({pending_count:1,failed_count:1,problems:[{invoice_no:'<img src=x onerror=alert(1)>',customer:'A&B',state:'error',error_code:'<secret-token>'}]})));
 assert.doesNotMatch(html,/<img|onerror=alert\(1\)>|secret-token/);
 assert.match(html,/&lt;img/);assert.match(html,/A&amp;B/);
});

function harness(read){
 const paints=[],timers=new Map();let id=0;
 const controller=status.createController({read,render:m=>paints.push(m),isHidden:()=>false,
  setTimeout:(fn,ms)=>{timers.set(++id,{fn,ms});return id;},clearTimeout:i=>timers.delete(i)});
 return {controller,paints,timers};
}
test('a failed refresh removes stale success and a later refresh recovers',async()=>{
 assert.equal(typeof status.createController,'function');
 let fail=false;const h=harness(async()=>{if(fail)throw Error('private details');return snapshot();});
 await h.controller.show();assert.equal(h.paints.at(-1).kind,'complete');
 fail=true;await h.controller.refresh();assert.equal(h.paints.at(-1).kind,'unavailable');
 assert.doesNotMatch(JSON.stringify(h.paints),/private details/);
 fail=false;await h.controller.refresh();assert.equal(h.paints.at(-1).kind,'complete');
 h.controller.hide();assert.equal(h.timers.size,0);
});
test('navigation/logout discards in-flight results and cancels polling',async()=>{
 assert.equal(typeof status.createController,'function');
 let finish;const h=harness(()=>new Promise(resolve=>finish=resolve));
 const first=h.controller.show();const paintsBefore=h.paints.length;
 h.controller.hide();finish(snapshot());await first;
 assert.equal(h.paints.length,paintsBefore);assert.equal(h.timers.size,0);
});
test('refreshes coalesce and a timeout does not leave the screen checking forever',async()=>{
 assert.equal(typeof status.createController,'function');
 let count=0,finish;const h=harness(()=>{count++;return new Promise(resolve=>finish=resolve);});
 const first=h.controller.show();const second=h.controller.refresh();
 assert.equal(count,1);
 const timeout=[...h.timers.values()].find(t=>t.ms===20000);assert.ok(timeout);timeout.fn();
 await Promise.all([first,second]);assert.equal(h.paints.at(-1).kind,'unavailable');
 finish(snapshot());await Promise.resolve();assert.equal(h.paints.at(-1).kind,'unavailable');
 assert.ok([...h.timers.values()].some(t=>t.ms===60000));h.controller.hide();
});

function mounted(read){
 const handlers={},doc={hidden:false,activeElement:null,addEventListener:(key,fn)=>handlers[key]=fn};
 let html='',details=null;
 const host={hidden:true,addEventListener:()=>{},querySelector:selector=>selector==='details'?details:null,
  get innerHTML(){return html;},set innerHTML(value){html=value;details=value.includes('<details')?{open:false}:null;}};
 doc.getElementById=()=>host;
 return {ui:status.mount({document:doc,read}),doc,host,handlers};
}
test('returning to a browser tab starts a new read and rejects its pre-hide snapshot',async()=>{
 const resolves=[];const h=mounted(()=>new Promise(resolve=>resolves.push(resolve)));
 try{
  const first=h.ui.show('raw');h.doc.hidden=true;h.handlers.visibilitychange();
  h.doc.hidden=false;h.handlers.visibilitychange();
  assert.equal(resolves.length,2);
  resolves[0](snapshot());resolves[1](snapshot({pending_count:1}));await first;
  await new Promise(setImmediate);assert.match(h.host.innerHTML,/시트 반영 대기/);assert.doesNotMatch(h.host.innerHTML,/시트 반영 완료/);
 }finally{h.ui.hide();}
});
test('an expanded problem list survives the transient checking state',async()=>{
 const h=mounted(async()=>snapshot({pending_count:1,failed_count:1,problems:[{invoice_no:'TEST',state:'error'}]}));
 try{
  await h.ui.show('raw');h.host.querySelector('details').open=true;
  await h.ui.refresh();assert.equal(h.host.querySelector('details').open,true);
 }finally{h.ui.hide();}
});
