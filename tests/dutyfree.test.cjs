const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const file=path.join(__dirname,'../dutyfree.js');
// 가상 상품·가상 금액·가상 계약 조건만 사용한다.
const t=(cols,rows)=>({cols,rows});
function fixture(){
 return {version:1,source:'dutyfree',generated_at:'2026-02-04T06:40:00+09:00',data_through:{lotte:'2026-02-02',shinsegae:'2026-02-03'},
  config:{agency_rate:0.1,vat:0.1,contract_fee_rate:0.5,agency_label:'대행사',fixed:[{label:'고정비',channel:'신세계 오프라인',from:'2026-02',to:null,amount:1000}]},
  tables:{
   daily:t(['date','channel','product','category','qty','amt','krw'],[
    ['2026-01-15','신세계 온라인','상품 A','립',9,90,90000],
    ['2026-02-01','신세계 온라인','상품 A','립',2,20,20000],
    ['2026-02-02','롯데 온라인','상품 A','립',1,11,12100],
    ['2026-02-03','신세계 오프라인','상품 B','아이',1,5,5000]]),
   sales:t(['month','group','channel','product','category','qty','amt','price','stock','stock_amt','partial'],[
    ['2026-01','신세계','신세계 온라인','상품 A','립',2,20,10,5,50,false],
    ['2026-01','롯데','롯데','상품 A','립',1,11,11,3,33,false],
    ['2026-02','신세계','신세계 온라인','상품 A','립',1,10,10,4,40,true]]),
   settle:t(['month','channel','product','category','qty','amt','rate','amt_krw','unit_cost','supply','fee','agency','cogs_unit','cogs','net','official'],[
    ['2026-01','롯데','상품 A','립',1,11,1100,12100,6000,6000,6100,0,1000,1000,0,true],
    ['2026-02','신세계 온라인','상품 A','립',2,20,1000,20000,5000,10000,10000,0,1000,2000,0,true],
    ['2026-02','신세계 오프라인','상품 B','아이',1,5,1000,5000,2500,2500,2500,0,null,null,0,true]]),
   fx:t(['month','channel','rate'],[['2026-01','신세계 온라인',1000],['2026-01','롯데',1100],['2026-02','신세계 온라인',1000],['2026-02','롯데',1100]]),
   purchase:t(['month','date','kind','qty_in','cost_in','qty_rtn','cost_rtn','supply_in','vat','total','sales_supply'],[
    ['2026-01',null,'월합계',10,60000,0,0,60000,6000,66000,5500],
    ['2026-01','20260105','입고',10,60000,0,0,null,null,null,null]])}};
}
const load=(today=new Date(2026,1,10))=>{const m=require(file);const model=m.buildModel(fixture(),today);m.applyCurrency(model,'USD');return {m,model};};
const st=(o={})=>({from:'2026-02',to:'2026-02',cmp:'none',ch:'전체',...o});

test('decode keeps full months from the file and rebuilds partial or missing months from daily rows per channel group',()=>{
 assert.ok(fs.existsSync(file),'dutyfree module must exist');const {m,model}=load();
 const jan=model.ALL.filter(r=>r.month==='2026-01');
 assert.equal(m.agg(jan).qty,3,'full January ignores daily rows');
 const feb=model.ALL.filter(r=>r.month==='2026-02');
 const ssOn=feb.find(r=>r.channel==='신세계 온라인');assert.deepEqual([ssOn.qty,ssOn.amt_usd,ssOn.stock,ssOn.fromFile],[2,20,4,true],'partial file row: daily sales, file stock');
 const ssOff=feb.find(r=>r.channel==='신세계 오프라인');assert.deepEqual([ssOff.qty,ssOff.amt_usd,ssOff.stock,ssOff.fromFile],[1,5,0,false]);
 const lt=feb.find(r=>r.channel==='롯데');assert.deepEqual([lt.qty,lt.amt_usd,lt.amt_krw],[1,11,12100],'롯데 온라인 is normalized and synthesized');
 assert.deepEqual(model.MONTHS,['2026-01','2026-02']);assert.deepEqual(model.STOCK_MONTHS,['2026-01','2026-02']);
 assert.equal(model.currentMonth,'2026-02');assert.equal(m.buildModel(fixture(),new Date(2026,6,1)).currentMonth,'2026-02','falls back to the latest month');
 m.applyCurrency(model,'KRW');assert.equal(m.agg(model.ALL.filter(r=>r.month==='2026-01')).amt,20000+12100,'KRW uses month and channel fx');
});

test('settlement uses snapshot config for agency fee with VAT, fixed cost by channel, and flags missing COGS',()=>{
 const {m,model}=load();
 const S=m.settleView(model,st());
 assert.deepEqual([S.cur.krw,S.cur.supply,S.cur.fee,S.cur.agency,S.cur.cogs,S.cur.fixed,S.cur.contrib],[25000,12500,12500,2750,2000,1000,6750]);
 assert.deepEqual([...S.noCogs],[['상품 B',1]]);
 assert.equal(m.settleView(model,st({ch:'신세계 온라인'})).cur.fixed,0,'fixed cost stays on its own channel');
 const cfg=fixture();cfg.config.agency_rate=0.2;const other=m.buildModel(cfg,new Date(2026,1,10));m.applyCurrency(other,'USD');
 assert.equal(m.settleView(other,st()).cur.agency,5500,'rate comes from the snapshot, not the code');
 const L=m.settleView(model,st({from:'2026-01',to:'2026-01'})).lotte;assert.equal(L.show,true);assert.deepEqual([L.rows[0].srm,L.rows[0].supply,L.rows[0].diff],[5500,6000,-500]);assert.equal(L.events.length,1);
 assert.equal(m.settleView(model,st({ch:'신세계 온라인'})).lotte.show,false);
});

test('latest day compares channels by their own last sale and excludes lagging channels from the total',()=>{
 const {m,model}=load();const L=m.latestDay(model,st());
 assert.equal(L.latest,'2026-02-03');assert.deepEqual(L.onLatest.map(p=>p.c.id),['신세계 오프라인']);assert.equal(L.tot.amt,5);
 assert.deepEqual(L.behind.map(p=>p.c.id).sort(),['롯데','신세계 온라인']);
 const on=L.perCh.find(p=>p.c.id==='신세계 온라인');assert.equal(on.d0,'2026-02-01');assert.equal(on.d1,'2026-01-15');
 assert.deepEqual(m.latestDay(model,st({ch:'롯데'})).perCh.map(p=>p.d0),['2026-02-02']);
});

test('stock uses each group latest file snapshot and labels mid-month downloads',()=>{
 const {m,model}=load();const K=m.stockView(model,st({from:'2026-01'}));
 assert.deepEqual([K.last.ss_stock,K.last.lt_stock,K.last.stock],[4,3,7]);
 assert.equal(K.ssLabel,'2026-02 파일 다운로드 시점');assert.equal(K.ltLabel,'2026-01 월말');
 const a=K.prods.find(p=>p.product==='상품 A');assert.equal(a.stock,7);
 const D=m.dailyView(model,st());assert.equal(D.days.length,3);assert.equal(D.best.date,'2026-02-01');
});

test('snapshot validation rejects missing tables, bad config and malformed rows',()=>{
 const m=require(file);
 assert.throws(()=>m.buildModel(null),/조회 가능한/);
 const a=fixture();delete a.tables.fx;assert.throws(()=>m.buildModel(a),/fx/);
 const b=fixture();b.config.fixed=null;assert.throws(()=>m.buildModel(b),/설정값/);
 const c=fixture();c.tables.daily.rows.push(['2026-02-04']);assert.throws(()=>m.buildModel(c),/daily 행/);
 assert.equal(m.esc('<img src=x onerror="a">&'),'&lt;img src=x onerror=&quot;a&quot;&gt;&amp;');
});

test('public module holds no contract terms or sales data',()=>{
 const src=fs.readFileSync(file,'utf8');
 for(const re of [/0\.05\b/,/0\.53\b/,/2,?750,?000/,/275만/,/\b53%/])assert.doesNotMatch(src,re);
});

test('navigation or logout during load discards stale data; failures can be retried',async()=>{
 const m=require(file);let resolve;
 const c=m.controller(()=>new Promise(r=>{resolve=r;}));const pending=c.load();c.clear();resolve({snapshot:fixture()});await pending;
 assert.equal(c.state.model,null);assert.equal(c.state.loading,false);
 let fail=true;const d=m.controller(async()=>{if(fail)throw Error('denied');return {snapshot:fixture()};});
 await d.load();assert.equal(d.state.model,null);assert.equal(d.state.error,'denied');fail=false;await d.load();assert.ok(d.state.model);assert.equal(d.state.error,'');
 const e=m.controller(async()=>({snapshot:null}));await e.load();assert.match(e.state.error,/조회 가능한/);
});
