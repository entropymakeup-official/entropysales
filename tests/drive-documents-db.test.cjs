const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');
const sqlPath=path.join(__dirname,'../sql/invoice-drive-documents.sql');
test('Drive evidence enforces private invoice access, valid metadata and one file per order without changing orders',async()=>{
 const db=new PGlite();try{
  await db.exec(`create role authenticated;create role anon;create schema auth;
   create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
   grant usage on schema auth to authenticated;grant execute on function auth.jwt() to authenticated;
   create table public.invoices(id uuid primary key, customer text,amount numeric);
   alter table public.invoices enable row level security;
   create policy audience on public.invoices to authenticated using (split_part(auth.jwt()->>'email','@',2)='entropymakeup.com');
   grant select on public.invoices to authenticated;
   insert into public.invoices values('00000000-0000-0000-0000-000000000001','Demo',100),('00000000-0000-0000-0000-000000000002','Demo',200);`);
  if(fs.existsSync(sqlPath))await db.exec(fs.readFileSync(sqlPath,'utf8'));
  assert.equal((await db.query("select to_regclass('public.invoice_drive_documents') as name")).rows[0].name,'invoice_drive_documents','Drive evidence table is installed');
  await db.exec(`set role authenticated;set request.jwt.claims='{"email":"demo@entropymakeup.com"}';`);
  const insert="insert into public.invoice_drive_documents(invoice_id,drive_file_id,name,type) values($1,$2,$3,'거래명세서') returning id";
  const row=(await db.query(insert,['00000000-0000-0000-0000-000000000001','test_file_1234567890','Statement.pdf'])).rows[0];
  assert.ok(row.id);
  await assert.rejects(db.query(insert,['00000000-0000-0000-0000-000000000001','test_file_1234567890','Other.pdf']),e=>e.code==='23505');
  await db.query(insert,['00000000-0000-0000-0000-000000000002','test_file_1234567890','Statement.pdf']);
  await assert.rejects(db.query(insert,['00000000-0000-0000-0000-000000000001','bad/link','bad']),e=>e.code==='23514');
  await assert.rejects(db.query(insert,['00000000-0000-0000-0000-000000000001','other_file_1234567890',' ']),e=>e.code==='23514');
  await assert.rejects(db.exec("update public.invoice_drive_documents set name='changed'"),e=>e.code==='42501');
  await db.exec(`set request.jwt.claims='{"email":"outside@example.test"}';`);
  assert.equal((await db.query('select * from public.invoice_drive_documents')).rows.length,0);
  await assert.rejects(db.query(insert,['00000000-0000-0000-0000-000000000001','other_file_1234567890','Outside.pdf']),e=>e.code==='42501');
  await db.exec('reset role;set role anon;');await assert.rejects(db.query('select * from public.invoice_drive_documents'),e=>e.code==='42501');
  await db.exec('reset role;');assert.deepEqual((await db.query('select amount::int from invoices order by amount')).rows,[{amount:100},{amount:200}]);
  await db.exec("delete from invoices where id='00000000-0000-0000-0000-000000000001'");
  assert.equal((await db.query('select * from public.invoice_drive_documents')).rows.length,1);
 }finally{await db.close();}
});
