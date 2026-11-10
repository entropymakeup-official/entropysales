// 면세점 판매 대시보드 (신세계 온라인·오프라인, 롯데 온라인).
// 자료: Supabase get_dutyfree_dashboard() 스냅샷(자동 수집 PC가 save_dutyfree_dashboard로 교체). DUTYFREE.md 참고.
// 계약 조건(에이전시 수수료율·고정비·약정 수수료율)은 스냅샷 config에서만 읽는다. 이 공개 코드에 값을 넣지 않는다.
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.DutyfreeDashboard=api;})(globalThis,function(){
'use strict';
const CHANNELS=[
 {id:'신세계 온라인',short:'신세계 온라인',color:'#2563EB',group:'신세계'},
 {id:'신세계 오프라인',short:'신세계 오프라인',color:'#0891B2',group:'신세계'},
 {id:'롯데',short:'롯데 온라인',color:'#EA580C',group:'롯데'}];
const GROUP_COLOR={'신세계':'#2563EB','롯데':'#EA580C'};
const QTY_COLOR='#059669',CONTRIB_COLOR='#7C3AED';
const TABS=[['overview','통합'],['daily','일별'],['monthly','월별'],['products','상품별'],['settle','정산'],['stock','재고']];
const DOW=['일','월','화','수','목','금','토'];
const TABLES={daily:['date','channel','product','category','qty','amt','krw'],sales:['month','group','channel','product','category','qty','amt','price','stock','stock_amt','partial'],settle:['month','channel','product','category','qty','amt','rate','amt_krw','unit_cost','supply','fee','agency','cogs_unit','cogs','net','official'],fx:['month','channel','rate'],purchase:['month','date','kind','qty_in','cost_in','qty_rtn','cost_rtn','supply_in','vat','total','sales_supply']};

// ─── 형식 ───
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const num=v=>v===null||v===undefined||v===''?null:Number(v);
const n0=v=>Number(v)||0;
const fmt=v=>Math.round(n0(v)).toLocaleString('en-US');
const pct=v=>v==null||!isFinite(v)?'—':(v*100).toFixed(1)+'%';
const won=v=>(v<0?'−₩':'₩')+fmt(Math.abs(v));
const usd=v=>(v<0?'−$':'$')+fmt(Math.abs(v));
const sum=(a,f)=>a.reduce((s,x)=>s+(Number(f(x))||0),0);
const md=d=>d.slice(5).replace('-','/');
const dow=d=>DOW[new Date(d+'T00:00:00Z').getUTCDay()];
const chName=id=>(CHANNELS.find(c=>c.id===id)||{short:id}).short;
const normChannel=c=>String(c)==='롯데 온라인'?'롯데':String(c);

// ─── 기간 ───
function addMonths(m,n){const [y,mo]=m.split('-').map(Number);const d=new Date(Date.UTC(y,mo-1+n,1));return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}`;}
function rangeMonths(a,b){const out=[];let m=a;while(m<=b){out.push(m);m=addMonths(m,1);}return out;}
function cmpRange(st){const n=rangeMonths(st.from,st.to).length;if(st.cmp==='prev')return [addMonths(st.from,-n),addMonths(st.from,-1)];if(st.cmp==='yoy')return [addMonths(st.from,-12),addMonths(st.to,-12)];return null;}
function monthEnd(m){const [y,mo]=m.split('-').map(Number);return `${m}-${String(new Date(Date.UTC(y,mo,0)).getUTCDate()).padStart(2,'0')}`;}

// ─── 스냅샷 → 모델 ───
function tableRows(t,name){
 if(!t||!Array.isArray(t.cols)||!Array.isArray(t.rows))throw Error(`면세점 자료의 ${name} 표 형식이 올바르지 않습니다.`);
 return t.rows.map(r=>{if(!Array.isArray(r)||r.length!==t.cols.length)throw Error(`면세점 자료의 ${name} 행 형식이 올바르지 않습니다.`);const o={};t.cols.forEach((c,i)=>{o[c]=r[i];});return o;});
}
function validateSnapshot(p){
 if(!p||typeof p!=='object')throw Error('조회 가능한 면세점 자료가 없습니다. 자동 갱신 상태를 확인해 주세요.');
 if(p.version!==1||p.source!=='dutyfree'||!p.tables||!p.config)throw Error('면세점 자료 형식이 올바르지 않습니다.');
 for(const k of Object.keys(TABLES))if(!p.tables[k])throw Error(`면세점 자료에 ${k} 표가 없습니다.`);
 const c=p.config;if(typeof c.agency_rate!=='number'||typeof c.vat!=='number'||typeof c.contract_fee_rate!=='number'||!Array.isArray(c.fixed))throw Error('면세점 자료의 설정값 형식이 올바르지 않습니다.');
 return p;
}
function buildModel(payload,today=new Date()){
 const p=validateSnapshot(payload);
 const FX={};for(const r of tableRows(p.tables.fx,'fx'))FX[r.month+'|'+normChannel(r.channel)]=n0(r.rate);
 const fxOf=(m,ch)=>FX[m+'|'+ch]??FX[m+'|신세계 온라인']??0;
 const SETTLE=tableRows(p.tables.settle,'settle').map(r=>({month:String(r.month),channel:normChannel(r.channel),product:String(r.product),category:String(r.category||''),qty:n0(r.qty),amt:n0(r.amt),rate:num(r.rate),amt_krw:num(r.amt_krw),unit_cost:num(r.unit_cost),supply:num(r.supply),cogs_unit:num(r.cogs_unit),cogs:num(r.cogs)}));
 const PURCH=tableRows(p.tables.purchase,'purchase').map(r=>{const o={month:String(r.month),date:r.date==null?'':String(r.date),kind:String(r.kind||'')};for(const k of ['qty_in','cost_in','qty_rtn','cost_rtn','supply_in','vat','total','sales_supply'])o[k]=num(r[k]);return o;});
 const ALL=tableRows(p.tables.sales,'sales').map(r=>{const o={month:String(r.month),group:String(r.group),channel:normChannel(r.channel),product:String(r.product),category:String(r.category||''),qty:n0(r.qty),price:num(r.price),stock:n0(r.stock),stock_amt:n0(r.stock_amt),partial:r.partial===true||r.partial==='true',fromFile:true};
  const rate=fxOf(o.month,o.channel);o.amt_usd=n0(r.amt);o.amt_krw=Math.round(o.amt_usd*rate);o.price_usd=o.price;o.price_krw=o.price==null?null:Math.round(o.price*rate);o.stock_amt_usd=o.stock_amt;o.stock_amt_krw=Math.round(o.stock_amt*rate);return o;});
 const DAILY=tableRows(p.tables.daily,'daily').map(r=>{const o={date:String(r.date),channel:normChannel(r.channel),product:String(r.product),category:String(r.category||''),qty:n0(r.qty),amt_usd:n0(r.amt)};o.amt_krw=n0(r.krw)||Math.round(o.amt_usd*fxOf(o.date.slice(0,7),o.channel));return o;}).sort((a,b)=>a.date.localeCompare(b.date));
 // 월말 전에 받은 월별 파일(partial)·월별 파일이 없는 달은 판매액을 일별 자료로 집계하고 재고만 파일 값을 쓴다(월×채널그룹 단위).
 const groupOf=ch=>ch.startsWith('신세계')?'신세계':'롯데';
 const fullM=new Set(ALL.filter(r=>!r.partial).map(r=>r.month+'|'+r.group)),syn=new Map();
 for(const r of DAILY){const m=r.date.slice(0,7);if(fullM.has(m+'|'+groupOf(r.channel)))continue;const k=m+'|'+r.channel+'|'+r.product;const o=syn.get(k)||{month:m,group:groupOf(r.channel),channel:r.channel,product:r.product,category:r.category,qty:0,amt_usd:0,amt_krw:0};o.qty+=r.qty;o.amt_usd+=r.amt_usd;o.amt_krw+=r.amt_krw;syn.set(k,o);}
 const fin=o=>{o.amt_usd=Math.round(o.amt_usd*100)/100;o.price_usd=o.qty>0?Math.round(o.amt_usd/o.qty*100)/100:null;o.price_krw=o.qty>0?Math.round(o.amt_krw/o.qty):null;return o;};
 for(const r of ALL){if(!r.partial)continue;const k=r.month+'|'+r.channel+'|'+r.product,o=syn.get(k);if(o){fin(o);Object.assign(r,{qty:o.qty,amt_usd:o.amt_usd,amt_krw:o.amt_krw,price_usd:o.price_usd,price_krw:o.price_krw});syn.delete(k);}else Object.assign(r,{qty:0,amt_usd:0,amt_krw:0});}
 for(const o of syn.values())ALL.push(Object.assign(fin(o),{stock:0,stock_amt:0,stock_amt_usd:0,stock_amt_krw:0,partial:true,fromFile:false}));
 const MONTHS=[...new Set(ALL.map(r=>r.month))].sort();
 const STOCK_MONTHS=[...new Set(ALL.filter(r=>r.fromFile).map(r=>r.month))].sort();
 const cfg=p.config,fixed=cfg.fixed.map(f=>({label:String(f.label||''),channel:normChannel(f.channel||''),from:String(f.from||''),to:f.to?String(f.to):null,amount:n0(f.amount)}));
 const lastMonth=[...MONTHS,...SETTLE.map(r=>r.month)].sort().pop()||'';
 const cm=`${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}`;
 return {ALL,DAILY,SETTLE,PURCH,FX,MONTHS,STOCK_MONTHS,lastMonth,currentMonth:MONTHS.includes(cm)?cm:MONTHS[MONTHS.length-1],
  config:{agencyRate:cfg.agency_rate,vat:cfg.vat,contractFeeRate:cfg.contract_fee_rate,agencyLabel:String(cfg.agency_label||'에이전시'),fixed},
  meta:{generatedAt:p.generated_at,dataThrough:p.data_through||{}}};
}
function applyCurrency(model,cur){const k=cur==='KRW';for(const r of model.ALL){r.amt=k?r.amt_krw:r.amt_usd;r.price=k?r.price_krw:r.price_usd;r.stock_amt_v=k?r.stock_amt_krw:r.stock_amt_usd;}for(const r of model.DAILY)r.amt=k?r.amt_krw:r.amt_usd;}

// ─── 집계 ───
function rowsIn(model,st,a,b,o={}){const ch=o.ch??st.ch;return model.ALL.filter(r=>r.month>=a&&r.month<=b&&(ch==='전체'||r.channel===ch)&&(!o.cat||o.cat==='전체'||r.category===o.cat)&&(!o.product||r.product===o.product));}
function activeChannels(model,months){return CHANNELS.filter(c=>model.ALL.some(r=>r.channel===c.id&&months.includes(r.month)));}
function chansFor(model,st,months){return activeChannels(model,months).filter(c=>st.ch==='전체'||c.id===st.ch);}
function blank(){const o={amt:0,qty:0,products:new Set()};for(const c of CHANNELS){o[c.id]=0;o[c.id+'|q']=0;}return o;}
function fin(o){o.products=o.products.size;o.avg=o.qty?o.amt/o.qty:null;return o;}
function agg(rows){const o=blank();for(const r of rows){o.amt+=r.amt;o.qty+=r.qty;o[r.channel]+=r.amt;o[r.channel+'|q']+=r.qty;if(r.qty>0)o.products.add(r.product);}return fin(o);}
function byMonth(rows,months){
 const m=new Map(months.map(mo=>[mo,Object.assign(blank(),{month:mo,ss_stock:0,lt_stock:0,stock_amt:0})]));
 for(const r of rows){const o=m.get(r.month);if(!o)continue;o.amt+=r.amt;o.qty+=r.qty;o[r.channel]+=r.amt;o[r.channel+'|q']+=r.qty;o[r.group==='신세계'?'ss_stock':'lt_stock']+=r.stock;o.stock_amt+=r.stock_amt_v||0;if(r.qty>0)o.products.add(r.product);}
 return [...m.values()].map(o=>{fin(o);o.stock=o.ss_stock+o.lt_stock;return o;});
}
function byProduct(rows){
 const m=new Map();
 for(const r of rows){
  const o=m.get(r.product)||Object.assign(blank(),{product:r.product,category:r.category,ss_price:null,lt_price:null,ss_pm:'',lt_pm:'',ss_stock:0,lt_stock:0,stock_amt:0,ss_sm:'',lt_sm:''});
  const g=r.group==='신세계'?'ss':'lt';
  o.amt+=r.amt;o.qty+=r.qty;o[r.channel]+=r.amt;o[r.channel+'|q']+=r.qty;if(r.qty>0)o.products.add(r.product);
  if(r.price!=null&&r.qty>0&&r.month>=o[g+'_pm']){o[g+'_price']=r.price;o[g+'_pm']=r.month;}
  if(r.month>o[g+'_sm']){o[g+'_stock']=0;o[g+'_sm']=r.month;}
  if(r.month===o[g+'_sm'])o[g+'_stock']+=r.stock;
  m.set(r.product,o);
 }
 return [...m.values()].map(fin);
}
const delta=(c,p)=>p?(c-p)/Math.abs(p):null;   // 음수(적자) 비교에서도 개선=▲, 악화=▼
function latestDay(model,st){
 const chans=CHANNELS.filter(c=>(st.ch==='전체'||c.id===st.ch)&&model.DAILY.some(r=>r.channel===c.id));
 const byCh=new Map();
 for(const r of model.DAILY){if(!chans.some(c=>c.id===r.channel))continue;const m=byCh.get(r.channel)||new Map();const o=m.get(r.date)||{amt:0,qty:0};o.amt+=r.amt;o.qty+=r.qty;m.set(r.date,o);byCh.set(r.channel,m);}
 let latest='';const perCh=[];
 for(const c of chans){const m=byCh.get(c.id);if(!m)continue;const dates=[...m.keys()].filter(d=>m.get(d).qty>0||m.get(d).amt!==0).sort();if(!dates.length)continue;
  const d0=dates[dates.length-1],d1=dates[dates.length-2]||null,last7=dates.slice(-7).map(d=>({d,amt:m.get(d).amt}));
  perCh.push({c,d0,d1,cur:m.get(d0),prev:d1?m.get(d1):null,last7,avg7:sum(last7,x=>x.amt)/last7.length});if(d0>latest)latest=d0;}
 const onLatest=perCh.filter(p=>p.d0===latest);
 return {latest,perCh,onLatest,behind:perCh.filter(p=>p.d0!==latest),tot:{amt:sum(onLatest,p=>p.cur.amt),qty:sum(onLatest,p=>p.cur.qty)}};
}
function fixedFor(model,st,month){return model.config.fixed.filter(f=>month>=f.from&&(!f.to||month<=f.to)&&(st.ch==='전체'||st.ch===f.channel)&&month<=model.lastMonth).reduce((s,f)=>s+f.amount,0);}
function settleView(model,st){
 const cfg=model.config,months=rangeMonths(st.from,st.to),chans=chansFor(model,st,months),c=cmpRange(st);
 const pick=(a,b)=>model.SETTLE.filter(r=>r.month>=a&&r.month<=b&&(st.ch==='전체'||r.channel===st.ch));
 const rows=pick(st.from,st.to),prevRows=c?pick(c[0],c[1]):null;
 const agency=krw=>Math.round(krw*cfg.agencyRate*(1+cfg.vat));
 const totals=(rs,ms)=>{const o={usd:sum(rs,r=>r.amt),krw:sum(rs,r=>r.amt_krw),supply:sum(rs,r=>r.supply),cogs:sum(rs,r=>r.cogs),qty:sum(rs,r=>r.qty)};o.fee=o.krw-o.supply;o.rate=o.krw&&o.usd?o.krw/o.usd:null;o.agency=agency(o.krw);o.fixed=sum(ms,m=>fixedFor(model,st,m));o.contrib=o.supply-o.agency-o.cogs-o.fixed;return o;};
 const cur=totals(rows,months),prev=prevRows?totals(prevRows,rangeMonths(c[0],c[1])):null;
 const bm=new Map(months.map(m=>[m,{month:m,usd:0,krw:0,supply:0,cogs:0,qty:0,byCh:Object.fromEntries(chans.map(ch=>[ch.id,0]))}]));
 for(const r of rows){const o=bm.get(r.month);if(!o)continue;o.usd+=r.amt;o.krw+=r.amt_krw||0;o.supply+=r.supply||0;o.cogs+=r.cogs||0;o.qty+=r.qty;if(r.channel in o.byCh)o.byCh[r.channel]+=r.amt;}
 const mrows=[...bm.values()].map(o=>{const ag=agency(o.krw),fx=fixedFor(model,st,o.month);return {...o,fee:o.krw-o.supply,rate:o.usd?o.krw/o.usd:null,agency:ag,fixed:fx,contrib:o.supply-ag-o.cogs-fx};});
 const pm=new Map();
 for(const r of rows){const k=r.product+'|'+r.channel;const o=pm.get(k)||{product:r.product,category:r.category,channel:chName(r.channel),qty:0,amt:0,amt_krw:0,supply:0,cogs:0,cogs_unit:null,unit_cost:null,um:''};o.qty+=r.qty;o.amt+=r.amt;o.amt_krw+=r.amt_krw||0;o.supply+=r.supply||0;o.cogs+=r.cogs||0;if(r.cogs_unit!=null)o.cogs_unit=r.cogs_unit;if(r.unit_cost!=null&&r.month>=o.um){o.unit_cost=r.unit_cost;o.um=r.month;}pm.set(k,o);}
 const prods=[...pm.values()].map(o=>{const ag=agency(o.amt_krw),net=o.supply-ag-o.cogs;return {...o,fee:o.amt_krw-o.supply,fee_rate:o.amt_krw?(o.amt_krw-o.supply)/o.amt_krw:null,agency:ag,net,net_rate:o.amt_krw?net/o.amt_krw:null};});
 const noCogs=new Map();for(const r of rows)if(r.cogs_unit==null&&r.qty)noCogs.set(r.product,(noCogs.get(r.product)||0)+r.qty);
 const fixedLabel=cfg.fixed.filter(f=>st.ch==='전체'||st.ch===f.channel).map(f=>`${f.label} ${won(f.amount)}/월 (${f.from}~${f.to||''})`).join(', ')||'해당 채널 고정비 없음';
 return {months,chans,cur,prev,mrows,prods,noCogs,fixedLabel,lotte:lotteSrm(model,st,months)};
}
function lotteSrm(model,st,months){
 const show=(st.ch==='전체'||st.ch==='롯데')&&model.PURCH.length>0;if(!show)return {show:false};
 const sumRows=model.PURCH.filter(r=>r.kind==='월합계'&&months.includes(r.month));
 const mine=new Map(months.map(m=>[m,{supply:0,krw:0}]));
 for(const r of model.SETTLE)if(r.channel==='롯데'&&mine.has(r.month)){const o=mine.get(r.month);o.supply+=r.supply||0;o.krw+=r.amt_krw||0;}
 const rows=months.map(m=>{const s=sumRows.filter(r=>r.month===m),o=mine.get(m),srm=s.length?sum(s,r=>r.sales_supply):null;return {month:m,srm,supply:o.supply,krw:o.krw,diff:srm==null?null:srm-o.supply,ratio:srm!=null&&o.krw?srm/o.krw:null,supply_in:sum(s,r=>r.supply_in),vat:sum(s,r=>r.vat),total:sum(s,r=>r.total)};});
 const T=k=>sum(rows,r=>r[k]),tot={srm:T('srm'),supply:T('supply'),krw:T('krw'),supply_in:T('supply_in'),vat:T('vat'),total:T('total')};tot.diff=tot.srm-tot.supply;tot.ratio=tot.krw?tot.srm/tot.krw:null;
 const qk=m=>`${m.slice(0,4)}-Q${Math.floor((Number(m.slice(5))-1)/3)+1}`,qm=new Map();
 for(const r of sumRows){const o=qm.get(qk(r.month))||{q:qk(r.month),srm:0,supply_in:0,vat:0,total:0,n:0};o.srm+=r.sales_supply||0;o.supply_in+=r.supply_in||0;o.vat+=r.vat||0;o.total+=r.total||0;o.n++;qm.set(o.q,o);}
 const events=model.PURCH.filter(r=>r.kind!=='월합계'&&months.includes(r.month)).sort((a,b)=>(b.date||'').localeCompare(a.date||''));
 return {show:true,rows,tot,quarters:[...qm.values()].sort((a,b)=>a.q.localeCompare(b.q)),events};
}
function stockView(model,st){
 const snapOf=g=>{let m=null;for(const r of model.ALL)if(r.fromFile&&r.group===g&&(!m||r.month>m))m=r.month;return m;};
 const ssSnap=snapOf('신세계'),ltSnap=snapOf('롯데'),snap=[ssSnap,ltSnap].filter(Boolean).sort().pop()||model.MONTHS[model.MONTHS.length-1];
 const label=m=>m?(model.ALL.some(r=>r.month===m&&r.partial&&r.fromFile)?`${m} 파일 다운로드 시점`:`${m} 월말`):'자료 없음';
 const all={...st,ch:'전체'};
 const snapRows=[...(ssSnap?rowsIn(model,all,ssSnap,ssSnap).filter(r=>r.fromFile&&r.group==='신세계'):[]),...(ltSnap?rowsIn(model,all,ltSnap,ltSnap).filter(r=>r.fromFile&&r.group==='롯데'):[])].filter(r=>st.ch==='전체'||r.channel===st.ch);
 const months=rangeMonths(st.from,st.to).filter(m=>model.STOCK_MONTHS.includes(m)),trend=byMonth(rowsIn(model,st,st.from,st.to).filter(r=>r.fromFile),months);
 const last={ss_stock:sum(snapRows.filter(r=>r.group==='신세계'),r=>r.stock),lt_stock:sum(snapRows.filter(r=>r.group==='롯데'),r=>r.stock),stock_amt:sum(snapRows,r=>r.stock_amt_v)};last.stock=last.ss_stock+last.lt_stock;
 const first=trend.find(r=>r.month<snap&&r.stock>0);
 const q3m=rangeMonths(addMonths(snap,-2),snap),q3=agg(rowsIn(model,st,q3m[0],snap)),cover=q3.qty?last.stock/(q3.qty/q3m.length):null;
 const prods=byProduct(snapRows),q3p=new Map(byProduct(rowsIn(model,st,q3m[0],snap)).map(p=>[p.product,p.qty]));
 for(const p of prods){p.stock=p.ss_stock+p.lt_stock;p.stock_amt=sum(snapRows.filter(r=>r.product===p.product),r=>r.stock_amt_v);p.q3=q3p.get(p.product)||0;p.cover=p.q3?p.stock/(p.q3/q3m.length):null;}
 for(const [prod,q] of q3p)if(!prods.some(p=>p.product===prod))prods.push({product:prod,category:(model.ALL.find(r=>r.product===prod)||{}).category||'',ss_stock:0,lt_stock:0,stock:0,stock_amt:0,q3:q,cover:null});
 return {snap,ssLabel:label(ssSnap),ltLabel:label(ltSnap),last,first,q3m,q3,cover,trend,prods:prods.filter(p=>p.stock>0||p.q3>0)};
}
function dailyView(model,st){
 const dChans=new Set(model.DAILY.map(r=>r.channel)),chans=CHANNELS.filter(c=>dChans.has(c.id)&&(st.ch==='전체'||c.id===st.ch));
 const lastDay=model.DAILY.length?model.DAILY[model.DAILY.length-1].date:monthEnd(st.to);
 const from=st.from+'-01',to=monthEnd(st.to)<lastDay?monthEnd(st.to):lastDay;
 const rows=model.DAILY.filter(r=>r.date>=from&&r.date<=to&&(st.ch==='전체'||r.channel===st.ch));
 const byDay=new Map();
 for(const r of rows){const o=byDay.get(r.date)||Object.assign(blank(),{date:r.date});o.amt+=r.amt;o.qty+=r.qty;o[r.channel]+=r.amt;o[r.channel+'|q']+=r.qty;if(r.qty>0)o.products.add(r.product);byDay.set(r.date,o);}
 const days=[...byDay.values()].map(fin).filter(d=>d.amt!==0||d.qty!==0).sort((a,b)=>a.date.localeCompare(b.date));
 const c=cmpRange(st),prevRows=c?model.DAILY.filter(r=>r.date>=c[0]+'-01'&&r.date<=monthEnd(c[1])&&(st.ch==='전체'||r.channel===st.ch)):null;
 const dowAvg=DOW.map((d,i)=>{const ds=days.filter(x=>new Date(x.date+'T00:00:00Z').getUTCDay()===i),o={label:d,n:ds.length,amt:ds.length?sum(ds,x=>x.amt)/ds.length:0};for(const ch of chans)o[ch.id]=ds.length?sum(ds,x=>x[ch.id])/ds.length:0;return o;});
 return {chans,from,to,rows,days,cur:agg(rows),prev:prevRows?agg(prevRows):null,best:days.reduce((a,b)=>!a||b.amt>a.amt?b:a,null),dowAvg};
}

// ─── 화면 ───
function controller(read){
 const state={model:null,loading:false,error:''};let gen=0;
 return {state,clear(){gen++;state.model=null;state.loading=false;state.error='';},async load(){
  const g=++gen;state.model=null;state.loading=true;state.error='';
  try{const data=await read();if(g!==gen)return;state.model=buildModel(data&&data.snapshot);}
  catch(e){if(g===gen)state.error=e.message||'면세점 자료를 불러오지 못했습니다.';}
  finally{if(g===gen)state.loading=false;}
 }};
}
function mount({document,client,Chart=globalThis.Chart}){
 const ctl=controller(async()=>{const {data,error}=await client.rpc('get_dutyfree_dashboard');if(error)throw Error(error.code==='42501'?'회사 계정으로 로그인한 경우에만 볼 수 있습니다.':'면세점 자료를 불러오지 못했습니다. 로그인 상태를 확인한 후 다시 시도해 주세요.');return data;});
 let active=false,view=0,root=null,charts=[];
 const st={tab:'overview',from:null,to:null,cmp:'prev',ch:'전체',cur:'USD',cat:'전체',q:'',pick:null,dyDay:null,dyQ:'',dyCh:'전체',stQ:'',sort:{pr:['amt','desc'],sk:['stock','desc'],st:['amt_krw','desc']}};
 const money=v=>st.cur==='KRW'?won(v):usd(v);
 const compact=v=>{const lim=st.cur==='KRW'?1e6:1e4;return Math.abs(v)>=lim?(st.cur==='KRW'?'₩':'$')+new Intl.NumberFormat('en',{notation:'compact',maximumFractionDigits:1}).format(v):money(v);};
 const dTag=(c,p)=>{if(p==null||!p)return '';const d=delta(c,p);return `<span class="dfs-d ${d>0?'up':d<0?'down':''}">${d>0?'▲':d<0?'▼':'='} ${pct(Math.abs(d))}</span>`;};
 const dCell=(c,p)=>{if(!p)return '—';const d=delta(c,p);return `<span class="dfs-d ${d>0?'up':d<0?'down':''}">${d>0?'▲':d<0?'▼':'='} ${pct(Math.abs(d))}</span>`;};
 const kpi=items=>`<div class="dfs-kpis">${items.map(t=>`<div class="kpi"><div class="lbl">${esc(t.k)} ${t.d||''}</div><div class="val">${t.v}</div><div class="sub">${t.p||''}</div></div>`).join('')}</div>`;
 const card=(title,body,{note='',id='',extra=''}={})=>`<div class="card dfs-card"${id?` id="${id}"`:''}><div class="card-hd"><h3>${esc(title)}${note?` <small>${esc(note)}</small>`:''}</h3>${extra}</div><div class="dfs-card-body">${body}</div></div>`;
 const canvas=(id,h=240,label='')=>`<div class="dfs-chart" style="height:${h}px"><canvas id="${id}" role="img" aria-label="${esc(label)}"></canvas></div>`;
 function table(head,rows,{total=null,sort=null,sortKey='',rowAttr=()=>''}={}){
  const th=head.map(h=>`<th class="${h.cls||''}"${h.k&&sort?` data-df-sort="${sortKey}:${h.k}" aria-sort="${sort[0]===h.k?(sort[1]==='desc'?'descending':'ascending'):'none'}"`:''}>${esc(h.label)}</th>`).join('');
  const td=(r,t)=>head.map(h=>{const v=h.v(r,t);return `<td class="${h.cls||''}">${v==null?'':v}</td>`;}).join('');
  let list=rows;if(sort){const [k,d]=sort,dir=d==='desc'?-1:1;list=[...rows].sort((a,b)=>typeof a[k]==='string'?dir*a[k].localeCompare(b[k]):dir*((a[k]??-Infinity)-(b[k]??-Infinity)));}
  return `<div class="tw dfs-tw"><table><thead><tr>${th}</tr></thead><tbody>${list.map(r=>`<tr${rowAttr(r)}>${td(r,false)}</tr>`).join('')}${total?`<tr class="dfs-tot">${td(total,true)}</tr>`:''}</tbody></table></div>`;
 }
 function destroyCharts(){for(const c of charts)try{c.destroy();}catch(e){}charts=[];}
 function chart(id,config){const el=root&&root.querySelector('#'+id);if(!el||!Chart)return;const grid='rgba(0,0,0,0.06)',text='#4A5B78';
  const o=config.options||(config.options={});o.responsive=true;o.maintainAspectRatio=false;o.interaction=o.interaction||{mode:'index',intersect:false};
  const pl=o.plugins||{};o.plugins={...pl,legend:{position:'bottom',labels:{boxWidth:10,font:{size:11},color:text},...(pl.legend||{})},tooltip:{backgroundColor:'#fff',titleColor:'#0F1C3F',bodyColor:text,borderColor:'#2563EB',borderWidth:0.5,padding:10,...(pl.tooltip||{})}};
  for(const s of Object.values(o.scales||{})){s.grid=Object.assign({color:grid,lineWidth:0.5},s.grid||{});s.ticks=Object.assign({color:text,font:{size:10}},s.ticks||{});s.border={display:false};}
  charts.push(new Chart(el,config));}
 const ds=(chans,rows,key=c=>c.id,stack=true)=>chans.map(c=>({label:c.short,data:rows.map(r=>r[key(c)]||0),backgroundColor:c.color,borderColor:c.color,borderWidth:stack?0:2.5,stack:stack?'s':undefined,tension:0.35,pointRadius:3,borderRadius:stack?3:0}));
 const moneyTick=v=>compact(v);

 function controls(model){
  const opts=model.MONTHS.map(m=>`<option value="${m}">${m}</option>`).join('');
  const c=cmpRange(st),n=rangeMonths(st.from,st.to).length,partial=model.ALL.some(r=>r.partial&&r.month>=st.from&&r.month<=st.to);
  const lastD=model.DAILY.length?model.DAILY[model.DAILY.length-1].date:'';
  const thru=model.meta.dataThrough||{};
  return `<div class="card dash-filters dfs-filters"><form onsubmit="return false">
   <label>시작 월<select data-df-ctl="from">${opts}</select></label><label>종료 월<select data-df-ctl="to">${opts}</select></label>
   <label>빠른 선택<select data-df-ctl="quick"><option value="">선택</option><option value="cur">이번 달</option><option value="1">최근 1개월</option><option value="3">최근 3개월</option><option value="6">최근 6개월</option><option value="12">최근 12개월</option><option value="ytd">올해</option><option value="all">전체</option></select></label>
   <label>비교<select data-df-ctl="cmp"><option value="prev">직전 동일 기간</option><option value="yoy">전년 동기</option><option value="none">비교 없음</option></select></label>
   <label>통화<select data-df-ctl="cur"><option value="USD">USD</option><option value="KRW">KRW (적용환율)</option></select></label>
   <button class="btn" type="button" data-df-reload><i class="ti ti-refresh"></i> 다시 불러오기</button></form>
   <p>선택 기간 ${st.from} ~ ${st.to} (${n}개월)${c?` · 비교 ${c[0]} ~ ${c[1]}`:''}${st.ch!=='전체'?` · <b>${esc(chName(st.ch))}</b>만 표시 <button type="button" class="btn btn-sm" data-df-ch="전체">채널 필터 해제</button>`:''}${partial&&lastD?` · 이번 달은 ${md(lastD)}까지 일별 집계`:''}</p>
   <details><summary>자료 기준</summary><p>마지막 갱신 ${esc(String(model.meta.generatedAt||'').replace('T',' ').slice(0,16))} · 롯데 ${esc(thru.lotte||'—')}까지 · 신세계 ${esc(thru.shinsegae||'—')}까지. 롯데는 SRM에서 매일 자동 수집하고, 신세계는 DFIS 파일을 받은 날까지 반영됩니다. 매출은 USD 판매가 기준이며 KRW는 월·채널별 실제 결제 원화로 역산한 적용환율을 씁니다.</p></details></div>`;
 }
 function channelCards(model){
  const months=rangeMonths(st.from,st.to),c=cmpRange(st),all={...st,ch:'전체'};
  const cur=agg(rowsIn(model,all,st.from,st.to)),prev=c?agg(rowsIn(model,all,c[0],c[1])):null,act=activeChannels(model,months);
  if(st.ch!=='전체'&&!act.some(x=>x.id===st.ch))st.ch='전체';
  const items=[{id:'전체',short:'전체 합계',color:'#0F1C3F',amt:cur.amt,qty:cur.qty,pamt:prev&&prev.amt,share:1},...act.map(ch=>({...ch,amt:cur[ch.id],qty:cur[ch.id+'|q'],pamt:prev&&prev[ch.id],share:cur.amt?cur[ch.id]/cur.amt:0}))];
  return `<div class="dfs-chan" role="group" aria-label="채널 선택">${items.map(it=>`<button type="button" class="dfs-chan-btn" data-df-ch="${esc(it.id)}" aria-pressed="${st.ch===it.id}" style="--cc:${it.color}"><span class="n">${esc(it.short)}${prev?dTag(it.amt,it.pamt):''}</span><span class="v">${money(it.amt)}</span><span class="p"><span>${fmt(it.qty)}개</span><span>${it.id==='전체'?(prev?`이전 ${money(it.pamt)}`:''):`비중 ${pct(it.share)}`}</span></span><span class="share"><i style="width:${it.share*100}%"></i></span></button>`).join('')}</div>`;
 }
 function baseKpis(cur,prev,extra=[]){return [
  {k:'총 매출',v:money(cur.amt),d:prev&&dTag(cur.amt,prev.amt),p:prev?`이전 구간 ${money(prev.amt)}`:''},
  {k:'판매수량',v:fmt(cur.qty)+'개',d:prev&&dTag(cur.qty,prev.qty),p:prev?`이전 구간 ${fmt(prev.qty)}개`:''},
  {k:'평균 판매가',v:cur.avg==null?'—':(st.cur==='KRW'?won(cur.avg):'$'+cur.avg.toFixed(2)),d:prev&&prev.avg!=null&&cur.avg!=null?dTag(cur.avg,prev.avg):'',p:prev&&prev.avg!=null?`이전 구간 ${st.cur==='KRW'?won(prev.avg):'$'+prev.avg.toFixed(2)}`:''},
  {k:'판매 상품수',v:fmt(cur.products)+'종',d:prev&&dTag(cur.products,prev.products),p:prev?`이전 구간 ${fmt(prev.products)}종`:''},...extra];}

 function renderOverview(model){
  const L=latestDay(model,st);
  const spark=arr=>{const mx=Math.max(...arr.map(x=>x.amt),1);return `<span class="dfs-spark" aria-hidden="true">${arr.map((x,i)=>`<i style="height:${Math.max(2,Math.round(x.amt/mx*26))}px" class="${i===arr.length-1?'last':''}" title="${x.d} ${money(x.amt)}"></i>`).join('')}</span>`;};
  const tiles=[];
  if(L.latest)tiles.push(`<div class="dfs-tile total" style="--cc:#2563EB"><div class="t"><b>전체 합계</b><span>${md(L.latest)} · ${L.onLatest.length}개 채널</span></div><div class="v">${money(L.tot.amt)}<small>${fmt(L.tot.qty)}개</small></div><div class="m">${L.onLatest.map(p=>`${esc(p.c.short)} ${money(p.cur.amt)}`).join(' · ')}</div></div>`);
  for(const p of L.perCh)tiles.push(`<div class="dfs-tile" style="--cc:${p.c.color}"><div class="t"><b>${esc(p.c.short)}</b><span class="${p.d0!==L.latest?'late':''}">${md(p.d0)} (${dow(p.d0)})</span></div><div class="v">${money(p.cur.amt)}<small>${fmt(p.cur.qty)}개</small>${p.prev?dTag(p.cur.amt,p.prev.amt):''}</div><div class="r"><div class="m">직전 판매일 ${p.d1?md(p.d1)+' '+money(p.prev.amt):'—'}<br>최근 7일 평균 ${money(p.avg7)}</div>${spark(p.last7)}</div></div>`);
  const note=L.latest?(L.behind.length?L.behind.map(p=>`${p.c.short}은 ${md(p.d0)}까지만 수집됨(전체 합계에서 제외)`).join(' · ')+' · ':'')+'증감은 각 채널의 직전 판매일 대비':'일별 자료 없음';
  const months=rangeMonths(st.from,st.to),chans=chansFor(model,st,months),c=cmpRange(st);
  const cur=agg(rowsIn(model,st,st.from,st.to)),prev=c?agg(rowsIn(model,st,c[0],c[1])):null,rows=byMonth(rowsIn(model,st,st.from,st.to),months);
  const best=rows.reduce((a,b)=>!a||b.amt>a.amt?b:a,null);
  const cats=new Map();for(const r of rowsIn(model,st,st.from,st.to)){const o=cats.get(r.category)||{category:r.category,amt:0,qty:0,prev:0};o.amt+=r.amt;o.qty+=r.qty;cats.set(r.category,o);}
  if(c)for(const r of rowsIn(model,st,c[0],c[1])){const o=cats.get(r.category);if(o)o.prev+=r.amt;}
  const clist=[...cats.values()].sort((a,b)=>b.amt-a.amt),ctot=sum(clist,x=>x.amt);
  const html=`${card(`최근 일일 매출${L.latest?` — ${L.latest} (${dow(L.latest)})`:''}`,`<div class="dfs-tiles">${tiles.join('')}</div>`,{note})}
   ${kpi(baseKpis(cur,prev,[{k:'최고 매출 월',v:best?best.month:'—',p:best?money(best.amt):''}]))}
   <div class="dfs-grid2">${card('월별 매출 추이',canvas('dfs-ov-line',260,'채널별 월 매출'),{note:'채널별 월 매출'})}${card('월별 판매수량',canvas('dfs-ov-qty',260,'채널별 월 판매수량'),{note:'채널별 누적'})}</div>
   <div class="dfs-grid2">${card('상품별 매출 상위 10',canvas('dfs-ov-top',300,'상품 매출 상위 10'),{note:'선택 기간 합계'})}${card('분류별 매출',table([{label:'분류',v:r=>esc(r.category)},{label:'매출',cls:'r',v:r=>money(r.amt)},{label:'수량',cls:'r',v:r=>fmt(r.qty)},{label:'비중',cls:'r',v:r=>ctot?pct(r.amt/ctot):'—'},{label:'비교 대비',cls:'r',v:r=>c?dCell(r.amt,r.prev):'—'}],clist),{note:'선택 기간 합계와 비교 구간 대비'})}</div>`;
  return {html,after(){
   chart('dfs-ov-line',{type:'line',data:{labels:rows.map(r=>r.month),datasets:ds(chans,rows,c=>c.id,false)},options:{scales:{x:{},y:{ticks:{callback:moneyTick}}},plugins:{tooltip:{callbacks:{label:x=>` ${x.dataset.label} ${money(x.raw)}`}}}}});
   chart('dfs-ov-qty',{type:'bar',data:{labels:rows.map(r=>r.month),datasets:ds(chans,rows,c=>c.id+'|q')},options:{scales:{x:{stacked:true},y:{stacked:true}},plugins:{tooltip:{callbacks:{label:x=>` ${x.dataset.label} ${fmt(x.raw)}개`}}}}});
   topChart('dfs-ov-top',byProduct(rowsIn(model,st,st.from,st.to)),chans,10);
  }};
 }
 function topChart(id,prods,chans,n){const top=[...prods].sort((a,b)=>b.amt-a.amt).slice(0,n);const el=root.querySelector('#'+id);if(el)el.parentElement.style.height=Math.max(160,top.length*28+50)+'px';
  chart(id,{type:'bar',data:{labels:top.map(p=>p.product.length>22?p.product.slice(0,21)+'…':p.product),datasets:ds(chans,top)},options:{indexAxis:'y',scales:{x:{stacked:true,ticks:{callback:moneyTick}},y:{stacked:true,ticks:{font:{size:10}}}},onClick:(e,els)=>{if(!els.length)return;st.pick=top[els[0].index].product;st.tab='products';paint();},plugins:{tooltip:{callbacks:{title:xs=>top[xs[0].dataIndex].product,label:x=>` ${x.dataset.label} ${money(x.raw)}`}}}}});}

 function renderDaily(model){
  const D=dailyView(model,st),chans=D.chans,multi=chans.length>1,q=st.dyQ.toLowerCase();
  if(st.dyDay&&!(st.dyDay>=D.from&&st.dyDay<=D.to))st.dyDay=null;
  if(!['전체',...chans.map(c=>c.id)].includes(st.dyCh))st.dyCh='전체';
  let list=D.rows.filter(r=>(!st.dyDay||r.date===st.dyDay)&&(st.dyCh==='전체'||r.channel===st.dyCh)&&(r.qty!==0||r.amt!==0)&&(!q||r.product.toLowerCase().includes(q)));
  list.sort((a,b)=>b.date.localeCompare(a.date)||a.channel.localeCompare(b.channel)||b.amt-a.amt);const total=list.length,MAX=3000;list=list.slice(0,MAX);
  const dayAttr=r=>` data-df-day="${r.date}" class="dfs-click${st.dyDay===r.date?' dfs-sel':''}"`;
  const chHead=multi?chans.map(ch=>({label:ch.short,cls:'r',v:r=>money(r[ch.id])})):[];
  const html=`${kpi([
   {k:'총 매출',v:money(D.cur.amt),d:D.prev&&dTag(D.cur.amt,D.prev.amt),p:D.prev?`이전 구간 ${money(D.prev.amt)}`:''},
   {k:'판매수량',v:fmt(D.cur.qty)+'개',d:D.prev&&dTag(D.cur.qty,D.prev.qty),p:D.prev?`이전 구간 ${fmt(D.prev.qty)}개`:''},
   {k:'판매일 수',v:fmt(D.days.length)+'일',p:'판매가 있었던 날'},
   {k:'일 평균 매출',v:D.days.length?money(D.cur.amt/D.days.length):'—',p:'판매일 기준'},
   {k:'최고 매출일',v:D.best?`${md(D.best.date)} (${dow(D.best.date)})`:'—',p:D.best?money(D.best.amt):''}])}
   ${card('일별 매출',canvas('dfs-dy-bar',260,'일별 매출'),{note:`${D.from} ~ ${D.to} · 막대를 누르면 그날 상품 내역만 표시`})}
   <div class="dfs-grid2">${card('요일별 평균 매출',canvas('dfs-dy-dow',220,'요일별 평균'),{note:'판매일 기준 평균'})}${card('매출 상위 10일',table([{label:'날짜',v:r=>r.date},{label:'요일',v:r=>dow(r.date)},...chHead,{label:multi?'합계':'매출',cls:'r',v:r=>money(r.amt)},{label:'수량',cls:'r',v:r=>fmt(r.qty)}],[...D.days].sort((a,b)=>b.amt-a.amt).slice(0,10),{rowAttr:dayAttr}))}</div>
   ${card('일별 내역',table([{label:'날짜',v:(r,t)=>t?'합계':r.date},{label:'요일',v:(r,t)=>t?'':dow(r.date)},...chHead,{label:multi?'합계 매출':'매출',cls:'r',v:r=>money(r.amt)},{label:'수량',cls:'r',v:r=>fmt(r.qty)},{label:'판매 상품수',cls:'r',v:r=>fmt(r.products)}],D.days,{total:D.cur,rowAttr:dayAttr}),{note:'행을 누르면 아래 상품 내역이 그날로 좁혀집니다'})}
   ${card('상품별 판매 내역',`<div class="dfs-toolbar"><input type="search" data-df-ctl="dyQ" placeholder="상품명 검색" aria-label="상품명 검색" value="${esc(st.dyQ)}"><select data-df-ctl="dyCh" aria-label="채널">${['전체',...chans.map(c=>c.id)].map(v=>`<option value="${esc(v)}"${st.dyCh===v?' selected':''}>${v==='전체'?'채널: 전체':esc(chName(v))}</option>`).join('')}</select>${st.dyDay?`<button type="button" class="btn btn-sm" data-df-day="${st.dyDay}">${st.dyDay} (${dow(st.dyDay)}) 만 보기 ×</button>`:''}<span class="dfs-count">${fmt(total)}건${total>MAX?` 중 최근 ${fmt(MAX)}건`:''} · 수량 ${fmt(sum(list,r=>r.qty))}개 · 매출 ${money(sum(list,r=>r.amt))}</span></div>`+table([{label:'날짜',v:r=>r.date},{label:'요일',v:r=>dow(r.date)},{label:'채널',v:r=>esc(chName(r.channel))},{label:'상품명',v:r=>esc(r.product)},{label:'분류',v:r=>esc(r.category)},{label:'수량',cls:'r',v:r=>fmt(r.qty)},{label:'매출',cls:'r',v:r=>money(r.amt)}],list))}`;
  return {html,after(){
   chart('dfs-dy-bar',{type:'bar',data:{labels:D.days.map(d=>md(d.date)),datasets:ds(chans,D.days)},options:{scales:{x:{stacked:true},y:{stacked:true,ticks:{callback:moneyTick}}},onClick:(e,els)=>{if(!els.length)return;const d=D.days[els[0].index].date;st.dyDay=st.dyDay===d?null:d;paint();},plugins:{tooltip:{callbacks:{title:xs=>{const d=D.days[xs[0].dataIndex].date;return `${d} (${dow(d)})`;},label:x=>` ${x.dataset.label} ${money(x.raw)}`}}}}});
   chart('dfs-dy-dow',{type:'bar',data:{labels:D.dowAvg.map(d=>d.label),datasets:ds(chans,D.dowAvg)},options:{scales:{x:{stacked:true},y:{stacked:true,ticks:{callback:moneyTick}}},plugins:{tooltip:{callbacks:{label:x=>` ${x.dataset.label} ${money(x.raw)}`}}}}});
  }};
 }
 function renderMonthly(model){
  const months=rangeMonths(st.from,st.to),chans=chansFor(model,st,months),rows=byMonth(rowsIn(model,st,st.from,st.to),months),c=cmpRange(st);
  const cur=agg(rowsIn(model,st,st.from,st.to)),prev=c?agg(rowsIn(model,st,c[0],c[1])):null,best=rows.reduce((a,b)=>!a||b.amt>a.amt?b:a,null);
  const withPrev=rows.map(r=>{const pm=addMonths(r.month,-1);return {...r,prev:agg(rowsIn(model,st,pm,pm)).amt};});
  const html=`${kpi(baseKpis(cur,prev,[{k:'최고 매출 월',v:best?best.month:'—',p:best?money(best.amt):''}]))}
   <div class="dfs-grid2">${card('월별 매출',canvas('dfs-mo-amt',240,'월별 매출'),{note:'채널별 누적'})}${card('월별 판매수량',canvas('dfs-mo-qty',240,'월별 판매수량'),{note:'채널별 누적'})}</div>
   ${card('월별 내역',table([{label:'월',v:(r,t)=>t?'합계':r.month},...chans.map(ch=>({label:ch.short,cls:'r',v:r=>money(r[ch.id])})),{label:'합계 매출',cls:'r',v:r=>money(r.amt)},{label:'전월비',cls:'r',v:(r,t)=>t?(prev?dCell(r.amt,prev.amt):'—'):dCell(r.amt,r.prev)},...chans.map(ch=>({label:ch.short+' 수량',cls:'r',v:r=>fmt(r[ch.id+'|q'])})),{label:'합계 수량',cls:'r',v:r=>fmt(r.qty)},{label:'판매 상품수',cls:'r',v:r=>fmt(r.products)}],withPrev,{total:cur}))}`;
  return {html,after(){
   chart('dfs-mo-amt',{type:'bar',data:{labels:rows.map(r=>r.month),datasets:ds(chans,rows)},options:{scales:{x:{stacked:true},y:{stacked:true,ticks:{callback:moneyTick}}},plugins:{tooltip:{callbacks:{label:x=>` ${x.dataset.label} ${money(x.raw)}`}}}}});
   chart('dfs-mo-qty',{type:'bar',data:{labels:rows.map(r=>r.month),datasets:ds(chans,rows,c=>c.id+'|q')},options:{scales:{x:{stacked:true},y:{stacked:true}},plugins:{tooltip:{callbacks:{label:x=>` ${x.dataset.label} ${fmt(x.raw)}개`}}}}});
  }};
 }
 function renderProducts(model){
  const cats=[...new Set(model.ALL.map(r=>r.category).filter(Boolean))].sort();if(st.cat!=='전체'&&!cats.includes(st.cat))st.cat='전체';
  const months=rangeMonths(st.from,st.to),chans=chansFor(model,st,months),c=cmpRange(st);
  const prods=byProduct(rowsIn(model,st,st.from,st.to,{cat:st.cat})),prevMap=new Map(c?byProduct(rowsIn(model,st,c[0],c[1],{cat:st.cat})).map(p=>[p.product,p.amt]):[]);
  for(const p of prods){p.prev=prevMap.get(p.product)||0;p.delta=p.prev?(p.amt-p.prev)/p.prev:null;}
  const diff=prods.filter(p=>p.ss_price!=null&&p.lt_price!=null&&p.ss_price!==p.lt_price).sort((a,b)=>Math.abs(b.lt_price-b.ss_price)-Math.abs(a.lt_price-a.ss_price));
  const q=st.q.toLowerCase(),list=prods.filter(p=>!q||p.product.toLowerCase().includes(q)),maxT=Math.max(...prods.map(p=>p.amt),1);
  const bar=(v,color)=>v?`<span class="dfs-bar"><i style="width:${v/maxT*100}%;background:${color}"></i><b>${money(v)}</b></span>`:'';
  const pickAttr=r=>` data-df-pick="${esc(r.product)}" class="dfs-click${st.pick===r.product?' dfs-sel':''}"`;
  const html=`<div class="dfs-toolbar"><input type="search" data-df-ctl="q" placeholder="상품명 검색" aria-label="상품명 검색" value="${esc(st.q)}"><select data-df-ctl="cat" aria-label="분류"><option value="전체">분류: 전체</option>${cats.map(x=>`<option value="${esc(x)}"${st.cat===x?' selected':''}>분류: ${esc(x)}</option>`).join('')}</select>${st.pick?`<button type="button" class="btn btn-sm" data-df-pick="${esc(st.pick)}">${esc(st.pick)} ×</button>`:''}</div>
   ${st.pick?card(st.pick+' 월별 추이',canvas('dfs-pr-trend',220,'선택 상품 월별 매출')):''}
   <div class="dfs-grid2">${card('상품별 매출 상위 15',canvas('dfs-pr-top',420,'상품 매출 상위 15'),{note:'막대를 누르면 상품 선택'})}${card('채널 간 가격이 다른 상품',diff.length?table([{label:'상품명',v:r=>esc(r.product)},{label:'신세계 가격',cls:'r',v:r=>money(r.ss_price)},{label:'롯데 온라인 가격',cls:'r',v:r=>money(r.lt_price)},{label:'차이',cls:'r',v:r=>`<span class="${r.lt_price>r.ss_price?'up':'down'}">${r.lt_price>r.ss_price?'+':''}${money(r.lt_price-r.ss_price)}</span>`}],diff):'<p class="dfs-empty">선택 기간에 두 채널 가격이 다른 상품이 없습니다.</p>',{note:'기간 내 마지막 판매가 기준'})}</div>
   ${card('상품별 상세',table([{label:'상품명',k:'product',v:r=>esc(r.product)},{label:'분류',k:'category',v:r=>esc(r.category)},...chans.map(ch=>({label:ch.short,k:ch.id,v:r=>bar(r[ch.id],ch.color)})),{label:'합계 매출',k:'amt',cls:'r',v:r=>money(r.amt)},{label:'비교 대비',k:'delta',cls:'r',v:r=>c?dCell(r.amt,r.prev):'—'},{label:'합계 수량',k:'qty',cls:'r',v:r=>fmt(r.qty)},{label:'신세계 가격',k:'ss_price',cls:'r',v:r=>r.ss_price==null?'':money(r.ss_price)},{label:'롯데 온라인 가격',k:'lt_price',cls:'r',v:r=>r.lt_price==null?'':money(r.lt_price)}],list,{sort:st.sort.pr,sortKey:'pr',rowAttr:pickAttr}),{note:'열 머리글을 누르면 정렬 · 행을 누르면 월별 추이'})}`;
  return {html,after(){
   topChart('dfs-pr-top',prods,chans,15);
   if(st.pick){const rows=byMonth(rowsIn(model,st,st.from,st.to,{product:st.pick}),months);chart('dfs-pr-trend',{type:'line',data:{labels:rows.map(r=>r.month),datasets:ds(chans,rows,c=>c.id,false)},options:{scales:{x:{},y:{ticks:{callback:moneyTick}}},plugins:{tooltip:{callbacks:{label:x=>` ${x.dataset.label} ${money(x.raw)}`}}}}});}
  }};
 }
 function renderSettle(model){
  const S=settleView(model,st),cfg=model.config,cur=S.cur,prev=S.prev,q=st.stQ.toLowerCase();
  const signed=v=>`<span class="${v<0?'down':''}">${won(v)}</span>`;
  const noCogsQty=[...S.noCogs.values()].reduce((a,b)=>a+b,0);
  const L=S.lotte;
  const lotteHtml=L.show?card('롯데 온라인 · SRM 정산 기준',`<p class="dfs-note">SRM 판매금액 = 그 달 판매분의 공급가 합계(롯데가 지급하는 정산 기준). 입고 공급가액 = 특정매입 입고 − 반품 공급가. 부가세 10%는 분기마다 지급.</p>`+table([{label:'월',v:(r,t)=>t?'합계':r.month},{label:'SRM 판매금액',cls:'r',v:r=>r.srm==null?'—':won(r.srm)},{label:'대시보드 공급가',cls:'r',v:r=>won(r.supply)},{label:'차이',cls:'r',v:r=>r.diff==null?'—':`<span class="${r.diff>0?'up':r.diff<0?'down':''}">${r.diff>0?'+':''}${won(r.diff)}</span>`},{label:'판매금액÷매출',cls:'r',v:r=>pct(r.ratio)},{label:'입고 공급가액',cls:'r',v:r=>won(r.supply_in)},{label:'부가세',cls:'r',v:r=>won(r.vat)},{label:'합계',cls:'r',v:r=>won(r.total)}],L.rows,{total:L.tot})+`<div class="dfs-grid2 dfs-inner"><div><h4>분기별 부가세(입고 기준)</h4>${table([{label:'분기',v:r=>r.q+(r.n<3?` (${r.n}개월)`:'')},{label:'판매금액',cls:'r',v:r=>won(r.srm)},{label:'입고 공급가액',cls:'r',v:r=>won(r.supply_in)},{label:'부가세',cls:'r',v:r=>won(r.vat)},{label:'합계',cls:'r',v:r=>won(r.total)}],L.quarters)}</div><div><h4>입고·반품 내역</h4>${table([{label:'일자',v:r=>(r.date||'').replace(/(\d{4})(\d{2})(\d{2})/,'$1-$2-$3')},{label:'구분',v:r=>esc(r.kind)},{label:'입고 수량',cls:'r',v:r=>fmt(r.qty_in)},{label:'입고 공급가',cls:'r',v:r=>won(n0(r.cost_in))},{label:'반품 수량',cls:'r',v:r=>fmt(r.qty_rtn)},{label:'반품 공급가',cls:'r',v:r=>won(n0(r.cost_rtn))}],L.events)}</div></div>`):'';
  const html=`${kpi([
   {k:'매출 (₩)',v:won(cur.krw),d:prev&&dTag(cur.krw,prev.krw),p:`${usd(cur.usd)} · 평균 적용환율 ${cur.rate?fmt(cur.rate)+'원/$':'—'}`},
   {k:'면세점 수수료',v:won(cur.fee),d:prev&&dTag(cur.fee,prev.fee),p:`실효 ${pct(cur.krw?cur.fee/cur.krw:null)} · 약정 ${pct(cfg.contractFeeRate)}`},
   {k:'공급가 · 면세점 정산액',v:won(cur.supply),d:prev&&dTag(cur.supply,prev.supply),p:prev?`이전 구간 ${won(prev.supply)}`:''},
   {k:`${cfg.agencyLabel} 수수료`,v:won(cur.agency),d:prev&&dTag(cur.agency,prev.agency),p:`매출의 ${pct(cfg.agencyRate)} + VAT = ${pct(cfg.agencyRate*(1+cfg.vat))}`},
   {k:'제조원가',v:won(cur.cogs),d:prev&&dTag(cur.cogs,prev.cogs),p:`판매수량 × 표준원가 · 물류비 미포함${S.noCogs.size?` · 원가 미등록 ${S.noCogs.size}개 상품 ${fmt(noCogsQty)}개 제외`:''}`},
   {k:'고정비',v:won(cur.fixed),d:prev&&dTag(cur.fixed,prev.fixed),p:esc(S.fixedLabel)},
   {k:'공헌이익',v:signed(cur.contrib),d:prev&&dTag(cur.contrib,prev.contrib),p:`공급가 − ${esc(cfg.agencyLabel)} − 제조원가 − 고정비 · 매출 대비 ${pct(cur.krw?cur.contrib/cur.krw:null)}`}])}
   ${card('월별 매출 · 공급가 · 공헌이익',canvas('dfs-st-chart',280,'월별 정산'),{note:'원화 기준 · 선은 적용환율'})}
   ${card('월별 정산 · 공헌이익',table([{label:'월',v:(r,t)=>t?'합계':r.month},...S.chans.map(ch=>({label:ch.short+' 매출($)',cls:'r',v:(r,t)=>usd(t?sum(model.SETTLE.filter(x=>x.channel===ch.id&&x.month>=st.from&&x.month<=st.to),x=>x.amt):r.byCh[ch.id]||0)})),{label:'매출($)',cls:'r',v:r=>usd(r.usd)},{label:'적용환율',cls:'r',v:r=>r.rate?fmt(r.rate):'—'},{label:'매출(₩)',cls:'r',v:r=>won(r.krw)},{label:'면세점 수수료',cls:'r',v:r=>won(r.fee)},{label:'수수료율',cls:'r',v:r=>pct(r.krw?r.fee/r.krw:null)},{label:'공급가',cls:'r',v:r=>won(r.supply)},{label:cfg.agencyLabel+' 수수료',cls:'r',v:r=>won(r.agency)},{label:'제조원가',cls:'r',v:r=>won(r.cogs)},{label:'고정비',cls:'r',v:r=>won(r.fixed)},{label:'공헌이익',cls:'r',v:r=>signed(r.contrib)},{label:'공헌이익률',cls:'r',v:r=>`<span class="${r.contrib<0?'down':''}">${pct(r.krw?r.contrib/r.krw:null)}</span>`}],S.mrows,{total:{...cur,month:'합계'}}))}
   ${card('상품별 정산 내역',`<div class="dfs-toolbar"><input type="search" data-df-ctl="stQ" placeholder="상품명 검색" aria-label="상품명 검색" value="${esc(st.stQ)}"></div>`+table([{label:'상품명',k:'product',v:r=>esc(r.product)},{label:'분류',k:'category',v:r=>esc(r.category)},{label:'채널',k:'channel',v:r=>esc(r.channel)},{label:'수량',k:'qty',cls:'r',v:r=>fmt(r.qty)},{label:'매출($)',k:'amt',cls:'r',v:r=>usd(r.amt)},{label:'매출(₩)',k:'amt_krw',cls:'r',v:r=>won(r.amt_krw)},{label:'공급단가',k:'unit_cost',cls:'r',v:r=>r.unit_cost==null?'—':won(r.unit_cost)},{label:'공급가',k:'supply',cls:'r',v:r=>won(r.supply)},{label:'면세점 수수료',k:'fee',cls:'r',v:r=>won(r.fee)},{label:'수수료율',k:'fee_rate',cls:'r',v:r=>pct(r.fee_rate)},{label:cfg.agencyLabel+' 수수료',k:'agency',cls:'r',v:r=>won(r.agency)},{label:'제조원가 단가',k:'cogs_unit',cls:'r',v:r=>r.cogs_unit==null?'<span class="down">원가 미등록</span>':won(r.cogs_unit)},{label:'제조원가',k:'cogs',cls:'r',v:r=>r.cogs_unit==null&&r.qty?'—':won(r.cogs)},{label:'공헌이익(고정비 전)',k:'net',cls:'r',v:r=>signed(r.net)},{label:'공헌이익률',k:'net_rate',cls:'r',v:r=>`<span class="${r.net<0?'down':''}">${pct(r.net_rate)}</span>`}],S.prods.filter(p=>!q||p.product.toLowerCase().includes(q)),{sort:st.sort.st,sortKey:'st'}),{note:'고정비는 상품별로 나눌 수 없어 제외 · 원가 미등록 상품은 제조원가 0'})}
   ${lotteHtml}
   <p class="dfs-note">정산 매출은 일별 결제 자료(신세계 DFIS 일별 ₩·$, 롯데 SRM 원화금액 조회) 기준이라 월별 탭과 소액 차이가 날 수 있습니다. 공급가 = 판매수량 × 매입단가(신세계)·공급원가(롯데). 실효 수수료율이 약정과 다른 품목은 공급단가가 다른 환율 시점에 책정된 경우입니다. 공헌이익 = 공급가 − ${esc(cfg.agencyLabel)} 수수료(VAT 포함) − 제조원가 − 고정비이며 물류비는 포함하지 않습니다.</p>`;
  return {html,after(){
   const rs=S.mrows;
   chart('dfs-st-chart',{type:'bar',data:{labels:rs.map(r=>r.month),datasets:[
    {label:'매출(₩)',data:rs.map(r=>r.krw),backgroundColor:'#2563EB',borderRadius:3,yAxisID:'y'},
    {label:'공급가',data:rs.map(r=>r.supply),backgroundColor:'#7EB3FF',borderRadius:3,yAxisID:'y'},
    {label:'공헌이익',data:rs.map(r=>r.contrib),backgroundColor:rs.map(r=>r.contrib<0?'#DC2626':CONTRIB_COLOR),borderRadius:3,yAxisID:'y'},
    {label:'적용환율',type:'line',data:rs.map(r=>r.rate),borderColor:QTY_COLOR,backgroundColor:QTY_COLOR,borderWidth:2,pointRadius:3,tension:0.3,yAxisID:'y2'}]},
    options:{scales:{x:{},y:{ticks:{callback:v=>(v<0?'−₩':'₩')+new Intl.NumberFormat('en',{notation:'compact',maximumFractionDigits:1}).format(Math.abs(v))}},y2:{position:'right',grid:{drawOnChartArea:false},ticks:{callback:v=>fmt(v)}}},plugins:{tooltip:{callbacks:{label:x=>x.dataset.yAxisID==='y2'?` 적용환율 ${x.raw?fmt(x.raw)+'원/$':'—'}`:` ${x.dataset.label} ${won(x.raw)}`}}}}});
  }};
 }
 function renderStock(model){
  const K=stockView(model,st);
  const html=`${kpi([
   {k:'재고 합계',v:fmt(K.last.stock)+'개',d:K.first?dTag(K.last.stock,K.first.stock):'',p:K.first?`${K.first.month} 월말 ${fmt(K.first.stock)}개 대비`:'신세계 + 롯데 온라인'},
   {k:'신세계 재고',v:fmt(K.last.ss_stock)+'개',p:`${K.ssLabel} · 온·오프 구분 없음`},
   {k:'롯데 온라인 재고',v:fmt(K.last.lt_stock)+'개',p:`${K.ltLabel} · 전체 점`},
   {k:'재고 금액',v:money(K.last.stock_amt),p:'판매가 기준'},
   {k:'소진 개월수',v:K.cover==null?'—':K.cover.toFixed(1)+'개월',p:`최근 ${K.q3m.length}개월 월평균 ${fmt(K.q3.qty/K.q3m.length)}개 판매 기준`}])}
   ${card('월별 재고 추이',canvas('dfs-sk-line',240,'월별 재고 추이'),{note:'월별 파일이 있는 달만'})}
   ${card('상품별 재고',table([{label:'상품명',k:'product',v:r=>esc(r.product)},{label:'분류',k:'category',v:r=>esc(r.category)},{label:'신세계 재고',k:'ss_stock',cls:'r',v:r=>fmt(r.ss_stock)},{label:'롯데 온라인 재고',k:'lt_stock',cls:'r',v:r=>fmt(r.lt_stock)},{label:'재고 합계',k:'stock',cls:'r',v:r=>fmt(r.stock)},{label:'재고 금액',k:'stock_amt',cls:'r',v:r=>money(r.stock_amt)},{label:'최근 3개월 판매',k:'q3',cls:'r',v:r=>fmt(r.q3)},{label:'소진 개월',k:'cover',cls:'r',v:r=>r.cover==null?(r.stock?'판매 없음':'—'):r.cover.toFixed(1)}],K.prods,{sort:st.sort.sk,sortKey:'sk'}),{note:`신세계 ${K.ssLabel} · 롯데 ${K.ltLabel} 재고와 최근 ${K.q3m.length}개월(${K.q3m[0]}~${K.snap}) 판매로 본 소진 개월수`})}`;
  return {html,after(){
   const has=g=>K.trend.map(r=>model.ALL.some(a=>a.month===r.month&&a.fromFile&&a.group===g));
   const ss=has('신세계'),lt=has('롯데');
   chart('dfs-sk-line',{type:'line',data:{labels:K.trend.map(r=>r.month),datasets:[{label:'신세계',data:K.trend.map((r,i)=>ss[i]?r.ss_stock:null),borderColor:GROUP_COLOR['신세계'],backgroundColor:GROUP_COLOR['신세계'],borderWidth:2.5,tension:0.35,pointRadius:3,spanGaps:true},{label:'롯데 온라인',data:K.trend.map((r,i)=>lt[i]?r.lt_stock:null),borderColor:GROUP_COLOR['롯데'],backgroundColor:GROUP_COLOR['롯데'],borderWidth:2.5,tension:0.35,pointRadius:3,spanGaps:true}]},options:{scales:{x:{},y:{ticks:{callback:v=>fmt(v)}}},plugins:{tooltip:{callbacks:{label:x=>` ${x.dataset.label} ${fmt(x.raw)}개`}}}}});
  }};
 }

 function paint(){
  if(!active||!root)return;destroyCharts();
  const s=ctl.state;
  if(s.loading){root.innerHTML='<p class="dfs-msg" role="status">면세점 판매 자료를 불러오는 중입니다…</p>';return;}
  if(s.error){root.innerHTML=`<div class="dfs-msg"><p role="alert">${esc(s.error)}</p><button class="btn" type="button" data-df-reload>다시 불러오기</button></div>`;return;}
  const model=s.model;if(!model)return;
  if(!st.from||!model.MONTHS.includes(st.from)){st.from=st.to=model.currentMonth;}
  if(!model.MONTHS.includes(st.to))st.to=model.MONTHS[model.MONTHS.length-1];
  applyCurrency(model,st.cur);
  const r=({overview:renderOverview,daily:renderDaily,monthly:renderMonthly,products:renderProducts,settle:renderSettle,stock:renderStock})[st.tab](model);
  root.innerHTML=`${controls(model)}${channelCards(model)}<nav class="dfs-tabs" role="tablist" aria-label="면세점 판매 보기">${TABS.map(([k,l])=>`<button type="button" role="tab" data-df-tab="${k}" aria-selected="${st.tab===k}">${l}</button>`).join('')}</nav><div class="dfs-page" role="tabpanel">${r.html}</div>`;
  for(const [k,v] of [['from',st.from],['to',st.to],['cmp',st.cmp],['cur',st.cur]]){const el=root.querySelector(`[data-df-ctl="${k}"]`);if(el)el.value=v;}
  r.after();
 }
 function onClick(e){
  const t=e.target.closest('[data-df-tab],[data-df-ch],[data-df-sort],[data-df-pick],[data-df-day],[data-df-reload]');if(!t||!root.contains(t))return;
  if(t.dataset.dfReload!==undefined){load();return;}
  if(t.dataset.dfTab){st.tab=t.dataset.dfTab;}
  else if(t.dataset.dfCh){st.ch=(t.dataset.dfCh==='전체'||st.ch===t.dataset.dfCh)?'전체':t.dataset.dfCh;}
  else if(t.dataset.dfSort){const [key,k]=t.dataset.dfSort.split(':'),s=st.sort[key];if(s[0]===k)s[1]=s[1]==='desc'?'asc':'desc';else st.sort[key]=[k,(k==='product'||k==='category'||k==='channel')?'asc':'desc'];}
  else if(t.dataset.dfPick){st.pick=st.pick===t.dataset.dfPick?null:t.dataset.dfPick;st.tab='products';}
  else if(t.dataset.dfDay){st.dyDay=st.dyDay===t.dataset.dfDay?null:t.dataset.dfDay;}
  paint();
 }
 function onInput(e){
  const t=e.target.closest('[data-df-ctl]');if(!t)return;const k=t.dataset.dfCtl,v=t.value,model=ctl.state.model;if(!model)return;
  if(e.type==='input'&&!['q','dyQ','stQ'].includes(k))return;
  if(k==='from'){st.from=v;if(st.to<v)st.to=v;}
  else if(k==='to'){st.to=v;if(st.from>v)st.from=v;}
  else if(k==='quick'){if(!v)return;const last=model.MONTHS[model.MONTHS.length-1];st.to=last;st.from=v==='cur'?last:v==='all'?model.MONTHS[0]:v==='ytd'?last.slice(0,4)+'-01':model.MONTHS[Math.max(0,model.MONTHS.length-Number(v))];}
  else if(k==='cmp')st.cmp=v;else if(k==='cur')st.cur=v;else if(k==='cat')st.cat=v;else if(k==='dyCh')st.dyCh=v;
  else if(['q','dyQ','stQ'].includes(k)){st[k]=v.trim();const pos=t.selectionStart;paint();const again=root.querySelector(`[data-df-ctl="${k}"]`);if(again){again.focus();try{again.setSelectionRange(pos,pos);}catch(err){}}return;}
  paint();
 }
 function hide(){active=false;view++;ctl.clear();destroyCharts();if(root)root.remove();root=null;}
 async function load(){const cur=++view;const pending=ctl.load();paint();await pending;if(active&&cur===view)paint();}
 async function show(){hide();active=true;document.getElementById('topbar-actions').replaceChildren();const content=document.getElementById('content');content.replaceChildren();root=document.createElement('section');root.className='dfs';root.setAttribute('aria-label','면세점 판매');root.addEventListener('click',onClick);root.addEventListener('change',onInput);root.addEventListener('input',onInput);content.append(root);await load();}
 client.auth.onAuthStateChange(event=>{if(event==='SIGNED_OUT')hide();});
 return {show,hide,state:st};
}
return {CHANNELS,TABLES,esc,addMonths,rangeMonths,cmpRange,validateSnapshot,buildModel,applyCurrency,rowsIn,agg,byMonth,byProduct,latestDay,dailyView,settleView,stockView,controller,mount};
});
