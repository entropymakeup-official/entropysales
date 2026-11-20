const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const {PGlite}=require('@electric-sql/pglite');
const read=f=>fs.readFileSync(path.join(__dirname,'../sql',f),'utf8');
const id=n=>'00000000-0000-0000-0000-'+String(n).padStart(12,'0');

async function setup({secrets=true}={}){
 const db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create schema auth;create schema approval_private;
 create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz);
 create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz);
 create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create function auth.jwt() returns jsonb language sql as $$select jsonb_build_object('session_id',current_setting('request.jwt.claim.session_id',true))$$;
 grant usage on schema public,auth,approval_private to anon,authenticated;
 insert into auth.users values ('${id(1)}','req@entropymakeup.com',now(),null),('${id(3)}','handler@entropymakeup.com',now(),null);
 insert into auth.sessions select id,id,null from auth.users;
 create table public.invoices(id uuid primary key default gen_random_uuid(),no text);
 create schema net;
 create table net._http_response(id bigint primary key,status_code integer,content text,error_msg text,timed_out boolean);
 create table net.calls(id bigserial primary key,url text,body jsonb,headers jsonb);
 -- 운영 pg_net 0.20.3처럼 Content-Type이 정확히 application/json이 아니면 거절한다.
 create function net.http_post(url text,body jsonb default '{}',params jsonb default '{}',headers jsonb default '{}',timeout_milliseconds integer default 5000) returns bigint
  language plpgsql as $$declare n bigint;begin
   if headers->>'Content-Type' is distinct from 'application/json' then raise exception 'Content-Type header must be "application/json"'; end if;
   insert into net.calls(url,body,headers) values (url,body,headers) returning id into n;return n;end$$;
 create schema vault;create table vault.decrypted_secrets(name text primary key,decrypted_secret text);
 create schema cron;create table cron.job(jobid bigserial primary key,jobname text,schedule text,command text);
 create function cron.schedule(n text,s text,c text) returns bigint language sql as $$insert into cron.job(jobname,schedule,command) values (n,s,c) returning jobid$$;
 create function cron.unschedule(j bigint) returns boolean language sql as $$delete from cron.job where jobid=j returning true$$;`);
 if(secrets)await db.exec(`insert into vault.decrypted_secrets values ('logistics_slack_bot_token','xoxb-test'),('logistics_slack_channel','C08MUA6K4D6')`);
 await db.exec(read('team-tasks.sql'));
 await db.exec(read('logistics.sql'));
 const s=read('logistics-slack.sql');await db.exec(s);await db.exec(s);
 await db.exec(`insert into logistics_handlers(email,display_name) values ('handler@entropymakeup.com','가짜 담당');
  insert into logistics_people(email,display_name,slack_user_id) values ('req@entropymakeup.com','가짜 요청자','UREQ0001'),('handler@entropymakeup.com','가짜 담당','UHND0001');`);
 const login=async n=>{await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.session_id',$1,false)",[id(n)]);await db.exec('set role authenticated');};
 const system=async()=>{await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub','',false)");};
 const flush=async()=>{await system();await db.query('select approval_private.logistics_slack_flush()');};
 const calls=async()=>{await system();return (await db.query('select * from net.calls order by id')).rows;};
 const respond=async(callId,obj,status=200)=>{await system();await db.query('insert into net._http_response(id,status_code,content) values ($1,$2,$3)',[callId,status,JSON.stringify(obj)]);};
 const create=async(title='예스스타일 <Air> & 11월')=>{await login(1);return (await db.query(`insert into logistics_requests(type_code,title_text,team_code,counterparty_text,want_date,ship_mode_code) values ('b2b',$1,'global','예스스타일','2026-11-24','air') returning *`,[title])).rows[0];};
 return {db,login,system,flush,calls,respond,create};
}

test('새 요청은 채널에 새 글로 보내고 ts를 저장한다',async()=>{
 const t=await setup();
 try{
  const r=await t.create();
  await t.flush();
  const [c]=await t.calls();
  assert.equal(c.url,'https://slack.com/api/chat.postMessage');
  assert.equal(c.headers.Authorization,'Bearer xoxb-test');
  assert.equal(c.body.channel,'C08MUA6K4D6');
  assert.equal(c.body.thread_ts,undefined);
  assert.match(c.body.text,/\[B2B출고\] 예스스타일 &lt;Air&gt; &amp; 11월/);
  assert.match(c.body.text,/희망 11\/24 · Air/);
  assert.match(c.body.text,/요청 <@UREQ0001> → <@UHND0001>/);
  // 주소를 그대로 보이지 않고 "요청 상세 보기" 문구 링크로 넣는다 (<url|문구>)
  assert.match(c.body.text,new RegExp(`<https://entropymakeup-official\\.github\\.io/entropysales/logistics\\.html\\?id=${r.id}\\|요청 상세 보기>`));
  await t.flush(); // 응답 전에는 다시 보내지 않는다
  assert.equal((await t.calls()).length,1);
  await t.respond(c.id,{ok:true,ts:'1795000000.000100'});
  await t.flush();
  const q=(await t.db.query('select slack_ts,slack_state_code from logistics_requests where id=$1',[r.id])).rows[0];
  assert.deepEqual([q.slack_ts,q.slack_state_code],['1795000000.000100','sent']);
  assert.equal((await t.db.query(`select state_code from logistics_slack_outbox where request_id=$1`,[r.id])).rows[0].state_code,'sent');
 }finally{await t.db.close();}
});

test('멘션을 끈 담당자는 새 요청 알림에서 빠지지만 담당자 권한은 그대로다',async()=>{
 const t=await setup();
 try{
  await t.system();
  await t.db.exec(`insert into logistics_handlers(email,display_name,mention_on_new) values ('boss@entropymakeup.com','대표',false);
   insert into logistics_people(email,display_name,slack_user_id) values ('boss@entropymakeup.com','대표','UBOSS001');`);
  await t.create();
  await t.flush();
  const [c]=await t.calls();
  assert.match(c.body.text,/→ <@UHND0001>\n/);
  assert.doesNotMatch(c.body.text,/UBOSS001/);
  const n=(await t.db.query(`select count(*)::int n from logistics_handlers where is_active`)).rows[0].n;
  assert.equal(n,2);
 }finally{await t.db.close();}
});

test('출고완료·보류는 원래 글의 스레드 답글로 보내고, 원글이 끝나기 전에는 기다린다',async()=>{
 const t=await setup();
 try{
  const r=await t.create('퀵 샘플');
  await t.login(3);
  await t.db.query(`update logistics_requests set status_code='on_hold',status_note_text='주소 확인' where id=$1`,[r.id]);
  await t.flush();
  assert.equal((await t.calls()).length,1); // 원글만 보냄, 답글은 대기
  await t.respond(1,{ok:true,ts:'1795000000.000200'});
  await t.flush();
  const cs=await t.calls();
  assert.equal(cs.length,2);
  assert.equal(cs[1].body.thread_ts,'1795000000.000200');
  assert.match(cs[1].body.text,/보류: 주소 확인/);
  assert.match(cs[1].body.text,/<@UREQ0001>/);
  await t.login(3);
  await t.db.query(`update logistics_requests set status_code='preparing' where id=$1`,[r.id]);
  await t.db.query(`update logistics_requests set status_code='shipped',result_text='배차 경기94자6172',shipped_on='2026-11-20' where id=$1`,[r.id]);
  await t.flush();
  const last=(await t.calls()).at(-1);
  assert.match(last.body.text,/출고완료 11\/20 · 배차 경기94자6172/);
 }finally{await t.db.close();}
});

test('실패는 5번까지 다시 보내고 그 뒤에는 실패로 표시한다. 원글이 실패하면 답글은 새 글로 보낸다',async()=>{
 const t=await setup();
 try{
  const r=await t.create();
  await t.login(3);
  await t.db.query(`update logistics_requests set status_code='canceled' where id=$1`,[r.id]);
  for(let i=1;i<=5;i++){await t.flush();const c=(await t.calls()).at(-1);await t.respond(c.id,{ok:false,error:'channel_not_found'});}
  await t.flush();
  const o=(await t.db.query(`select event_code,state_code,attempts,last_error_text from logistics_slack_outbox where request_id=$1 order by id`,[r.id])).rows;
  assert.deepEqual([o[0].state_code,o[0].attempts],['failed',5]);
  assert.match(o[0].last_error_text,/channel_not_found/);
  assert.equal((await t.db.query('select slack_state_code from logistics_requests where id=$1',[r.id])).rows[0].slack_state_code,'failed');
  const last=(await t.calls()).at(-1);
  assert.match(last.body.text,/취소/);
  assert.equal(last.body.thread_ts,undefined);
 }finally{await t.db.close();}
});

test('토큰이 없으면 아무것도 보내지 않고, 예약 작업은 하나만 등록되고, 클라이언트는 실행할 수 없다',async()=>{
 const t=await setup({secrets:false});
 try{
  await t.create();
  await t.flush();
  assert.equal((await t.calls()).length,0);
  await t.system();
  const jobs=(await t.db.query(`select jobname,schedule,command from cron.job`)).rows;
  assert.deepEqual(jobs,[{jobname:'logistics-slack-send',schedule:'* * * * *',command:'select approval_private.logistics_slack_flush()'}]);
  await t.login(1);
  await assert.rejects(()=>t.db.query('select approval_private.logistics_slack_flush()'),/permission denied/);
 }finally{await t.db.close();}
});

test('글을 만들다 오류가 나는 행이 있어도 다른 행은 계속 보낸다',async()=>{
 const t=await setup();
 try{
  const bad=await t.create('오류 행');
  const good=await t.create('정상 행');
  await t.system();
  await t.db.query(`update logistics_slack_outbox set payload=payload||'{"want_date":"not-a-date"}'::jsonb where request_id=$1`,[bad.id]);
  await t.flush();
  const cs=await t.calls();
  assert.equal(cs.length,1);
  assert.match(cs[0].body.text,/정상 행/);
  const o=(await t.db.query(`select request_id,state_code,attempts,last_error_text from logistics_slack_outbox order by id`)).rows;
  assert.deepEqual([o[0].state_code,o[0].attempts],['pending',1]);
  assert.ok(o[0].last_error_text.length>0&&o[0].last_error_text.length<=300);
  assert.equal(o[1].state_code,'sending');
  for(let i=0;i<4;i++)await t.flush(); // 계속 실패하면 5번째에 실패로 표시
  const f=(await t.db.query(`select state_code,attempts from logistics_slack_outbox where request_id=$1`,[bad.id])).rows[0];
  assert.deepEqual([f.state_code,f.attempts],['failed',5]);
  assert.equal((await t.db.query('select slack_state_code from logistics_requests where id=$1',[bad.id])).rows[0].slack_state_code,'failed');
 }finally{await t.db.close();}
});
