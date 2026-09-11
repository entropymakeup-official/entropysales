const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {PGlite}=require('@electric-sql/pglite');
const {harness}=require('./helpers/approvals.cjs');
test('payment and shipping requests preserve confirmed database rows and full before snapshots',async()=>{
 const db=new PGlite();try{
  await db.exec("create table invoices(id text primary key,status text,pay_date date,ship_status text);insert into invoices values('inv-a','Ordered',null,'준비중');create table requests(id text,payload jsonb);");
  const h=harness({execute:async(name,args)=>{assert.equal(name,'submit_change_request');await db.query('insert into requests values($1,$2::jsonb)',[args.p_client_id,JSON.stringify(args.p_operations)]);return {data:{id:args.p_client_id,status:'pending'}};}});
  vm.runInContext('const _invoiceStatusPending=new Set();',h.ctx);h.ctx.refreshInvoiceStatusControls=()=>{};h.load('saveInvoiceStatus');
  await h.ctx.saveInvoiceStatus('inv-a',{status:'Paid',pay_date:'2026-09-11'},'입금');await h.ctx.saveInvoiceStatus('inv-a',{ship_status:'출고완료'},'출고');
  assert.deepEqual((await db.query('select * from invoices')).rows,[{id:'inv-a',status:'Ordered',pay_date:null,ship_status:'준비중'}]);
  const submitted=(await db.query('select payload from requests')).rows;assert.equal(submitted.length,2);
  for(const {payload} of submitted){assert.equal(payload[0].before.status,'Ordered');assert.equal(payload[0].before.pay_date,null);}
  assert.equal(h.ctx._invoices[0].status,'Ordered');
  // Actual approval, conflicts and trigger rollback: change-approvals-db.test.cjs.
 }finally{await db.close();}
});
