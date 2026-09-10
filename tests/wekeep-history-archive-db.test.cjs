const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');
const base=fs.readFileSync(path.join(__dirname,'../sql/wekeep-history.sql'),'utf8');
const archivePath=path.join(__dirname,'../sql/wekeep-history-archive.sql');
const install=async db=>{if(fs.existsSync(archivePath))await db.exec(fs.readFileSync(archivePath,'utf8'));};
const identity={sku:'1',name:'Archive product',code:'',supplier:'Supplier'};
const day=(date,changes={})=>({date,inbound:1,returned:-2,faulty:0,damaged:3,outbound:4,balance:9,...changes});
async function setup(t,withArchive=true){
 const db=new PGlite();t.after(()=>db.close());
 await db.exec(`create role anon;create role authenticated;create schema auth;
 create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create function auth.jwt() returns jsonb language sql as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;`);
 await db.exec(base);if(withArchive)await install(db);
 await db.query("select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',false)");
 await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({email:'staff@entropymakeup.com'})]);
 return db;
}
const read=async(db,year=2025)=>(await db.query('select public.get_wekeep_history_year($1::integer) as value',[year])).rows[0].value;
const month=(result,n,sku='1')=>result.months.find(x=>x.month===n&&x.sku===sku);
async function save(db,from,to,days,offset=-60000,catalog=[identity]){
 const collected_at=new Date(Date.now()+offset).toISOString();
 await db.query('select public.save_wekeep_history($1::jsonb)',[JSON.stringify({version:1,source:'wekeep',collected_at,from,to,catalog,products:[{sku:catalog[0].sku,days}]})]);
 return collected_at;
}
test('annual RPC exists and returns a bounded empty year',async t=>{
 const db=await setup(t);const result=await read(db);
 assert.equal(result.year,2025);assert.deepEqual(result.catalog,[]);assert.deepEqual(result.months,[]);
 assert.match(result.today,/^\d{4}-\d{2}-\d{2}$/);assert.ok(Date.parse(result.checked_at));
 for(const year of [null,1999,Number(result.today.slice(0,4))+1,10000])await assert.rejects(()=>read(db,year),/INVALID_HISTORY_YEAR/);
});
test('January survives February; corrections replace date values and empty markers stay null',async t=>{
 const db=await setup(t);
 const janTime=await save(db,'2025-01-01','2025-01-31',[day('2025-01-01'),day('2025-01-31',{balance:77})],-120000);
 await save(db,'2025-02-01','2025-02-28',[],-90000);
 let result=await read(db);assert.equal(result.months.length,12);
 assert.deepEqual(month(result,1),{sku:'1',month:1,covered_days:31,record_days:2,inbound:2,returned:-4,faulty:0,damaged:6,outbound:8,balance:77,balance_date:'2025-01-31',last_collected_at:month(result,1).last_collected_at,oldest_collected_at:month(result,1).oldest_collected_at});
 assert.equal(Date.parse(month(result,1).oldest_collected_at),Date.parse(janTime));
 assert.equal(month(result,2).covered_days,28);assert.equal(month(result,2).record_days,0);assert.equal(month(result,2).inbound,null);
 assert.equal(month(result,3).covered_days,0);assert.equal(month(result,3).last_collected_at,null);
 await save(db,'2025-01-31','2025-01-31',[day('2025-01-31',{balance:88,inbound:-3})],-60000);
 result=await read(db);assert.equal(month(result,1).covered_days,31);assert.equal(month(result,1).record_days,2);assert.equal(month(result,1).inbound,-2);assert.equal(month(result,1).balance,88);
 await save(db,'2025-01-31','2025-01-31',[],-30000);
 result=await read(db);assert.equal(month(result,1).record_days,1);assert.equal(month(result,1).balance,null);assert.equal(month(result,1).balance_date,null);
});
test('seed preserves timestamps; reinstall and live roster deletion retain independent history',async t=>{
 const db=await setup(t,false);
 const at=await save(db,'2025-01-01','2025-01-02',[day('2025-01-01')],-120000);
 await install(db);let result=await read(db);assert.equal(Date.parse(month(result,1).last_collected_at),Date.parse(at));
 await install(db);assert.deepEqual((await read(db)).months,result.months);
 await save(db,'2025-02-01','2025-02-01',[],-60000,[{...identity,sku:'2',name:'Replacement'}]);
 result=await read(db);assert.deepEqual(result.catalog.find(x=>x.sku==='1'),identity);assert.equal(month(result,1).record_days,1);
 assert.equal((await db.query('select count(*)::int as n from wekeep_history_private.product_window where sku=\'1\'')).rows[0].n,0);
});
test('archive date timestamps are monotonic and equal-time conflicts roll back',async t=>{
 const db=await setup(t);await save(db,'2025-01-01','2025-01-01',[day('2025-01-01')]);
 const before=(await read(db)).months;
 await db.exec("update wekeep_history_private.product_window set days=days");
 assert.deepEqual((await read(db)).months,before);
 await db.exec("update wekeep_history_private.product_window set collected_at=collected_at-interval '1 hour',days='[]'::jsonb");
 assert.deepEqual((await read(db)).months,before);await install(db);assert.deepEqual((await read(db)).months,before);
 await assert.rejects(()=>db.exec("update wekeep_history_private.product_window set collected_at=collected_at+interval '1 hour'"),/CONFLICTING_HISTORY/);
 assert.deepEqual((await read(db)).months,before);
 // The preceding update conflicts with the existing record at the same timestamp.
});
test('signed flow totals exceed int32, exact month end required, and future dates excluded',async t=>{
 const db=await setup(t);
 await save(db,'2025-01-29','2025-01-31',[day('2025-01-29',{inbound:2147483647}),day('2025-01-30',{inbound:2147483647})],-120000);
 const jan=month(await read(db),1);assert.equal(jan.inbound,4294967294);assert.equal(jan.returned,-4);assert.equal(jan.balance,null);
 const today=(await db.query("select (now() at time zone 'Asia/Seoul')::date::text as d")).rows[0].d;
 const future=(await db.query("select ((now() at time zone 'Asia/Seoul')::date+1)::text as d")).rows[0].d;
 await save(db,today,today,[day(today)],-90000);
 const todayCollected=month(await read(db,Number(today.slice(0,4))),Number(today.slice(5,7))).last_collected_at;
 await save(db,future,future,[day(future,{inbound:999})],-60000);
 const result=await read(db,Number(today.slice(0,4)));const current=month(result,Number(today.slice(5,7)));
 assert.equal(result.today,today);assert.equal(current.covered_days,1);assert.equal(current.record_days,1);assert.equal(current.inbound,1);assert.equal(current.balance_date,today);assert.equal(current.last_collected_at,todayCollected);assert.equal(current.oldest_collected_at,todayCollected);
});
test('company guard and private privileges reject outsiders and direct archive access',async t=>{
 const db=await setup(t);await db.exec('set role anon');await assert.rejects(()=>read(db),/permission denied/);await db.exec('reset role');
 await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({email:'outside@example.com'})]);
 await db.exec('set role authenticated');await assert.rejects(()=>read(db),/Unauthorized/);
 await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({email:'entropyadmin@entropy.internal'})]);await read(db);
 for(const table of ['archive_catalog','archive_day'])await assert.rejects(()=>db.query(`select * from wekeep_history_private.${table}`),/permission denied/);
 await db.query("select set_config('request.jwt.claim.sub','',false)");await assert.rejects(()=>read(db),/Unauthorized/);
});


test('leap-year coverage counts February 29 and a recorded zero stays numeric',async t=>{
 const db=await setup(t);await save(db,'2024-02-01','2024-02-29',[day('2024-02-29',{inbound:0,balance:0})]);
 const result=await read(db,2024);const feb=month(result,2);
 assert.equal(feb.covered_days,29);assert.equal(feb.record_days,1);assert.equal(feb.inbound,0);assert.equal(feb.balance,0);assert.equal(feb.balance_date,'2024-02-29');
 assert.equal(month(await read(db,2025),2).covered_days,0);
});
