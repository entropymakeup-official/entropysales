const {test}=require('node:test');
const assert=require('node:assert/strict');
const consign=require('../consignment-settlement.js');
// 가상 거래처·금액만 사용한다.
const customers=[{id:'s1',name:'가상 면세 A'},{id:'s2',name:'가상 면세 B'}];
const period={start:'2026-03-15',end:'2026-04-10'};
const row=(x={})=>({customer_id:'s1',month:'2026-04-01',stocked_supply:'1000',sold_supply:'300',deposited_amount:'330',deposited_date:'2026-05-10',
 ending_stock_qty:7,ending_stock_supply:'700',evidence:{closing_url:'https://drive.google.com/file/d/fixture/view',reconciliation_url:'https://docs.google.com/spreadsheets/d/fixture/edit'},note:null,...x});
function client(pages){
 const calls=[];return {calls,from(table){assert.equal(table,'consignment_settlements');let sort=[];
 return {select(columns,options){assert.equal(options.count,'exact');assert.match(columns,/ending_stock_supply/);return this;},
 order(key){sort.push(key);return this;},range(from,to){assert.deepEqual(sort,['month','customer_id']);calls.push([from,to]);
 const page=pages[calls.length-1];if(page instanceof Error)return Promise.reject(page);return page;}};}};
}
test('months overlapping the period are summed; unsettled balance uses each store\'s latest month in range',()=>{
 const rows=[row(),row({month:'2026-03-01',stocked_supply:500,sold_supply:200,deposited_amount:null,deposited_date:null,ending_stock_qty:2,ending_stock_supply:200}),
  row({customer_id:'s2',month:'2026-03-01',stocked_supply:-100,sold_supply:50,deposited_amount:55,ending_stock_qty:1,ending_stock_supply:90}),
  row({month:'2026-05-01'}),row({month:'2026-02-01'})];
 const before=JSON.stringify(rows),s=consign.summarize(rows,period,customers);
 assert.equal(s.rows.length,3);assert.equal(s.totalRegistered,5);
 assert.equal(s.stocked,1400);assert.equal(s.sold,550);assert.equal(s.deposited,385);assert.equal(s.missingDeposits,1);
 assert.equal(s.stock,790);assert.equal(s.stockQty,8);
 const b=consign.summarize(rows,{...period,customer:'가상 면세 B'},customers);
 assert.equal(b.rows.length,1);assert.equal(b.stock,90);
 assert.equal(JSON.stringify(rows),before);
});
test('malformed months, amounts, deposits and duplicates are rejected',()=>{
 for(const bad of [row({month:'2026-04-02'}),row({month:'2026-02-30'}),row({stocked_supply:null}),row({sold_supply:''}),row({ending_stock_supply:-1}),
  row({ending_stock_qty:1.5}),row({deposited_date:null}),row({deposited_amount:null}),row({deposited_date:'2026-13-01'}),row({customer_id:''})])
  assert.throws(()=>consign.summarize([bad],period,customers));
 assert.throws(()=>consign.summarize([row(),row()],period,customers),/중복/);
});
test('load reads every page and refuses partial or failed reads',async()=>{
 const pages=[{data:[row()],count:2,error:null},{data:[row({month:'2026-03-01'})],count:2,error:null}];
 const ok=await consign.load(client([...pages,...pages]));assert.equal(ok.status,'ready');assert.equal(ok.rows.length,2);
 for(const bad of [[{data:[row()],count:2,error:null},{data:[],count:2,error:null}],[{data:null,count:null,error:{message:'denied'}}],[new Error('boom')]]){
  const s=await consign.load(client(bad));assert.equal(s.status,'error');assert.deepEqual(s.rows,[]);
 }
});
test('render shows totals, safe links only, and never a partial total on error',()=>{
 const html=consign.render({status:'ready',rows:[row({evidence:{closing_url:'javascript:alert(1)',reconciliation_url:'https://docs.google.com/spreadsheets/d/x/edit'},note:'<b>메모</b>'})]},period,customers);
 assert.match(html,/id="dash-consignment"/);assert.match(html,/₩1,000/);assert.match(html,/₩700/);
 assert.match(html,/입금 대조/);assert.doesNotMatch(html,/javascript:/);assert.doesNotMatch(html,/<b>메모/);
 assert.doesNotMatch(consign.render({status:'error',rows:[]},period,customers),/₩/);
 assert.doesNotMatch(consign.render({status:'ready',rows:[row(),row()]},period,customers),/₩/);
 assert.match(consign.render({status:'ready',rows:[]},period,customers),/등록된 정산 자료가 없습니다/);
});
