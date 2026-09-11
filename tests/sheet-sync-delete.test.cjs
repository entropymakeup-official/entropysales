const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {createController}=require('../sheet-sync-status');const {harness}=require('./helpers/approvals.cjs');
for(const name of ['delInv','delRawItem'])test(name+' pending deletion does not report a confirmed sheet change',async()=>{
 const responses=[],paints=[],h=harness();const controller=createController({read:()=>new Promise(resolve=>responses.push(resolve)),render:m=>paints.push(m)});
 h.ctx.invoiceSheetStatus=controller;h.ctx.document.getElementById=()=>null;vm.runInContext('const _deletingInvoiceIds=new Set();',h.ctx);h.load('deleteInvoiceRecord','delInv','delRawItem');
 try{const before=controller.show();await h.ctx[name]('inv-a');assert.equal(responses.length,1);responses[0]({enabled:true,pending_count:0,failed_count:0,delayed_count:0,missing_count:0,last_synced_at:'2026-09-10T03:00:00Z',checked_at:'2026-09-10T03:01:00Z',problems:[]});await before;assert.equal(h.ctx._invoices.length,1);assert.equal(h.calls[0].name,'submit_change_request');}finally{controller.hide();}
});
