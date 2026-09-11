const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../../app.js'),'utf8');
function code(name){
 const asyncStart=source.indexOf('async function '+name+'(');const start=asyncStart<0?source.indexOf('function '+name+'('):asyncStart;if(start<0)throw Error(name);
 // Parse the complete declaration independent of line endings and nested blocks.
 for(let end=source.indexOf('\n',start);end>=0;end=source.indexOf('\n',end+1)){
  const candidate=source.slice(start,end);
  try{new vm.Script(candidate);return candidate;}catch(error){if(!(error instanceof SyntaxError))throw error;}
 }
 throw Error('Incomplete function: '+name);
}
function harness({response={data:{id:'request-1',status:'pending'}},execute,reason='정정 사유',confirm=true}={}){
 const calls=[],notices=[],closed=[],downloads=[],elements={};
 const element=id=>elements[id]||(elements[id]={value:'',textContent:'저장',innerHTML:'',disabled:false,dataset:{},style:{},classList:{contains:()=>true},setAttribute(){},querySelectorAll:()=>[]});
 const ctx={crypto:require('node:crypto').webcrypto,TextEncoder,URL,setTimeout:fn=>fn(),clearTimeout,console,
 _invoices:[{id:'inv-a',no:'OLD',customer:'Demo',status:'Ordered',pay_date:null,ship_status:'준비중',note:'before'}],_items:[{id:'item-a',invoice_id:'inv-a',name:'Old',qty:1,price:10}],_customers:[],_products:[],_taxRecords:[],_stocks:[],_docs:[],_schedules:[],_pd:[],
 _savingInv:false,_editInvBefore:null,_savingRaw:false,_savingRawUpload:false,_editInv:null,_editProd:null,_editCust:null,_editStock:null,_editDoc:null,
 window:{},document:{getElementById:element,querySelectorAll:()=>[],querySelector:()=>null,removeEventListener(){},activeElement:null},
 prompt:()=>reason,confirm:()=>confirm,toast:s=>notices.push(s),alert:s=>notices.push(s),cm:id=>closed.push(id),om(){},esc:s=>String(s||''),today:()=> '2026-09-11',custByName:()=>({mgr:'M',code:'D'}),getInvItems:id=>ctx._items.filter(i=>i.invoice_id===id),itemsRev:()=>10,
 renderInvoices(){},filterInv(){},renderRaw(){},filterRaw(){},renderProducts(){},filterProd(){},renderCustomers(){},renderForecast(){},filterDocs(){},buildCalendar(){},cancelRawUpload(){},downloadMeongse:inv=>downloads.push(inv),invoiceSheetStatus:{saved(){throw Error('pending request must not sync');}},
 sb:{rpc:async(name,args)=>{calls.push({name,args:JSON.parse(JSON.stringify(args))});return execute?execute(name,args):response;},from:table=>({select:()=>({eq:async()=>({data:[],error:null})})})}};
 vm.createContext(ctx);vm.runInContext(fs.readFileSync(path.join(__dirname,'../../change-requests.js'),'utf8'),ctx);vm.runInContext(fs.readFileSync(path.join(__dirname,'../../invoice-amounts.js'),'utf8'),ctx);vm.runInContext(fs.readFileSync(path.join(__dirname,'../../dashboard-model.js'),'utf8'),ctx);
 vm.runInContext(source.slice(source.indexOf('const changeRequests='),source.indexOf('globalThis.invoiceSheetStatus =')),ctx);
 function load(...names){for(const name of names)vm.runInContext(code(name),ctx);}
 return{ctx,calls,notices,closed,downloads,elements,element,load,source,code};
}
module.exports={harness,code,source};
