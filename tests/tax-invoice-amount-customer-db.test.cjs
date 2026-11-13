const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const {PGlite}=require('@electric-sql/pglite');
const A='00000000-0000-0000-0000-000000000001',U='00000000-0000-0000-0000-000000000002';
const WRONG='10000000-0000-0000-0000-000000000001',RIGHT='10000000-0000-0000-0000-000000000002',OTHER='10000000-0000-0000-0000-000000000003';
test('tax invoice amounts allow only approved customer relinks that match the buyer business number',async()=>{
 const db=new PGlite();
 try{
  await db.exec(`create role anon;create role authenticated;create schema auth;create schema storage;
   create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,raw_app_meta_data jsonb default '{}');
   insert into auth.users values('${A}','entropyadmin@entropy.internal',now(),'{}'),('${U}','member@entropymakeup.com',now(),'{}');
   create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
   create table storage.objects(id uuid primary key,bucket_id text,name text);alter table storage.objects enable row level security;
   create table customers(id uuid primary key default gen_random_uuid(),name text not null,biz text);
   create table documents(id uuid primary key default gen_random_uuid(),name text,customer text,type text);
   insert into customers values('${WRONG}','에이엘케이','557-14-01180'),('${RIGHT}','스타일앤코(리셀러)','140-81-71331'),('${OTHER}','다른 거래처',null);
   create table tax_invoice_amounts(approval_number text primary key,buyer_business_number text not null,customer_id uuid references customers(id),supply_amount numeric not null,created_at timestamptz default now());
   insert into tax_invoice_amounts(approval_number,buyer_business_number,customer_id,supply_amount) values('T-1','1408171331','${WRONG}',5449500);
   grant usage on schema public,auth to authenticated,anon;`);
  for(const table of ['invoices','invoice_items','products','stocks','schedules','tax_records','app_settings','product_details','invoice_drive_documents'])await db.exec(`create table ${table}(id uuid primary key default gen_random_uuid(),name text)`);
  const sql=name=>fs.readFileSync(path.join(__dirname,'../sql/'+name),'utf8');
  for(const name of ['change-approvals.sql','contracts.sql','contacts.sql'])await db.exec(sql(name));
  const login=async id=>{await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);await db.exec('set role authenticated');};
  const submit=async ops=>(await db.query('select submit_change_request($1::jsonb,$2,$3::uuid) r',[JSON.stringify(Array.isArray(ops)?ops:[ops]),'Tax amount relink',crypto.randomUUID()])).rows[0].r;
  const review=async id=>(await db.query('select review_change_request($1::uuid,$2,$3) r',[id,true,'Reviewed'])).rows[0].r;
  const row=async()=>{await db.exec('reset role');const r=(await db.query("select to_jsonb(t) r from tax_invoice_amounts t where approval_number='T-1'")).rows[0].r;return r;};
  const before=await row();
  const relink=(values,b=before)=>({table:'tax_invoice_amounts',action:'update',key:{approval_number:'T-1'},before:b,values});
  await login(U);await assert.rejects(()=>submit(relink({customer_id:RIGHT})),/INVALID_OPERATION/);
  await db.exec('reset role');const original=(await db.query("select pg_get_functiondef('approval_private.apply_operations(jsonb)'::regprocedure) d")).rows[0].d;
  await db.exec(sql('tax-invoice-amount-customer.sql'));
  const patched=(await db.query("select pg_get_functiondef('approval_private.apply_operations(jsonb)'::regprocedure) d")).rows[0].d;
  assert.notEqual(patched,original);assert.match(patched,/'contacts','tax_invoice_amounts'\) or a is null/);
  // 다시 적용하면 이미 바뀐 함수로 보고 아무것도 바꾸지 않는다.
  await assert.rejects(()=>db.exec(sql('tax-invoice-amount-customer.sql')),/allowlist changed/);await db.exec('rollback');
  await login(U);
  await assert.rejects(()=>submit(relink({supply_amount:1})),/CUSTOMER_ONLY/);
  await assert.rejects(()=>submit(relink({customer_id:RIGHT,supply_amount:1})),/CUSTOMER_ONLY/);
  await assert.rejects(()=>submit({table:'tax_invoice_amounts',action:'delete',key:{approval_number:'T-1'},before}),/CUSTOMER_ONLY/);
  await assert.rejects(()=>submit({table:'tax_invoice_amounts',action:'insert',values:{approval_number:'T-2',buyer_business_number:'1',customer_id:RIGHT,supply_amount:1}}),/CUSTOMER_ONLY/);
  await assert.rejects(()=>submit(relink({customer_id:OTHER})),/BUYER_MISMATCH/);
  await assert.rejects(()=>submit(relink({customer_id:null})),/BUYER_MISMATCH/);
  await assert.rejects(()=>db.exec(`update tax_invoice_amounts set customer_id='${RIGHT}'`),/permission denied|APPROVAL_REQUIRED/);
  const request=await submit(relink({customer_id:RIGHT}));assert.equal(request.status,'pending');
  assert.equal((await row()).customer_id,WRONG);
  await login(A);assert.equal((await review(request.id)).status,'approved');
  const after=await row();assert.equal(after.customer_id,RIGHT);assert.equal(Number(after.supply_amount),5449500);assert.equal(after.buyer_business_number,'1408171331');
  await login(U);await assert.rejects(()=>submit(relink({customer_id:RIGHT})),/STALE_DATA/);
  // 다른 표의 기존 승인 흐름은 그대로 동작한다.
  const other=await submit({table:'customers',action:'insert',values:{name:'New customer'}});await login(A);assert.equal((await review(other.id)).status,'approved');
  // 계산서 쪽 사업자번호에 하이픈이 있어도 숫자만 비교하고, 숫자가 없는 번호는 거래처 사업자번호가 비어도 통과시키지 않는다.
  await db.exec('reset role');
  await db.exec(`alter table customers disable trigger user;insert into customers values('10000000-0000-0000-0000-000000000004','빈 번호','');alter table customers enable trigger user;
   alter table tax_invoice_amounts disable trigger user;
   insert into tax_invoice_amounts(approval_number,buyer_business_number,customer_id,supply_amount) values('T-3','557-14-01180','${RIGHT}',1),('T-4','-','${RIGHT}',1);
   alter table tax_invoice_amounts enable trigger user;`);
  const rowOf=async n=>(await db.query('select to_jsonb(t) r from tax_invoice_amounts t where approval_number=$1',[n])).rows[0].r;
  const t3=await rowOf('T-3'),t4=await rowOf('T-4');
  await login(U);
  const hyphen=await submit({table:'tax_invoice_amounts',action:'update',key:{approval_number:'T-3'},before:t3,values:{customer_id:WRONG}});assert.equal(hyphen.status,'pending');
  await assert.rejects(()=>submit({table:'tax_invoice_amounts',action:'update',key:{approval_number:'T-4'},before:t4,values:{customer_id:'10000000-0000-0000-0000-000000000004'}}),/BUYER_MISMATCH/);
  // 되돌리기는 승인 함수를 설치 전 정의로 정확히 돌려놓고, 두 번 실행하면 멈춘다.
  await db.exec('reset role');await db.exec(sql('tax-invoice-amount-customer-rollback.sql'));
  assert.equal((await db.query("select pg_get_functiondef('approval_private.apply_operations(jsonb)'::regprocedure) d")).rows[0].d,original);
  await assert.rejects(()=>db.exec(sql('tax-invoice-amount-customer-rollback.sql')),/allowlist changed/);await db.exec('rollback');
  assert.equal((await row()).customer_id,RIGHT);
 }finally{await db.close();}
});
