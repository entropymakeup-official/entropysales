const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const {PGlite}=require('@electric-sql/pglite');
test('master snapshot allows company read only, rejects anonymous/outsider/revoked sessions and all client writes',async()=>{
 const file=path.join(__dirname,'../sql/product-master.sql');assert.ok(fs.existsSync(file),'master schema must exist');const db=new PGlite();
 try{
 await db.exec(`create role anon;create role authenticated;create schema auth;create schema approval_private;
 create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz);
 create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz);
 create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create function auth.jwt() returns jsonb language sql as $$select jsonb_build_object('session_id',current_setting('request.jwt.claim.session_id',true))$$;
 grant usage on schema public,auth,approval_private to anon,authenticated;
 insert into auth.users values ('00000000-0000-0000-0000-000000000001','member@entropymakeup.com',now(),null),('00000000-0000-0000-0000-000000000002','outsider@example.com',now(),null),('00000000-0000-0000-0000-000000000003','entropyadmin@entropy.internal',now(),null);
 insert into auth.sessions select id,id,null from auth.users;`);
 await db.exec(fs.readFileSync(file,'utf8'));
 await db.query(`insert into product_master_snapshots(id,source_name,source_date,source_sha256,headers,products) values(true,'fixture.xlsx','2026-09-28',repeat('a',64),$1::jsonb,'[]')`,[JSON.stringify(Array(52).fill('header'))]);
 const read=()=>db.query('select source_name from product_master_snapshots');
 const login=async(n,session=n)=>{await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.session_id',$2,false)",['00000000-0000-0000-0000-'+String(n).padStart(12,'0'),'00000000-0000-0000-0000-'+String(session).padStart(12,'0')]);await db.exec('set role authenticated');};
 await db.exec('set role anon');await assert.rejects(read,/permission denied/);
 await login(1);assert.equal((await read()).rows.length,1);
 for(const statement of ["update product_master_snapshots set source_name='edited'","delete from product_master_snapshots","insert into product_master_snapshots(id) values(true)",'truncate product_master_snapshots'])await assert.rejects(()=>db.exec(statement),/permission denied/);
 await login(2);assert.equal((await read()).rows.length,0);
 await login(3);assert.equal((await read()).rows.length,1);await assert.rejects(()=>db.exec('delete from product_master_snapshots'),/permission denied/);
 await login(1,2);assert.equal((await read()).rows.length,0);
 await db.exec("reset role;update auth.sessions set not_after=now()-interval '1 second'");await login(1);assert.equal((await read()).rows.length,0);
 await db.exec('reset role;update auth.sessions set not_after=null;delete from auth.sessions where user_id=\'00000000-0000-0000-0000-000000000001\'');await login(1);assert.equal((await read()).rows.length,0);
 }finally{await db.close();}
});
