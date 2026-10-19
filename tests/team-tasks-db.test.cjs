const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const {PGlite}=require('@electric-sql/pglite');

async function setup(){
 const db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create schema auth;create schema approval_private;
 create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz);
 create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz);
 create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create function auth.jwt() returns jsonb language sql as $$select jsonb_build_object('session_id',current_setting('request.jwt.claim.session_id',true))$$;
 grant usage on schema public,auth,approval_private to anon,authenticated;
 insert into auth.users values ('00000000-0000-0000-0000-000000000001','member@entropymakeup.com',now(),null),('00000000-0000-0000-0000-000000000002','outsider@example.com',now(),null),('00000000-0000-0000-0000-000000000003','boss@entropymakeup.com',now(),null);
 insert into auth.sessions select id,id,null from auth.users;`);
 const sql=fs.readFileSync(path.join(__dirname,'../sql/team-tasks.sql'),'utf8');
 await db.exec(sql);
 await db.exec(sql); // 다시 실행해도 안전해야 한다
 const del=fs.readFileSync(path.join(__dirname,'../sql/team-tasks-delete.sql'),'utf8');
 await db.exec(del);await db.exec(del);
 const review=fs.readFileSync(path.join(__dirname,'../sql/team-tasks-review.sql'),'utf8');
 await db.exec(review);await db.exec(review);
 await db.exec(`insert into team_task_members(email,display_name) values ('member@entropymakeup.com','가짜 팀원'),('other@entropymakeup.com','다른 팀원')`);
 await db.exec(`insert into team_task_members(email,display_name,is_admin) values ('boss@entropymakeup.com','가짜 관리자',true)`);
 const login=async(n)=>{await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.session_id',$1,false)",['00000000-0000-0000-0000-'+String(n).padStart(12,'0')]);await db.exec('set role authenticated');};
 return {db,login};
}

test('업무 목록: 회사 계정만 읽고 쓰며 삭제와 이력 직접 쓰기는 막는다',async()=>{
 const {db,login}=await setup();
 try{
  await db.exec('set role anon');
  await assert.rejects(()=>db.query('select * from team_tasks'),/permission denied/);
  await login(1);
  const ins=await db.query(`insert into team_tasks(title_text,summary_text,created_by_text) values ('  견적서 회신  ','요약','위조') returning *`);
  const t=ins.rows[0];
  assert.equal(t.title_text,'견적서 회신');
  assert.equal(t.created_by_text,'member@entropymakeup.com');
  assert.equal(t.status_code,'todo');
  assert.equal((await db.query('delete from team_tasks returning id')).rows.length,0); // 관리자가 아니면 지워지지 않는다
  await assert.rejects(()=>db.query(`insert into team_task_history(task_id,field_code) values ($1,'title')`,[t.id]),/permission denied/);
  await assert.rejects(()=>db.query(`update team_task_members set display_name='x'`),/permission denied/);
  assert.equal((await db.query('select * from team_task_members')).rows.length,3);
  await assert.rejects(()=>db.query(`update team_task_members set is_admin=true`),/permission denied/);
  await login(2);
  assert.equal((await db.query('select * from team_tasks')).rows.length,0);
  await assert.rejects(()=>db.query(`insert into team_tasks(title_text) values ('외부인')`),/row-level security/);
 }finally{await db.close();}
});

test('업무 목록: 상태·담당·기한 변경은 이력을 남기고 완료 정보를 맞춘다',async()=>{
 const {db,login}=await setup();
 try{
  await db.exec(`update team_task_members set is_admin=true where email='member@entropymakeup.com'`); // 완료를 바로 찍을 수 있는 목록 관리자로 본다
  await login(1);
  const {rows:[t]}=await db.query(`insert into team_tasks(title_text,source_key,source_kind_code) values ('서류 요청','gmail-t1','gmail') returning *`);
  await db.query(`update team_tasks set assignee_email='other@entropymakeup.com',due_on='2026-10-20',status_code='done',source_key='hacked',created_by_text='위조' where id=$1`,[t.id]);
  let {rows:[u]}=await db.query('select * from team_tasks where id=$1',[t.id]);
  assert.equal(u.source_key,'gmail-t1');
  assert.equal(u.created_by_text,'member@entropymakeup.com');
  assert.equal(u.done_by_text,'member@entropymakeup.com');
  assert.ok(u.done_at);
  await db.query(`update team_tasks set status_code='in_progress' where id=$1`,[t.id]);
  ({rows:[u]}=await db.query('select * from team_tasks where id=$1',[t.id]));
  assert.equal(u.done_at,null);
  assert.equal(u.done_by_text,null);
  const h=(await db.query('select field_code,from_text,to_text,changed_by_text from team_task_history where task_id=$1 order by id',[t.id])).rows;
  assert.deepEqual(h.map(r=>r.field_code),['created','assignee','due','status','status']);
  assert.deepEqual([h[1].from_text,h[1].to_text],['','other@entropymakeup.com']);
  assert.deepEqual([h[3].from_text,h[3].to_text],['todo','done']);
  assert.ok(h.every(r=>r.changed_by_text==='member@entropymakeup.com'));
  await assert.rejects(()=>db.query(`insert into team_tasks(title_text,source_key) values ('중복','gmail-t1')`),/duplicate key|unique/);
  await assert.rejects(()=>db.query(`update team_tasks set assignee_email='nobody@entropymakeup.com' where id=$1`,[t.id]),/foreign key/);
  await assert.rejects(()=>db.query(`insert into team_tasks(title_text,source_url) values ('링크','javascript:alert(1)')`),/check constraint/);
 }finally{await db.close();}
});

test('업무 목록: 로그인 없는 중계 입력은 등록자 표시를 유지한다',async()=>{
 const {db}=await setup();
 try{
  await db.exec('reset role');
  const {rows:[t]}=await db.query(`insert into team_tasks(title_text,created_by_text,source_kind_code,source_key) values ('슬랙 요청','이예진(수집 페이지)','slack','slack-C1-1.1') returning *`);
  assert.equal(t.created_by_text,'이예진(수집 페이지)');
  const h=(await db.query('select changed_by_text from team_task_history where task_id=$1',[t.id])).rows;
  assert.equal(h[0].changed_by_text,'이예진(수집 페이지)');
 }finally{await db.close();}
});

test('업무 목록: 관리자만 완전 삭제하고 삭제 기록은 남는다',async()=>{
 const {db,login}=await setup();
 try{
  await login(1);
  const {rows:[t]}=await db.query(`insert into team_tasks(title_text,source_key) values ('엉뚱한 수집','slack-C9-9.9') returning *`);
  await login(2);
  assert.equal((await db.query('delete from team_tasks returning id')).rows.length,0);
  await login(3);
  assert.equal((await db.query('delete from team_tasks where id=$1 returning id',[t.id])).rows.length,1);
  await db.exec('reset role');
  assert.equal((await db.query('select * from team_tasks where id=$1',[t.id])).rows.length,0);
  const h=(await db.query('select field_code,from_text,changed_by_text from team_task_history where task_id=$1 order by id',[t.id])).rows;
  assert.deepEqual(h.map(r=>r.field_code),['created','deleted']);
  assert.equal(h[1].from_text,'엉뚱한 수집');
  assert.equal(h[1].changed_by_text,'boss@entropymakeup.com');
 }finally{await db.close();}
});

test('업무 목록: 관리자가 아니면 완료가 완료 검토로 바뀌고 관리자가 승인한다',async()=>{
 const {db,login}=await setup();
 try{
  await login(1);
  const {rows:[t]}=await db.query(`insert into team_tasks(title_text,assignee_email) values ('회신','member@entropymakeup.com') returning *`);
  await db.query(`update team_tasks set status_code='done' where id=$1`,[t.id]);
  let {rows:[u]}=await db.query('select status_code,done_at from team_tasks where id=$1',[t.id]);
  assert.equal(u.status_code,'review');
  assert.equal(u.done_at,null);
  await login(3);
  await db.query(`update team_tasks set status_code='done' where id=$1`,[t.id]);
  ({rows:[u]}=await db.query('select status_code,done_by_text from team_tasks where id=$1',[t.id]));
  assert.equal(u.status_code,'done');
  assert.equal(u.done_by_text,'boss@entropymakeup.com');
  await db.exec('reset role');
  const {rows:[s]}=await db.query(`insert into team_tasks(title_text,status_code) values ('중계 입력','done') returning status_code`);
  assert.equal(s.status_code,'done'); // 로그인 없는 중계 입력은 중계 작업이 정한 상태를 따른다
  const h=(await db.query(`select from_text,to_text from team_task_history where task_id=$1 and field_code='status' order by id`,[t.id])).rows;
  assert.deepEqual(h.map(r=>r.to_text),['review','done']);
 }finally{await db.close();}
});
