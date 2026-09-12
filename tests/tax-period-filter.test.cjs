const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');

function setup(dashboardYear){
  const nodes=Object.fromEntries(['content','topbar-actions','tax-kpis','tax-content','ft-y','ft-m','ft-st','ft-tax'].map(id=>[id,{innerHTML:'',value:''}]));
  const invoices=[
    {id:'old',no:'OLD',customer:'Zero',order_date:'2025-12-22'},
    {id:'jan',no:'JAN',customer:'Zero',order_date:'2026-01-05'},
    {id:'sep',no:'SEP',customer:'Tax',order_date:'2026-09-07'}
  ];
  const items=[
    {invoice_id:'old',sales_type:'Paid',qty:1,price:200},
    {invoice_id:'jan',sales_type:'Paid',qty:1,price:100},
    {invoice_id:'sep',sales_type:'Paid',qty:1,price:300}
  ];
  const customers=[{id:'z',name:'Zero',mgr:'Raye',tax:'영세'},{id:'t',name:'Tax',mgr:'Grace',tax:'과세'}];
  const context={
    _invoices:invoices,_taxRecords:[
      {customer_id:'z',month:'2025-12',status:'발행완료'},
      {customer_id:'z',month:'2026-01',status:'발행완료'}
    ],
    document:{getElementById:id=>nodes[id]||null},window:{},
    today:()=> '2026-09-12',TAX_ST:['발행예정','발행완료','취소'],
    custByName:name=>customers.find(c=>c.name===name),
    getInvItems:id=>items.filter(i=>i.invoice_id===id),
    itemsRev:xs=>xs.filter(i=>i.sales_type==='Paid').reduce((sum,i)=>sum+i.qty*i.price,0),
    fmt:value=>'₩'+Number(value).toLocaleString('en-US'),
    dashboardPeriod:dashboardYear?()=>({start:dashboardYear+'-01-01',end:dashboardYear+'-12-31',allTime:false}):undefined
  };
  vm.createContext(context);
  const app=fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');
  const start=app.indexOf('function renderTax(){');
  const end=app.indexOf('\nasync function updTaxSt2',start);
  vm.runInContext(app.slice(start,end),context);
  return {context,nodes};
}

test('tax page defaults to the dashboard year and every KPI follows the visible period',()=>{
  const {context,nodes}=setup();
  context.renderTax();

  assert.equal(nodes['ft-y'].value,'2026');
  assert.match(nodes['tax-kpis'].innerHTML,/₩400/);
  assert.match(nodes['tax-kpis'].innerHTML,/1건/);
  assert.match(nodes['tax-content'].innerHTML,/2026-09/);
  assert.match(nodes['tax-content'].innerHTML,/2026-01/);
  assert.doesNotMatch(nodes['tax-content'].innerHTML,/2025-12/);

  nodes['ft-y'].value='';
  context.filterTax();
  assert.match(nodes['tax-kpis'].innerHTML,/₩600/);
  assert.match(nodes['tax-content'].innerHTML,/2025-12/);

  nodes['ft-y'].value='2026';
  nodes['ft-m'].value='2026-01';
  context.filterTax();
  assert.match(nodes['tax-kpis'].innerHTML,/₩100/);
  assert.match(nodes['tax-kpis'].innerHTML,/0건/);
  assert.match(nodes['tax-kpis'].innerHTML,/1건/);
  assert.match(nodes['tax-content'].innerHTML,/2026-01/);
  assert.doesNotMatch(nodes['tax-content'].innerHTML,/2026-09/);
});

test('tax page follows a non-current dashboard year and selecting a month synchronizes its year',()=>{
  const {context,nodes}=setup('2025');
  context.renderTax();

  assert.equal(nodes['ft-y'].value,'2025');
  assert.match(nodes['tax-kpis'].innerHTML,/₩200/);
  assert.match(nodes['tax-content'].innerHTML,/2025-12/);
  assert.doesNotMatch(nodes['tax-content'].innerHTML,/2026-01/);

  context.selectTaxMonth('2026-01');
  assert.equal(nodes['ft-y'].value,'2026');
  assert.equal(nodes['ft-m'].value,'2026-01');
  assert.match(nodes['tax-kpis'].innerHTML,/₩100/);
  assert.match(nodes['tax-content'].innerHTML,/2026-01/);
  assert.doesNotMatch(nodes['tax-content'].innerHTML,/2025-12/);
});
