const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');

const sqlPath=path.join(__dirname,'../sql/wekeep-history.sql');

function iso(offsetMs){return new Date(Date.now()+offsetMs).toISOString();}
function catalog(){
 return [
  {sku:'2',name:'중복 관리코드 제품',code:'',supplier:'공급사'},
  {sku:'0001',name:'  공백 보존 제품  ',code:'',supplier:'공급사'},
 ];
}
function day(date,changes={}){
 return {date,inbound:1,returned:-2,faulty:0,damaged:3,outbound:4,balance:-5,...changes};
}
function batch(collectedAt,products,changes={}){
 return {
  version:1,source:'wekeep',collected_at:collectedAt,
  from:'2026-08-12',to:'2026-09-10',catalog:catalog(),products,...changes,
 };
}
function stored(value){return {catalog:value.catalog,products:value.products};}

test('history windows are private, strict, atomic, monotonic and preserve other product windows',async()=>{
 assert.ok(fs.existsSync(sqlPath),'history SQL migration must exist');
 const sql=fs.readFileSync(sqlPath,'utf8');
 const db=new PGlite();
 try{
  await db.exec(`create role anon;create role authenticated;create schema auth;
   grant usage on schema auth to authenticated;
   create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
   create function auth.jwt() returns jsonb language sql as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;`);
  await db.exec(sql);
  const read=async()=> (await db.query('select public.get_wekeep_history() as value')).rows[0].value;
  const write=async(value)=> (await db.query('select public.save_wekeep_history($1::jsonb) as value',[JSON.stringify(value)])).rows[0].value;

  const firstTime=iso(-120000);
  const first=batch(firstTime,[{sku:'0001',days:[day('2026-08-12'),day('2026-09-10',{inbound:0,balance:17})]}]);

  await db.exec('set role anon');
  await assert.rejects(read,/permission denied/);
  await assert.rejects(()=>write(first),/permission denied/);
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',false)");
  await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({email:'outside@example.com'})]);
  await db.exec('set role authenticated');
  await assert.rejects(read,/Unauthorized/);
  await assert.rejects(()=>write(first),/Unauthorized/);
  await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({email:'history@entropymakeup.com'})]);

  const empty=await read();
  assert.deepEqual(empty.catalog,[]);
  assert.deepEqual(empty.products,[]);
  assert.ok(Number.isFinite(Date.parse(empty.checked_at)));
  await assert.rejects(db.query('select * from wekeep_history_private.catalog'),/permission denied/);
  await assert.rejects(db.query('select * from wekeep_history_private.product_window'),/permission denied/);

  const firstAck=await write(first);
  assert.deepEqual(firstAck,{saved:true,collected_at:firstTime,product_count:1,day_count:2});
  const afterFirst=await read();
  assert.deepEqual(afterFirst.catalog,catalog());
  assert.deepEqual(afterFirst.products,[{
   sku:'0001',from:'2026-08-12',to:'2026-09-10',collected_at:firstTime,
   days:[day('2026-08-12'),day('2026-09-10',{inbound:0,balance:17})],
  }]);
  assert.equal(afterFirst.products[0].days.length,2,'missing dates stay missing instead of becoming zero rows');

  const reordered={
   products:[{days:[
    {balance:-5,outbound:4,damaged:3,faulty:0,returned:-2,inbound:1,date:'2026-08-12'},
    {balance:17,outbound:4,damaged:3,faulty:0,returned:-2,inbound:0,date:'2026-09-10'},
   ],sku:'0001'}],
   catalog:catalog().map(({sku,name,code,supplier})=>({supplier,code,name,sku})),
   to:'2026-09-10',from:'2026-08-12',collected_at:firstTime,source:'wekeep',version:1,
  };
  assert.deepEqual(await write(reordered),firstAck,'JSON object key order does not break idempotency');
  await assert.rejects(()=>write(batch(firstTime,[{sku:'0001',days:[day('2026-08-12',{balance:999})]}])),/CONFLICTING_HISTORY/);
  assert.deepEqual((await read()).products,afterFirst.products);

  const sameCollectionBatch=batch(firstTime,[{sku:'2',days:[]}]);
  assert.deepEqual(await write(sameCollectionBatch),{
   saved:true,collected_at:firstTime,product_count:1,day_count:0,
  });
  assert.deepEqual((await read()).products,[
   afterFirst.products[0],
   {sku:'2',from:'2026-08-12',to:'2026-09-10',collected_at:firstTime,days:[]},
  ],'separate batches from one collection keep product windows already saved');

  const secondTime=iso(-60000);
  const second=batch(secondTime,[{sku:'2',days:[]}],{
   catalog:[
    {sku:'2',name:'중복 관리코드 제품',code:'',supplier:'공급사'},
    {sku:'0001',name:'  공백 보존 제품  ',code:'',supplier:'변경 공급사'},
   ],
  });
  assert.deepEqual(await write(second),{saved:true,collected_at:secondTime,product_count:1,day_count:0});
  const stable=await read();
  const stableState=stored(stable);
  assert.deepEqual(stable.catalog,second.catalog,'blank duplicate codes and current metadata are preserved exactly');
  assert.deepEqual(stable.products,[
   afterFirst.products[0],
   {sku:'2',from:'2026-08-12',to:'2026-09-10',collected_at:secondTime,days:[]},
  ],'a later batch preserves windows for products absent from that batch');

  const staleTime=iso(-90000);
  const stale=batch(staleTime,[
   {sku:'0001',days:[day('2026-08-13',{balance:88})]},
   {sku:'2',days:[day('2026-08-13',{balance:99})]},
  ]);
  await assert.rejects(()=>write(stale),/STALE_HISTORY/);
  assert.deepEqual(stored(await read()),stableState,'one stale product rejects the whole batch including otherwise newer windows and catalog');

  const invalidTime=iso(-30000);
  const validProduct={sku:'0001',days:[day('2026-08-12')]};
  const invalids=[
   null,
   {...batch(invalidTime,[validProduct]),extra:true},
   {version:1,source:'wekeep',collected_at:invalidTime,from:'2026-08-12',to:'2026-09-10',catalog:catalog()},
   {...batch(invalidTime,[validProduct]),version:1.0,source:'other'},
   {...batch(invalidTime,[validProduct]),collected_at:'2026-09-10'},
   {...batch(iso(3600000),[validProduct])},
   {...batch(iso(-90000000),[validProduct])},
   {...batch(invalidTime,[validProduct]),from:'2026-02-30',to:'2026-03-01'},
   {...batch(invalidTime,[validProduct]),from:'2026-08-11',to:'2026-09-11'},
   {...batch(invalidTime,[validProduct]),from:'2026-09-10',to:'2026-09-09'},
   {...batch(invalidTime,[validProduct]),catalog:[]},
   {...batch(invalidTime,[])},
   {...batch(invalidTime,[validProduct]),catalog:[catalog()[0],catalog()[0]]},
   batch(invalidTime,[validProduct,{...validProduct}]),
   {...batch(invalidTime,[validProduct]),catalog:[{...catalog()[0],sku:'x'}]},
   {...batch(invalidTime,[validProduct]),catalog:[{...catalog()[0],sku:'1',name:'   '}]},
   {...batch(invalidTime,[validProduct]),catalog:[{...catalog()[0],sku:'1',code:null}]},
   {...batch(invalidTime,[validProduct]),catalog:[{...catalog()[0],sku:'1',extra:true}]},
   batch(invalidTime,[{sku:'999',days:[]}]),
   batch(invalidTime,[{sku:'0001',days:[day('2026-08-12'),day('2026-08-12')]}]),
   batch(invalidTime,[{sku:'0001',days:[day('2026-08-11')]}]),
   batch(invalidTime,[{sku:'0001',days:[day('2026-02-30')]}]),
   batch(invalidTime,[{sku:'0001',days:[{...day('2026-08-12'),outbound:'4'}]}]),
   batch(invalidTime,[{sku:'0001',days:[{...day('2026-08-12'),outbound:1.5}]}]),
   batch(invalidTime,[{sku:'0001',days:[{...day('2026-08-12'),outbound:2147483648}]}]),
   batch(invalidTime,[{sku:'0001',days:[{...day('2026-08-12'),extra:0}]}]),
  ];
  for(const invalid of invalids){
   await assert.rejects(()=>write(invalid),/INVALID_HISTORY/);
   assert.deepEqual(stored(await read()),stableState,'malformed payload rolls back without changing current data');
  }

  await assert.rejects(()=>write({...second,catalog:[{...second.catalog[0],name:'changed'},second.catalog[1]]}),/CONFLICTING_HISTORY/);
  assert.deepEqual(stored(await read()),stableState);

  await db.exec('reset role');
  await db.exec(sql);
  await db.query("select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',false)");
  await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({email:'entropyadmin@entropy.internal'})]);
  await db.exec('set role authenticated');
  assert.deepEqual(stored(await read()),stableState,'repeat installation keeps data and the admin account can read it');
 }finally{await db.close();}
});
