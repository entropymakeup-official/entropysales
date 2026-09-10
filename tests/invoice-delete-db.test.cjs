const {test}=require('node:test'),assert=require('node:assert/strict');
const {PGlite}=require('@electric-sql/pglite');
const {harness}=require('./helpers/invoice-delete.cjs');
for(const name of ['delInv','delRawItem'])test(name+' preserves parent and items when a database trigger rejects the single delete',async()=>{
 const db=new PGlite();
 try{
  // Same validated FK observed in production. This database contains only fixtures.
  await db.exec(`create table invoices(id text primary key);
   create table invoice_items(id text primary key,invoice_id text references invoices(id) on delete cascade);
   insert into invoices values('inv-a'),('inv-b');
   insert into invoice_items values('item-a','inv-a'),('item-b','inv-b');
   create function reject_delete() returns trigger language plpgsql as $$begin raise exception 'fixture trigger failure';end$$;
   create trigger reject_delete before delete on invoices for each row execute function reject_delete();`);
  const h=harness({execute:async({table,column,id,selection})=>{
   assert.ok(['invoices','invoice_items'].includes(table));assert.ok(['id','invoice_id'].includes(column));
   try{return {data:(await db.query(`delete from ${table} where ${column}=$1${selection==='id'?' returning id':''}`,[id])).rows,error:null};}
   catch(error){return {data:null,error:{message:error.message}};}
  }});
  await h.run(name);
  assert.deepEqual((await db.query('select id from invoices order by id')).rows,[{id:'inv-a'},{id:'inv-b'}]);
  assert.deepEqual((await db.query('select id from invoice_items order by id')).rows,[{id:'item-a'},{id:'item-b'}]);
  assert.equal(h.ctx._invoices.length,2);assert.equal(h.ctx._items.length,2);assert.equal(h.notified(),0);
  await db.exec('drop trigger reject_delete on invoices');await h.run(name);
  assert.deepEqual((await db.query('select id from invoices order by id')).rows,[{id:'inv-b'}]);
  assert.deepEqual((await db.query('select id from invoice_items order by id')).rows,[{id:'item-b'}]);
  assert.equal(h.ctx._items.length,1);assert.equal(h.notified(),1);
 }finally{await db.close();}
});
