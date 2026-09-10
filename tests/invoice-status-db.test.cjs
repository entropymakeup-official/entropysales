const {test}=require('node:test'),assert=require('node:assert/strict');
const {PGlite}=require('@electric-sql/pglite');
const {harness}=require('./helpers/invoice-status.cjs');
test('conditional status updates reject a stale tab and roll back when the capture trigger fails',async()=>{
 const db=new PGlite();
 try{
  await db.exec(`create table invoices(id text primary key,status text,pay_date date,ship_status text,tracking_num text);
   insert into invoices values('inv-a','Ordered',null,'준비중','EXISTING');
   create table captures(invoice_id text);
   create function capture() returns trigger language plpgsql as $$begin insert into captures values(new.id);return new;end$$;
   create trigger capture after update on invoices for each row execute function capture();`);
  const execute=async({table,patch,filters,selection})=>{
   assert.equal(table,'invoices');
   const allowed=new Set(['id','status','pay_date','ship_status']);
   const params=[],parameter=value=>{params.push(value);return '$'+params.length;};
   const fields=Object.keys(patch);for(const key of [...fields,...filters.map(x=>x[1]),...selection.split(',')])assert.ok(allowed.has(key));
   const sets=fields.map(key=>key+'='+parameter(patch[key]));
   const where=filters.map(([op,key,value])=>op==='is'?key+' is null':key+'='+parameter(value));
   // date::text reproduces PostgREST's date-only JSON representation.
   const selected=selection.split(',').map(key=>key==='pay_date'?'pay_date::text as pay_date':key);
   try{return {data:(await db.query(`update invoices set ${sets.join(',')} where ${where.join(' and ')} returning ${selected.join(',')}`,params)).rows,error:null};}
   catch(error){return {data:null,error:{message:error.message}};}
  };
  const first=harness({execute}),stale=harness({execute,date:'2026-09-09'});
  await first.run();await stale.run();
  assert.equal(first.inv.status,'Paid');assert.equal(stale.inv.status,'Ordered');assert.equal(stale.notified(),0);
  assert.deepEqual((await db.query('select status,pay_date::text,ship_status,tracking_num from invoices')).rows,[{status:'Paid',pay_date:'2026-09-10',ship_status:'준비중',tracking_num:'EXISTING'}]);
  assert.equal((await db.query('select * from captures')).rows.length,1);
  await db.exec(`create function reject_update() returns trigger language plpgsql as $$begin raise exception 'fixture capture failure';end$$;
   create trigger zz_reject after update on invoices for each row execute function reject_update();`);
  await first.run('ship');assert.equal(first.inv.ship_status,'준비중');
  assert.equal((await db.query('select ship_status from invoices')).rows[0].ship_status,'준비중');
  assert.equal((await db.query('select * from captures')).rows.length,1,'failed statement also rolls back its capture');
  await db.exec('drop trigger zz_reject on invoices');
  await first.run('ship');await first.run();
  assert.deepEqual((await db.query('select status,pay_date,ship_status,tracking_num from invoices')).rows,[{status:'Ordered',pay_date:null,ship_status:'출고완료',tracking_num:'EXISTING'}]);
 }finally{await db.close();}
});
