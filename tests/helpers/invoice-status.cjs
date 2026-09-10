const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../../app.js'),'utf8');
function statusCode(){
 const helper=source.indexOf('const _invoiceStatusPending=');
 const start=helper<0?source.indexOf('async function togglePayStatus('):helper;
 return source.slice(source.indexOf('async function updTracking('),start)+source.slice(start,source.indexOf('async function toggleShipStatus(',start))+
  source.slice(source.indexOf('async function updShipSt('),source.indexOf('function openNewInv('));
}
function harness({response,execute,date='2026-09-10',confirm=true,invoice={}}={}){
 const calls=[],notices=[],dialogs=[],renders=[];let notified=0;
 const inv={id:'inv-a',no:'TEST_A',status:'Ordered',pay_date:null,ship_status:'준비중',tracking_num:'',...invoice};
 const elements={
  'inv-pay-inv-a':{innerHTML:'미입금',setAttribute(){},title:''},
  'inv-ship-inv-a':{value:inv.ship_status||'준비중',className:'ss s준비중',disabled:false},
  'nav-invoices':{classList:{contains:()=>true}},
  'inv-tbody':{querySelectorAll:()=>[]}
 };
 const ctx=vm.createContext({
  _invoices:[inv,{id:'inv-b',status:'Paid',pay_date:'2026-09-01',tracking_num:'OTHER'}],
  document:{getElementById:id=>elements[id],activeElement:null},
  filterInv:()=>renders.push('filter'),toast:s=>notices.push(s),esc:s=>String(s||''),today:()=> '2026-09-10',
  prompt:message=>{dialogs.push(message);return date;},confirm:message=>{dialogs.push(message);return confirm;},
  getInvItems:()=>[{qty:1,price:100}],itemsRev:()=>100,
  invoiceSheetStatus:{saved:()=>notified++},
  sb:{from:table=>({update:patch=>{
   const request={table,patch:JSON.parse(JSON.stringify(patch)),filters:[],selection:null};calls.push(request);
   const run=()=>execute?execute(request):Promise.resolve(response===undefined?{data:[{id:inv.id,...patch}],error:null}:response);
   const q={eq:(key,value)=>{request.filters.push(['eq',key,value]);return q;},is:(key,value)=>{request.filters.push(['is',key,value]);return q;},select:selection=>{request.selection=selection;return q;},then:(ok,bad)=>run().then(ok,bad)};return q;
  }})}
 });
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../../dashboard-model.js'),'utf8'),ctx);
 vm.runInContext(statusCode(),ctx);
 const run=(kind='pay')=>kind==='pay'?ctx.togglePayStatus('inv-a',inv.pay_date,inv.status):ctx.updShipSt('inv-a','출고완료',elements['inv-ship-inv-a']);
 return {ctx,inv,calls,notices,dialogs,renders,elements,run,notified:()=>notified};
}
module.exports={harness};
