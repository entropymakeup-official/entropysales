const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const {PGlite}=require('@electric-sql/pglite');
const A='00000000-0000-0000-0000-000000000001',U='00000000-0000-0000-0000-000000000002',O='00000000-0000-0000-0000-000000000003';
const CR='10000000-0000-0000-0000-000000000001',STC='10000000-0000-0000-0000-000000000002';
test('customer retail prices are approval-only, validated, readable by company users and patch only the deployed allowlist',async()=>{
 const db=new PGlite();
 try{
  await db.exec(`create role anon;create role authenticated;create schema auth;create schema storage;
   create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,raw_app_meta_data jsonb default '{}');
   insert into auth.users values('${A}','entropyadmin@entropy.internal',now(),'{}'),('${U}','member@entropymakeup.com',now(),'{}'),('${O}','outside@example.com',now(),'{}');
   create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
   create table storage.objects(id uuid primary key,bucket_id text,name text);alter table storage.objects enable row level security;
   create table customers(id uuid primary key default gen_random_uuid(),name text not null,biz text,supply_rate numeric);
   create table documents(id uuid primary key default gen_random_uuid(),name text,customer text,type text);
   create table tax_invoice_amounts(approval_number text primary key,buyer_business_number text not null,customer_id uuid references customers(id),supply_amount numeric not null,created_at timestamptz default now());
   insert into customers values('${CR}','거래처A',null,30),('${STC}','거래처B',null,25);
   grant usage on schema public,auth to authenticated,anon;`);
  for(const table of ['invoices','invoice_items','products','stocks','schedules','tax_records','app_settings','product_details','invoice_drive_documents'])await db.exec(`create table ${table}(id uuid primary key default gen_random_uuid(),name text)`);
  const sql=name=>fs.readFileSync(path.join(__dirname,'../sql/'+name),'utf8');
  // Reproduce the installed approval allowlist (…,'contracts','contacts','tax_invoice_amounts').
  for(const name of ['change-approvals.sql','contracts.sql','contacts.sql','tax-invoice-amount-customer.sql'])await db.exec(sql(name));
  const login=async id=>{await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);await db.exec('set role authenticated');};
  const submit=async ops=>(await db.query('select submit_change_request($1::jsonb,$2,$3::uuid) r',[JSON.stringify(Array.isArray(ops)?ops:[ops]),'Contract price list',crypto.randomUUID()])).rows[0].r;
  const review=async id=>(await db.query('select review_change_request($1::uuid,$2,$3) r',[id,true,'Reviewed'])).rows[0].r;
  const rows=async()=>(await db.query('select * from customer_retail_prices order by barcode')).rows;
  const insert=patch=>({table:'customer_retail_prices',action:'insert',values:{customer_id:CR,barcode:'8800000000001',retail_price:21000,note:'가격표',...patch}});

  await login(U);const unrelated=await submit({table:'customers',action:'insert',values:{name:'Unrelated pending'}});
  await db.exec('reset role');
  const snapshot=(await db.query('select to_jsonb(r) r from approval_private.requests r where id=$1',[unrelated.id])).rows[0].r;
  const original=(await db.query("select pg_get_functiondef('approval_private.apply_operations(jsonb)'::regprocedure) d")).rows[0].d;
  await db.exec(sql('customer-retail-prices.sql'));
  assert.equal((await db.query("select pg_get_functiondef('approval_private.apply_operations(jsonb)'::regprocedure) d")).rows[0].d,
   original.replace("'contacts','tax_invoice_amounts') or a is null","'contacts','tax_invoice_amounts','customer_retail_prices') or a is null"));
  assert.deepEqual((await db.query('select to_jsonb(r) r from approval_private.requests r where id=$1',[unrelated.id])).rows[0].r,snapshot);

  await db.exec('set role anon');await assert.rejects(rows,/permission denied/);
  await login(O);await assert.rejects(()=>submit(insert({})),/UNAUTHORIZED/);
  await login(U);
  for(const command of ["insert into customer_retail_prices(customer_id,barcode,retail_price) values('"+CR+"','1',1)","update customer_retail_prices set retail_price=1","delete from customer_retail_prices","truncate customer_retail_prices"])
   await assert.rejects(()=>db.exec(command),/permission denied|APPROVAL_REQUIRED/);
  for(const patch of [{barcode:''},{barcode:' 88 '},{barcode:'x'.repeat(65)},{retail_price:0},{retail_price:-1},{retail_price:'21000'},{note:'x'.repeat(501)},{customer_id:O},{customer_id:null}])
   await assert.rejects(()=>submit(insert(patch)),undefined,JSON.stringify(patch));

  const request=await submit([insert({}),insert({barcode:'8800000000002',retail_price:23000,note:'  padded  '})]);
  assert.equal(request.status,'pending');assert.equal((await rows()).length,0);
  await assert.rejects(()=>review(request.id),/FORBIDDEN|ADMIN/);
  await login(A);assert.equal((await review(request.id)).status,'approved');
  let current=await rows();assert.equal(current.length,2);assert.equal(Number(current[0].retail_price),21000);assert.equal(current[1].note,'padded');
  await login(O);await assert.rejects(rows,/UNAUTHORIZED/);

  await login(U);
  await assert.rejects(()=>submit(insert({})),/unique|duplicate/);
  // Same barcode for a different customer is independent (거래처B keeps RSP unless it gets its own row).
  const other=await submit(insert({customer_id:STC,retail_price:18000,note:''}));
  const update={table:'customer_retail_prices',action:'update',key:{id:current[0].id},before:current[0],values:{retail_price:21500}};
  const first=await submit(update),stale=await submit({...update,values:{retail_price:22000}});
  await login(A);await review(other.id);await review(first.id);await assert.rejects(()=>review(stale.id),/STALE_DATA/);
  current=await rows();assert.equal(current.length,3);
  assert.equal(Number(current.find(r=>r.customer_id===CR&&r.barcode==='8800000000001').retail_price),21500);

  await login(U);const removal=await submit({table:'customer_retail_prices',action:'delete',key:{id:current[1].id},before:current[1]});
  await login(A);await review(removal.id);assert.equal((await rows()).length,2);
  await db.exec('reset role');await assert.rejects(()=>db.exec('truncate customer_retail_prices'),/APPROVAL_REQUIRED/);

  // An unexpected deployed allowlist must abort the whole additive migration.
  await db.exec('drop table customer_retail_prices;drop function approval_private.can_read_customer_retail_prices();drop function approval_private.touch_customer_retail_price();');
  await assert.rejects(()=>db.exec(sql('customer-retail-prices.sql')),/allowlist changed/);await db.exec('rollback');
  assert.equal((await db.query("select to_regclass('public.customer_retail_prices') r")).rows[0].r,null);
 }finally{await db.close();}
});
