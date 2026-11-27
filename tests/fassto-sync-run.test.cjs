const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const S=require('../tools/fassto-sync.cjs');
const NOW=Date.UTC(2026,10,27,1);
const tmp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'fassto-sync-'));
const CONFIG={fassto:{baseUrl:'https://fassto.example',apiCd:'cd',apiKey:'k',cstCd:'C1',whCd:''},supabase:{url:'https://db.example',anonKey:'anon',syncKey:'s'.repeat(40)}};
const writeConfig=(dir,c=CONFIG)=>fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify(c));

// 경로별로 응답을 돌려주는 가짜 fetch. 호출을 기록한다.
function fakeFetch(routes){
 const calls=[];
 const fetch=async(url,opt={})=>{
  calls.push({url,method:opt.method||'GET',headers:opt.headers||{},body:opt.body?JSON.parse(opt.body):null});
  for(const [re,fn] of routes){const m=re.exec(url);if(m){const r=await fn(m,opt);return {ok:(r.status||200)<400,status:r.status||200,json:async()=>r.body,text:async()=>JSON.stringify(r.body??null)};}}
  return {ok:false,status:404,json:async()=>({}),text:async()=>'not found'};
 };
 return {fetch,calls};
}
const ok=data=>({body:{header:{code:'200'},data}});
const baseRoutes=(over={})=>[
 [/\/api\/v1\/auth\/connect/,()=>ok({accessToken:'tok',expreDatetime:'20261127180000'})],
 [/\/api\/v1\/stock\/list\/C1/,()=>ok([{cstGodCd:'11111111111111',godNm:'가짜 상품',giftDiv:'01',distTermDt:'2029-01-01',canStockQty:5}])],
 [/\/api\/v1\/delivery\/C1\/2026-11-13\/2026-12-11\/ALL\/2/,()=>ok([{slipNo:'GG24OO261201000001',ordNo:'가짜 주문 1',ordDt:'2026-12-01',outDiv:'2',shopNm:'가짜 바이어',ordQty:30,wrkStat:'1',updTime:'t1',updUserNm:'가짜 요청자'}])],
 [/\/api\/v1\/delivery\/C1\/2026-11-13\/2026-12-11\/ALL\/1/,()=>ok([{slipNo:'GG24OO261201000002',outDiv:'1',salChanel:'가짜몰',wrkStat:'1',updTime:'t'}])],
 [/\/api\/v1\/delivery\/detail\/C1\/GG24OO261201000001/,()=>ok([{goods:[{cstGodCd:'11111111111111',godNm:'가짜 상품',distTermDt:'2029-01-01',ordQty:30}]}])],
 [/\/rest\/v1\/rpc\/logistics_fassto_ingest/,()=>({body:{stock_rows:1,stock_warning:'',created:1,updated:0,canceled:0,invoices:0,skipped:0}})],
 [/\/rest\/v1\/rpc\/logistics_fassto_report_error/,()=>({body:null})],
 ...(over.routes||[])];

test('처음 실행하면 빈 설정 파일을 만들고 끝낸다',async()=>{
 const dir=tmp(),out=[];
 const r=await S.run({dir,fetch:async()=>{throw new Error('부르면 안 됨');},nowMs:NOW,out:m=>out.push(m)});
 assert.equal(r.status,'config-created');
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,'config.json'),'utf8')),S.TEMPLATE);
 const r2=await S.run({dir,fetch:async()=>{throw new Error('x');},nowMs:NOW,out:m=>out.push(m)});
 assert.equal(r2.status,'config-missing');assert.match(out.at(-1),/fassto\.apiCd/);
});

test('정상 실행: 쇼핑몰 택배를 빼고, 바뀐 건만 상세를 부르고, 한 번에 ingest하고, 토큰과 상태를 다시 쓴다',async()=>{
 const dir=tmp();writeConfig(dir);
 const f=fakeFetch(baseRoutes());
 const r=await S.run({dir,fetch:f.fetch,nowMs:NOW,out:()=>{}});
 assert.equal(r.status,'ok');
 const ingest=f.calls.find(c=>/logistics_fassto_ingest/.test(c.url));
 assert.equal(ingest.headers.apikey,'anon');assert.equal(ingest.headers.Authorization,'Bearer anon');
 assert.equal(ingest.body.p_key,'s'.repeat(40));
 assert.equal(ingest.body.p_stock.length,1);
 assert.deepEqual(ingest.body.p_deliveries.map(d=>d.slip_no),['GG24OO261201000001']);
 assert.equal(ingest.body.p_deliveries[0].items[0].qty,30);
 const api=f.calls.filter(c=>c.url.startsWith('https://fassto.example')&&!/auth/.test(c.url));
 assert.ok(api.every(c=>c.headers.accessToken==='tok'));
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,'state.json'),'utf8')),{slips:{GG24OO261201000001:'t1'}});
 // 두 번째: 토큰 재사용(connect 없음), 상세 다시 안 부름, 품목 없이 보냄
 const g=fakeFetch(baseRoutes());
 await S.run({dir,fetch:g.fetch,nowMs:NOW+60000,out:()=>{}});
 assert.equal(g.calls.filter(c=>/auth\/connect/.test(c.url)).length,0);
 assert.equal(g.calls.filter(c=>/delivery\/detail/.test(c.url)).length,0);
 assert.equal('items' in g.calls.find(c=>/ingest/.test(c.url)).body.p_deliveries[0],false);
 const log=fs.readFileSync(path.join(dir,'logs','2026-11-27.log'),'utf8');
 assert.match(log,/새 요청 1/);
});

test('상세 조회가 실패한 건은 품목 없이 보내고, 다음 실행에서 다시 부른다',async()=>{
 const dir=tmp();writeConfig(dir);
 const f=fakeFetch([[/delivery\/detail/,()=>({status:500,body:{errorInfo:{errorCode:'SERVER',errorMessage:'x'}}})],...baseRoutes()]);
 const r=await S.run({dir,fetch:f.fetch,nowMs:NOW,out:()=>{}});
 assert.equal(r.status,'ok');
 assert.equal('items' in f.calls.find(c=>/ingest/.test(c.url)).body.p_deliveries[0],false);
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,'state.json'),'utf8')),{slips:{}});
});

test('IP가 거부되면 DB에 아무것도 쓰지 않고 조용히 끝낸다',async()=>{
 const dir=tmp();writeConfig(dir);
 const f=fakeFetch([[/auth\/connect/,()=>({status:403,body:{errorInfo:{errorCode:'INVALID_ACCESS',errorMessage:'ip'}}})],...baseRoutes()]);
 const r=await S.run({dir,fetch:f.fetch,nowMs:NOW,out:()=>{}});
 assert.equal(r.status,'ip-skip');
 assert.equal(f.calls.filter(c=>/rest\/v1/.test(c.url)).length,0);
});

test('그 밖의 오류는 report_error로 남기고, 미리보기는 DB를 부르지 않는다',async()=>{
 const dir=tmp();writeConfig(dir);
 const f=fakeFetch([[/stock\/list/,()=>({status:500,body:{errorInfo:{errorCode:'SERVER',errorMessage:'점검 중'}}})],...baseRoutes()]);
 const r=await S.run({dir,fetch:f.fetch,nowMs:NOW,out:()=>{}});
 assert.equal(r.status,'error');process.exitCode=0;
 assert.match(f.calls.find(c=>/report_error/.test(c.url)).body.p_error,/SERVER: 점검 중/);
 const g=fakeFetch(baseRoutes()),out=[];
 const d=await S.run({dir,fetch:g.fetch,nowMs:NOW,dryRun:true,out:m=>out.push(m)});
 assert.equal(d.status,'dry-run');assert.equal(d.mall,1);
 assert.equal(g.calls.filter(c=>/rest\/v1/.test(c.url)).length,0);
 assert.match(out.join('\n'),/쇼핑몰 택배 1건 제외/);
 assert.equal(fs.existsSync(path.join(dir,'state.json')),false);
});

test('15분 안에 만든 잠금 파일이 있으면 건너뛴다',async()=>{
 const dir=tmp();writeConfig(dir);fs.writeFileSync(path.join(dir,'sync.lock'),'x');
 const r=await S.run({dir,fetch:async()=>{throw new Error('x');},nowMs:NOW,out:()=>{}});
 assert.equal(r.status,'locked');
});

test('--new-key: 열쇠와 sha256 해시를 만들고, SQL에는 해시만 넣는다',()=>{
 const out=[];const {key,hash}=S.newKey(m=>out.push(m));
 assert.match(key,/^[0-9a-f]{64}$/);
 assert.equal(hash,crypto.createHash('sha256').update(key,'utf8').digest('hex'));
 const sqlLine=out.find(l=>l.startsWith('insert into'));
 assert.ok(sqlLine.includes(hash)&&!sqlLine.includes(key));
});
