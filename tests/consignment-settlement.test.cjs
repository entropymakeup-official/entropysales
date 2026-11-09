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
 return {select(columns,options){assert.equal(options.count,'exact');assert.equal(columns,'*');return this;},
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
test('summary card shows totals and issue count; page shows safe links only, escaped notes, never partial totals on error',()=>{
 const card=consign.render({status:'ready',rows:[row({note:'<b>메모</b>'})]},period,customers);
 assert.match(card,/id="dash-consignment"/);assert.match(card,/₩1,000/);assert.match(card,/₩700/);assert.match(card,/확인 필요 1건/);assert.match(card,/go\('consign'\)/);
 const filter={year:'2026',customer:'',issuesOnly:false};
 const page=consign.renderPage({status:'ready',rows:[row({evidence:{closing_url:'javascript:alert(1)',reconciliation_url:'https://docs.google.com/spreadsheets/d/x/edit',tax_invoice_url:'https://flex.team/workflow/archive/my?task-key=x'},note:'<b>메모</b>'})]},filter,customers,new Map([['가상 면세 A|2026-04-01',1100]]));
 assert.match(page,/id="consign-page"/);assert.match(page,/입금 대조/);assert.match(page,/세금계산서/);assert.doesNotMatch(page,/javascript:/);assert.doesNotMatch(page,/<b>메모/);
 assert.match(page,/대시보드 주문\(발주월\) ₩1,100/);
 assert.doesNotMatch(consign.render({status:'error',rows:[]},period,customers),/₩/);
 assert.doesNotMatch(consign.render({status:'ready',rows:[row(),row()]},period,customers),/₩/);
 assert.doesNotMatch(consign.renderPage({status:'ready',rows:[row(),row()]},filter,customers),/₩/);
 assert.match(consign.render({status:'ready',rows:[]},period,customers),/등록된 정산 자료가 없습니다/);
 const issuesOnly=consign.renderPage({status:'ready',rows:[row()]},{...filter,issuesOnly:true},customers);
 assert.match(issuesOnly,/consign-row-needs/);
});
test('checks: stock flow and continuity, deposit with or without VAT, evidence and verification',()=>{
 const ok=(x={})=>row({opening_stock_qty:5,in_qty:4,return_qty:1,sold_qty:1,ending_stock_qty:7,sold_supply:300,deposited_amount:300,
  evidence:{closing_url:'https://drive.google.com/file/d/a/view',tax_invoice_url:'https://flex.team/workflow/x'},verified_by:'tester',verified_at:'2026-11-09T00:00:00Z',...x});
 const pick=(rows,k)=>consign.checkRows(rows).map(r=>r.checks.find(c=>c.key===k).status);
 assert.deepEqual(consign.checkRows([ok()]).map(r=>r.status),['ok']);
 assert.deepEqual(pick([ok({ending_stock_qty:8})],'stock'),['fail']);
 assert.deepEqual(pick([ok({month:'2026-03-01',ending_stock_qty:4,opening_stock_qty:2,in_qty:3,return_qty:0,sold_qty:1}),ok()],'stock'),['ok','fail']);
 assert.deepEqual(pick([ok({month:'2026-03-01',ending_stock_qty:5,opening_stock_qty:2,in_qty:4,return_qty:0,sold_qty:1}),ok()],'stock'),['ok','ok']);
 assert.deepEqual(pick([ok({opening_stock_qty:null})],'stock'),['missing']);
 assert.deepEqual(pick([ok({sold_supply:1000000,deposited_amount:1100000})],'deposit'),['ok']);
 assert.deepEqual(pick([ok({sold_supply:10349068,deposited_amount:11383693})],'deposit'),['ok']);
 assert.deepEqual(pick([ok({deposited_amount:500})],'deposit'),['fail']);
 assert.deepEqual(pick([ok({deposited_amount:500,note:'환급 포함'})],'deposit'),['explained']);
 assert.deepEqual(pick([ok({deposited_amount:null,deposited_date:null})],'deposit'),['pending']);
 assert.deepEqual(pick([ok({evidence:{closing_url:'https://drive.google.com/file/d/a/view'}})],'invoice'),['missing']);
 assert.deepEqual(pick([ok({stocked_supply:0,evidence:{closing_url:'https://drive.google.com/file/d/a/view'}})],'invoice'),['na']);
 assert.deepEqual(pick([ok({verified_by:null,verified_at:null})],'verified'),['missing']);
 assert.throws(()=>consign.summarize([ok({verified_at:null})],period,customers));
 assert.throws(()=>consign.summarize([ok({in_qty:-1})],period,customers));
});
test('order reference totals use Paid items by order month and skip cancelled orders without touching inputs',()=>{
 const invoices=[{id:'a',customer:'가상 면세 A',order_date:'2026-04-10',status:'Paid'},{id:'b',customer:'가상 면세 A',order_date:'2026-04-20',status:'Cancelled'},{id:'c',customer:'가상 면세 A',order_date:'2026-05-01',status:'Paid'}];
 const items=[{invoice_id:'a',sales_type:'Paid',qty:2,price:100},{invoice_id:'a',sales_type:'FOC',qty:5,price:100},{invoice_id:'b',sales_type:'Paid',qty:1,price:999},{invoice_id:'c',sales_type:'Paid',qty:1,price:50}];
 const before=JSON.stringify([invoices,items]);
 const t=consign.orderTotals(invoices,items,i=>i.qty*i.price);
 assert.equal(t.get('가상 면세 A|2026-04-01'),200);assert.equal(t.get('가상 면세 A|2026-05-01'),50);
 assert.equal(JSON.stringify([invoices,items]),before);
});
