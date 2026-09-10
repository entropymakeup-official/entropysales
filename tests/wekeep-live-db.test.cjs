const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');

test('wekeep snapshots are private, validated and monotonic with failed writes preserving data',async()=>{
 const sql=fs.readFileSync(path.join(__dirname,'../sql/wekeep-live.sql'),'utf8');
 const db=new PGlite();
 try{
  await db.exec(`create role anon;create role authenticated;create schema auth;
   grant usage on schema auth to authenticated;
   create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
   create function auth.jwt() returns jsonb language sql as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;`);
  await db.exec(sql);
  const read=async()=> (await db.query('select public.get_wekeep_inventory() as value')).rows[0].value;
  const write=async(s)=> (await db.query('select public.save_wekeep_inventory($1::jsonb) as value',[JSON.stringify(s)])).rows[0].value;
  const row={name:'<b>시험 제품</b>',code:'',supplier:'-',available:-128,safety:0,held:0,defective:2};
  const good={version:1,source:'wekeep',collected_at:new Date(Date.now()-60000).toISOString(),expected_count:2,rows:[row,{...row,available:2202}]};
  await db.exec('set role anon');
  await assert.rejects(read,/permission denied/);await assert.rejects(()=>write(good),/permission denied/);
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',false)");
  await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({email:'outside@example.com'})]);
  await db.exec('set role authenticated');
  await assert.rejects(read,/Unauthorized/);await assert.rejects(()=>write(good),/Unauthorized/);
  await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({email:'test@entropymakeup.com'})]);
  assert.equal((await read()).snapshot,null);
  const ack=await write(good);assert.equal(ack.saved,true);assert.equal(ack.row_count,2);
  assert.equal(ack.collected_at,good.collected_at);
  assert.ok(Number.isFinite(Date.parse((await read()).checked_at)));
  assert.deepEqual((await read()).snapshot,good);
  assert.deepEqual(await write(good),ack,'identical retries are safe');
  for(const invalid of [
   {...good,expected_count:3}, {...good,rows:[]}, {...good,version:2},
   {...good,source:'other'}, {...good,collected_at:new Date(Date.now()+3600000).toISOString()},
   {...good,collected_at:new Date(Date.now()-90000000).toISOString()},
   {...good,collected_at:'invalid'}, {...good,collected_at:'2026-09-10'},
   {...good,collected_at:null}, {...good,expected_count:null},
   {...good,rows:[{...row,available:null},row]},
   {...good,rows:[{...row,available:'2'},row]},
   {...good,rows:[{...row,available:1.5},row]},
   {...good,rows:[{...row,available:2147483648},row]},
   {...good,rows:[{...row,name:''},row]}, {...good,rows:[null,row]},
   ...['   ','\t','\n',' \t\n '].map(name=>({...good,rows:[{...row,name},row]})),
   {...good,rows:[{...row,code:null},row]}, {...good,unexpected:'x'},
   {...good,rows:[{...row,unexpected:'x'},row]},
  ]){
   if(invalid.collected_at===good.collected_at)invalid.collected_at=new Date().toISOString();
   await assert.rejects(()=>write(invalid),error=>/INVALID_|INCOMPLETE_|invalid input syntax/.test(error.message));
   assert.deepEqual((await read()).snapshot,good);
  }
  await assert.rejects(()=>write({...good,collected_at:new Date(Date.now()-120000).toISOString()}),/STALE_SNAPSHOT/);
  await assert.rejects(()=>write({...good,rows:[{...row,available:1},row]}),/STALE_SNAPSHOT/);
  assert.deepEqual((await read()).snapshot,good);
  await assert.rejects(db.query('select * from wekeep_inventory_private.snapshot'),/permission denied/);
  const later={...good,collected_at:new Date().toISOString()};
  await write(later);assert.deepEqual((await read()).snapshot,later);
  await db.query("select set_config('request.jwt.claim.sub','',false)");await assert.rejects(read,/Unauthorized/);
  await db.exec('reset role');
  await db.exec(sql); // installation is repeatable without erasing last snapshot
  await db.query("select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',false)");
  await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({email:'entropyadmin@entropy.internal'})]);
  await db.exec('set role authenticated');assert.deepEqual((await read()).snapshot,later);
 }finally{await db.close();}
});
