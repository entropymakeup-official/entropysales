const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {PGlite}=require('@electric-sql/pglite');
const {harness}=require('./helpers/approvals.cjs');
for(const method of ['delInv','delRawItem'])test(method+' submits deletion without executing cascade before approval',async()=>{
 const db=new PGlite();try{
  await db.exec("create table invoices(id text primary key);create table invoice_items(id text primary key,invoice_id text references invoices on delete cascade);insert into invoices values('inv-a');insert into invoice_items values('item-a','inv-a');create table requests(payload jsonb);");
  const h=harness({execute:async(name,args)=>{assert.equal(name,'submit_change_request');await db.query('insert into requests values($1::jsonb)',[JSON.stringify(args.p_operations)]);return {data:{id:args.p_client_id,status:'pending'}};}});
  vm.runInContext('const _deletingInvoiceIds=new Set();',h.ctx);h.load('deleteInvoiceRecord','delInv','delRawItem');h.element('m-inv-view').dataset.invoiceId='inv-a';await h.ctx[method]('inv-a');
  assert.equal((await db.query('select * from invoices')).rows.length,1);assert.equal((await db.query('select * from invoice_items')).rows.length,1);
  const op=(await db.query('select payload from requests')).rows[0].payload[0];assert.equal(op.action,'delete');assert.equal(op.before_items[0].id,'item-a');assert.deepEqual(op.before_drive_documents,[]);
  assert.equal(h.ctx._invoices.length,1);assert.equal(h.ctx._items.length,1);
  // Actual approval cascade and rejection rollback: change-approvals-db.test.cjs.
 }finally{await db.close();}
});
