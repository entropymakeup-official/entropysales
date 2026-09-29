const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const file=require('node:path').join(__dirname,'../request-editor.js');
const E=fs.existsSync(file)?require(file):{};
test('status draft preserves pending item edits and groups payment and shipment into one operation',()=>{
 assert.equal(typeof E.prepareInvoice,'function');
 const before={id:'i',no:'INV',status:'Ordered',ship_status:'준비중',tracking_num:'KEEP'};
 const req={id:'r',revision:3,reason:'기존',operations:[{action:'invoice',id:'i',before:{invoice:before,items:[]},invoice:{no:'INV',status:'Ordered'},items:[{name:'Changed',qty:3,price:10}]}]};
 const draft=E.prepareInvoice(before,[req]);
 assert.equal(draft.id,'r');assert.equal(draft.revision,3);assert.equal(draft.operations[0].items[0].qty,3);
 draft.operations[0].invoice.status='Paid';draft.operations[0].invoice.ship_status='출고완료';
 assert.equal(req.operations[0].invoice.status,'Ordered');
 assert.deepEqual(draft.operations[0].before.invoice,before);
 assert.throws(()=>E.prepareInvoice(before,[req,req]),/여러/);
});
test('new combined request targets only status fields and keeps confirmed data intact',()=>{
 assert.equal(typeof E.prepareInvoice,'function');
 const inv={id:'i',status:'Ordered',pay_date:null,ship_status:'준비중',ship_date:null};
 const draft=E.prepareInvoice(inv,[]);assert.equal(draft.operations.length,1);
 assert.deepEqual(draft.operations[0].values,{status:'Ordered',pay_date:null,ship_status:'준비중',ship_date:null});
 draft.operations[0].values.status='Paid';assert.equal(inv.status,'Ordered');
});
test('edit fields include existing proposed values and missing status fields without exposing baseline IDs',()=>{
 assert.equal(typeof E.fields,'function');
 const op={table:'invoices',action:'update',key:{id:'i'},before:{id:'i',status:'Ordered',ship_status:'준비중',created_at:'system'},values:{status:'Paid'}};
 const draft={operations:[op]};const fields=E.fields(draft);
 assert.ok(fields.some(f=>f.key==='ship_status'));assert.ok(fields.some(f=>f.key==='pay_date'));
 assert.ok(!fields.some(f=>['id','created_at','before'].includes(f.key)));
 E.assign(draft,fields.find(f=>f.key==='ship_status'),'출고완료');
 assert.equal(op.values.status,'Paid');assert.equal(op.values.ship_status,'출고완료');assert.equal(op.before.ship_status,'준비중');
});
test('full editing promotes an own status request without losing its proposed payment values',()=>{
 const before={id:'i',no:'INV',customer:'Demo',status:'Ordered',ship_status:'준비중'};
 const request={id:'r',revision:2,operations:[{table:'invoices',action:'update',key:{id:'i'},before,values:{status:'Paid'}}]};
 const draft=E.prepareInvoice(before,[request],[{id:'item',invoice_id:'i',name:'X',qty:2,price:3,sales_type:'Paid'}]);
 assert.equal(draft.operations[0].action,'invoice');assert.equal(draft.operations[0].invoice.status,'Paid');
 assert.equal(draft.operations[0].items[0].qty,2);assert.equal(draft.operations[0].items[0].id,undefined);
 assert.deepEqual(draft.operations[0].before.invoice,before);
});
test('same-user session refresh preserves draft; sign-out and a different user close it',async()=>{
 let auth,removed=0;const controls={};
 const dialog={setAttribute(){},addEventListener(){},querySelectorAll:()=>[],querySelector:s=>controls[s]||(controls[s]={focus(){},value:''}),showModal(){},close(){},remove(){removed++;}};
 const document={createElement:()=>dialog,body:{appendChild(){}},activeElement:null};
 const client={auth:{getSession:async()=>({data:{session:{user:{id:'me'}}}}),onAuthStateChange:fn=>{auth=fn;return {data:{subscription:{unsubscribe(){}}}};}}};
 await E.open({document,client,request:{operations:[],reason:'draft'}});
 assert.equal(await E.open({document,client,request:{operations:[],reason:'duplicate'}}),dialog);
 auth('SIGNED_IN',{user:{id:'me'}});assert.equal(removed,0);
 auth('TOKEN_REFRESHED',{user:{id:'me'}});assert.equal(removed,0);
 auth('SIGNED_IN',{user:{id:'other'}});assert.equal(removed,1);
 await E.open({document,client,request:{operations:[],reason:'draft'}});auth('SIGNED_OUT',null);assert.equal(removed,2);
});
