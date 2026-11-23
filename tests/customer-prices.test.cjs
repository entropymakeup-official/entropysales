const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const CP=require('../customer-prices.js');
const {harness}=require('./helpers/approvals.cjs');

const CR={id:'cr',name:'코마렉스',supply_rate:'35'},STC={id:'stc',name:'스타일앤코',supply_rate:'32'};
const TINT={barcode:'8800000000001',name:'참 틴트',price:18000};
const ROWS=[{id:'p1',customer_id:'cr',barcode:'8800000000001',retail_price:21000,note:'11/03 가격표'}];

test('supply price uses the customer base retail price when present, otherwise RSP',()=>{
 assert.deepEqual(CP.supplyPrice({customer:CR,product:TINT,barcode:' 8800000000001 ',rows:ROWS}),{price:7350,retail:21000,rate:35,source:'customer',note:'11/03 가격표',rsp:18000});
 assert.equal(CP.supplyPrice({customer:STC,product:TINT,barcode:TINT.barcode,rows:ROWS}).price,5760);
 assert.equal(CP.supplyPrice({customer:CR,product:{barcode:'x',price:10000},barcode:'x',rows:ROWS}).source,'rsp');
 // No rate → no calculated price (keeps the previous behaviour).
 assert.equal(CP.supplyPrice({customer:{id:'cr'},product:TINT,barcode:TINT.barcode,rows:ROWS}).price,null);
 // Unmapped barcode can still be priced from the customer table.
 assert.equal(CP.supplyPrice({customer:CR,product:null,barcode:TINT.barcode,rows:ROWS}).price,7350);
 assert.equal(CP.supplyPrice({customer:null,product:TINT,barcode:TINT.barcode,rows:undefined}).price,null);
});

test('paste parser reads tab separated rows with thousands separators and skips headers',()=>{
 const r=CP.parsePaste('바코드\t소비자가\n8800000000001\t21,000\t11/03 가격표\n\n8800000000002\t₩23,000\n');
 assert.deepEqual(r.rows,[{barcode:'8800000000001',retail_price:21000,note:'11/03 가격표'},{barcode:'8800000000002',retail_price:23000,note:''}]);
 assert.equal(r.errors.length,0);
 assert.equal(CP.parsePaste('8800000000001\t0\n8800000000002\tabc').errors.length,2);
});

test('planChanges emits insert/update/delete only for real differences and validates rows',()=>{
 const before=[...ROWS,{id:'p2',customer_id:'cr',barcode:'8800000000002',retail_price:23000,note:''},{id:'x',customer_id:'stc',barcode:'8800000000001',retail_price:18000,note:''}];
 const unchanged=CP.planChanges({customerId:'cr',before,draft:[{id:'p1',barcode:'8800000000001',retail_price:'21000',note:'11/03 가격표'},{id:'p2',barcode:'8800000000002',retail_price:23000,note:''}]});
 assert.deepEqual(unchanged,{errors:[],changes:[]});
 const plan=CP.planChanges({customerId:'cr',before,draft:[{id:'p1',barcode:'8800000000001',retail_price:'21,500',note:'11/20 인상'},{barcode:'8800000000003',retail_price:19000,note:''},{barcode:'',retail_price:'',note:''}]});
 assert.deepEqual(plan.errors,[]);
 assert.deepEqual(plan.changes.map(c=>[c[1],c[2].id||null]),[['delete','p2'],['update','p1'],['insert',null]]);
 assert.deepEqual(plan.changes[1][3],{retail_price:21500,note:'11/20 인상'});
 assert.equal(plan.changes[1][4],before[0]);
 assert.deepEqual(plan.changes[2][3],{customer_id:'cr',barcode:'8800000000003',retail_price:19000,note:''});
 // Other customers' rows are never touched.
 assert.ok(plan.changes.every(c=>c[2].id!=='x'));
 for(const draft of [[{barcode:'',retail_price:100}],[{barcode:'1',retail_price:0}],[{barcode:'1',retail_price:'abc'}],[{barcode:'1',retail_price:1},{barcode:'1',retail_price:2}]]){
  const r=CP.planChanges({customerId:'cr',before,draft});assert.ok(r.errors.length>0,JSON.stringify(draft));assert.equal(r.changes.length,0);
 }
});

function entryRow(barcode){
 const cells={};const el=(col,extra={})=>(cells[col]={value:'',textContent:'',readOnly:false,style:{},title:'',...extra});
 const rate={textContent:''};
 el('0',{value:barcode});el('1');el('2');el('5',{closest:()=>({querySelector:()=>rate})});el('6');
 const tr={querySelector:sel=>{const m=sel.match(/data-col="(\d)"\](?: (input))?/);if(!m)return null;return cells[m[1]];}};
 return {tr,cells,rate};
}

test('order entry auto price uses the customer base retail price and labels the basis',()=>{
 const h=harness();h.ctx.CustomerPrices=CP;h.ctx.fmt=n=>Number(n).toLocaleString('en-US');h.ctx.fmtExact=n=>String(n);
 h.load('customerSupplyPrice','supplyRateLabel','xgParseBarcode','xgCalcAmt');
 h.ctx._products=[TINT,{barcode:'8800000000009',name:'Other',price:10000}];h.ctx._customers=[CR,STC];
 h.ctx._customerRetailPrices=ROWS;
 h.element('rm-cust').value='코마렉스';
 let r=entryRow('8800000000001');h.ctx.xgParseBarcode(r.tr);
 assert.equal(r.cells['5'].value,7350);assert.equal(r.cells['2'].textContent,'21,000');assert.match(r.rate.textContent,/35% · 거래처 기준가/);
 r=entryRow('8800000000009');h.ctx.xgParseBarcode(r.tr);assert.equal(r.cells['5'].value,3500);assert.equal(r.rate.textContent,'(35%)');
 h.element('rm-cust').value='스타일앤코';
 r=entryRow('8800000000001');h.ctx.xgParseBarcode(r.tr);assert.equal(r.cells['5'].value,5760);assert.equal(r.cells['2'].textContent,'18,000');
});

test('customer save bundles base retail price changes into one change request and skips an unchanged customer row',async()=>{
 const h=harness();h.ctx.CustomerPrices=CP;h.ctx.fmt=String;
 h.load('saveCust','renderCustRetailEditor','custRetailSet','custRetailAdd','custRetailChanges');
 const cust={id:'cr',name:'코마렉스',code:'CR',mgr:'liah',country:'',tax:'영세',biz:'',addr:'',ceo:'',contact:'',phone:'',email:'',biz_type:'',note:'',status:'거래중',supply_rate:35};
 h.ctx._customers=[cust];h.ctx._customerRetailPrices=ROWS;
 for(const [k,v] of Object.entries({name:'코마렉스',code:'CR',mgr:'liah',country:'',tax:'영세',biz:'',addr:'',ceo:'',contact:'',phone:'',email:'','biz-type':'',note:'',status:'거래중','supply-rate':'35'}))h.element('c-'+k).value=v;
 h.ctx._editCust=JSON.parse(JSON.stringify(cust));
 h.ctx.renderCustRetailEditor('cr');
 h.ctx.custRetailAdd();h.ctx.custRetailSet(1,'barcode','8800000000002');h.ctx.custRetailSet(1,'retail_price','23000');
 await h.ctx.saveCust();
 assert.equal(h.calls.length,1);
 const ops=h.calls[0].args.p_operations;
 assert.deepEqual(ops.map(o=>[o.table,o.action]),[['customer_retail_prices','insert']]);
 assert.deepEqual(ops[0].values,{customer_id:'cr',barcode:'8800000000002',retail_price:23000,note:''});
 assert.equal(h.ctx._customerRetailPrices.length,1,'confirmed cache is unchanged until approval');
 // Changing the rate as well puts both edits in the same request.
 h.element('c-supply-rate').value='40';await h.ctx.saveCust();
 assert.deepEqual(h.calls[1].args.p_operations.map(o=>[o.table,o.action]),[['customers','update'],['customer_retail_prices','insert']]);
 // Invalid rows block submission.
 h.ctx.custRetailSet(1,'retail_price','0');const alerts=h.notices.length;await h.ctx.saveCust();
 assert.equal(h.calls.length,2);assert.ok(h.notices.length>alerts);
});
