const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const {PGlite}=require('@electric-sql/pglite');
const read=f=>fs.readFileSync(path.join(__dirname,'../sql',f),'utf8');
const id=n=>'00000000-0000-0000-0000-'+String(n).padStart(12,'0');

async function setup({before}={}){
 const db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create schema auth;create schema approval_private;
 create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz);
 create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz);
 create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create function auth.jwt() returns jsonb language sql security definer as $$select jsonb_build_object('session_id',current_setting('request.jwt.claim.session_id',true),'email',(select email from auth.users where id=nullif(current_setting('request.jwt.claim.sub',true),'')::uuid))$$;
 grant usage on schema public,auth,approval_private to anon,authenticated;
 insert into auth.users values ('${id(1)}','req@entropymakeup.com',now(),null),('${id(2)}','outsider@example.com',now(),null),('${id(3)}','handler@entropymakeup.com',now(),null),('${id(4)}','other@entropymakeup.com',now(),null),('${id(5)}','old@entropymakeup.com',now(),null);
 insert into auth.sessions select id,id,null from auth.users;
 create table public.invoices(id uuid primary key default gen_random_uuid(),no text);grant select on public.invoices to authenticated;`);
 await db.exec(read('team-tasks.sql')); // is_company_member(), current_email()
 await db.exec(read('logistics.sql'));
 await db.exec(`insert into logistics_handlers(email,display_name) values ('handler@entropymakeup.com','가짜 담당');
  insert into logistics_handlers(email,display_name,is_active) values ('old@entropymakeup.com','전 담당',false)`);
 if(before)await before(db);
 const sql=read('logistics-fassto.sql');await db.exec(sql);await db.exec(sql); // 다시 실행해도 안전
 const login=async n=>{await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.session_id',$1,false)",[id(n)]);await db.exec('set role authenticated');};
 const asSystem=async()=>{await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub','',false)");};
 const create=async(o={})=>(await db.query(`insert into logistics_requests(type_code,title_text,team_code,counterparty_text,ship_mode_code,fassto_order_no)
  values ('sample',$1,'global','가짜 바이어',$2,$3) returning *`,[o.title||'샘플',o.mode||'parcel',o.order_no||null])).rows[0];
 const kstDay=async()=>(await db.query(`select to_char((now() at time zone 'UTC')+interval '9 hours','YYYYMMDD') d`)).rows[0].d;
 return {db,login,asSystem,create,kstDay};
}

test('주문번호: 등록할 때 LG+KST날짜_순번으로 채우고, 클라이언트 값과 수정은 무시한다',async()=>{
 const {db,login,create,kstDay}=await setup();
 try{
  const day=await kstDay();
  await login(1);
  const a=await create({order_no:'HACK'});
  const b=await create();
  assert.equal(a.fassto_order_no,`LG${day}_001`);
  assert.equal(b.fassto_order_no,`LG${day}_002`);
  await db.query(`update logistics_requests set fassto_order_no='X_1',title_text='고침' where id=$1`,[a.id]);
  assert.equal((await db.query('select fassto_order_no from logistics_requests where id=$1',[a.id])).rows[0].fassto_order_no,`LG${day}_001`);
 }finally{await db.close();}
});

test('주문번호: 설치 전 요청은 설치할 때 등록 KST 날짜별 순번으로 채운다',async()=>{
 const {db}=await setup({before:async db=>{
  await db.exec(`insert into logistics_requests(type_code,title_text,team_code,counterparty_text,ship_mode_code,requester_email) values
   ('sample','첫째','global','c','parcel','req@entropymakeup.com'),('sample','둘째','global','c','parcel','req@entropymakeup.com'),('sample','셋째','global','c','parcel','req@entropymakeup.com')`);
  await db.exec(`alter table logistics_requests disable trigger user; -- created_at은 트리거가 지키므로 잠시 끄고 과거 시각을 넣는다
   update logistics_requests set created_at='2026-11-19T14:30:00Z' where title_text='첫째';
   update logistics_requests set created_at='2026-11-19T15:30:00Z' where title_text='둘째';
   update logistics_requests set created_at='2026-11-19T16:00:00Z' where title_text='셋째';
   alter table logistics_requests enable trigger user;`);
 }});
 try{
  const rows=(await db.query('select title_text,fassto_order_no from logistics_requests order by created_at')).rows;
  assert.deepEqual(rows.map(r=>r.fassto_order_no),['LG20261119_001','LG20261120_001','LG20261120_002']); // 15:00Z = KST 자정
 }finally{await db.close();}
});

test('파스토 목록 교체: anon·authenticated는 실행 못 하고, 시스템은 전체를 바꾸며 상품코드는 문자만 받는다',async()=>{
 const {db,login,asSystem}=await setup();
 try{
  const rows=JSON.stringify([{product_code:'0012345',barcode:'8800000000001',product_name:'가짜 립',kind_text:'본품',lot_text:'L1',expires_on:'2028-01-31',available_qty:120},
   {product_code:'0012345',barcode:'8800000000001',product_name:'가짜 립',kind_text:'본품',lot_text:'L2',expires_on:'2028-06-30',available_qty:30},
   {product_code:'A-9',barcode:'',product_name:'가짜 쇼핑백',kind_text:'부자재',lot_text:'',expires_on:'',available_qty:'5'}]);
  await db.exec('set role anon');
  await assert.rejects(()=>db.query(`select approval_private.logistics_replace_fassto_stock($1::jsonb,'fms-browser')`,[rows]),/permission denied/);
  await login(3);
  await assert.rejects(()=>db.query(`select approval_private.logistics_replace_fassto_stock($1::jsonb,'fms-browser')`,[rows]),/permission denied/);
  await assert.rejects(()=>db.query(`insert into logistics_fassto_stock(product_code) values ('x')`),/permission denied/);
  await asSystem();
  await db.query(`insert into logistics_fassto_stock(product_code,product_name) values ('OLD','지워질 상품')`);
  assert.equal((await db.query(`select approval_private.logistics_replace_fassto_stock($1::jsonb,'fms-browser') n`,[rows])).rows[0].n,3);
  const s=(await db.query('select product_code,lot_text,expires_on::text e,available_qty from logistics_fassto_stock order by product_code,lot_text')).rows;
  assert.deepEqual(s.map(r=>[r.product_code,r.lot_text,r.e,r.available_qty]),[['0012345','L1','2028-01-31',120],['0012345','L2','2028-06-30',30],['A-9','',null,5]]);
  const sync=(await db.query('select source_text,row_count from logistics_fassto_sync')).rows;
  assert.deepEqual(sync.map(r=>[r.source_text,r.row_count]),[['fms-browser',3]]);
  await assert.rejects(()=>db.query(`select approval_private.logistics_replace_fassto_stock('[{"product_code":12345}]'::jsonb,'fms-browser')`),/LOGISTICS_STOCK_CODE_NOT_TEXT/);
  await assert.rejects(()=>db.query(`select approval_private.logistics_replace_fassto_stock('[]'::jsonb,'fms-browser')`),/LOGISTICS_STOCK_EMPTY/);
  await assert.rejects(()=>db.query(`select approval_private.logistics_replace_fassto_stock($1::jsonb,'manual')`,[rows]),/LOGISTICS_STOCK_BAD_SOURCE/);
  assert.equal((await db.query('select count(*)::int n from logistics_fassto_stock')).rows[0].n,3); // 실패하면 그대로
  await login(4);
  assert.equal((await db.query('select * from logistics_fassto_stock')).rows.length,3);
  assert.equal((await db.query('select * from logistics_fassto_sync')).rows.length,1);
  await login(2);
  assert.equal((await db.query('select * from logistics_fassto_stock')).rows.length,0);
 }finally{await db.close();}
});

test('받는 곳: 요청자와 활성 담당자만 읽고 쓰며, 다른 직원에게는 0행이다',async()=>{
 const {db,login,create}=await setup();
 try{
  await login(1);const r=await create();
  await db.query(`insert into logistics_request_recipients(request_id,name_text,phone_text,address1_text) values ($1,' 홍길동 ','010-0000-0000','가짜시 가짜로 1')`,[r.id]);
  const mine=(await db.query('select name_text,updated_by_text from logistics_request_recipients')).rows;
  assert.deepEqual([mine[0].name_text,mine[0].updated_by_text],['홍길동','req@entropymakeup.com']);
  await login(4);
  assert.equal((await db.query('select * from logistics_request_recipients')).rows.length,0);
  await assert.rejects(()=>db.query(`insert into logistics_request_recipients(request_id,name_text) values ($1,'x')`,[r.id]),/LOGISTICS_FORBIDDEN|row-level security/);
  assert.equal((await db.query(`update logistics_request_recipients set name_text='남' returning *`)).rows.length,0);
  await login(5); // 비활성 담당자
  assert.equal((await db.query('select * from logistics_request_recipients')).rows.length,0);
  await login(3);
  assert.equal((await db.query('select * from logistics_request_recipients')).rows.length,1);
  await login(2);
  assert.equal((await db.query('select * from logistics_request_recipients')).rows.length,0);
 }finally{await db.close();}
});

test('받는 곳: 운송사·Incoterms·발송인은 담당자만, 요청자는 requested에서만, 담당자는 닫히기 전까지',async()=>{
 const {db,login,create}=await setup();
 try{
  await login(1);const r=await create({mode:'express'});
  await assert.rejects(()=>db.query(`insert into logistics_request_recipients(request_id,name_text,courier_text) values ($1,'A','FEDEX')`,[r.id]),/LOGISTICS_HANDLER_ONLY/);
  await db.query(`insert into logistics_request_recipients(request_id,name_text,country_code) values ($1,'A','ch')`,[r.id]);
  assert.equal((await db.query('select country_code from logistics_request_recipients')).rows[0].country_code,'CH');
  await assert.rejects(()=>db.query(`update logistics_request_recipients set incoterms_code='DAP' where request_id=$1`,[r.id]),/LOGISTICS_HANDLER_ONLY/);
  await login(3);
  await db.query(`update logistics_request_recipients set courier_text='FEDEX',incoterms_code='DAP',sender_email_text='s@entropymakeup.com' where request_id=$1`,[r.id]);
  await db.query(`update logistics_requests set status_code='accepted' where id=$1`,[r.id]);
  await login(1);
  await assert.rejects(()=>db.query(`update logistics_request_recipients set name_text='B' where request_id=$1`,[r.id]),/LOGISTICS_FORBIDDEN/);
  // 요청자 upsert(담당자 칸을 보내지 않음)는 requested일 때 담당자 값을 지우지 않는다
  const r2=await create({mode:'express',title:'둘째'});
  await db.query(`insert into logistics_request_recipients(request_id,name_text) values ($1,'A')`,[r2.id]);
  await login(3);
  await db.query(`update logistics_request_recipients set courier_text='FEDEX' where request_id=$1`,[r2.id]);
  await login(1);
  await db.query(`insert into logistics_request_recipients(request_id,name_text) values ($1,'B') on conflict (request_id) do update set name_text=excluded.name_text`,[r2.id]);
  assert.deepEqual(Object.values((await db.query('select name_text,courier_text from logistics_request_recipients where request_id=$1',[r2.id])).rows[0]),['B','FEDEX']);
  await login(3);
  await db.query(`update logistics_requests set status_code='shipped',result_text='송장 1',shipped_on='2026-11-21' where id=$1`,[r.id]);
  await assert.rejects(()=>db.query(`update logistics_request_recipients set courier_text='DHL' where request_id=$1`,[r.id]),/LOGISTICS_CLOSED/);
 }finally{await db.close();}
});

test('품목: 회사 구성원은 읽고, 요청자는 requested에서만·담당자는 닫히기 전까지 통째로 바꾼다',async()=>{
 const {db,login,create}=await setup();
 try{
  await login(1);const r=await create();
  const items=JSON.stringify([{product_code:'0012345',product_name_text:'가짜 립',qty:3,lot_text:'L1',expires_on:'2028-01-31'},{product_code:'A-9',qty:1,lot_text:'',expires_on:'2028-01-01'}]);
  assert.equal((await db.query(`select public.logistics_replace_items($1,$2::jsonb) n`,[r.id,items])).rows[0].n,2);
  const got=(await db.query('select line_no,product_code,qty,expires_on::text e from logistics_request_items order by line_no')).rows;
  assert.deepEqual(got.map(x=>[x.line_no,x.product_code,x.qty,x.e]),[[1,'0012345',3,'2028-01-31'],[2,'A-9',1,null]]);
  await assert.rejects(()=>db.query(`select public.logistics_replace_items($1,'[{"product_code":12345,"qty":1}]'::jsonb)`,[r.id]),/LOGISTICS_ITEM_BAD/);
  await assert.rejects(()=>db.query(`select public.logistics_replace_items($1,'[{"product_code":"X","qty":0}]'::jsonb)`,[r.id]),/check constraint/);
  const many=JSON.stringify(Array.from({length:51},()=>({product_code:'X',qty:1})));
  await assert.rejects(()=>db.query(`select public.logistics_replace_items($1,$2::jsonb)`,[r.id,many]),/LOGISTICS_ITEM_LIMIT/);
  assert.equal((await db.query('select count(*)::int n from logistics_request_items')).rows[0].n,2); // 실패하면 그대로
  await login(4);
  assert.equal((await db.query('select * from logistics_request_items')).rows.length,2);
  await assert.rejects(()=>db.query(`select public.logistics_replace_items($1,'[]'::jsonb)`,[r.id]),/LOGISTICS_FORBIDDEN/);
  await assert.rejects(()=>db.query(`delete from logistics_request_items`),/LOGISTICS_FORBIDDEN/);
  await login(3);
  await db.query(`update logistics_requests set status_code='accepted' where id=$1`,[r.id]);
  await login(1);
  await assert.rejects(()=>db.query(`select public.logistics_replace_items($1,'[{"product_code":"X","qty":1}]'::jsonb)`,[r.id]),/LOGISTICS_FORBIDDEN/);
  await login(3);
  assert.equal((await db.query(`select public.logistics_replace_items($1,'[{"product_code":"X","qty":5}]'::jsonb) n`,[r.id])).rows[0].n,1);
  await db.query(`update logistics_requests set status_code='canceled' where id=$1`,[r.id]);
  await assert.rejects(()=>db.query(`select public.logistics_replace_items($1,'[]'::jsonb)`,[r.id]),/LOGISTICS_CLOSED/);
  await login(2);
  assert.equal((await db.query('select * from logistics_request_items')).rows.length,0);
  await db.exec('set role anon');
  await assert.rejects(()=>db.query(`select public.logistics_replace_items($1,'[]'::jsonb)`,[r.id]),/permission denied/);
 }finally{await db.close();}
});
