const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');
test('status RPC enforces existing audience, classifies revisions and exposes no worker secrets',async()=>{
 const file=path.join(__dirname,'../sql/invoice-sheet-status.sql');
 assert.ok(fs.existsSync(file),'status RPC migration must exist');
 const db=new PGlite();
 try{
  await db.exec(`create role anon;create role authenticated;
   create schema auth;grant usage on schema auth to authenticated;
   create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
   create function auth.jwt() returns jsonb language sql as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
   create table public.invoices(id uuid primary key,no text,customer text);
   create schema invoice_sheet_private;
   create table invoice_sheet_private.config(singleton boolean primary key,enabled boolean,secret_hash text);
   insert into invoice_sheet_private.config values(true,true,'DO_NOT_EXPOSE');
   create table invoice_sheet_private.queue(invoice_id uuid primary key,revision bigint,synced_revision bigint,queued_at timestamptz,lease_until timestamptz,last_error text,synced_at timestamptz);
  `);
  await db.exec(fs.readFileSync(file,'utf8'));
  const query=async()=> (await db.query('select public.get_invoice_sheet_status() as status')).rows[0].status;
  await db.exec('set role anon');await assert.rejects(query,/permission denied/);await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',false)");
  await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({email:'outsider@example.com'})]);
  await db.exec('set role authenticated');await assert.rejects(query,/Unauthorized/);await db.exec('reset role');
  await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({email:'test@entropymakeup.com'})]);
  const ids=Array.from({length:6},(_,i)=>`00000000-0000-0000-0000-${String(i+10).padStart(12,'0')}`);
  for(const [i,id]of ids.entries())await db.query('insert into invoices values($1,$2,$3)',[id,'TEST-'+i,'Test customer']);
  await db.query(`insert into invoice_sheet_private.queue values
   ($1,1,1,now()-interval '1 hour',null,null,now()-interval '30 minutes'),
   ($2,3,2,now(),null,null,now()-interval '30 minutes'),
   ($3,4,0,now()-interval '20 minutes',null,'DESTINATION_WRITE_FAILED',null),
   ($4,5,0,now()-interval '20 minutes',null,null,null),
   ($5,6,0,now(),now()+interval '10 minutes',null,null)`,ids.slice(0,5));
  const before=(await db.query('select * from invoice_sheet_private.queue order by invoice_id')).rows;
  await db.exec('set role authenticated');
  const value=await query();
  assert.equal(value.pending_count,5);assert.equal(value.failed_count,1);assert.equal(value.delayed_count,1);assert.equal(value.missing_count,1);
  assert.ok(value.last_synced_at);assert.equal(value.problems.length,3);
  assert.deepEqual(value.problems.map(p=>p.state).sort(),['delayed','error','missing']);
  assert.doesNotMatch(JSON.stringify(value),/secret|revision|lease|DO_NOT_EXPOSE/);
  await assert.rejects(db.query('select * from invoice_sheet_private.queue'),/permission denied/);
  await db.exec('reset role');
  assert.deepEqual((await db.query('select * from invoice_sheet_private.queue order by invoice_id')).rows,before);
  await db.query("update invoice_sheet_private.queue set last_error='raw-secret-token' where invoice_id=$1",[ids[2]]);
  assert.doesNotMatch(JSON.stringify(await query()),/raw-secret-token/);
  await db.exec('update invoice_sheet_private.config set enabled=false');assert.equal((await query()).enabled,false);
  await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({email:'entropyadmin@entropy.internal'})]);
  await db.exec('set role authenticated');assert.equal((await query()).enabled,false);await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub','',false)");await assert.rejects(query,/Unauthorized/);
 }finally{await db.close();}
});
