const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const {PGlite}=require('@electric-sql/pglite');

// 가상 계정과 가상 금액만 사용한다.
const users=[['1','member@entropymakeup.com'],['2','outsider@example.com'],['3','entropyadmin@entropy.internal'],['4','dutyfree-sync@entropy.internal']];
const uid=n=>'00000000-0000-0000-0000-'+String(n).padStart(12,'0');
function snapshot(generatedAt=new Date().toISOString(),patch={}){
 const t=(cols,rows)=>({cols,rows});
 return {version:1,source:'dutyfree',generated_at:generatedAt,data_through:{lotte:'2026-01-02',shinsegae:'2026-01-02'},
  config:{agency_rate:0.1,vat:0.1,contract_fee_rate:0.5,fixed:[{label:'고정비 A',channel:'채널 B',from:'2026-01',to:null,amount:100}]},
  tables:{daily:t(['date','channel','product','category','qty','amt','krw'],[['2026-01-02','채널 A','상품 1','립',1,10,13000]]),
   sales:t(['month','group','channel','product','category','qty','amt','price','stock','stock_amt','partial'],[['2026-01','그룹','채널 A','상품 1','립',1,10,10,5,50,false]]),
   settle:t(['month','channel','product','qty'],[]),fx:t(['month','channel','rate'],[['2026-01','채널 A',1300]]),purchase:t(['month','kind'],[])},...patch};
}
async function setup(){
 const db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create schema auth;create schema approval_private;
 create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz);
 create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz);
 create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create function auth.jwt() returns jsonb language sql as $$select jsonb_build_object('session_id',current_setting('request.jwt.claim.session_id',true))$$;
 grant usage on schema public,auth to anon,authenticated;`);
 for(const [n,email] of users)await db.query('insert into auth.users values($1,$2,now(),null)',[uid(n),email]);
 await db.exec('insert into auth.sessions select id,id,null from auth.users');
 await db.exec(fs.readFileSync(path.join(__dirname,'../sql/dutyfree-dashboard.sql'),'utf8'));
 return db;
}
const asUser=async(db,n,session=n)=>{await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.session_id',$2,false)",[uid(n),uid(session)]);await db.exec('set role authenticated');};
const read=db=>db.query('select public.get_dutyfree_dashboard() as r').then(x=>x.rows[0].r);
const save=(db,s)=>db.query('select public.save_dutyfree_dashboard($1::jsonb) as r',[JSON.stringify(s)]).then(x=>x.rows[0].r);

test('dutyfree snapshot: company accounts read, only the sync account writes, private table is unreachable',async()=>{
 const file=path.join(__dirname,'../sql/dutyfree-dashboard.sql');assert.ok(fs.existsSync(file),'dutyfree schema must exist');
 const db=await setup();
 try{
  await db.exec('set role anon');await assert.rejects(()=>read(db),/permission denied/);
  await asUser(db,1);assert.equal((await read(db)).snapshot,null,'empty before first save');
  await assert.rejects(()=>save(db,snapshot()),/Unauthorized snapshot writer/,'company users cannot write');
  await asUser(db,4);const res=await save(db,snapshot());assert.equal(res.saved,true);assert.equal(res.counts.daily,1);
  await asUser(db,1);const got=await read(db);assert.equal(got.snapshot.tables.daily.rows[0][2],'상품 1');assert.ok(got.generated_at);
  await asUser(db,3);assert.ok((await read(db)).snapshot,'internal admin can read');
  await asUser(db,2);await assert.rejects(()=>read(db),/Unauthorized dashboard user/);
  await asUser(db,1,2);await assert.rejects(()=>read(db),/Unauthorized dashboard user/,'session of another user is rejected');
  await asUser(db,1);for(const statement of ['select * from dutyfree_private.snapshot','delete from dutyfree_private.snapshot'])await assert.rejects(()=>db.exec(statement),/permission denied/);
  await db.exec("reset role;update auth.sessions set not_after=now()-interval '1 second' where user_id='"+uid(1)+"'");await asUser(db,1);await assert.rejects(()=>read(db),/Unauthorized dashboard user/,'expired session');
 }finally{await db.close();}
});

test('dutyfree snapshot: invalid, oversized-shape, empty and older snapshots are rejected and keep the previous data',async()=>{
 const db=await setup();
 try{
  await asUser(db,4);
  const now=Date.now(),iso=ms=>new Date(ms).toISOString();
  await save(db,snapshot(iso(now-60000)));
  const bad=[
   [{...snapshot(),version:2},/INVALID_SNAPSHOT/],
   [{...snapshot(),extra:1},/INVALID_SNAPSHOT/],
   [{...snapshot(),source:'other'},/INVALID_SNAPSHOT/],
   [snapshot(iso(now),{config:{agency_rate:'0.1',vat:0.1,contract_fee_rate:0.5,fixed:[]}}),/INVALID_CONFIG/],
   [snapshot('not a date'),/INVALID_GENERATED_AT/],
   [snapshot(iso(now+60*60000)),/STALE_OR_FUTURE_SNAPSHOT/],
   [snapshot(iso(now-8*86400000)),/STALE_OR_FUTURE_SNAPSHOT/],
   [(()=>{const s=snapshot();s.tables.daily.rows=[['2026-01-02','채널 A']];return s;})(),/INVALID_TABLE daily/],
   [(()=>{const s=snapshot();delete s.tables.fx;return s;})(),/INVALID_TABLE fx/],
   [(()=>{const s=snapshot();s.tables.other={cols:['a'],rows:[]};return s;})(),/INVALID_TABLES/],
   [(()=>{const s=snapshot();s.tables.daily.rows=[];return s;})(),/EMPTY_SNAPSHOT/],
   [snapshot(iso(now-120000)),/OLDER_SNAPSHOT/],
  ];
  for(const [s,err] of bad)await assert.rejects(()=>save(db,s),err);
  await asUser(db,1);const got=await read(db);assert.equal(got.snapshot.generated_at,iso(now-60000),'previous snapshot preserved');
  await asUser(db,4);const newer=snapshot(iso(now));newer.tables.daily.rows.push(['2026-01-03','채널 A','상품 2','립',2,20,26000]);
  assert.equal((await save(db,newer)).counts.daily,2);
  await asUser(db,1);assert.equal((await read(db)).snapshot.tables.daily.rows.length,2,'newer snapshot replaces the whole payload');
 }finally{await db.close();}
});
