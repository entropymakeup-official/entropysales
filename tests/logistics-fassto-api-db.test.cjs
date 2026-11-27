const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const {PGlite}=require('@electric-sql/pglite');
const read=f=>fs.readFileSync(path.join(__dirname,'../sql',f),'utf8');
const id=n=>'00000000-0000-0000-0000-'+String(n).padStart(12,'0');
const KEY='test-sync-key-'+'0'.repeat(40);

async function setup(){
 const db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create schema auth;create schema approval_private;
 create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz);
 create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz);
 create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create function auth.jwt() returns jsonb language sql security definer as $$select jsonb_build_object('session_id',current_setting('request.jwt.claim.session_id',true),'email',(select email from auth.users where id=nullif(current_setting('request.jwt.claim.sub',true),'')::uuid))$$;
 grant usage on schema public,auth,approval_private to anon,authenticated;
 insert into auth.users values ('${id(1)}','req@entropymakeup.com',now(),null),('${id(3)}','handler@entropymakeup.com',now(),null),('${id(4)}','other@entropymakeup.com',now(),null);
 insert into auth.sessions select id,id,null from auth.users;
 create table public.invoices(id uuid primary key default gen_random_uuid(),no text);grant select on public.invoices to authenticated;`);
 await db.exec(read('team-tasks.sql'));
 await db.exec(read('logistics.sql'));
 await db.exec(`insert into logistics_handlers(email,display_name) values ('handler@entropymakeup.com','가짜 담당');
  insert into logistics_people(email,display_name) values ('req@entropymakeup.com','가짜 요청자');`);
 await db.exec(read('logistics-fassto.sql'));
 const sql=read('logistics-fassto-api.sql');await db.exec(sql);await db.exec(sql); // 다시 실행해도 안전
 await db.exec(`insert into approval_private.logistics_fassto_keys(key_hash,label_text) values (encode(sha256(convert_to('${KEY}','UTF8')),'hex'),'테스트');
  insert into approval_private.logistics_fassto_settings(id,default_requester_email) values (1,'handler@entropymakeup.com');`);
 const login=async n=>{await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.session_id',$1,false)",[id(n)]);await db.exec('set role authenticated');};
 const asSystem=async()=>{await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub','',false)");};
 const asAnon=async()=>{await asSystem();await db.exec('set role anon');};
 const ingest=async(deliveries,stock=null,key=KEY)=>{await asAnon();try{return (await db.query('select public.logistics_fassto_ingest($1,$2::jsonb,$3::jsonb) r',[key,stock==null?null:JSON.stringify(stock),deliveries==null?null:JSON.stringify(deliveries)])).rows[0].r;}finally{await asSystem();}};
 const create=async(o={})=>{await login(1);try{return (await db.query(`insert into logistics_requests(type_code,title_text,team_code,counterparty_text,ship_mode_code) values ('b2b',$1,'global','가짜 바이어',$2) returning *`,[o.title||'수동 요청',o.mode||'direct'])).rows[0];}finally{await asSystem();}};
 const req=async slip=>(await db.query('select * from logistics_requests where fassto_slip_no=$1',[slip])).rows[0];
 return {db,login,asSystem,asAnon,ingest,create,req};
}
const dlv=(o={})=>({slip_no:'GG24OO261201000001',order_no:'가짜 주문 1',order_date:'2026-12-01',out_div:'car',shop_name:'가짜 바이어',status_code:'ORDER',
 remark:'가짜 비고',invoice_no:'',parcel_name:'',registered_by:'가짜 요청자',qty_total:30,
 items:[{product_code:'11111111111111',product_name:'가짜 상품',expires_on:'2029-01-01',qty:30}],...o});

test('연결 칸: 회사 구성원은 파스토 칸을 넣거나 바꿀 수 없고, 시스템은 바꿀 수 있다',async()=>{
 const {db,login,asSystem}=await setup();
 try{
  await login(1);
  const r=(await db.query(`insert into logistics_requests(type_code,title_text,team_code,counterparty_text,ship_mode_code,fassto_slip_no,fassto_status_code)
   values ('b2b','t','global','c','direct','HACK1','DONE') returning *`)).rows[0];
  assert.equal(r.fassto_slip_no,null);assert.equal(r.fassto_status_code,null);
  await asSystem();
  await db.query(`update logistics_requests set fassto_slip_no='GG24OO261201000009',fassto_status_code='ORDER' where id=$1`,[r.id]);
  await login(3);
  await db.query(`update logistics_requests set fassto_slip_no='HACK2',fassto_status_code='DONE',title_text='고침' where id=$1`,[r.id]);
  await asSystem();
  const after=(await db.query('select * from logistics_requests where id=$1',[r.id])).rows[0];
  assert.equal(after.fassto_slip_no,'GG24OO261201000009');assert.equal(after.fassto_status_code,'ORDER');assert.equal(after.title_text,'고침');
  await assert.rejects(()=>db.query(`update logistics_requests set fassto_status_code='PARTDONE' where id=$1`,[r.id]),/check/i);
 }finally{await db.close();}
});

test('기사 정보: 담당자만 쓰고, 요청자·담당자만 읽고, 취소된 요청에는 못 쓴다',async()=>{
 const {db,login,asSystem,create}=await setup();
 try{
  const r=await create();
  await login(1);
  await assert.rejects(()=>db.query(`insert into logistics_request_drivers(request_id,driver_name_text) values ($1,'가짜 기사')`,[r.id]));
  await login(3);
  await db.query(`insert into logistics_request_drivers(request_id,driver_name_text,driver_phone_text,vehicle_no_text) values ($1,' 가짜 기사 ','010-0000-0000','00가0000')`,[r.id]);
  const row=(await db.query('select * from logistics_request_drivers where request_id=$1',[r.id])).rows[0];
  assert.equal(row.driver_name_text,'가짜 기사');assert.equal(row.updated_by_text,'handler@entropymakeup.com');
  await login(1);
  assert.equal((await db.query('select * from logistics_request_drivers where request_id=$1',[r.id])).rows.length,1);
  await login(4);
  assert.equal((await db.query('select * from logistics_request_drivers where request_id=$1',[r.id])).rows.length,0);
  await asSystem();
  await db.query(`update logistics_requests set status_code='canceled' where id=$1`,[r.id]);
  await login(3);
  await assert.rejects(()=>db.query(`update logistics_request_drivers set vehicle_no_text='11나1111' where request_id=$1`,[r.id]),/LOGISTICS_CLOSED/);
 }finally{await db.close();}
});

test('동기화 표: 기존 재고 갱신 행은 kind_code=stock, 오류 칸 기본값은 빈 문자열',async()=>{
 const {db}=await setup();
 try{
  await db.query(`select approval_private.logistics_replace_fassto_stock('[{"product_code":"11111111111111","available_qty":5}]'::jsonb,'fms-browser')`);
  const s=(await db.query('select kind_code,error_text from logistics_fassto_sync')).rows[0];
  assert.deepEqual(s,{kind_code:'stock',error_text:''});
  await assert.rejects(()=>db.query(`insert into logistics_fassto_sync(source_text,row_count,kind_code) values ('fassto-api',0,'etc')`),/check/i);
 }finally{await db.close();}
});

test('열쇠·설정 표: anon·authenticated는 읽을 수 없다',async()=>{
 const {db,login,asAnon,asSystem}=await setup();
 try{
  await login(3);
  await assert.rejects(()=>db.query('select * from approval_private.logistics_fassto_keys'),/permission denied/);
  await asAnon();
  await assert.rejects(()=>db.query('select * from approval_private.logistics_fassto_settings'),/permission denied/);
  await asSystem();
 }finally{await db.close();}
});
