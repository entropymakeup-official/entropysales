const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {harness}=require('./helpers/approvals.cjs');const A=require('../invoice-amounts.js');
const root=path.join(__dirname,'..'),read=f=>fs.readFileSync(path.join(root,f),'utf8');
const lostLine={id:'item-lost',invoice_id:'inv-a',barcode:'CARRIED',name:'Carried over item',sales_type:'Lost',qty:1,price:55};
function fixture(){
 const h=harness();h.ctx.invoiceSheetStatus.refresh=()=>{};Object.assign(h.ctx,{InvoiceAmounts:A,SALES_TYPES:['Paid','FOC','Lost'],MGRS:['Tester'],stBadge:s=>s,statusBadge:s=>s,shipBadge:s=>s,shipModeBadge:()=>'',_invFileCache:{},loadInvDocs(){},renderDriveDocs(){},loadDriveDocs(){},setTimeout(){},_caSelected:'Demo',_caChart:null});
 h.ctx._invoices[0].order_date='2026-01-02';h.ctx._items=[{id:'item-a',invoice_id:'inv-a',barcode:'SYNTHETIC',name:'Synthetic item',sales_type:'Paid',qty:3,price:40},{...lostLine}];
 const printed=[];h.ctx.window.open=()=>({document:{write:html=>printed.push(html),close(){}},focus(){},print(){}});
 h.load('fmt','fmtN','itemsRev','itemsByType');return {...h,printed};
}
test('invoice detail hides Lost lines but keeps Paid revenue and notes the hidden count',()=>{
 const h=fixture();h.load('viewInv');h.ctx.viewInv('inv-a');
 const rows=h.element('view-inv-items').innerHTML;assert.match(rows,/Synthetic item/);assert.doesNotMatch(rows,/Carried over item|₩55/);
 assert.match(h.element('view-inv-meta').innerHTML,/₩120/);assert.match(h.element('view-inv-meta').innerHTML,/1개/);
 assert.match(h.element('view-inv-note').textContent,/미출고·미청구 처리 품목 1개/);
});
test('printable statement and customer analysis/report omit Lost amounts and columns',()=>{
 const h=fixture();h.load('downloadMeongse','buildCustAnalysis','printCustReport','pdBase','pdSales');
 h.ctx.downloadMeongse(h.ctx._invoices[0]);assert.doesNotMatch(h.printed[0],/LOST|Carried over item|₩55/);assert.match(h.printed[0],/₩120/);
 h.ctx.buildCustAnalysis('Demo');const body=h.element('ca-body').innerHTML;assert.doesNotMatch(body,/Lost|₩55/);assert.match(body,/₩120/);assert.match(body,/전체의 100\.0%/);
 h.ctx.printCustReport();assert.doesNotMatch(h.printed[1],/Lost|₩55|₩175/);assert.match(h.printed[1],/₩120/);
});
test('dashboard has no Lost card or wording and Lost never changes revenue totals',()=>{
 const nodes=Object.fromEntries(['content','topbar-actions','dash-start','dash-end','dash-customer','dash-period-error'].map(id=>[id,{innerHTML:'',value:'',textContent:''}]));
 const invoices=[{id:'a',no:'A',customer:'Zero',order_date:'2026-02-01',status:'Ordered'}];
 const c={_invoices:invoices,_items:[],_customers:[{name:'Zero',tax:'영세'}],document:{getElementById:id=>nodes[id]},window:{},setTimeout:()=>{},today:()=>'2026-09-09',fmt:n=>'₩'+Math.round(n),esc:s=>String(s||''),
  getInvItems:id=>c._items.filter(i=>i.invoice_id===id),itemsRev:xs=>xs.reduce((a,x)=>a+x.qty*x.price,0),itemsByType:()=>0};
 vm.createContext(c);for(const f of ['invoice-amounts.js','dashboard-model.js','tax-ledger.js','dashboard-ui.js'])vm.runInContext(read(f),c);
 const app=read('app.js'),start=app.indexOf('function renderDash(){');vm.runInContext(app.slice(start,app.indexOf('\nfunction ',start+1)),c);
 const snap=()=>JSON.parse(vm.runInContext('JSON.stringify(_dashSnapshot)',c));
 c._items=[{invoice_id:'a',sales_type:'Paid',qty:1,price:100}];c.renderDash();const without=snap();
 c._items.push({invoice_id:'a',sales_type:'Lost',qty:9,price:1000});c.renderDash();const withLost=snap();
 for(const k of ['recordedRevenue','revenue','pendingRevenue','foc'])assert.equal(withLost[k],without[k],k);
 assert.equal(withLost.recordedRevenue,100);
 assert.doesNotMatch(nodes.content.innerHTML,/Lost|openDashboardEvidence\('lost'\)/);
});
test('monthly view drops the Lost filter while edit form and approvals keep Lost selectable',()=>{
 const app=read('app.js');assert.doesNotMatch(app,/<option value="lost">/);
 assert.match(app,/const SALES_TYPES = \[[^\]]*'Lost'\]/);
 assert.match(read('request-editor.js'),/'sales_type'\?\['Paid','FOC','GWP','Sample','Replacement','Lost'\]/);
});
