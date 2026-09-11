const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.join(__dirname,'..');
function setup(){
 const nodes=Object.fromEntries(['content','topbar-actions','dash-start','dash-end','dash-customer','dash-period-error'].map(id=>[id,{innerHTML:'',value:'',textContent:''}]));
 const invoices=[{id:'a',no:'A',customer:'Zero',order_date:'2026-02-01',status:'Ordered'},{id:'b',no:'B',customer:'Tax',order_date:'2026-02-02',status:'Ordered'},{id:'c',no:'C',customer:'Zero',order_date:'2025-02-01',status:'Ordered'}];
 const items=invoices.map((x,i)=>({invoice_id:x.id,sales_type:'Paid',qty:1,price:(i+1)*100}));
 const c={_invoices:invoices,_items:items,_customers:[{name:'Zero',tax:'영세'},{name:'Tax',tax:'과세'}],_revenueGoal:5000000000,
 document:{getElementById:id=>nodes[id]},window:{},setTimeout:()=>{},today:()=> '2026-09-09',fmt:n=>'₩'+Math.round(n),esc:s=>String(s||''),
 getInvItems:id=>items.filter(i=>i.invoice_id===id),itemsRev:xs=>xs.reduce((a,x)=>a+x.qty*x.price,0),itemsByType:()=>0};
 vm.createContext(c);for(const f of ['invoice-amounts.js','dashboard-model.js','dashboard-ui.js'])vm.runInContext(fs.readFileSync(path.join(root,f),'utf8'),c);
 const app=fs.readFileSync(path.join(root,'app.js'),'utf8'),start=app.indexOf('function renderDash(){'),end=app.indexOf('\nfunction ',start+1);
 vm.runInContext(app.slice(start,end),c);return {c,nodes};
}
test('dashboard render and customer filter share supply totals and preserve source records',()=>{
 const {c,nodes}=setup(),before=JSON.stringify([c._invoices,c._items]);c.renderDash();
 const state=()=>JSON.parse(vm.runInContext('JSON.stringify(_dashSnapshot)',c));
 assert.equal(state().revenue,100);assert.equal(state().pendingRevenue,200);assert.equal(state().rows.length,2);
 assert.match(nodes.content.innerHTML,/id="dash-start"/);assert.match(nodes.content.innerHTML,/공급가액 집계분/);
 nodes['dash-start'].value='2026-01-01';nodes['dash-end'].value='2026-12-31';nodes['dash-customer'].value='Tax';c.applyDashboardPeriod();
 assert.equal(state().revenue,0);assert.equal(state().pendingRevenue,200);assert.equal(state().rows.length,1);
 assert.equal(JSON.stringify([c._invoices,c._items]),before);
 nodes['dash-end'].value='2025-01-01';c.applyDashboardPeriod();assert.match(nodes['dash-period-error'].textContent,/올바르게/);
 assert.equal(state().rows.length,1);
});

test('overview total shows all registered sales while preserving the supply breakdown after filtering',()=>{
 const {c,nodes}=setup();c.renderDash();
 const total=()=>nodes.content.innerHTML.match(/<button[^>]+onclick="openDashboardEvidence\('recordedRevenue'\)"[^>]*>([\s\S]*?)<\/button>/)?.[1];
 assert.ok(total(),'registered sales must have a visible evidence card');
 assert.match(total(),/₩300/);
 assert.ok(nodes.content.innerHTML.indexOf("openDashboardEvidence('recordedRevenue')")<nodes.content.innerHTML.indexOf("openDashboardEvidence('revenue')"));
 nodes['dash-start'].value='2026-01-01';nodes['dash-end'].value='2026-12-31';nodes['dash-customer'].value='Tax';c.applyDashboardPeriod();
 assert.match(total(),/₩200/);
 const state=JSON.parse(vm.runInContext('JSON.stringify(_dashSnapshot)',c));
 assert.equal(state.recordedRevenue,200);assert.equal(state.revenue,0);assert.equal(state.pendingRevenue,200);
});

test('all-time query includes earlier years, retains the customer scope and exits on a year selection',()=>{
 const {c,nodes}=setup(),before=JSON.stringify([c._invoices,c._items]);
 assert.equal(typeof c.setDashboardAllTime,'function');
 c.setDashboardAllTime();
 const state=()=>JSON.parse(vm.runInContext('JSON.stringify(_dashSnapshot)',c));
 assert.equal(state().recordedRevenue,600);assert.equal(state().rows.length,3);
 assert.equal(c.dashboardPeriod().allTime,true);
 assert.doesNotMatch(c.dashboardGoalCard(),/[0-9]+\.[0-9]+%/,'all-time sales cannot imply annual target progress');
 nodes['dash-start'].value=c.dashboardPeriod().start;nodes['dash-end'].value=c.dashboardPeriod().end;nodes['dash-customer'].value='Zero';
 c.applyDashboardPeriod(true);
 assert.equal(state().recordedRevenue,400);assert.equal(c.dashboardPeriod().allTime,true);
 c.setDashboardYear('2026');
 assert.equal(state().recordedRevenue,100);assert.equal(c.dashboardPeriod().allTime,false);
 assert.equal(JSON.stringify([c._invoices,c._items]),before);
});
