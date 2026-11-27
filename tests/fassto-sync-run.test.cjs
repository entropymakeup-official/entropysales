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
  calls.push({url,method:opt.method||'GET',headers:opt.headers||{},body:opt.body?JSON.parse(opt.body):null,signal:opt.signal});
  for(const [re,fn] of routes){const m=re.exec(url);if(m){const r=await fn(m,opt);return {ok:(r.status||200)<400,status:r.status||200,json:async()=>r.body,text:async()=>r.raw!=null?r.raw:JSON.stringify(r.body??null)};}}
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
 [/\/rest\/v1\/rpc\/logistics_fassto_ingest/,(m,opt)=>{const b=JSON.parse(opt.body);
  return {body:b.p_stock?{stock_rows:b.p_stock.length,stock_warning:'',created:0,updated:0,canceled:0,invoices:0,skipped:0}
   :{stock_rows:null,stock_warning:'',created:b.p_deliveries.length,updated:0,canceled:0,invoices:0,skipped:0}};}],
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

test('정상 실행: 쇼핑몰 택배를 빼고, 바뀐 건만 상세를 부르고, 재고·출고를 나눠 ingest하고, 토큰과 상태를 다시 쓴다',async()=>{
 const dir=tmp();writeConfig(dir);
 const f=fakeFetch(baseRoutes());
 const r=await S.run({dir,fetch:f.fetch,nowMs:NOW,out:()=>{}});
 assert.equal(r.status,'ok');
 const [stockCall,ingest,...rest]=f.calls.filter(c=>/logistics_fassto_ingest/.test(c.url));
 assert.equal(rest.length,0);
 assert.equal(stockCall.body.p_stock.length,1);assert.equal(stockCall.body.p_deliveries,null);
 assert.equal(ingest.headers.apikey,'anon');assert.equal(ingest.headers.Authorization,'Bearer anon');
 assert.equal(ingest.body.p_key,'s'.repeat(40));
 assert.equal(ingest.body.p_stock,null);
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
 assert.equal('items' in g.calls.filter(c=>/ingest/.test(c.url)).at(-1).body.p_deliveries[0],false);
 const log=fs.readFileSync(path.join(dir,'logs','2026-11-27.log'),'utf8');
 assert.match(log,/새 요청 1/);
});

test('상세 조회가 실패한 건은 품목 없이 보내고, 다음 실행에서 다시 부른다',async()=>{
 const dir=tmp();writeConfig(dir);
 const f=fakeFetch([[/delivery\/detail/,()=>({status:500,body:{errorInfo:{errorCode:'SERVER',errorMessage:'x'}}})],...baseRoutes()]);
 const r=await S.run({dir,fetch:f.fetch,nowMs:NOW,out:()=>{}});
 assert.equal(r.status,'ok');
 assert.equal('items' in f.calls.find(c=>/ingest/.test(c.url)&&c.body.p_deliveries).body.p_deliveries[0],false);
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

// 차량 출고 n건 목록과, 어느 출고든 ordQty와 같은 품목을 돌려주는 상세
const carRows=(n,o={})=>Array.from({length:n},(_,i)=>({slipNo:'GG24OO2612010'+String(i+1).padStart(5,'0'),ordNo:'가짜 주문 '+i,ordDt:'2026-12-01',outDiv:'2',
 shopNm:'가짜 바이어',ordQty:3,wrkStat:'1',updTime:'t'+i,updUserNm:'가짜 요청자',...o}));
const listRoutes=(car,parcel=[])=>[[/\/delivery\/C1\/[^/]+\/[^/]+\/ALL\/2/,()=>ok(car)],[/\/delivery\/C1\/[^/]+\/[^/]+\/ALL\/1/,()=>ok(parcel)]];
const anyDetail=(goods=q=>[{cstGodCd:'11111111111111',godNm:'가짜 상품',distTermDt:'2029-01-01',ordQty:q}])=>[[/\/delivery\/detail\/C1\/(\w+)/,()=>ok([{goods:goods(3)}])]];
const ingests=f=>f.calls.filter(c=>/logistics_fassto_ingest/.test(c.url));
const state=dir=>JSON.parse(fs.readFileSync(path.join(dir,'state.json'),'utf8'));

test('F5 재고는 따로, 출고는 30건씩 나눠 ingest하고, 결과를 합쳐 한 줄로 남긴다',async()=>{
 const dir=tmp();writeConfig(dir);const out=[];
 const f=fakeFetch([...listRoutes(carRows(65)),...anyDetail(),...baseRoutes()]);
 const r=await S.run({dir,fetch:f.fetch,nowMs:NOW,out:m=>out.push(m)});
 assert.equal(r.status,'ok');
 const calls=ingests(f);
 assert.deepEqual(calls.map(c=>[c.body.p_stock&&c.body.p_stock.length,c.body.p_deliveries&&c.body.p_deliveries.length]),[[1,null],[null,30],[null,30],[null,5]]);
 assert.equal(Object.keys(state(dir).slips).length,65);
 assert.match(out.at(-1),/재고 1행 · 새 요청 65/);
});

test('F5 출고가 없어도 빈 배열로 한 번 보내 동기화 기록을 남긴다',async()=>{
 const dir=tmp();writeConfig(dir);
 const f=fakeFetch([...listRoutes([]),...baseRoutes()]);
 assert.equal((await S.run({dir,fetch:f.fetch,nowMs:NOW,out:()=>{}})).status,'ok');
 assert.deepEqual(ingests(f).map(c=>c.body.p_deliveries),[null,[]]);
});

test('F5 중간 묶음이 실패하면 멈추고, 성공한 묶음의 출고만 상태에 남기고, 오류는 한 번만 보고한다',async()=>{
 const dir=tmp();writeConfig(dir);
 const fail=[/\/rest\/v1\/rpc\/logistics_fassto_ingest/,(m,opt)=>{const b=JSON.parse(opt.body);
  if(b.p_deliveries&&b.p_deliveries[0].slip_no==='GG24OO261201000031')return {status:500,body:{code:'57014',message:'canceling statement due to statement timeout'}};
  return {body:{stock_rows:b.p_stock?1:null,stock_warning:'',created:b.p_deliveries?b.p_deliveries.length:0,updated:0,canceled:0,invoices:0,skipped:0}};}];
 const f=fakeFetch([...listRoutes(carRows(65)),...anyDetail(),fail,...baseRoutes()]);
 const r=await S.run({dir,fetch:f.fetch,nowMs:NOW,out:()=>{}});
 assert.equal(r.status,'error');assert.equal(process.exitCode,1);process.exitCode=0;
 assert.equal(ingests(f).length,3); // 재고 + 첫 묶음 + 실패한 둘째 묶음
 assert.equal(f.calls.filter(c=>/report_error/.test(c.url)).length,1);
 const slips=Object.keys(state(dir).slips);
 assert.equal(slips.length,30);assert.ok(slips.includes('GG24OO261201000030')&&!slips.includes('GG24OO261201000031'));
});

test('F3 상세 품목이 비었거나 합계가 주문 수량과 다르면 품목 없이 보내고 상태에 남기지 않는다',async()=>{
 const dir=tmp();writeConfig(dir);
 const rows=carRows(3);
 const detail=[[/\/delivery\/detail\/C1\/(\w+)/,m=>m[1].endsWith('1')?ok([{goods:[]}])
  :m[1].endsWith('2')?ok([{goods:[{cstGodCd:'11111111111111',godNm:'가짜 상품',distTermDt:'2029-01-01',ordQty:2}]}])
  :ok([{goods:[{cstGodCd:'11111111111111',godNm:'가짜 상품',distTermDt:'2029-01-01',ordQty:3}]}])]];
 const f=fakeFetch([...listRoutes(rows),...detail,...baseRoutes()]);
 assert.equal((await S.run({dir,fetch:f.fetch,nowMs:NOW,out:()=>{}})).status,'ok');
 const sent=ingests(f).at(-1).body.p_deliveries;
 assert.deepEqual(sent.map(d=>'items' in d),[false,false,true]);
 assert.deepEqual(Object.keys(state(dir).slips),['GG24OO261201000003']);
 const log=fs.readFileSync(path.join(dir,'logs','2026-11-27.log'),'utf8');
 assert.match(log,/GG24OO261201000001.*품목이 없/);assert.match(log,/GG24OO261201000002.*2개.*3개/);
});

test('F4 token.json·state.json이 깨져 있으면 기본값으로 다시 시작한다',async()=>{
 const dir=tmp();writeConfig(dir);
 fs.writeFileSync(path.join(dir,'token.json'),'{"accessToken":"tok-가짜-비밀"');fs.writeFileSync(path.join(dir,'state.json'),'not json');
 const f=fakeFetch(baseRoutes());
 const r=await S.run({dir,fetch:f.fetch,nowMs:NOW,out:()=>{}});
 assert.equal(r.status,'ok');
 assert.equal(f.calls.filter(c=>/auth\/connect/.test(c.url)).length,1);
 assert.equal(f.calls.filter(c=>/report_error/.test(c.url)).length,0);
 assert.deepEqual(state(dir),{slips:{GG24OO261201000001:'t1'}});
});

test('F4 config.json이 깨져 있으면 정해진 문구만 보이고 config-invalid로 끝낸다',async()=>{
 const dir=tmp();fs.writeFileSync(path.join(dir,'config.json'),'{"fassto":{"apiKey":"가짜-비밀-값"');const out=[];
 const r=await S.run({dir,fetch:async()=>{throw new Error('부르면 안 됨');},nowMs:NOW,out:m=>out.push(m)});
 assert.equal(r.status,'config-invalid');assert.equal(process.exitCode,1);process.exitCode=0;
 assert.deepEqual(out,['설정 파일(config.json)을 읽지 못했어요. JSON 형식을 확인해 주세요.']);
});

test('F4 DB 응답이 JSON이 아니어도 JSON.parse 문구는 오류 기록·로그에 나가지 않는다',async()=>{
 const dir=tmp();writeConfig(dir);
 const f=fakeFetch([[/\/rest\/v1\/rpc\/logistics_fassto_ingest/,()=>({raw:'<html>가짜</html>'})],...baseRoutes()]);
 const r=await S.run({dir,fetch:f.fetch,nowMs:NOW,out:()=>{}});
 assert.equal(r.status,'error');process.exitCode=0;
 const p=f.calls.find(c=>/report_error/.test(c.url)).body.p_error;
 assert.doesNotMatch(p,/JSON|Unexpected|token|html/i);assert.match(p,/응답을 읽지 못했어요/);
 assert.doesNotMatch(fs.readFileSync(path.join(dir,'logs','2026-11-27.log'),'utf8'),/Unexpected|<html>/);
});

test('F4 모든 fetch에 30초 제한 signal을 넘기고, 조회 기간 설정은 숫자로 바꾼다',async()=>{
 const dir=tmp();writeConfig(dir,{...CONFIG,lookbackDays:'abc',lookaheadDays:'7'});
 const f=fakeFetch([...listRoutes([]),...baseRoutes()]);
 assert.equal((await S.run({dir,fetch:f.fetch,nowMs:NOW,out:()=>{}})).status,'ok');
 assert.ok(f.calls.length>0&&f.calls.every(c=>c.signal instanceof AbortSignal));
 assert.ok(f.calls.some(c=>c.url.includes('/delivery/C1/2026-11-13/2026-12-04/ALL/2')));
});

test('F4 명령줄 실행은 run 실패를 잡아 실패 문구와 종료 코드 1을 남긴다',()=>{
 const src=fs.readFileSync(path.join(__dirname,'../tools/fassto-sync.cjs'),'utf8');
 assert.match(src,/run\(\{dryRun:args\.includes\('--dry-run'\)\}\)\.catch\(e=>\{console\.error\('실패: '\+e\.message\);process\.exitCode=1;\}\)/);
});

test('F1 미리보기는 상태별 건수와, 오늘 전 출고완료라 새로 만들지 않을 건수를 보여 준다',async()=>{
 const dir=tmp();writeConfig(dir);const out=[];
 const rows=[...carRows(2),...carRows(3,{wrkStat:'3',ordDt:'2026-11-20'}).map((x,i)=>({...x,slipNo:'GG24OO2611200000'+(i+1)})),
  {...carRows(1,{wrkStat:'3',ordDt:'2026-11-27'})[0],slipNo:'GG24OO261127000001'},{...carRows(1,{wrkStat:'8'})[0],slipNo:'GG24OO261127000002'}];
 const f=fakeFetch([...listRoutes(rows),...anyDetail(),...baseRoutes()]);
 const r=await S.run({dir,fetch:f.fetch,nowMs:NOW,dryRun:true,out:m=>out.push(m)});
 assert.equal(r.status,'dry-run');
 const text=out.join('\n');
 assert.match(text,/상태별: ORDER 2 · DONE 4 · CANCEL 1/);
 assert.match(text,/오늘 전 주문의 출고완료 3건/);
});
