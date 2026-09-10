const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const historyFile=path.join(__dirname,'../inventory-history.js');
const history=fs.existsSync(historyFile)?require(historyFile):{};
const live=require('../live-inventory.js');
const NOW='2026-09-10T06:00:00.000Z';

function day(date,extra={}){
  return {date,inbound:0,returned:0,faulty:0,damaged:0,outbound:0,balance:10,...extra};
}
function batch(extra={}){
  return {
    version:1,source:'wekeep',collected_at:'2026-09-10T05:55:00.000Z',from:'2026-08-12',to:'2026-09-10',
    catalog:[
      {sku:'101',name:'제품 A',code:'DUP',supplier:'공급처'},
      {sku:'102',name:'제품 B',code:'DUP',supplier:'공급처'}
    ],
    products:[{
      sku:'101',days:[
        day('2026-09-08',{inbound:5,balance:15}),
        day('2026-09-10',{outbound:-3,balance:12})
      ]
    }],
    ...extra
  };
}
function response(extra={}){
  const source=batch();
  return {
    catalog:source.catalog,
    products:source.products.map(product=>({sku:product.sku,from:source.from,to:source.to,collected_at:source.collected_at,days:product.days})),
    checked_at:NOW,
    ...extra
  };
}

test('validateBatch accepts signed quantities, duplicate management codes and missing dates without adding zero rows',()=>{
  assert.equal(typeof history.validateBatch,'function');
  const checked=history.validateBatch(batch(),NOW);
  assert.deepEqual(checked.products[0].days.map(item=>item.date),['2026-09-08','2026-09-10']);
  assert.equal(checked.products[0].days[1].outbound,-3);
  assert.equal(checked.catalog[0].code,checked.catalog[1].code);
});

test('validateBatch rejects duplicate dates, invalid calendar dates and dates outside the requested window',()=>{
  for(const days of [
    [day('2026-09-08'),day('2026-09-08')],
    [day('2026-02-30')],
    [day('2026-08-11')]
  ]) assert.throws(()=>history.validateBatch(batch({products:[{sku:'101',days}]}),NOW),/날짜/);
});

test('validateBatch enforces exact keys, unique digit SKUs and catalog membership',()=>{
  assert.throws(()=>history.validateBatch({...batch(),extra:true},NOW),/알 수 없는/);
  assert.throws(()=>history.validateBatch(batch({catalog:[...batch().catalog,{sku:'101',name:'중복',code:'',supplier:''}]}),NOW),/SKU/);
  assert.throws(()=>history.validateBatch(batch({catalog:[{sku:'A1',name:'제품',code:'',supplier:''}],products:[]}),NOW),/SKU/);
  assert.throws(()=>history.validateBatch(batch({products:[{sku:'999',days:[]}]}),NOW),/카탈로그/);
  assert.throws(()=>history.validateBatch(batch({products:[{sku:'101',days:[{...day('2026-09-08'),memo:'x'}]}]}),NOW),/알 수 없는/);
});

test('validateBatch enforces a 1-31 day exact date window and fresh collection timestamp',()=>{
  assert.throws(()=>history.validateBatch(batch({from:'2026-08-10'}),NOW),/31일/);
  assert.throws(()=>history.validateBatch(batch({from:'2026-09-11'}),NOW),/기간/);
  assert.throws(()=>history.validateBatch(batch({collected_at:'2026-09-09T05:59:59.999Z'}),NOW),/24시간/);
  assert.throws(()=>history.validateBatch(batch({collected_at:'2026-09-10T06:05:00.001Z'}),NOW),/미래/);
});

test('filterHistory applies inclusive dates and a nonzero category filter without inventing missing days',()=>{
  const got=history.filterHistory(response(),{sku:'101',from:'2026-09-08',to:'2026-09-10',type:'outbound'});
  assert.deepEqual(got.map(item=>item.date),['2026-09-10']);
  assert.equal(got[0].outbound,-3);
  assert.equal(got.some(item=>item.date==='2026-09-09'),false);
  assert.deepEqual(history.filterHistory(response(),{sku:'101',from:'2026-09-08',to:'2026-09-10',type:'inbound'}).map(item=>item.date),['2026-09-08']);
});

test('summaries label collected-record totals and coverage separately from absent source dates',()=>{
  const summary=history.summarizeHistory(response(),{sku:'101',from:'2026-09-08',to:'2026-09-10',type:'all'});
  assert.deepEqual(summary.totals,{inbound:5,returned:0,faulty:0,damaged:0,outbound:-3});
  assert.equal(summary.recordCount,2);
  assert.deepEqual(summary.missingDates,['2026-09-09']);
  assert.deepEqual(history.summarizeCoverage(response()),{collected:1,total:2});
});

test('dates outside a product collection window are distinct from missing source records inside that window',()=>{
  const partialWindow=response({products:[{sku:'101',from:'2026-09-09',to:'2026-09-10',collected_at:'2026-09-10T05:55:00.000Z',days:[day('2026-09-10')]}]});
  const summary=history.summarizeHistory(partialWindow,{sku:'101',from:'2026-09-08',to:'2026-09-10',type:'all'});
  assert.deepEqual(summary.outsideDates,['2026-09-08']);
  assert.deepEqual(summary.missingDates,['2026-09-09']);
  const html=history.render({kind:'ready',data:partialWindow},{sku:'101',from:'2026-09-08',to:'2026-09-10'});
  assert.match(html,/2026-09-08 수집 범위 밖/);
  assert.match(html,/2026-09-09 기록 없음/);
});

test('matchCatalog links only a unique exact name, code and supplier triple',()=>{
  const catalog=[
    {sku:'101',name:'같은 제품',code:'DUP',supplier:'A'},
    {sku:'102',name:'같은 제품',code:'DUP',supplier:'A'},
    {sku:'103',name:'같은 제품',code:'DUP',supplier:'B'}
  ];
  assert.deepEqual(history.matchCatalog({name:'같은 제품',code:'DUP',supplier:'B'},catalog),{kind:'matched',sku:'103',matches:[catalog[2]]});
  const ambiguous=history.matchCatalog({name:'같은 제품',code:'DUP',supplier:'A'},catalog);
  assert.equal(ambiguous.kind,'ambiguous');
  assert.deepEqual(ambiguous.matches.map(item=>item.sku),['101','102']);
  assert.equal('sku' in ambiguous,false);
  assert.equal(history.matchCatalog({name:' 같은 제품',code:'DUP',supplier:'B'},catalog).kind,'missing');
});

test('deriveStatus rejects malformed reads and marks history stale at the separate 180-minute threshold',()=>{
  assert.equal(history.deriveStatus(response(),NOW).kind,'ready');
  const stillCurrent=response({products:[...response().products,{sku:'102',from:'2026-08-12',to:'2026-09-10',collected_at:'2026-09-10T03:00:00.001Z',days:[]}]});
  assert.equal(history.deriveStatus(stillCurrent,NOW).kind,'ready');
  const stale=response({products:[...response().products,{sku:'102',from:'2026-08-12',to:'2026-09-10',collected_at:'2026-09-10T03:00:00.000Z',days:[]}]});
  assert.equal(history.deriveStatus(stale,NOW).kind,'stale');
  assert.equal(history.deriveStatus({...response(),checked_at:'bad'},NOW).kind,'failed');
  assert.equal(history.deriveStatus({...response(),catalog:[{sku:'bad',name:'x',code:'',supplier:''}]},NOW).kind,'failed');
});

test('render distinguishes empty, partial and failed states and keeps the import controls collapsed',()=>{
  const empty=history.render({kind:'empty',data:{catalog:[],products:[],checked_at:NOW}});
  assert.match(empty,/아직 수집된 입출고 이력이 없습니다/);
  assert.match(empty,/<summary>입출고 수집 자료 반영<\/summary>/);
  assert.match(empty,/aria-label="입출고 수집 자료"/);
  assert.match(empty,/>입출고 검증 후 반영</);
  const partial=history.render({kind:'ready',data:response()},{sku:'101',from:'2026-09-08',to:'2026-09-10'});
  assert.match(partial,/수집된 기록 합계/);
  assert.match(partial,/수집 범위<\/strong> 1 \/ 전체 2개 제품/);
  assert.match(partial,/2026-09-09[^<]*기록 없음/);
  assert.match(partial,/aria-label="일별 입출고 이력"/);
  assert.match(partial,/입고\/출고 추이/);
  assert.match(partial,/잔고 추이/);
  assert.match(partial,/반품입고/);
  assert.match(partial,/하자입고/);
  assert.match(partial,/불량입고/);
  assert.match(partial,/입출고 이력 순환 수집 · 전체 약 2시간/);
  assert.doesNotMatch(partial,/해외 판매/);
  assert.match(history.render({kind:'failed'}),/입출고 이력을 불러오지 못했습니다/);
});

test('render requires an explicit product selection before showing product-only charts',()=>{
  const html=history.render({kind:'ready',data:response()},{from:'2026-09-08',to:'2026-09-10'});
  assert.match(html,/제품을 선택하면 일별 추이/);
  assert.doesNotMatch(html,/aria-label="입고\/출고 추이"/);
});

function controllerHarness(read,now=()=>NOW){
  const paints=[],timers=new Map();let timerId=0;
  const controller=history.createController({read,render:value=>paints.push(value),now,timeoutMs:25,
    setTimeout:(fn,ms)=>{timers.set(++timerId,{fn,ms});return timerId;},clearTimeout:id=>timers.delete(id)});
  return {controller,paints,timers};
}
function fireTimer(h,ms){
  const found=[...h.timers.entries()].find(([,timer])=>timer.ms===ms);
  assert.ok(found,`expected ${ms}ms timer`);h.timers.delete(found[0]);found[1].fn();
}

test('read timeout retains cached history as failed data, never labels it fresh, and polling stops on hide',async()=>{
  let calls=0,finish;
  const h=controllerHarness(()=>++calls===1?Promise.resolve(response()):new Promise(resolve=>finish=resolve));
  await h.controller.show();
  const refresh=h.controller.refresh(true);await Promise.resolve();fireTimer(h,25);await refresh;
  assert.equal(h.paints.at(-1).kind,'failed');
  assert.equal(h.paints.at(-1).previous.kind,'ready');
  const html=history.render(h.paints.at(-1));
  assert.match(html,/마지막 확인 성공 자료/);
  assert.doesNotMatch(html,/상태 최신/);
  assert.ok([...h.timers.values()].some(timer=>timer.ms===60000));
  h.controller.hide();assert.equal(h.timers.size,0);
  finish(response());await Promise.resolve();
});

test('save acknowledgement must match timestamp, product count and actual day count',()=>{
  const source=batch();
  assert.deepEqual(history.validateSaveResult({saved:true,collected_at:source.collected_at,product_count:1,day_count:2},source),{saved:true,collected_at:source.collected_at,product_count:1,day_count:2});
  for(const ack of [null,{saved:true,collected_at:source.collected_at,product_count:2,day_count:2},{saved:true,collected_at:source.collected_at,product_count:1,day_count:30}]){
    assert.throws(()=>history.validateSaveResult(ack,source),/저장 확인/);
  }
});

test('authoritative readback confirms date-sorted storage without mutating descending input or depending on object key order',()=>{
  const source=batch({products:[{sku:'101',days:[
    day('2026-09-10',{outbound:-3,balance:12}),
    day('2026-09-08',{inbound:5,balance:15})
  ]}]});
  const before=JSON.stringify(source);
  const stored=response({products:[{
    days:[
      {balance:15,outbound:0,damaged:0,faulty:0,returned:0,inbound:5,date:'2026-09-08'},
      {balance:12,outbound:-3,damaged:0,faulty:0,returned:0,inbound:0,date:'2026-09-10'}
    ],collected_at:source.collected_at,to:source.to,from:source.from,sku:'101'
  }]});
  assert.equal(history.confirmsBatch(stored,source),true);
  assert.equal(JSON.stringify(source),before);
});

test('current inventory rows pass exact identity to history instead of choosing by management code',()=>{
  const current={version:1,source:'wekeep',collected_at:'2026-09-10T05:55:00.000Z',expected_count:1,rows:[{name:'제품 A',code:'DUP',supplier:'공급처',available:1,safety:0,held:0,defective:0}]};
  const html=live.render({kind:'ready',snapshot:current,checked_at:NOW});
  assert.match(html,/data-inventory-history="0"/);
  let received=null;
  const handlers={};let painted='';
  const host={addEventListener:(name,fn)=>handlers[name]=fn,querySelector:()=>null,get innerHTML(){return painted;},set innerHTML(v){painted=v;}};
  const doc={activeElement:null,getElementById:id=>id==='content'?host:id==='topbar-actions'?{innerHTML:''}:null};
  const ui=live.mount({document:doc,read:async()=>({snapshot:current,checked_at:NOW}),write:async()=>null,onHistory:identity=>received=identity});
  return ui.show().then(()=>{
    handlers.click({target:{closest:selector=>selector==='[data-inventory-history]'?{dataset:{inventoryHistory:'0'}}:null}});
    assert.deepEqual(received,{name:'제품 A',code:'DUP',supplier:'공급처'});
    ui.hide();
  });
});

test('write timeout performs one bounded readback, does not resubmit, and leaves an uncertain message when unconfirmed',async()=>{
  const handlers={},timers=new Map();let timerId=0,html='',writeCalls=0,readCalls=0;
  const host={addEventListener:(name,fn)=>handlers[name]=fn,querySelector:()=>null,get innerHTML(){return html;},set innerHTML(value){html=value;}};
  const payloadNode={id:'history-payload',value:''};
  const doc={activeElement:null,getElementById:id=>id==='content'?host:id==='topbar-actions'?{innerHTML:''}:id==='history-payload'?payloadNode:null};
  const ui=history.mount({document:doc,timeoutMs:25,setTimeout:(fn,ms)=>{timers.set(++timerId,{fn,ms});return timerId;},clearTimeout:id=>timers.delete(id),
    read:async()=>{readCalls++;return {catalog:[],products:[],checked_at:new Date().toISOString()};},write:()=>{writeCalls++;return new Promise(()=>{});}});
  await ui.show();
  const source=batch({collected_at:new Date().toISOString()});payloadNode.value=JSON.stringify(source);handlers.input({target:payloadNode});
  handlers.click({target:{closest:()=>({dataset:{historyAction:'save'}})}});await Promise.resolve();
  fireTimer({timers},25);await new Promise(setImmediate);
  assert.equal(writeCalls,1);assert.equal(readCalls,2);
  assert.match(html,/저장 여부 확인 필요/);assert.match(html,/자동 재전송하지 않았습니다/);
  assert.doesNotMatch(html,/data-history-action="save" disabled/);
  ui.hide();
});
