const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {createController}=require('../sheet-sync-status');
const {deletionCode}=require('./helpers/invoice-delete.cjs');
for(const name of ['delInv','delRawItem'])test(name+' discards a status response from before a confirmed deletion',async()=>{
 const responses=[],paints=[];
 const controller=createController({read:()=>new Promise(resolve=>responses.push(resolve)),render:m=>paints.push(m)});
 const ctx=vm.createContext({invoiceSheetStatus:controller,confirm:()=>true,_invoices:[{id:'test'}],_items:[{invoice_id:'test'}],
  document:{getElementById:()=>null},window:{},
  sb:{from:()=>({delete:()=>({eq:()=>({select:async()=>({data:[{id:'test'}],error:null})})})})},renderInvoices:()=>controller.refresh(),renderRaw:()=>controller.refresh(),toast:()=>{}});
 vm.runInContext(deletionCode(),ctx);
 try{
  const before=controller.show();await ctx[name]('test');assert.equal(responses.length,2);
  responses[0]({enabled:true,pending_count:0,failed_count:0,delayed_count:0,missing_count:0,last_synced_at:'2026-09-10T03:00:00Z',checked_at:'2026-09-10T03:01:00Z',problems:[]});
  responses[1]({enabled:true,pending_count:1,failed_count:0,delayed_count:0,missing_count:0,last_synced_at:'2026-09-10T03:00:00Z',checked_at:'2026-09-10T03:02:00Z',problems:[]});
  await before;await new Promise(setImmediate);assert.equal(paints.at(-1).kind,'pending');
 }finally{controller.hide();}
});
