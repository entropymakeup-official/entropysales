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
 vm.createContext(c);for(const f of ['dashboard-model.js','tax-ledger.js','dashboard-ui.js'])vm.runInContext(fs.readFileSync(path.join(root,f),'utf8'),c);
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

test('confirmed tax panel shares filters without changing order totals or annual goal calculations',()=>{
 const {c,nodes}=setup();c._customers[1].id='tax-customer';
 vm.runInContext(`_taxLedgerState={status:'ready',rows:[{approval_number:'TEST-LEDGER',customer_id:'tax-customer',written_date:'2024-04-30',issued_date:'2024-05-08',record_kind:'original',currency:'KRW',supply_amount:700,vat_amount:70,gross_amount:770,evidence:{}}]}`,c);
 c.setDashboardAllTime();assert.equal(c.dashboardPeriod().start,'2024-04-30');
 assert.match(nodes.content.innerHTML,/id="dash-tax-ledger"/);assert.match(nodes.content.innerHTML,/₩700/);
 assert.equal(JSON.parse(vm.runInContext('JSON.stringify(_dashSnapshot)',c)).recordedRevenue,600);
 c.setDashboardYear('2026');assert.match(nodes.content.innerHTML,/이 범위에 없습니다/);
 assert.equal(JSON.parse(vm.runInContext('JSON.stringify(_dashSnapshot)',c)).recordedRevenue,300);
 c.setDashboardAllTime();nodes['dash-start'].value=c.dashboardPeriod().start;nodes['dash-end'].value=c.dashboardPeriod().end;nodes['dash-customer'].value='Zero';c.applyDashboardPeriod(true);
 assert.match(nodes.content.innerHTML,/이 범위에 없습니다/);assert.doesNotMatch(nodes.content.innerHTML,/₩700/);
});

test('reload and logout discard earlier tax reads instead of restoring stale account data',async()=>{
 const {c,nodes}=setup();assert.equal(typeof c.loadDashboardTaxLedger,'function');assert.equal(typeof c.resetDashboardTaxLedger,'function');
 nodes['dash-tax-ledger']={innerHTML:'<strong>Previous account amount</strong>'};
 const pending=[];c.TaxLedger.load=()=>new Promise(resolve=>pending.push(resolve));c.sb={};
 const first=c.loadDashboardTaxLedger(),second=c.loadDashboardTaxLedger();
 pending[1]({status:'ready',rows:[{approval_number:'new'}]});await second;
 pending[0]({status:'ready',rows:[{approval_number:'old'}]});await first;
 assert.equal(vm.runInContext('_taxLedgerState.rows[0].approval_number',c),'new');
 const third=c.loadDashboardTaxLedger();c.resetDashboardTaxLedger();pending[2]({status:'ready',rows:[{approval_number:'signed-out'}]});await third;
 assert.equal(vm.runInContext('_taxLedgerState.rows.length',c),0);
 assert.doesNotMatch(nodes['dash-tax-ledger'].innerHTML,/Previous account amount/);
});

test('normal application data load reads the tax ledger through the real reader',async()=>{
 const {c,nodes}=setup();c.setTimeout=setTimeout;c.clearTimeout=clearTimeout;c.matchMedia=()=>({matches:false});
 const records={customers:[{id:'c1',name:'Tax',tax:'과세'}],invoices:c._invoices,invoice_items:c._items,
 tax_invoice_amounts:[{approval_number:'LOAD-TEST',customer_id:'c1',written_date:'2026-04-30',issued_date:'2026-05-08',record_kind:'original',currency:'KRW',supply_amount:700,vat_amount:70,gross_amount:770,evidence:{}}]};
 c.sb={from(table){const result={data:records[table]||[],error:null};return {
 select(){return this;},order(){return this;},eq(){return this;},maybeSingle(){return Promise.resolve({data:null,error:null});},
 range(from,to){return Promise.resolve({...result,data:result.data.slice(from,to+1),count:result.data.length});},
 then(resolve,reject){return Promise.resolve(result).then(resolve,reject);}};}};
 const app=fs.readFileSync(path.join(root,'app.js'),'utf8'),start=app.indexOf('let _loadAllPromise'),end=app.indexOf('\nasync function preloadAllInvFiles',start+1);
 vm.runInContext(app.slice(start,end),c);await c._loadAllInner();c.renderDash();
 assert.match(nodes.content.innerHTML,/id="dash-tax-ledger"/);assert.match(nodes.content.innerHTML,/₩700/);
 assert.equal(vm.runInContext('_taxLedgerState.status',c),'ready');
});

test('logout during a load clears visible data and a new login loads independently',async()=>{
 const {c,nodes}=setup(),pending=[];let account='old';
 c.loading=()=>'<p>Loading</p>';c.localStorage={setItem(){}};
 c.sb={from(table){const owner=account;return {
  select(){return this;},order(){return this;},eq(){return this;},maybeSingle(){return Promise.resolve({data:null});},
  range(){return Promise.resolve({data:[{invoice_id:owner,qty:1,price:10,sales_type:'Paid'}]});},
  then(resolve,reject){return Promise.resolve({data:table==='customers'?[{id:owner,name:owner,tax:'영세'}]:[]}).then(resolve,reject);}
 };}};
 c.TaxLedger.load=()=>new Promise(resolve=>pending.push(resolve));
 const app=fs.readFileSync(path.join(root,'app.js'),'utf8'),start=app.indexOf('let _loadAllPromise'),end=app.indexOf('\nasync function preloadAllInvFiles',start);
 vm.runInContext(app.slice(start,end),c);
 nodes.content.innerHTML='<strong>Previous account amount</strong>';
 const oldRead=c.loadAll();
 assert.equal(typeof c.resetApplicationData,'function');c.resetApplicationData();
 assert.doesNotMatch(nodes.content.innerHTML,/Previous account amount/);
 account='new';const newRead=c.loadAll();assert.equal(pending.length,2);
 pending[0]({status:'ready',rows:[]});assert.equal(await oldRead,false);
 // Completing the old request must not detach the still-running current request.
 const duplicate=c.loadAll();assert.equal(pending.length,2);
 pending[1]({status:'ready',rows:[]});assert.equal(await newRead,true);assert.equal(await duplicate,true);
 assert.equal(c._customers[0].id,'new');assert.equal(c._items[0].invoice_id,'new');
 assert.equal(vm.runInContext('_taxLedgerState.status',c),'ready');
 const auth=app.slice(app.indexOf('async function signOut(){'),app.indexOf('// ─── 업체별 분석'));
 assert.match(auth,/resetApplicationData\(\)/);
 assert.equal((auth.match(/if\(!await loadAll\(\)\)return;/g)||[]).length,2,'both auth entry points stop stale navigation');
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
