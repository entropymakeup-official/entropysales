const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const {PGlite}=require('@electric-sql/pglite');
const read=f=>fs.readFileSync(path.join(__dirname,'../sql',f),'utf8');
const id=n=>'00000000-0000-0000-0000-'+String(n).padStart(12,'0');

async function setup({storage=false}={}){
 const db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create schema auth;create schema approval_private;
 create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz);
 create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz);
 create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create function auth.jwt() returns jsonb language sql as $$select jsonb_build_object('session_id',current_setting('request.jwt.claim.session_id',true),'email',(select email from auth.users where id=nullif(current_setting('request.jwt.claim.sub',true),'')::uuid))$$;
 grant usage on schema public,auth,approval_private to anon,authenticated;
 insert into auth.users values ('${id(1)}','req@entropymakeup.com',now(),null),('${id(2)}','outsider@example.com',now(),null),('${id(3)}','handler@entropymakeup.com',now(),null),('${id(4)}','other@entropymakeup.com',now(),null);
 insert into auth.sessions select id,id,null from auth.users;
 create table public.invoices(id uuid primary key default gen_random_uuid(),no text);grant select,delete on public.invoices to authenticated;`);
 await db.exec(read('team-tasks.sql')); // is_company_member(), current_email()
 if(storage){
  await db.exec(`create schema storage;grant usage on schema storage to authenticated;
  create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint);
  create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,owner_id text);
  alter table storage.objects enable row level security;grant select,insert,update,delete on storage.objects to authenticated;
  create policy "authenticated storage" on storage.objects to authenticated using (split_part(auth.jwt()->>'email','@',2)='entropymakeup.com') with check (split_part(auth.jwt()->>'email','@',2)='entropymakeup.com');`);
 }
 const sql=read('logistics.sql');await db.exec(sql);await db.exec(sql); // 다시 실행해도 안전
 if(storage){const s=read('logistics-storage.sql');await db.exec(s);await db.exec(s);}
 await db.exec(`insert into logistics_handlers(email,display_name) values ('handler@entropymakeup.com','가짜 담당')`);
 const login=async n=>{await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.session_id',$1,false)",[id(n)]);await db.exec('set role authenticated');};
 const asSystem=async()=>{await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub','',false)");};
 const create=async(o={})=>(await db.query(`insert into logistics_requests(type_code,title_text,team_code,counterparty_text,want_date,ship_mode_code)
  values ($1,$2,'global','예스스타일','2026-11-24',$3) returning *`,[o.type||'b2b',o.title||'예스스타일 Air',o.mode||'air'])).rows[0];
 return {db,login,asSystem,create};
}

test('회사 계정만 읽고 등록하며, 요청자와 첫 상태는 DB가 정한다',async()=>{
 const {db,login,create}=await setup();
 try{
  await db.exec('set role anon');
  await assert.rejects(()=>db.query('select * from logistics_requests'),/permission denied/);
  await login(1);
  const r=(await db.query(`insert into logistics_requests(type_code,title_text,team_code,counterparty_text,ship_mode_code,requester_email,status_code,result_text,slack_ts)
   values ('sample',' 샘플 ','global',' NOVI ','express','fake@entropymakeup.com','shipped','위조','1.1') returning *`)).rows[0];
  assert.equal(r.requester_email,'req@entropymakeup.com');
  assert.equal(r.status_code,'requested');
  assert.equal(r.title_text,'샘플');
  assert.equal(r.result_text,'');
  assert.equal(r.slack_ts,null);
  assert.equal(r.slack_state_code,'pending');
  await assert.rejects(()=>db.query('delete from logistics_requests'),/permission denied/);
  await assert.rejects(()=>db.query(`insert into logistics_request_history(request_id,field_code) values ($1,'status')`,[r.id]),/permission denied/);
  await assert.rejects(()=>db.query('select * from logistics_slack_outbox'),/permission denied/);
  await assert.rejects(()=>db.query(`insert into logistics_handlers(email,display_name) values ('req@entropymakeup.com','나')`),/permission denied/);
  assert.equal((await db.query('select * from logistics_handlers')).rows.length,1);
  await login(2);
  assert.equal((await db.query('select * from logistics_requests')).rows.length,0);
  await assert.rejects(()=>create(),/row-level security/);
 }finally{await db.close();}
});

test('요청자는 요청 상태에서만 요약 수정과 취소를 할 수 있다',async()=>{
 const {db,login,create}=await setup();
 try{
  await login(1);const r=await create();
  await db.query(`update logistics_requests set title_text='수정' where id=$1`,[r.id]);
  await assert.rejects(()=>db.query(`update logistics_requests set status_code='accepted' where id=$1`,[r.id]),/LOGISTICS_FORBIDDEN/);
  await assert.rejects(()=>db.query(`update logistics_requests set result_text='x' where id=$1`,[r.id]),/LOGISTICS_FORBIDDEN/);
  await login(4);
  await assert.rejects(()=>db.query(`update logistics_requests set title_text='남의 것' where id=$1`,[r.id]),/LOGISTICS_FORBIDDEN/);
  await login(3);
  await db.query(`update logistics_requests set status_code='accepted' where id=$1`,[r.id]);
  await login(1);
  await assert.rejects(()=>db.query(`update logistics_requests set status_code='canceled' where id=$1`,[r.id]),/LOGISTICS_FORBIDDEN/);
  const r2=await create({title:'두 번째'});
  await db.query(`update logistics_requests set status_code='canceled' where id=$1`,[r2.id]);
  assert.equal((await db.query('select status_code from logistics_requests where id=$1',[r2.id])).rows[0].status_code,'canceled');
 }finally{await db.close();}
});

test('담당자 전환 규칙: 건너뛰기, 결과·사유 필수, 닫힌 요청 보호',async()=>{
 const {db,login,create}=await setup();
 try{
  await login(1);const r=await create();
  await login(3);
  await assert.rejects(()=>db.query(`update logistics_requests set status_code='shipped' where id=$1`,[r.id]),/LOGISTICS_RESULT_REQUIRED/);
  await assert.rejects(()=>db.query(`update logistics_requests set status_code='on_hold' where id=$1`,[r.id]),/LOGISTICS_NOTE_REQUIRED/);
  await db.query(`update logistics_requests set status_code='on_hold',status_note_text='재고 이동 중' where id=$1`,[r.id]);
  await assert.rejects(()=>db.query(`update logistics_requests set status_code='shipped',result_text='CJ 1',shipped_on='2026-11-24' where id=$1`,[r.id]),/LOGISTICS_BAD_TRANSITION/);
  await db.query(`update logistics_requests set status_code='preparing' where id=$1`,[r.id]);
  await db.query(`update logistics_requests set status_code='shipped',result_text='배차 경기94자6172',shipped_on='2026-11-24' where id=$1`,[r.id]);
  await assert.rejects(()=>db.query(`update logistics_requests set title_text='닫힌 뒤' where id=$1`,[r.id]),/LOGISTICS_CLOSED/);
  await db.query(`update logistics_requests set result_text='배차 경기94자6172 / 송장 123' where id=$1`,[r.id]); // 결과 정정은 가능
  await assert.rejects(()=>db.query(`update logistics_requests set status_code='preparing' where id=$1`,[r.id]),/LOGISTICS_NOTE_REQUIRED/);
  await assert.rejects(()=>db.query(`update logistics_requests set status_code='canceled' where id=$1`,[r.id]),/LOGISTICS_BAD_TRANSITION/);
  await db.query(`update logistics_requests set status_code='preparing',status_note_text='송장 오기' where id=$1`,[r.id]);
  await db.query(`update logistics_requests set status_code='canceled' where id=$1`,[r.id]);
  await assert.rejects(()=>db.query(`update logistics_requests set result_text='x' where id=$1`,[r.id]),/LOGISTICS_CLOSED/);
  await db.query(`update logistics_requests set slack_ts='9.9' where id=$1`,[r.id]); // 담당자의 슬랙 칸 변경은 조용히 무시
  assert.equal((await db.query('select slack_ts from logistics_requests where id=$1',[r.id])).rows[0].slack_ts,null);
  const q=await create({type:'quick',mode:'quick',title:'퀵'});
  await db.query(`update logistics_requests set status_code='shipped',result_text='기사 010',shipped_on='2026-11-20',slack_ts='9.9',slack_state_code='sent' where id=$1`,[q.id]);
  const after=(await db.query('select slack_ts,slack_state_code from logistics_requests where id=$1',[q.id])).rows[0];
  assert.deepEqual([after.slack_ts,after.slack_state_code],[null,'pending']); // 슬랙 칸은 시스템만 바꾼다
 }finally{await db.close();}
});

test('이력과 슬랙 대기열은 트리거가 남긴다',async()=>{
 const {db,login,asSystem,create}=await setup();
 try{
  await login(1);const r=await create();
  await login(3);
  await db.query(`update logistics_requests set status_code='accepted',want_date='2026-11-25',packing_code='waiting' where id=$1`,[r.id]);
  await db.query(`update logistics_requests set status_code='on_hold',status_note_text='거래처 회신 대기' where id=$1`,[r.id]);
  await db.query(`update logistics_requests set status_code='preparing' where id=$1`,[r.id]);
  await db.query(`update logistics_requests set status_code='shipped',result_text='BL 1',shipped_on='2026-11-26' where id=$1`,[r.id]);
  await db.query(`update logistics_requests set status_code='preparing',status_note_text='BL 정정' where id=$1`,[r.id]);
  const h=(await db.query('select field_code,from_text,to_text,changed_by_text from logistics_request_history where request_id=$1 order by id',[r.id])).rows;
  assert.deepEqual(h.map(x=>x.field_code),['created','status','want_date','packing','status','status','status','result','status']);
  assert.deepEqual([h[1].from_text,h[1].to_text,h[1].changed_by_text],['requested','accepted','handler@entropymakeup.com']);
  await asSystem();
  const o=(await db.query('select event_code,state_code,payload from logistics_slack_outbox where request_id=$1 order by id',[r.id])).rows;
  assert.deepEqual(o.map(x=>x.event_code),['created','on_hold','shipped','reopened']);
  assert.ok(o.every(x=>x.state_code==='pending'));
  assert.equal(o[1].payload.status_note_text,'거래처 회신 대기');
  assert.equal(o[2].payload.result_text,'BL 1');
  assert.equal(o[0].payload.requester_email,'req@entropymakeup.com');
 }finally{await db.close();}
});

test('연결 주문이 지워지면 출고완료 요청이어도 연결만 비워진다',async()=>{
 const {db,login,create}=await setup();
 try{
  await db.exec('reset role');
  const inv=(await db.query(`insert into public.invoices(no) values ('TEST_001') returning id`)).rows[0].id;
  await login(1);const r=await create();
  await db.query(`update logistics_requests set invoice_id=$2 where id=$1`,[r.id,inv]);
  await login(3);
  await db.query(`update logistics_requests set status_code='shipped',result_text='BL 1',shipped_on='2026-11-24' where id=$1`,[r.id]);
  await login(4); // 담당자가 아닌 사람이 주문을 지워도
  await db.query('delete from public.invoices where id=$1',[inv]);
  const q=(await db.query('select invoice_id,status_code from logistics_requests where id=$1',[r.id])).rows[0];
  assert.deepEqual([q.invoice_id,q.status_code],[null,'shipped']);
 }finally{await db.close();}
});

test('첨부·댓글: 작성자는 DB가 정하고, 닫힌 요청과 10개 초과는 막는다',async()=>{
 const {db,login,create}=await setup();
 try{
  await login(1);const r=await create();
  const path0=`${r.id}/${id(9)}-출고요청서.xlsx`;
  const f=(await db.query(`insert into logistics_request_files(request_id,kind_code,storage_path,name_text,size_bytes,created_by) values ($1,'request',$2,'출고요청서.xlsx',100,'fake@x.com') returning *`,[r.id,path0])).rows[0];
  assert.equal(f.created_by,'req@entropymakeup.com');
  await assert.rejects(()=>db.query(`insert into logistics_request_files(request_id,kind_code,storage_path,name_text,size_bytes) values ($1,'request','other/x.xlsx','x',1)`,[r.id]),/check constraint|LOGISTICS_FORBIDDEN/);
  await assert.rejects(()=>db.query(`insert into logistics_request_files(request_id,kind_code,storage_path,name_text,size_bytes) values ($1,'request',$2,'x',20971521)`,[r.id,`${r.id}/${id(8)}-x`]),/check constraint/);
  for(let i=10;i<19;i++)await db.query(`insert into logistics_request_files(request_id,kind_code,storage_path,name_text,size_bytes) values ($1,'etc',$2,'x',1)`,[r.id,`${r.id}/${id(i)}-x`]);
  await assert.rejects(()=>db.query(`insert into logistics_request_files(request_id,kind_code,storage_path,name_text,size_bytes) values ($1,'etc',$2,'x',1)`,[r.id,`${r.id}/${id(30)}-x`]),/LOGISTICS_FILE_LIMIT/);
  const c=(await db.query(`insert into logistics_request_comments(request_id,body_text,author_email) values ($1,' 주소 확인 ','fake@x.com') returning *`,[r.id])).rows[0];
  assert.deepEqual([c.author_email,c.body_text],['req@entropymakeup.com','주소 확인']);
  await assert.rejects(()=>db.query(`update logistics_request_comments set body_text='x'`),/permission denied/);
  await login(4);
  assert.equal((await db.query('delete from logistics_request_comments returning id')).rows.length,0);
  assert.equal((await db.query('delete from logistics_request_files returning id')).rows.length,0);
  await login(1);
  assert.equal((await db.query('delete from logistics_request_comments returning id')).rows.length,1);
  await login(3);
  assert.equal((await db.query(`delete from logistics_request_files where storage_path=$1 returning id`,[path0])).rows.length,1); // 담당자는 지울 수 있다
  await db.query(`update logistics_requests set status_code='canceled' where id=$1`,[r.id]);
  await assert.rejects(()=>db.query(`insert into logistics_request_files(request_id,kind_code,storage_path,name_text,size_bytes) values ($1,'etc',$2,'x',1)`,[r.id,`${r.id}/${id(31)}-x`]),/LOGISTICS_CLOSED/);
 }finally{await db.close();}
});
