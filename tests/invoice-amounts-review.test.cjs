const {test,describe,before,after,beforeEach,afterEach}=require('node:test'),assert=require('node:assert/strict');
const {harness:appHarness}=require('./helpers/approvals.cjs');
const A=require('../invoice-amounts.js');
const line=(extra={})=>({id:'line',invoice_id:'inv',name:'Synthetic item',barcode:null,sales_type:'Paid',qty:3,price:40,amount_override:91.25,amount_reference:'Synthetic proof',...extra});
function app(invoice={id:'inv',no:'SYNTHETIC',customer:'Demo',mgr:'M',order_date:'2026-01-02'},items=[line()]){
 const h=appHarness();h.ctx._invoices=[invoice];h.ctx._items=items;h.ctx._editInv=invoice;h.ctx._editInvBefore={invoice,items};h.ctx.window._editRawInvId=invoice.id;h.ctx.window._editRawBefore={invoice,items};h.ctx.setTimeout=()=>{};
 h.load('fmt','fmtN','itemsRev','itemsByType');h.ctx.custByName=()=>({mgr:invoice.mgr});
 for(const [id,value]of Object.entries({'inv-no':invoice.no,'inv-cust-ro':invoice.customer,'inv-odate':invoice.order_date,'inv-status':'Ordered','inv-ship':'준비중','inv-note':'Header only','rm-cust':invoice.customer,'rm-date':invoice.order_date}))h.element(id).value=value;
 const rows=items.map(item=>{const inputs=[item.name,item.barcode??'',String(item.qty),String(item.price)].map(value=>({value}));const select={value:item.sales_type},amount={};return {inputs,select,amount,querySelectorAll:s=>s==='input'?inputs:[{},{},{},{},{},amount],querySelector:s=>s==='select'?select:s==='[data-col="6"]'?amount:s.includes('data-col="3"')?select:inputs[{'0':1,'1':0,'4':2,'5':3}[s.match(/data-col="(\d)"/)?.[1]]]};});
 h.ctx.document.querySelectorAll=s=>s==='#inv-items tr'||s==='#xg-body tr'?rows:[];h.element('xg-body').rows=rows;
 const printed=[];h.ctx.window.open=()=>({document:{write:s=>printed.push(s),close(){}},focus(){}});Object.assign(h.ctx,{_caSelected:invoice.customer,_caChart:null,_calYear:2026,_calMonth:0});
 return {...h,rows,printed};
}
test('actual amount formatter retains cents and signed cents while count formatting remains integral',()=>{
 const h=app();for(const [value,expected]of [[91.25,'₩91.25'],[-.25,'₩-0.25'],[0,'₩0'],[-0,'₩0'],[1234.5,'₩1,234.5'],[null,'-']])assert.equal(h.ctx.fmt(value),expected);
 assert.equal(h.ctx.fmtN(91.25),'91');assert.equal(h.ctx.fmtN(1234),'1,234');
});
test('dashboard evidence and supply reconciliation use the same two-decimal display as actual app money',()=>{
 const h=app(),m=require('../dashboard-model.js');const invoices=[{id:'a',customer:'Zero',order_date:'2026-01-02'},{id:'b',customer:'Tax',order_date:'2026-01-03'}],items=invoices.map((inv,i)=>line({invoice_id:inv.id,amount_override:[100.4,200.4][i]}));
 const summary=m.summarizeSupply(invoices,items,{start:'2026-01-01',end:'2026-01-31'},[{name:'Zero',tax:'영세'},{name:'Tax',tax:'과세'}]),e=m.evidence(summary,'recordedRevenue');
 assert.equal(h.ctx.fmt(summary.recordedRevenue),'₩300.8');assert.equal(e.roundedRows,300.8);assert.equal(e.displayTotal,300.8);assert.equal(e.adjustment,0);assert.equal(summary.displayAdjustment,0);
});
test('product screen and print detail retain proof cents through the actual product money formatter',()=>{
 const h=app(undefined,[line({barcode:'SYNTHETIC'})]);require('node:vm').runInContext(h.source.match(/^const PD_.+$/gm).join('\n'),h.ctx);h.load('pdBase','pdSales','pdBrandBadge','pdDetailHtml','pdSection','pdRow','pdDim');
 for(const printed of [false,true])assert.match(h.ctx.pdDetailHtml({barcode:'SYNTHETIC',name_kr:'Synthetic item'},printed),/누적 판매<\/b> 3개 · ₩91\.25/);
});
test('customer average amount retains cents on screen and print',()=>{
 const h=app();h.load('buildCustAnalysis','printCustReport');h.ctx.buildCustAnalysis('Demo');h.ctx.printCustReport();for(const html of [h.element('ca-body').innerHTML,h.printed[0]])assert.match(html,/건당 평균 매출<\/div><div class="(?:val|kpi-val)">₩91\.25/);
});
test('actual saveInv serializes an unchanged empty barcode as the original null without proof in replacement payload',async()=>{
 const h=app();h.load('saveInv');await h.ctx.saveInv();const op=h.calls[0].args.p_operations[0];assert.equal(op.items[0].barcode,null);assert.equal(op.before.items[0].barcode,null);assert.equal('amount_override' in op.items[0],false);
});
test('actual RAW extraction and save retain the original null barcode instead of dropping its Paid line',async()=>{
 const h=app();h.load('xgGetItems','saveRawManual','persistRawInvoice');assert.equal(h.ctx.xgGetItems().length,1);await h.ctx.saveRawManual();assert.equal(h.calls.length,1);assert.equal(h.calls[0].args.p_operations[0].items[0].barcode,null);
});
test('ambiguous null/empty source rows are not merged or represented as preserved proof',async()=>{
 const old=[line(),line({id:'empty',barcode:'',amount_override:70})],h=app(undefined,old);h.load('saveInv');await h.ctx.saveInv();const serialized=h.calls[0].args.p_operations[0].items;
 assert.deepEqual(serialized.map(item=>item.barcode),['','']);assert.deepEqual(A.previewAmounts(serialized,old),[120,120]);
});
test('a changed barcode remains a change and a new blank barcode remains blank',async()=>{
 const h=app();h.load('saveInv');h.rows[0].inputs[1].value='NEW';await h.ctx.saveInv();assert.equal(h.calls[0].args.p_operations[0].items[0].barcode,'NEW');h.ctx._editInv=null;h.rows[0].inputs[1].value='';await h.ctx.saveInv();assert.equal(h.calls[1].args.p_operations[0].items[0].barcode,'');
});
test('preview cannot carry proof across distinct null versus zero numeric signatures',()=>{
 assert.deepEqual(A.previewAmounts([line({barcode:'',qty:0})],[line({qty:null})]),[0]);
});
function signedApp(values=[100,-20,0]){
 const h=app();h.ctx._invoices=values.map((value,i)=>({id:'inv'+i,no:'SYNTHETIC-'+i,customer:'Demo',order_date:'2026-01-0'+(i+2),status:'Ordered'}));h.ctx._items=values.map((value,i)=>line({id:'line'+i,invoice_id:'inv'+i,amount_override:value}));return h;
}
test('weekly customer totals include credits and agree with overall revenue',()=>{
 const h=signedApp();h.load('_generateReport');h.ctx._generateReport('2026',1,'2026-01-01','2026-01-07');const html=h.printed[0];assert.match(html,/<div class="bar-val">₩80<\/div>/);assert.doesNotMatch(html,/<div class="bar-val">₩100<\/div>/);
});
test('customer history and printable monthly/history cells display negative and explicit zero Paid values',()=>{
 const h=signedApp([-.25,0]);h.load('buildCustAnalysis','printCustReport');h.ctx.buildCustAnalysis('Demo');h.ctx.printCustReport();
 for(const html of [h.element('ca-body').innerHTML,h.printed[0]]){
  const history=html.slice(html.lastIndexOf('SYNTHETIC-0')).split('</tr>')[0];assert.match(history,/₩-0\.25/);const zero=html.slice(html.lastIndexOf('SYNTHETIC-1')).split('</tr>')[0];assert.match(zero,/₩0/);
 }
 assert.match(h.printed[0],/<td class="num">₩-0\.25<\/td>/);
});
test('monthly report retains credit cells, zero-net customers and explicit zero cells',()=>{
 const h=signedApp([-20,0]);h.load('buildMonthly');h.element('fm-y').value='2026';h.element('fm-t').value='revenue';h.ctx.buildMonthly();let table=h.element('monthly-content').innerHTML.split('<tbody>')[1];assert.match(table,/Demo<\/strong><\/td><td[^>]*>₩-20<\/td>/);
 h.ctx._items[0].amount_override=0;h.ctx.buildMonthly();table=h.element('monthly-content').innerHTML.split('<tbody>')[1];assert.match(table,/Demo/);assert.match(table,/₩0/);
});
test('calendar net revenue includes credits and displays credit and zero Paid days',()=>{
 const h=signedApp([100,-20,0]);h.load('buildCalendar');h.ctx.buildCalendar();const html=h.element('content').innerHTML;assert.match(html,/₩80/);assert.match(html,/₩-20/);assert.match(html,/₩0/);
});

// Run the app's actual serialized request against the SQL agent's read-only contract.
const {createDatabase,harness:dbHarness,ITEM}=require('./helpers/invoice-amount-db.cjs');
describe('real frontend replacement payload with SQL proof contract',()=>{
 let db,d;before(async()=>{db=await createDatabase();d=dbHarness(db);});after(async()=>{if(db)await db.close();});
 beforeEach(async()=>{await db.exec('begin');await d.login();await d.approveUpdate({amount_override:91.25,amount_reference:'Synthetic proof'},ITEM);});afterEach(async()=>{await db.exec('rollback; reset role');});
 for(const route of ['invoice','raw'])test(route+' header-only request is accepted pending and preserves null barcode/proof after approval',async()=>{
  const invoice=await d.invoice(),items=await d.items(),h=app(invoice,items);
  if(route==='invoice'){h.load('saveInv');await h.ctx.saveInv();}else{h.load('xgGetItems','saveRawManual','persistRawInvoice');await h.ctx.saveRawManual();}
  assert.equal(h.calls.length,1);const op=h.calls[0].args.p_operations[0];const pending=await d.submit([op]);assert.equal(pending.status,'pending');assert.deepEqual(await d.items(),items);await d.review(pending.id);
  const saved=(await d.items()).find(item=>item.name==='Synthetic A');assert.equal(saved.barcode,null);assert.equal(saved.amount_override,91.25);assert.equal(saved.amount_reference,'Synthetic proof');
 });
});
