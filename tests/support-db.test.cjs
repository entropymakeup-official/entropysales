const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const {PGlite}=require('@electric-sql/pglite');
const read=f=>fs.readFileSync(path.join(__dirname,'../sql',f),'utf8');
const id=n=>'00000000-0000-0000-0000-'+String(n).padStart(12,'0');
const fid=n=>'11111111-0000-0000-0000-'+String(n).padStart(12,'0');

// 1=요청자, 2=회사 밖, 3=경영지원 담당, 4=다른 직원
async function setup({storage=false,slack=false}={}){
 const db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create schema auth;create schema approval_private;
 create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz);
 create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz);
 create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create function auth.jwt() returns jsonb language sql security definer as $$select jsonb_build_object('session_id',current_setting('request.jwt.claim.session_id',true),'email',(select email from auth.users where id=nullif(current_setting('request.jwt.claim.sub',true),'')::uuid))$$;
 grant usage on schema public,auth,approval_private to anon,authenticated;
 insert into auth.users values ('${id(1)}','req@entropymakeup.com',now(),null),('${id(2)}','outsider@example.com',now(),null),('${id(3)}','handler@entropymakeup.com',now(),null),('${id(4)}','other@entropymakeup.com',now(),null);
 insert into auth.sessions select id,id,null from auth.users;
 create table public.invoices(id uuid primary key default gen_random_uuid(),no text);grant select,delete on public.invoices to authenticated;`);
 if(slack)await db.exec(`create schema net;
 create table net._http_response(id bigint primary key,status_code integer,content text,error_msg text,timed_out boolean);
 create table net.calls(id bigserial primary key,url text,body jsonb,headers jsonb);
 create function net.http_post(url text,body jsonb default '{}',params jsonb default '{}',headers jsonb default '{}',timeout_milliseconds integer default 5000) returns bigint
  language plpgsql as $$declare n bigint;begin insert into net.calls(url,body,headers) values (url,body,headers) returning id into n;return n;end$$;
 create schema vault;create table vault.decrypted_secrets(name text primary key,decrypted_secret text);
 create schema cron;create table cron.job(jobid bigserial primary key,jobname text,schedule text,command text);
 create function cron.schedule(n text,s text,c text) returns bigint language sql as $$insert into cron.job(jobname,schedule,command) values (n,s,c) returning jobid$$;
 create function cron.unschedule(j bigint) returns boolean language sql as $$delete from cron.job where jobid=j returning true$$;
 insert into vault.decrypted_secrets values ('logistics_slack_bot_token','xoxb-test'),('logistics_slack_channel','CLOGI0001');`);
 if(storage)await db.exec(`create schema storage;grant usage on schema storage to authenticated;
  create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint);
  create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,owner_id text);
  alter table storage.objects enable row level security;grant select,insert,update,delete on storage.objects to authenticated;
  create policy "authenticated storage" on storage.objects to authenticated using (split_part(auth.jwt()->>'email','@',2)='entropymakeup.com') with check (split_part(auth.jwt()->>'email','@',2)='entropymakeup.com');`);
 await db.exec(read('team-tasks.sql'));
 await db.exec(read('logistics.sql'));
 if(slack)await db.exec(read('logistics-slack.sql'));
 const sql=read('support.sql');await db.exec(sql);await db.exec(sql); // 다시 실행해도 안전
 if(storage){const s=read('support-storage.sql');await db.exec(s);await db.exec(s);}
 if(slack){const s=read('support-slack.sql');await db.exec(s);await db.exec(s);}
 await db.exec(`insert into support_handlers(email,display_name) values ('handler@entropymakeup.com','가짜 경영지원');
  insert into logistics_people(email,display_name,slack_user_id) values ('req@entropymakeup.com','가짜 요청자','UREQ0001'),('handler@entropymakeup.com','가짜 경영지원','UHND0001');`);
 const login=async n=>{await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.session_id',$1,false)",[id(n)]);await db.exec('set role authenticated');};
 const asSystem=async()=>{await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub','',false)");};
 const create=async(o={})=>(await db.query(`insert into support_requests(type_code,title_text,counterparty_text,due_date,amount_text)
  values ($1,$2,'데모거래처','2026-11-30','공급가 1,000,000원') returning *`,[o.type||'tax_invoice',o.title||'데모 11월 계산서'])).rows[0];
 const file=async(reqId,n,kind='request')=>(await db.query(`insert into support_request_files(request_id,kind_code,storage_path,name_text,size_bytes) values ($1,$2,$3,'a.pdf',10) returning *`,
  [reqId,kind,`${reqId}/${fid(n)}-a.pdf`])).rows[0];
 const setStatus=(reqId,to,extra='')=>db.query(`update support_requests set status_code='${to}'${extra} where id=$1 returning *`,[reqId]);
 return {db,login,asSystem,create,file,setStatus};
}

test('회사 계정만 읽고 등록하며, 요청자와 첫 상태는 DB가 정한다',async()=>{
 const {db,login,create}=await setup();
 try{
  await db.exec('set role anon');
  await assert.rejects(()=>db.query('select * from support_requests'),/permission denied/);
  await login(1);
  const r=(await db.query(`insert into support_requests(type_code,title_text,counterparty_text,requester_email,status_code,result_text,done_at)
   values ('purchase_confirm',' 구매확인서 ',' 데모 ','fake@entropymakeup.com','done','위조',now()) returning *`)).rows[0];
  assert.equal(r.requester_email,'req@entropymakeup.com');
  assert.equal(r.status_code,'requested');
  assert.equal(r.title_text,'구매확인서');
  assert.equal(r.result_text,'');
  assert.equal(r.done_at,null);
  await assert.rejects(()=>db.query('delete from support_requests'),/permission denied/);
  await assert.rejects(()=>db.query('select * from support_slack_outbox'),/permission denied/);
  await assert.rejects(()=>db.query(`insert into support_handlers(email,display_name) values ('req@entropymakeup.com','나')`),/permission denied/);
  await login(4);
  assert.equal((await db.query('select * from support_requests')).rows.length,1);
  await login(2);
  assert.equal((await db.query('select * from support_requests')).rows.length,0);
  await assert.rejects(()=>create(),/row-level security/);
 }finally{await db.close();}
});

test('요청자는 요청 상태에서만 요약 수정·취소, 다른 직원은 못 바꾼다',async()=>{
 const {db,login,create,setStatus}=await setup();
 try{
  await login(1);const r=await create();
  await db.query(`update support_requests set title_text='수정' where id=$1`,[r.id]);
  await assert.rejects(()=>setStatus(r.id,'in_progress'),/SUPPORT_FORBIDDEN/);
  await assert.rejects(()=>db.query(`update support_requests set result_text='x' where id=$1`,[r.id]),/SUPPORT_FORBIDDEN/);
  await login(4);
  await assert.rejects(()=>db.query(`update support_requests set title_text='남의 것' where id=$1`,[r.id]),/SUPPORT_FORBIDDEN/);
  await login(3);await setStatus(r.id,'in_progress');
  await login(1);
  await assert.rejects(()=>db.query(`update support_requests set title_text='늦은 수정' where id=$1`,[r.id]),/SUPPORT_FORBIDDEN/);
  await assert.rejects(()=>setStatus(r.id,'canceled'),/SUPPORT_FORBIDDEN/);
  const r2=await create({title:'취소할 것'});
  assert.equal((await setStatus(r2.id,'canceled')).rows[0].status_code,'canceled');
 }finally{await db.close();}
});

test('완료에는 발급본 첨부가 필요하고, 되돌리기·보류에는 사유가 필요하다',async()=>{
 const {db,login,create,file,setStatus}=await setup();
 try{
  await login(1);const r=await create();
  await file(r.id,1,'request');
  await login(3);
  await assert.rejects(()=>setStatus(r.id,'done'),/SUPPORT_RESULT_FILE_REQUIRED/);
  await assert.rejects(()=>setStatus(r.id,'on_hold'),/SUPPORT_NOTE_REQUIRED/);
  await file(r.id,2,'result');
  const done=(await setStatus(r.id,'done',`, result_text='승인 2026-0001'`)).rows[0];
  assert.equal(done.status_code,'done');assert.ok(done.done_at);
  await assert.rejects(()=>db.query(`update support_requests set title_text='완료 뒤' where id=$1`,[r.id]),/SUPPORT_CLOSED/);
  await assert.rejects(()=>setStatus(r.id,'canceled'),/SUPPORT_BAD_TRANSITION/);
  await assert.rejects(()=>setStatus(r.id,'in_progress'),/SUPPORT_NOTE_REQUIRED/);
  const back=(await setStatus(r.id,'in_progress',`, status_note_text='금액 정정'`)).rows[0];
  assert.equal(back.done_at,null);
  await setStatus(r.id,'canceled');
  await assert.rejects(()=>setStatus(r.id,'requested'),/SUPPORT_CLOSED/);
 }finally{await db.close();}
});

test('이력과 슬랙 대기열은 트리거가 남긴다',async()=>{
 const {db,login,asSystem,create,file,setStatus}=await setup();
 try{
  await login(1);const r=await create();
  await login(3);await file(r.id,1,'result');await setStatus(r.id,'done');
  await asSystem();
  const ev=(await db.query('select event_code from support_slack_outbox where request_id=$1 order by id',[r.id])).rows.map(x=>x.event_code);
  assert.deepEqual(ev,['created','done']);
  const h=(await db.query('select field_code,to_text from support_request_history where request_id=$1 order by id',[r.id])).rows;
  assert.deepEqual(h.map(x=>x.field_code),['created','status']);
 }finally{await db.close();}
});

test('첨부 행: 요청자·담당자만 보고, 발급본은 담당자만 올리며, 마지막 발급본은 완료 중에 못 지운다',async()=>{
 const {db,login,create,file,setStatus}=await setup();
 try{
  await login(1);const r=await create();
  await file(r.id,1,'request');
  await assert.rejects(()=>file(r.id,2,'result'),/SUPPORT_HANDLER_ONLY/);
  await login(4);
  assert.equal((await db.query('select * from support_request_files')).rows.length,0);
  await assert.rejects(()=>file(r.id,3,'request'),/SUPPORT_FORBIDDEN|row-level security/);
  await login(3);
  assert.equal((await db.query('select * from support_request_files')).rows.length,1);
  const res=await file(r.id,4,'result');
  await setStatus(r.id,'done');
  await assert.rejects(()=>db.query('delete from support_request_files where id=$1',[res.id]),/SUPPORT_RESULT_FILE_REQUIRED/);
  await file(r.id,5,'result'); // 완료 뒤 정정본 추가
  assert.equal((await db.query('delete from support_request_files where id=$1 returning id',[res.id])).rows.length,1);
  await login(1);
  assert.equal((await db.query('select * from support_request_files')).rows.length,2);
  await assert.rejects(()=>file(r.id,6,'request'),/SUPPORT_CLOSED/);
  assert.equal((await db.query(`delete from support_request_files where kind_code='request' returning id`)).rows.length,0); // 닫힌 요청은 요청자가 못 지움
 }finally{await db.close();}
});

test('첨부 버킷: 요청자·담당자만 읽고, 열린 요청 경로에만 올리고, 수정은 막는다',async()=>{
 const {db,login,create,file}=await setup({storage:true});
 try{
  await login(1);const r=await create();
  const name=`${r.id}/${fid(1)}-a.pdf`;
  await db.query(`insert into storage.objects(bucket_id,name,owner_id) values ('support-docs',$1,$2)`,[name,id(1)]);
  await file(r.id,1,'request');
  await assert.rejects(()=>db.query(`insert into storage.objects(bucket_id,name,owner_id) values ('support-docs','bad-path',$1)`,[id(1)]),/row-level security/);
  await login(4);
  assert.equal((await db.query(`select * from storage.objects where bucket_id='support-docs'`)).rows.length,0);
  await assert.rejects(()=>db.query(`insert into storage.objects(bucket_id,name,owner_id) values ('support-docs',$1,$2)`,[`${r.id}/${fid(2)}-b.pdf`,id(4)]),/row-level security/);
  await login(3);
  assert.equal((await db.query(`select * from storage.objects where bucket_id='support-docs'`)).rows.length,1);
  assert.equal((await db.query(`update storage.objects set name='x' where bucket_id='support-docs' returning id`)).rows.length,0);
  await login(1);
  assert.equal((await db.query(`select * from storage.objects where bucket_id='support-docs'`)).rows.length,1);
 }finally{await db.close();}
});

test('슬랙: 새 요청은 담당자 멘션 새 글, 완료는 스레드 답글, 채널이 없으면 보내지 않는다',async()=>{
 const {db,login,asSystem,create,file,setStatus}=await setup({slack:true});
 try{
  await login(1);const r=await create({title:'데모 <계산서> & 11월'});
  await asSystem();
  await db.query('select approval_private.support_slack_flush()');
  assert.equal((await db.query('select * from net.calls')).rows.length,0); // support_slack_channel 없음
  await db.exec(`insert into vault.decrypted_secrets values ('support_slack_channel','CSUP0001')`);
  await db.query('select approval_private.support_slack_flush()');
  const c1=(await db.query('select * from net.calls order by id')).rows;
  assert.equal(c1.length,1);
  assert.equal(c1[0].body.channel,'CSUP0001');
  assert.match(c1[0].body.text,/\[세금계산서 발행\] 데모 &lt;계산서&gt; &amp; 11월/);
  assert.match(c1[0].body.text,/<@UREQ0001> → <@UHND0001>/);
  assert.match(c1[0].body.text,/support\.html\?id=/);
  await db.query('insert into net._http_response(id,status_code,content) values ($1,200,$2)',[c1[0].id,JSON.stringify({ok:true,ts:'111.222'})]);
  await db.query('select approval_private.support_slack_flush()');
  await login(3);await file(r.id,1,'result');await setStatus(r.id,'done',`, result_text='승인 0001'`);
  await asSystem();
  await db.query('select approval_private.support_slack_flush()');
  const c2=(await db.query('select * from net.calls order by id')).rows;
  assert.equal(c2.length,2);
  assert.equal(c2[1].body.thread_ts,'111.222');
  assert.match(c2[1].body.text,/완료 · 승인 0001/);
  assert.equal((await db.query(`select count(*)::int n from cron.job where jobname='support-slack-send'`)).rows[0].n,1);
  await login(1);
  await assert.rejects(()=>db.query('select approval_private.support_slack_flush()'),/permission denied/);
 }finally{await db.close();}
});
