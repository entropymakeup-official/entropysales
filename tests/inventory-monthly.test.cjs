const test=require('node:test');
const assert=require('node:assert/strict');
const monthly=require('../inventory-monthly.js');
const TODAY='2026-09-11';
const catalog=[{sku:'101',name:'제품 <A>',code:'A',supplier:'공급처'},{sku:'102',name:'제품 B',code:'B',supplier:'공급처'}];
const response=(changes={})=>({year:2026,today:TODAY,catalog,months:[],checked_at:'2026-09-10T15:00:00Z',...changes});
const row=(changes={})=>({sku:'101',month:1,covered_days:31,record_days:31,inbound:0,returned:0,faulty:0,damaged:0,outbound:-4,balance:20,balance_date:'2026-01-31',last_collected_at:'2026-09-10T15:00:00Z',oldest_collected_at:'2026-09-10T00:00:00Z',...changes});
test('annual validation checks years, duplicate rows, identities, calendar coverage and exact balance dates',()=>{
  assert.equal(monthly.validateAnnual(response()).year,2026);
  for(const bad of [response({year:1999}),response({year:2027}),response({today:'2026-02-30'}),response({months:[row(),row()]}),response({months:[row({sku:'missing'})]}),response({months:[row({month:2,covered_days:29,record_days:29})]}),response({months:[row({balance_date:'2026-01-30'})]}),response({months:[row({inbound:Number.MAX_SAFE_INTEGER+1})]}),response({months:[row({record_days:0})]})])assert.throws(()=>monthly.validateAnnual(bad));
});
test('12 calendar rows, leap year, partial present month and future months',()=>{
  const rows=monthly.summarizeMonthly(response());
  assert.equal(rows.length,12);assert.equal(rows[1].expected_days,56);
  assert.equal(rows[8].expected_days,22);assert.equal(rows[8].period,'current');assert.equal(rows[9].status,'future');
  assert.equal(monthly.summarizeMonthly(response({year:2024}))[1].expected_days,58);
  assert.equal(monthly.summarizeMonthly(response({catalog:[]}))[0].status,'empty');
});
test('known zero, unqueried, queried absent and incomplete recorded subtotals are distinct',()=>{
  const data=response({months:[row(),row({sku:'102',covered_days:2,record_days:0,inbound:null,returned:null,faulty:null,damaged:null,outbound:null,balance:null,balance_date:null})]});
  const first=monthly.summarizeMonthly(data)[0];
  assert.equal(first.inbound,0);assert.equal(first.outbound,-4);assert.equal(first.balance,null);assert.equal(first.status,'partial');assert.equal(first.covered_days,33);assert.equal(first.record_days,31);
  assert.equal(monthly.summarizeMonthly(data)[1].inbound,null);
  assert.equal(monthly.summarizeMonthly(data,'102')[0].status,'no-record');
  assert.equal(monthly.summarizeMonthly(data,'101')[0].status,'complete');
  assert.equal(monthly.summarizeMonthly(data,'missing')[0].status,'empty');
});
test('balances require every selected product exact month end or today and are never carried',()=>{
  const data=response({months:[row(),row({sku:'102',balance:7}),row({month:9,covered_days:11,record_days:11,balance:4,balance_date:TODAY})]});
  assert.equal(monthly.summarizeMonthly(data)[0].balance,27);assert.equal(monthly.summarizeMonthly(data)[1].balance,null);
  assert.equal(monthly.summarizeMonthly(data,'101')[8].balance_date,TODAY);
  assert.equal(monthly.summarizeMonthly(data)[8].balance,null);
});
test('render shows 12 months, signed chart values, escaped products and conservative labels',()=>{
  const html=monthly.render({kind:'ready',data:response({months:[row()]})},{year:2026});
  assert.equal((html.match(/data-month="/g)||[]).length,12);
  assert.match(html,/제품 &lt;A&gt;/);assert.doesNotMatch(html,/제품 <A>/);assert.match(html,/-4/);
  assert.match(html,/기록 소계/);assert.match(html,/미수집/);assert.match(html,/예정/);assert.match(html,/최신 기준/);assert.match(html,/전체 제품/);
});
function harness(options={}){
  const handlers={};let html='';const timers=new Map();let id=0;
  const host={addEventListener:(key,fn)=>handlers[key]=fn,querySelector:()=>null,get innerHTML(){return html;},set innerHTML(value){html=value;}};
  const doc={activeElement:null,getElementById:key=>key==='content'?host:key==='topbar-actions'?{innerHTML:''}:null};
  const ui=monthly.mount({document:doc,now:()=>Date.parse('2026-09-11T00:00:00Z'),read:async()=>response(),setTimeout:(fn,ms)=>{timers.set(++id,{fn,ms});return id;},clearTimeout:key=>timers.delete(key),timeoutMs:25,...options});
  return {ui,handlers,timers,html:()=>html};
}
const tick=()=>new Promise(setImmediate);
test('late annual reads cannot paint a new year; hide clears all bounded timers',async()=>{
  let finish;const h=harness({read:year=>year===2026?new Promise(resolve=>finish=resolve):Promise.resolve(response({year}))});
  const first=h.ui.show();await tick();h.handlers.change({target:{id:'monthly-year',value:'2025'}});await tick();
  assert.match(h.html(),/2025년 월별/);finish(response());await first;assert.match(h.html(),/2025년 월별/);
  h.ui.hide();assert.equal(h.timers.size,0);
});
test('read timeouts and wrong-year responses do not present data as ready',async()=>{
  const h=harness({read:()=>new Promise(()=>{})});const pending=h.ui.show();await tick();
  [...h.timers.values()].find(timer=>timer.ms===25).fn();await pending;assert.match(h.html(),/불러오지 못했습니다/);h.ui.hide();
  const wrong=harness({read:async()=>response({year:2025})});await wrong.ui.show();assert.match(wrong.html(),/불러오지 못했습니다/);wrong.ui.hide();
});
test('current inventory product link uses exact matching; ambiguous identity asks selection',async()=>{
  const h=harness();await h.ui.openProduct(catalog[0]);assert.match(h.html(),/value="101" selected/);h.ui.hide();
  const duplicate=harness({read:async()=>response({catalog:[catalog[0],{...catalog[0],sku:'103'}]})});await duplicate.ui.openProduct(catalog[0]);assert.match(duplicate.html(),/후보/);duplicate.ui.hide();
});
const batch=()=>({version:1,source:'wekeep',collected_at:new Date().toISOString(),from:TODAY,to:TODAY,catalog:[catalog[0]],products:[{sku:'101',days:[]}]});
test('ack alone cannot confirm save; original readback mismatch remains uncertain and writes once',async()=>{
  const source=batch();let writes=0,verifies=0;
  const h=harness({write:async()=>{writes++;return {saved:true,collected_at:source.collected_at,product_count:1,day_count:0};},verify:async()=>{verifies++;return {catalog:[],products:[],checked_at:new Date().toISOString()};}});
  await h.ui.show();h.handlers.input({target:{id:'monthly-payload',value:JSON.stringify(source)}});await h.ui.save();
  assert.equal(writes,1);assert.equal(verifies,1);assert.match(h.html(),/저장 여부 확인 필요/);assert.doesNotMatch(h.html(),/반영 완료/);h.ui.hide();
});
test('write timeout makes one bounded original readback and successful readback permits confirmation',async()=>{
  const source=batch();let verifies=0;
  const h=harness({write:()=>new Promise(()=>{}),verify:async()=>{verifies++;return {catalog:source.catalog,products:[{sku:'101',from:TODAY,to:TODAY,collected_at:source.collected_at,days:[]}],checked_at:new Date().toISOString()};}});
  await h.ui.show();h.handlers.input({target:{id:'monthly-payload',value:JSON.stringify(source)}});const saving=h.ui.save();await tick();
  [...h.timers.values()].find(timer=>timer.ms===25).fn();await saving;assert.equal(verifies,1);assert.match(h.html(),/저장 확인 완료/);h.ui.hide();assert.equal(h.timers.size,0);
});
test('hiding during a write cancels verification and prevents late completion repaint',async()=>{
  let finish,verifies=0;const source=batch();
  const h=harness({write:()=>new Promise(resolve=>finish=resolve),verify:async()=>{verifies++;}});
  await h.ui.show();h.handlers.input({target:{id:'monthly-payload',value:JSON.stringify(source)}});const saving=h.ui.save();await tick();
  h.ui.hide();const before=h.html();finish({saved:true,collected_at:source.collected_at,product_count:1,day_count:0});await saving;
  assert.equal(verifies,0);assert.equal(h.html(),before);assert.equal(h.timers.size,0);
});
test('unanswered authoritative readback is bounded and leaves the import available for review',async()=>{
  const source=batch();const h=harness({write:async()=>({saved:true,collected_at:source.collected_at,product_count:1,day_count:0}),verify:()=>new Promise(()=>{})});
  await h.ui.show();h.handlers.input({target:{id:'monthly-payload',value:JSON.stringify(source)}});const saving=h.ui.save();await tick();
  [...h.timers.values()].find(timer=>timer.ms===25).fn();await saving;assert.match(h.html(),/저장 여부 확인 필요/);assert.doesNotMatch(h.html(),/data-monthly-action="save" disabled/);h.ui.hide();
});
test('search filters products without silently changing aggregate scope; invalid years do not read',async()=>{
  let reads=0;const h=harness({read:async()=>{reads++;return response();}});await h.ui.show();
  h.handlers.input({target:{id:'monthly-search',value:'제품 B'}});assert.doesNotMatch(h.html(),/제품 &lt;A&gt;/);assert.match(h.html(),/전체 제품 \(2\)/);
  h.handlers.change({target:{id:'monthly-year',value:'1999'}});h.handlers.change({target:{id:'monthly-year',value:'2027'}});await tick();assert.equal(reads,1);h.ui.hide();
});
test('allowed collection clock skew up to five minutes remains readable',()=>{
  const data=response({months:[row({last_collected_at:'2026-09-10T15:04:00Z'})]});assert.doesNotThrow(()=>monthly.validateAnnual(data));
});
