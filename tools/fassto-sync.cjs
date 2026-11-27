#!/usr/bin/env node
'use strict';
// 파스토 OpenAPI → 대시보드 물류 요청 동기화. 파스토에 등록한 사무실 고정 IP의 PC에서 작업 스케줄러로 돈다.
// 쓰는 법: node tools/fassto-sync.cjs [--dry-run] [--new-key]
// 설정·토큰·상태·로그는 저장소 밖(FASSTO_SYNC_DIR 또는 %LOCALAPPDATA%\entropy-fassto-sync)에 둔다. 설치: LOGISTICS.md "파스토 API 동기화".
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const C=require('./fassto-sync-core.cjs');

const TEMPLATE={fassto:{baseUrl:'https://fmsapi.fassto.ai',apiCd:'',apiKey:'',cstCd:'',whCd:''},
 supabase:{url:'',anonKey:'',syncKey:''},parcelSalesChannelEmptyOnly:true,lookbackDays:14,lookaheadDays:14};
const REQUIRED=['fassto.apiCd','fassto.apiKey','fassto.cstCd','supabase.url','supabase.anonKey','supabase.syncKey'];
const LOCK_MS=15*60000;
// 한 번에 ingest로 보내는 출고 건수. Supabase anon 문장 시간 제한(57014)에 걸리면 줄인다.
const CHUNK=30;
const FETCH_MS=30000; // 파스토·Supabase 요청마다 30초 제한
const CONFIG_BAD='설정 파일(config.json)을 읽지 못했어요. JSON 형식을 확인해 주세요.';
const num=(v,def)=>{const n=Number(v);return Number.isFinite(n)?n:def;};

class FasstoError extends Error{constructor(code,msg){super(`${code}: ${msg}`);this.code=code;}}

const defaultDir=(env=process.env)=>env.FASSTO_SYNC_DIR||path.join(env.LOCALAPPDATA||path.join(os.homedir(),'AppData','Local'),'entropy-fassto-sync');
// token.json·state.json용: 없거나 깨졌으면 기본값으로 다시 시작한다(내용은 어디에도 남기지 않음)
function readJson(p,def){try{return JSON.parse(fs.readFileSync(p,'utf8'));}catch(e){if(e.code==='ENOENT'||e instanceof SyntaxError)return def;throw e;}}
function writeJson(p,v){const t=p+'.tmp';fs.writeFileSync(t,JSON.stringify(v,null,1));fs.renameSync(t,p);}

function loadConfig(dir){
 const p=path.join(dir,'config.json');
 if(!fs.existsSync(p)){fs.mkdirSync(dir,{recursive:true});writeJson(p,TEMPLATE);return {created:p};}
 let c;
 try{c=JSON.parse(fs.readFileSync(p,'utf8'));}catch(e){if(e instanceof SyntaxError)return {invalid:true};throw e;}
 if(!c||typeof c!=='object'||Array.isArray(c))return {invalid:true};
 const config={...TEMPLATE,...c,fassto:{...TEMPLATE.fassto,...c.fassto},supabase:{...TEMPLATE.supabase,...c.supabase}};
 const missing=REQUIRED.filter(k=>!String(k.split('.').reduce((o,x)=>o?.[x],config)||'').trim());
 return {config,missing};
}

function takeLock(dir){
 const p=path.join(dir,'sync.lock');
 try{fs.writeFileSync(p,String(Date.now()),{flag:'wx'});return ()=>fs.rmSync(p,{force:true});}
 catch(e){
  if(e.code!=='EEXIST')throw e;
  if(Date.now()-fs.statSync(p).mtimeMs<LOCK_MS)return null;
  fs.rmSync(p,{force:true});return takeLock(dir);
 }
}

function logger(dir,nowMs){
 const ld=path.join(dir,'logs');fs.mkdirSync(ld,{recursive:true});
 const day=C.kstDay(nowMs),cut=C.addDays(day,-30);
 for(const f of fs.readdirSync(ld)){const m=/^(\d{4}-\d{2}-\d{2})\.log$/.exec(f);if(m&&m[1]<cut)fs.rmSync(path.join(ld,f),{force:true});}
 return line=>fs.appendFileSync(path.join(ld,day+'.log'),`${new Date(nowMs+9*3600000).toISOString().slice(11,19)} ${line}\n`);
}

function fasstoClient({config,fetch,dir,nowMs}){
 const base=config.fassto.baseUrl.replace(/\/+$/,''),cst=encodeURIComponent(config.fassto.cstCd),tokenPath=path.join(dir,'token.json');
 let token=readJson(tokenPath,null);
 async function call(method,url,headers={}){
  const res=await fetch(url,{method,headers:{Accept:'application/json',...headers},signal:AbortSignal.timeout(FETCH_MS)});
  let body;try{body=await res.json();}catch(_){throw new FasstoError('BAD_RESPONSE',`HTTP ${res.status}`);}
  const err=body&&body.errorInfo;
  if(err&&err.errorCode)throw new FasstoError(err.errorCode,err.errorMessage||'');
  if(!res.ok)throw new FasstoError('HTTP_'+res.status,(body&&body.header&&body.header.msg)||'');
  return body?body.data:null;
 }
 async function connect(){
  const q=`apiCd=${encodeURIComponent(config.fassto.apiCd)}&apiKey=${encodeURIComponent(config.fassto.apiKey)}`;
  const d=await call('POST',`${base}/api/v1/auth/connect?${q}`);
  if(!d||!d.accessToken)throw new FasstoError('NO_TOKEN','토큰을 받지 못했어요');
  token={accessToken:String(d.accessToken),expreDatetime:String(d.expreDatetime||'')};writeJson(tokenPath,token);
 }
 async function get(p){
  if(!C.tokenValid(token,nowMs))await connect();
  try{return await call('GET',base+p,{accessToken:token.accessToken});}
  catch(e){if(!/TOKEN|AUTH/i.test(e.code||''))throw e;await connect();return call('GET',base+p,{accessToken:token.accessToken});}
 }
 return {
  stock:()=>get(`/api/v1/stock/list/${cst}`+(config.fassto.whCd?`?whCd=${encodeURIComponent(config.fassto.whCd)}`:'')),
  deliveries:(start,end,outDiv)=>get(`/api/v1/delivery/${cst}/${start}/${end}/ALL/${outDiv}`),
  detail:slip=>get(`/api/v1/delivery/detail/${cst}/${encodeURIComponent(slip)}`)
 };
}

async function rpc(config,fetch,fn,args){
 const res=await fetch(`${config.supabase.url.replace(/\/+$/,'')}/rest/v1/rpc/${fn}`,{method:'POST',
  headers:{apikey:config.supabase.anonKey,Authorization:`Bearer ${config.supabase.anonKey}`,'Content-Type':'application/json'},body:JSON.stringify(args),
  signal:AbortSignal.timeout(FETCH_MS)});
 const text=await res.text();
 if(!res.ok)throw new Error(`DB ${res.status}: ${String(text).slice(0,200)}`);
 try{return text?JSON.parse(text):null;}catch(_){throw new Error(`DB ${res.status}: 응답을 읽지 못했어요`);}
}

async function run({dir=defaultDir(),fetch=globalThis.fetch,nowMs=Date.now(),dryRun=false,out=console.log}={}){
 const cfg=loadConfig(dir);
 if(cfg.created){out(`설정 파일을 만들었어요: ${cfg.created}\n값을 채운 뒤 다시 실행하세요.`);return {status:'config-created'};}
 if(cfg.invalid){out(CONFIG_BAD);process.exitCode=1;return {status:'config-invalid',exitCode:1};}
 if(cfg.missing.length){out('설정 파일에 빈 값이 있어요: '+cfg.missing.join(', '));return {status:'config-missing'};}
 const config=cfg.config,log=logger(dir,nowMs);
 const release=takeLock(dir);
 if(!release){log('이전 실행이 아직 끝나지 않아 건너뜀');return {status:'locked'};}
 try{
  const fx=fasstoClient({config,fetch,dir,nowMs});
  const statePath=path.join(dir,'state.json');
  let state=readJson(statePath,{slips:{}});
  if(!state||typeof state.slips!=='object'||!state.slips)state={slips:{}};
  let stockList,raw;
  try{
   stockList=await fx.stock();
   const {start,end}=C.dateRange(nowMs,num(config.lookbackDays,14),num(config.lookaheadDays,14));
   raw=[...((await fx.deliveries(start,end,'2'))||[]),...((await fx.deliveries(start,end,'1'))||[])];
  }catch(e){
   if(e.code==='INVALID_ACCESS'){log('파스토가 이 IP를 거부함(사무실 밖에서 실행?) — 건너뜀');return {status:'ip-skip'};}
   throw e;
  }
  const kept=raw.filter(x=>C.keepDelivery(x,config)),mall=raw.length-kept.length;
  // entries: 보낼 출고 건과, 성공하면 state.json에 남길 updTime(undefined면 남기지 않아 다음 실행에서 상세를 다시 부른다)
  const entries=[],unknown=[];
  for(const x of kept){
   const slip=String(x.slipNo||'').trim();if(!slip)continue;
   if(!C.statusOf(x)){unknown.push(`${slip}:${x.wrkStat}`);continue;}
   let items=null,upd;
   if(C.needsDetail(x,state)){
    try{
     const got=C.toItems(await fx.detail(slip));
     const sum=got.reduce((a,g)=>a+g.qty,0),ord=Number(x.ordQty)||0;
     // 품목이 비었거나 합계가 주문 수량과 다르면 품목 없이 보내고(저장된 품목 유지) 다음 실행에서 다시 부른다
     if(!got.length)log(`품목 확인 필요 ${slip}: 상세에 품목이 없어요 — 품목 없이 보내고 다음에 다시 불러요`);
     else if(ord>0&&sum!==ord)log(`품목 확인 필요 ${slip}: 품목 합계 ${sum}개가 주문 수량 ${ord}개와 달라요 — 품목 없이 보내고 다음에 다시 불러요`);
     else{items=got;upd=String(x.updTime||'');}
    }catch(e){log(`상세 조회 실패 ${slip}: ${e.message}`);}
   }else upd=state.slips[slip];
   entries.push({slip,upd,delivery:C.toDelivery(x,items)});
  }
  const deliveries=entries.map(e=>e.delivery);
  if(unknown.length)log('모르는 작업상태라 건너뜀: '+unknown.join(', '));
  const stock=C.toStockRows(stockList);
  if(dryRun){
   out(`[미리보기] 재고 ${stock.length}행 · 출고 ${raw.length}건 중 쇼핑몰 택배 ${mall}건 제외 · 동기화 대상 ${deliveries.length}건`);
   for(const d of deliveries)out(`- ${d.slip_no} | ${d.out_div==='car'?'차량':'택배'} | ${d.status_code} | ${d.order_date} | ${d.shop_name} | ${d.order_no} | ${d.qty_total}개`
    +(d.items?` | 품목 ${d.items.length}줄`:'')+(d.invoice_no?` | 송장 ${d.parcel_name} ${d.invoice_no}`:''));
   out('재고 상품코드 예시: '+stock.slice(0,5).map(r=>r.product_code).join(', '));
   if(unknown.length)out('모르는 작업상태: '+unknown.join(', '));
   const count={};for(const d of deliveries)count[d.status_code]=(count[d.status_code]||0)+1;
   out('상태별: '+(['ORDER','WORKING','DONE','CANCEL','SHORTAGE'].filter(k=>count[k]).map(k=>`${k} ${count[k]}`).join(' · ')||'없음'));
   const today=C.kstDay(nowMs),oldDone=deliveries.filter(d=>d.status_code==='DONE'&&d.order_date&&d.order_date<today).length;
   out(`오늘 전 주문의 출고완료 ${oldDone}건은 연결된 요청이 없으면 이미 나간 출고로 보고 새로 만들지 않아요`);
   return {status:'dry-run',stock,deliveries,mall};
  }
  // 재고는 따로 한 번, 출고는 CHUNK건씩. 출고가 없어도 빈 배열로 한 번 보내 동기화 기록을 남긴다.
  const ingest=(p_stock,p_deliveries)=>rpc(config,fetch,'logistics_fassto_ingest',{p_key:config.supabase.syncKey,p_stock,p_deliveries});
  const s0=await ingest(stock,null)||{};
  const res={stock_rows:s0.stock_rows??null,stock_warning:s0.stock_warning||'',created:0,updated:0,canceled:0,invoices:0,skipped:0};
  const chunks=[];for(let i=0;i<entries.length;i+=CHUNK)chunks.push(entries.slice(i,i+CHUNK));
  if(!chunks.length)chunks.push([]);
  const slips={};
  for(const ch of chunks){
   const r=await ingest(null,ch.map(e=>e.delivery))||{};
   for(const k of ['created','updated','canceled','invoices','skipped'])res[k]+=Number(r[k])||0;
   for(const e of ch)if(e.upd!==undefined)slips[e.slip]=e.upd;
   writeJson(statePath,{slips}); // 성공한 묶음까지만 남긴다
  }
  const line=C.summary(res,{mall});log(line);out(line);
  return {status:'ok',result:res};
 }catch(e){
  const msg=e instanceof SyntaxError?'응답을 읽지 못했어요':String(e.message); // JSON.parse 문구(내용 일부)는 내보내지 않는다
  log('실패: '+msg);out('실패: '+msg);
  if(!dryRun){try{await rpc(config,fetch,'logistics_fassto_report_error',{p_key:config.supabase.syncKey,p_error:msg.slice(0,300)});}
   catch(e2){log('오류 기록 실패: '+e2.message);}}
  process.exitCode=1;
  return {status:'error',error:e};
 }finally{release();}
}

function newKey(out=console.log){
 const key=crypto.randomBytes(32).toString('hex'),hash=crypto.createHash('sha256').update(key,'utf8').digest('hex');
 out('아래 열쇠를 설정 파일의 supabase.syncKey에 넣으세요. 이 화면에만 한 번 보여요:');
 out(key);
 out('Supabase SQL 편집기에서 아래 문장을 실행하세요(해시만 들어 있어요):');
 out(`insert into approval_private.logistics_fassto_keys(key_hash,label_text) values ('${hash}','사무실 PC');`);
 return {key,hash};
}

if(require.main===module){
 const args=process.argv.slice(2);
 if(args.includes('--new-key'))newKey();
 else run({dryRun:args.includes('--dry-run')}).catch(e=>{console.error('실패: '+e.message);process.exitCode=1;});
}
module.exports={run,newKey,loadConfig,defaultDir,TEMPLATE};
