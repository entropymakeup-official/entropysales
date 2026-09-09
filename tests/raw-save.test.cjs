const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../app.js'),'utf8');
function setup(rpc){
  const calls=[], messages=[];
  const original={id:'a',no:'INV',customer:'old',status:'Paid',ship_status:'출고완료',foc:12,note:'keep'};
  const ctx={window:{_editRawInvId:'a'},document:{getElementById:id=>({value:({'rm-cust':'new','rm-date':'2026-09-09'})[id]||''}),querySelectorAll:()=>[]},
    _invoices:[original],_items:[{id:'old',invoice_id:'a'}],
    custByName:()=>({mgr:'manager'}),xgGetItems:()=>[{name:'Product',barcode:'123',qty:2,price:3,salesType:'Paid'}],
    sb:{rpc:async(name,args)=>{calls.push({name,args});return rpc(args);},from:()=>{throw Error('Non-atomic request');}},
    toast:m=>messages.push(m),cm:()=>{},cancelRawUpload:()=>{},setTimeout:()=>{},renderRaw:()=>{}};
  vm.createContext(ctx);
  const start=source.indexOf('async function saveRawManual');
  const end=source.indexOf('// ── Excel 업로드',start);
  vm.runInContext('let _savingRaw=false;\n'+source.slice(start,end),ctx);
  return {ctx,calls,messages,original};
}
test('edit preserves header fields and uses server item IDs',async()=>{
 const s=setup(a=>({data:{invoice:{...a.p_invoice,id:'a'},items:[{id:42,invoice_id:'a'}]},error:null}));
 await s.ctx.saveRawManual();
 assert.equal(s.calls.length,1);assert.equal(s.calls[0].name,'save_invoice_atomic');
 for(const key of ['status','ship_status','foc','note'])assert.equal(s.calls[0].args.p_invoice[key],s.original[key]);
 assert.equal(s.ctx._items[0].id,42);assert.equal(s.ctx.window._editRawInvId,null);
});
test('edit failure retains original rows and editor',async()=>{
 const s=setup(()=>({data:null,error:{message:'item rejected'}}));
 await s.ctx.saveRawManual();
 assert.equal(s.ctx._items[0].id,'old');assert.equal(s.ctx._invoices[0],s.original);
 assert.equal(s.ctx.window._editRawInvId,'a');assert.match(s.messages.join(' '),/item rejected/);
});
test('create failure preserves pending confirmation',async()=>{
 const s=setup(()=>{throw Error('network');});
 const pending={cust:'new',invNo:'NEW',odate:'2026-09-09',items:[{name:'P',barcode:'123',qty:1,price:5,salesType:'Paid'}]};
 s.ctx.window._pendingRaw=pending;
 await s.ctx.confirmRawSave();
 assert.equal(s.ctx.window._pendingRaw,pending);assert.equal(s.ctx._invoices.length,1);
 assert.match(s.messages.join(' '),/network/);
});
test('malformed success response does not replace local data',async()=>{
 const s=setup(()=>({data:{invoice:{id:'a'},items:[]}}));
 await s.ctx.saveRawManual();
 assert.equal(s.ctx._items[0].id,'old');assert.equal(s.ctx.window._editRawInvId,'a');
 assert.match(s.messages.join(' '),/저장 결과/);
});
test('failed request releases lock for a later attempt',async()=>{
 const s=setup(()=>({error:{message:'rejected'}}));
 await s.ctx.saveRawManual();await s.ctx.saveRawManual();
 assert.equal(s.calls.length,2);
});
test('concurrent confirm clicks produce only one request',async()=>{
 let finish;const s=setup(()=>new Promise(resolve=>finish=resolve));
 s.ctx.window._pendingRaw={cust:'new',invNo:'NEW',odate:'2026-09-09',items:[{name:'P',barcode:'123',qty:1,price:5,salesType:'Paid'}]};
 const first=s.ctx.confirmRawSave();await s.ctx.confirmRawSave();
 assert.equal(s.calls.length,1);
 finish({data:{invoice:{id:'b',no:'NEW'},items:[{id:99,invoice_id:'b'}]}});await first;
 assert.equal(s.ctx._invoices.length,2);assert.equal(s.ctx._items[1].id,99);
 assert.equal(s.ctx.window._pendingRaw,null);
});
