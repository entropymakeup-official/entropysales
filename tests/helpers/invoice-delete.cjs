const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../../app.js'),'utf8');
function deletionCode(){
 const helper=source.indexOf('const _deletingInvoiceIds=');
 const start=helper<0?source.indexOf('async function delInv('):helper;
 return source.slice(start,source.indexOf('// ─── RAW ───',start))+
  source.slice(source.indexOf('async function delRawItem('),source.indexOf('function editRawItem('));
}
function harness({response={data:[{id:'inv-a'}],error:null},execute,confirm=true}={}){
 const calls=[],notices=[],renders=[],closed=[],confirmations=[];let notified=0;
 const elements={'m-inv-view':{dataset:{invoiceId:'inv-a'}},'nav-invoices':{classList:{contains:()=>true}},'nav-raw':{classList:{contains:()=>true}}};
 const ctx=vm.createContext({
  _invoices:[{id:'inv-a',no:'TEST_A',customer:'Test customer'},{id:'inv-b',no:'TEST_B'}],
  _items:[{id:'item-a',invoice_id:'inv-a'},{id:'item-b',invoice_id:'inv-b'}],
  window:{_rr:[{invId:'inv-a'},{invId:'inv-b'}]},
  confirm:message=>{confirmations.push(message);return confirm;},
  toast:message=>notices.push(message),cm:id=>closed.push(id),
  document:{getElementById:id=>elements[id]},
  invoiceSheetStatus:{saved:()=>{notified++;}},
  renderInvoices:()=>renders.push('invoices'),renderRaw:()=>renders.push('raw'),filterRaw:()=>renders.push('raw-table'),
  sb:{from:table=>({delete:()=>({eq:(column,id)=>{
   const request={table,column,id,selection:null};calls.push(request);
   const run=()=>execute?execute(request):Promise.resolve(response);
   return {select:selection=>{request.selection=selection;return run();},then:(ok,bad)=>run().then(ok,bad)};
  }})})}
 });
 vm.runInContext(deletionCode(),ctx);
 return {ctx,calls,notices,renders,closed,confirmations,elements,notified:()=>notified,run:name=>ctx[name]('inv-a')};
}
module.exports={deletionCode,harness};
