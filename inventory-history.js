(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.InventoryHistory=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';

  const MAX_BYTES=4*1024*1024;
  const MAX_AGE_MS=24*60*60*1000;
  const MAX_FUTURE_MS=5*60*1000;
  const STALE_MS=180*60*1000;
  const DEFAULT_TIMEOUT_MS=15000;
  const QUANTITY_KEYS=['inbound','returned','faulty','damaged','outbound','balance'];
  const FLOW_KEYS=['inbound','returned','faulty','damaged','outbound'];
  const TYPE_LABELS={all:'전체 유형',inbound:'입고',returned:'반품입고',faulty:'하자입고',damaged:'불량입고',outbound:'출고'};

  function fail(message){throw new Error(message);}
  function hasOnlyKeys(value,expected){
    const keys=Object.keys(value);
    return keys.length===expected.length&&keys.every(key=>expected.includes(key));
  }
  function byteLength(value){
    const json=JSON.stringify(value);
    if(typeof TextEncoder!=='undefined')return new TextEncoder().encode(json).length;
    if(typeof Buffer!=='undefined')return Buffer.byteLength(json,'utf8');
    return unescape(encodeURIComponent(json)).length;
  }
  function currentMs(now){
    const parsed=now===undefined?Date.now():(typeof now==='number'?now:Date.parse(now));
    if(!Number.isFinite(parsed))fail('현재 시각이 올바르지 않습니다.');
    return parsed;
  }
  function isoMs(value,label){
    if(typeof value!=='string'||!value.trim())fail(`${label}이 올바른 ISO 시각이 아닙니다.`);
    const parsed=Date.parse(value);
    if(!Number.isFinite(parsed))fail(`${label}이 올바른 ISO 시각이 아닙니다.`);
    return parsed;
  }
  function dateMs(value,label='날짜'){
    if(typeof value!=='string'||!/^(\d{4})-(\d{2})-(\d{2})$/.test(value))fail(`${label} 형식이 올바르지 않습니다.`);
    const [,year,month,date]=value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const parsed=Date.UTC(Number(year),Number(month)-1,Number(date));
    const canonical=new Date(parsed).toISOString().slice(0,10);
    if(canonical!==value)fail(`${label}가 실제 달력 날짜가 아닙니다.`);
    return parsed;
  }
  function addDays(value,days){return new Date(dateMs(value)+days*86400000).toISOString().slice(0,10);}
  function dateList(from,to){
    const start=dateMs(from),end=dateMs(to);
    if(start>end)return [];
    const result=[];
    for(let ms=start;ms<=end;ms+=86400000)result.push(new Date(ms).toISOString().slice(0,10));
    return result;
  }
  function validateCollectionTime(value,now,allowOld){
    const collected=isoMs(value,'수집 시각'),current=currentMs(now);
    if(!allowOld&&collected<current-MAX_AGE_MS)fail('수집 시각이 24시간보다 오래되었습니다.');
    if(collected>current+MAX_FUTURE_MS)fail('수집 시각이 5분보다 먼 미래입니다.');
    return collected;
  }
  function validateSku(value,label='SKU'){
    if(typeof value!=='string'||!/^\d{1,40}$/.test(value))fail(`${label}가 올바르지 않습니다.`);
  }
  function validateCatalogItem(item,index){
    if(!item||typeof item!=='object'||Array.isArray(item))fail(`${index+1}번째 카탈로그 형식이 올바르지 않습니다.`);
    if(!hasOnlyKeys(item,['sku','name','code','supplier']))fail(`${index+1}번째 카탈로그에 알 수 없는 항목이 있습니다.`);
    validateSku(item.sku,`${index+1}번째 SKU`);
    for(const key of ['name','code','supplier'])if(typeof item[key]!=='string')fail(`${index+1}번째 카탈로그 문자열이 올바르지 않습니다.`);
    if(!item.name.trim()||item.name.length>1000||item.code.length>300||item.supplier.length>500)fail(`${index+1}번째 카탈로그 문자열 길이가 올바르지 않습니다.`);
  }
  function validateDay(item,index,from,to){
    if(!item||typeof item!=='object'||Array.isArray(item))fail(`${index+1}번째 일별 기록 형식이 올바르지 않습니다.`);
    if(!hasOnlyKeys(item,['date',...QUANTITY_KEYS]))fail(`${index+1}번째 일별 기록에 알 수 없는 항목이 있습니다.`);
    const parsed=dateMs(item.date,`${index+1}번째 날짜`);
    if(parsed<dateMs(from)||parsed>dateMs(to))fail(`${index+1}번째 날짜가 수집 기간 밖입니다.`);
    for(const key of QUANTITY_KEYS)if(!Number.isInteger(item[key])||item[key]<-2147483648||item[key]>2147483647)fail(`${index+1}번째 일별 수량이 올바른 정수가 아닙니다.`);
  }
  function validateWindow(from,to){
    const start=dateMs(from,'시작 날짜'),end=dateMs(to,'종료 날짜');
    if(start>end)fail('수집 기간의 시작 날짜가 종료 날짜보다 늦습니다.');
    const count=(end-start)/86400000+1;
    if(count<1||count>31)fail('수집 기간은 1일부터 31일까지여야 합니다.');
  }
  function validateDays(days,from,to,label){
    if(!Array.isArray(days))fail(`${label} 일별 기록이 배열이 아닙니다.`);
    const dates=new Set();
    days.forEach((item,index)=>{
      validateDay(item,index,from,to);
      if(dates.has(item.date))fail(`${label}에 중복 날짜가 있습니다.`);
      dates.add(item.date);
    });
  }
  function validateBatch(value,now){
    if(!value||typeof value!=='object'||Array.isArray(value))fail('입출고 수집 자료 형식이 올바르지 않습니다.');
    if(!hasOnlyKeys(value,['version','source','collected_at','from','to','catalog','products']))fail('입출고 수집 자료에 알 수 없는 항목이 있습니다.');
    if(value.version!==1||value.source!=='wekeep')fail('지원하지 않는 입출고 수집 자료입니다.');
    validateCollectionTime(value.collected_at,now,false);
    validateWindow(value.from,value.to);
    if(!Array.isArray(value.catalog)||value.catalog.length<1||value.catalog.length>10000)fail('카탈로그는 1개부터 10000개까지여야 합니다.');
    const catalogSkus=new Set();
    value.catalog.forEach((item,index)=>{
      validateCatalogItem(item,index);
      if(catalogSkus.has(item.sku))fail('카탈로그 SKU가 중복되었습니다.');
      catalogSkus.add(item.sku);
    });
    if(!Array.isArray(value.products)||value.products.length<1||value.products.length>200)fail('제품 이력은 1개부터 200개까지여야 합니다.');
    const productSkus=new Set();
    value.products.forEach((product,index)=>{
      if(!product||typeof product!=='object'||Array.isArray(product)||!hasOnlyKeys(product,['sku','days']))fail(`${index+1}번째 제품 이력에 알 수 없는 항목이 있습니다.`);
      validateSku(product.sku,`${index+1}번째 제품 SKU`);
      if(productSkus.has(product.sku))fail('제품 이력 SKU가 중복되었습니다.');
      if(!catalogSkus.has(product.sku))fail('제품 이력 SKU가 카탈로그에 없습니다.');
      productSkus.add(product.sku);
      validateDays(product.days,value.from,value.to,`${index+1}번째 제품`);
    });
    if(byteLength(value)>MAX_BYTES)fail('입출고 수집 자료가 4MB 제한을 초과합니다.');
    return value;
  }
  function validateRead(value,now){
    if(!value||typeof value!=='object'||Array.isArray(value)||!hasOnlyKeys(value,['catalog','products','checked_at']))fail('입출고 조회 응답 형식이 올바르지 않습니다.');
    const checked=isoMs(value.checked_at,'서버 확인 시각'),current=currentMs(now);
    if(checked>current+MAX_FUTURE_MS)fail('서버 확인 시각이 미래입니다.');
    if(!Array.isArray(value.catalog)||value.catalog.length>10000)fail('조회 카탈로그가 올바르지 않습니다.');
    const catalogSkus=new Set();
    value.catalog.forEach((item,index)=>{validateCatalogItem(item,index);if(catalogSkus.has(item.sku))fail('조회 카탈로그 SKU가 중복되었습니다.');catalogSkus.add(item.sku);});
    if(!Array.isArray(value.products)||value.products.length>10000)fail('조회 제품 이력이 올바르지 않습니다.');
    const productSkus=new Set();
    value.products.forEach((product,index)=>{
      if(!product||typeof product!=='object'||Array.isArray(product)||!hasOnlyKeys(product,['sku','from','to','collected_at','days']))fail(`${index+1}번째 조회 제품 형식이 올바르지 않습니다.`);
      validateSku(product.sku,`${index+1}번째 조회 제품 SKU`);
      if(productSkus.has(product.sku))fail('조회 제품 SKU가 중복되었습니다.');
      if(!catalogSkus.has(product.sku))fail('조회 제품 SKU가 카탈로그에 없습니다.');
      productSkus.add(product.sku);
      validateWindow(product.from,product.to);
      validateCollectionTime(product.collected_at,current,true);
      validateDays(product.days,product.from,product.to,`${index+1}번째 조회 제품`);
    });
    return value;
  }
  function publicKind(error){
    const code=String(error&&error.code||''),status=Number(error&&error.status||0),message=String(error&&error.message||'').toLowerCase();
    if(code==='PGRST301'||status===401||message.includes('jwt expired'))return 'session-expired';
    if(code==='42883'||code==='PGRST202'||message.includes('could not find the function'))return 'uninstalled';
    return 'failed';
  }
  function deriveStatus(value,now){
    if(value&&value.error)return {kind:publicKind(value.error)};
    try{
      const data=validateRead(value,now);
      if(data.products.length===0)return {kind:'empty',data};
      const current=currentMs(now);
      const stale=data.products.some(product=>current-Date.parse(product.collected_at)>=STALE_MS);
      return {kind:stale?'stale':'ready',data};
    }catch(_error){return {kind:'failed'};}
  }
  function filterHistory(data,filters={}){
    const product=(data&&data.products||[]).find(item=>item.sku===String(filters.sku||''));
    if(!product)return [];
    const from=filters.from||product.from,to=filters.to||product.to,type=filters.type||'all';
    return product.days.filter(item=>item.date>=from&&item.date<=to&&(type==='all'||(FLOW_KEYS.includes(type)&&item[type]!==0))).slice().sort((a,b)=>a.date.localeCompare(b.date));
  }
  function summarizeCoverage(data){return {collected:(data&&data.products||[]).length,total:(data&&data.catalog||[]).length};}
  function summarizeHistory(data,filters={}){
    const product=(data&&data.products||[]).find(item=>item.sku===String(filters.sku||''));
    const rows=filterHistory(data,{...filters,type:'all'});
    const visible=filterHistory(data,filters);
    const totals=FLOW_KEYS.reduce((result,key)=>{result[key]=visible.reduce((sum,item)=>sum+item[key],0);return result;},{});
    const actual=new Set(rows.map(item=>item.date));
    const requested=filters.from&&filters.to?dateList(filters.from,filters.to):[];
    const outsideDates=product?requested.filter(date=>date<product.from||date>product.to):requested;
    const missingDates=product?requested.filter(date=>date>=product.from&&date<=product.to&&!actual.has(date)):[];
    return {totals,recordCount:visible.length,missingDates,outsideDates,rows:visible};
  }
  function matchCatalog(identity,catalog){
    const matches=(catalog||[]).filter(item=>item.name===identity.name&&item.code===identity.code&&item.supplier===identity.supplier);
    if(matches.length===1)return {kind:'matched',sku:matches[0].sku,matches};
    if(matches.length>1)return {kind:'ambiguous',matches};
    return {kind:'missing',matches:[]};
  }
  function escapeHtml(value){return String(value??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');}
  function formatNumber(value){return Number(value).toLocaleString('ko-KR');}
  function formatTime(value){
    try{return new Intl.DateTimeFormat('ko-KR',{dateStyle:'medium',timeStyle:'medium',timeZone:'Asia/Seoul'}).format(new Date(value));}
    catch(_error){return String(value||'-');}
  }
  function kstToday(now){return new Date(currentMs(now)+9*60*60*1000).toISOString().slice(0,10);}
  function defaultFilters(now){const to=kstToday(now);return {sku:'',query:'',from:addDays(to,-29),to,type:'all'};}
  function displayRangeStatus(from,to){
    if(!from||!to)return {valid:false,message:'시작일과 종료일을 모두 선택해 주세요.'};
    let start,end;
    try{start=dateMs(from,'시작일');end=dateMs(to,'종료일');}
    catch(_error){return {valid:false,message:'날짜 형식을 확인해 주세요.'};}
    if(start>end)return {valid:false,message:'시작일은 종료일보다 늦을 수 없습니다.'};
    if((end-start)/86400000+1>31)return {valid:false,message:'조회 기간은 31일 이내로 선택해 주세요.'};
    return {valid:true,message:''};
  }
  function tabBar(){return '<div class="inventory-view-tabs" role="tablist" aria-label="실시간 재고 보기"><button type="button" role="tab" aria-selected="false" data-history-action="current">현재 재고</button><button type="button" role="tab" aria-selected="true">입출고 이력</button></div>';}
  function importPanel(options){
    return `<details class="inventory-import history-import"><summary>입출고 수집 자료 반영</summary><div class="inventory-import-body"><label for="history-payload">입출고 수집 자료</label><textarea id="history-payload" aria-label="입출고 수집 자료" rows="7" spellcheck="false" placeholder="{&quot;version&quot;:1,...}">${escapeHtml(options.payload||'')}</textarea><div class="inventory-import-actions"><button class="btn btn-primary" type="button" data-history-action="save"${options.saving?' disabled':''}>${options.saving?'반영 중…':'입출고 검증 후 반영'}</button><span class="inventory-save-message" role="status">${escapeHtml(options.saveMessage||'')}</span></div></div></details>`;
  }
  function messageState(kind){
    const messages={loading:['입출고 이력을 확인하고 있습니다.','잠시만 기다려 주세요.'],empty:['아직 수집된 입출고 이력이 없습니다.','수집 자료를 검증해 반영하면 제품별 일별 기록을 볼 수 있습니다.'],failed:['입출고 이력을 불러오지 못했습니다.','잠시 후 새로고침해 주세요.'],uninstalled:['입출고 이력 저장소가 아직 설치되지 않았습니다.','운영 준비가 끝난 뒤 다시 확인해 주세요.'],'session-expired':['로그인 세션이 만료되었습니다.','다시 로그인한 뒤 확인해 주세요.']};
    const selected=messages[kind]||messages.failed;
    return `<div class="inventory-state inventory-state-${escapeHtml(kind)}"><strong>${selected[0]}</strong><p>${selected[1]}</p></div>`;
  }
  function productLabel(item){return [item.name,item.code||'(빈 코드)',item.supplier].join(' · ');}
  function mixedWindows(products){
    const groups=new Map();
    products.forEach(item=>{const key=`${item.from} ~ ${item.to}`;groups.set(key,(groups.get(key)||0)+1);});
    return [...groups.entries()];
  }
  function matchBanner(match){
    if(!match||match.kind==='matched')return '';
    if(match.kind==='missing')return '<div class="inventory-stale">현재 재고 행과 이름·관리코드·공급처가 모두 정확히 같은 이력 제품이 없습니다.</div>';
    return `<div class="inventory-stale history-ambiguous"><strong>정확히 같은 제품 후보가 ${match.matches.length}개입니다.</strong> 임의로 연결하지 않았습니다. 확인할 항목을 선택해 주세요.<div class="history-match-list">${match.matches.map((item,index)=>`<button class="btn btn-sm" type="button" data-history-match="${index}">후보 ${index+1} · ${escapeHtml(productLabel(item))} · SKU ${escapeHtml(item.sku)}</button>`).join('')}</div></div>`;
  }
  function renderCharts(rows){
    const maxFlow=Math.max(1,...rows.flatMap(item=>[Math.abs(item.inbound),Math.abs(item.outbound)]));
    const flow=rows.map(item=>`<div class="history-chart-row"><span>${escapeHtml(item.date.slice(5))}</span><span class="history-bar inbound" style="width:${Math.round(Math.abs(item.inbound)/maxFlow*100)}%" title="입고 ${escapeHtml(item.inbound)}"></span><span class="history-chart-value">입고 ${formatNumber(item.inbound)}</span><span class="history-bar outbound" style="width:${Math.round(Math.abs(item.outbound)/maxFlow*100)}%" title="출고 ${escapeHtml(item.outbound)}"></span><span class="history-chart-value">출고 ${formatNumber(item.outbound)}</span></div>`).join('');
    const min=Math.min(...rows.map(item=>item.balance),0),max=Math.max(...rows.map(item=>item.balance),1),span=max-min||1;
    const start=rows.length?dateMs(rows[0].date):0,end=rows.length?dateMs(rows.at(-1).date):0,dateSpan=end-start;
    const plotted=rows.map(item=>({item,x:dateSpan?(dateMs(item.date)-start)/dateSpan*100:50,y:90-(item.balance-min)/span*80}));
    const segments=[];
    plotted.forEach(point=>{
      const previous=segments.at(-1)?.at(-1);
      if(!previous||dateMs(point.item.date)-dateMs(previous.item.date)!==86400000)segments.push([]);
      segments.at(-1).push(point);
    });
    const lines=segments.filter(segment=>segment.length>1).map(segment=>`<polyline points="${segment.map(point=>`${point.x},${point.y}`).join(' ')}" fill="none" stroke="currentColor" stroke-width="2" vector-effect="non-scaling-stroke"></polyline>`).join('');
    const points=plotted.map(point=>`<circle cx="${point.x}" cy="${point.y}" r="2.2" fill="currentColor" role="img" aria-label="${escapeHtml(point.item.date)} 잔고 ${escapeHtml(point.item.balance)}"></circle>`).join('');
    return `<div class="history-charts"><section class="card history-chart" aria-label="입고/출고 추이"><div class="card-hd"><h3>입고/출고 추이</h3></div><div class="history-flow-chart">${flow||'<p class="inventory-muted">표시할 수집 기록이 없습니다.</p>'}</div></section><section class="card history-chart" aria-label="잔고 추이"><div class="card-hd"><h3>잔고 추이</h3></div>${rows.length?`<svg viewBox="0 0 100 100" role="img" aria-label="잔고 추이">${lines}${points}</svg><div class="history-balance-range">${escapeHtml(rows[0].date)} ${formatNumber(rows[0].balance)} → ${escapeHtml(rows.at(-1).date)} ${formatNumber(rows.at(-1).balance)}</div>`:'<p class="inventory-muted">표시할 수집 기록이 없습니다.</p>'}</section></div>`;
  }
  function renderTable(product,summary,filters){
    const byDate=new Map(summary.rows.map(item=>[item.date,item]));
    const dates=filters.type&&filters.type!=='all'?summary.rows.map(item=>item.date):dateList(filters.from,filters.to);
    const body=dates.map(date=>{
      const item=byDate.get(date);
      if(!item&&summary.outsideDates.includes(date))return `<tr class="history-outside"><td>${escapeHtml(date)} 수집 범위 밖</td><td colspan="6">이 제품의 수집 기간에 포함되지 않은 날짜입니다.</td></tr>`;
      if(!item)return `<tr class="history-gap"><td>${escapeHtml(date)} 기록 없음</td><td colspan="6">원본에 수집된 일별 기록이 없습니다.</td></tr>`;
      return `<tr><td>${escapeHtml(item.date)}</td>${QUANTITY_KEYS.map(key=>`<td class="num${item[key]<0?' negative':''}">${formatNumber(item[key])}</td>`).join('')}</tr>`;
    }).join('');
    return `<div class="card inventory-table-card"><div class="tw"><table class="inventory-table history-table" aria-label="일별 입출고 이력"><thead><tr><th>날짜</th><th>입고</th><th>반품입고</th><th>하자입고</th><th>불량입고</th><th>출고</th><th>잔고</th></tr></thead><tbody>${body||'<tr><td colspan="7" class="inventory-no-results">조건에 맞는 수집 기록이 없습니다.</td></tr>'}</tbody></table></div></div>`;
  }
  function render(state,options={}){
    const baseOptions={...defaultFilters(options.now),...options};
    let kind=state&&state.kind||'failed',failureBanner='';
    if(['loading','failed'].includes(kind)&&state&&state.previous&&['ready','stale'].includes(state.previous.kind)){
      failureBanner=kind==='failed'?'<div class="inventory-stale history-read-failed"><strong>확인 실패</strong> · 아래 내용은 마지막 확인 성공 자료입니다.</div>':'<div class="inventory-checking">새 자료 확인 중 · 아래 내용은 마지막 확인 성공 자료입니다.</div>';
      state=state.previous;kind=state.kind;
    }
    const toolbar=`<div class="inventory-toolbar"><button class="btn" type="button" data-history-action="refresh"><i class="ti ti-refresh"></i> 새로고침</button></div>`;
    if(!['ready','stale'].includes(kind))return `<div class="inventory-page history-page">${tabBar()}${toolbar}${messageState(kind)}${kind==='session-expired'?'':importPanel(baseOptions)}</div>`;
    const data=state.data,coverage=summarizeCoverage(data);
    const query=String(baseOptions.query||'').toLocaleLowerCase('ko');
    const choices=data.catalog.filter(item=>!query||[item.name,item.code,item.supplier].some(value=>value.toLocaleLowerCase('ko').includes(query)));
    const product=data.products.find(item=>item.sku===String(baseOptions.sku||''));
    const catalogItem=data.catalog.find(item=>item.sku===String(baseOptions.sku||''));
    const windows=mixedWindows(data.products);
    const collectionTimes=data.products.map(item=>item.collected_at).sort();
    const latest=collectionTimes.at(-1)||'-',oldest=collectionTimes[0]||'-';
    const status=kind==='stale'?'<div class="inventory-stale"><strong>수집 지연</strong> · 일부 제품의 마지막 수집 후 3시간 이상 지났습니다.</div>':(failureBanner?'':'<div class="inventory-fresh"><strong>상태 최신</strong> · 수집 제품의 마지막 반영이 3시간 이내입니다.</div>');
    let detail='<div class="inventory-state"><strong>제품을 선택하면 일별 추이와 기록을 확인할 수 있습니다.</strong><p>검색하거나 제품 목록에서 선택해 주세요.</p></div>';
    if(product&&catalogItem){
      const rangeStatus=displayRangeStatus(baseOptions.from,baseOptions.to);
      if(!rangeStatus.valid)detail=`<div class="inventory-state history-filter-error" role="alert"><strong>조회 기간을 확인해 주세요.</strong><p>${escapeHtml(rangeStatus.message)}</p></div>`;
      else{
        const summary=summarizeHistory(data,baseOptions);
        const totals=FLOW_KEYS.map(key=>`<div class="kpi"><div class="lbl">${TYPE_LABELS[key]}</div><div class="val${summary.totals[key]<0?' negative':''}">${formatNumber(summary.totals[key])}</div></div>`).join('');
        const missing=summary.missingDates.length?`<details class="history-gaps"><summary>기록 없는 날짜 ${summary.missingDates.length}일</summary><ul>${summary.missingDates.map(date=>`<li>${escapeHtml(date)} 기록 없음</li>`).join('')}</ul></details>`:'<div class="inventory-fresh">수집 범위 안에 날짜 공백이 없습니다.</div>';
        const outside=summary.outsideDates.length?`<div class="inventory-checking">선택 기간 중 ${summary.outsideDates.length.toLocaleString('ko-KR')}일은 이 제품의 수집 범위 밖입니다.</div>`:'';
        detail=`<div class="history-product-heading"><strong>${escapeHtml(productLabel(catalogItem))}</strong><span>수집 범위 ${escapeHtml(product.from)} ~ ${escapeHtml(product.to)} · 수집 ${escapeHtml(formatTime(product.collected_at))}</span></div><div class="history-summary-title">수집된 기록 합계 · ${summary.recordCount.toLocaleString('ko-KR')}건</div><div class="inventory-kpis history-kpis">${totals}</div>${outside}${missing}${renderCharts(filterHistory(data,{...baseOptions,type:'all'}))}${renderTable(product,summary,baseOptions)}`;
      }
    }
    return `<div class="inventory-page history-page">${tabBar()}${toolbar}${matchBanner(baseOptions.match)}${failureBanner}${status}<div class="inventory-meta"><span><strong>수집 범위</strong> ${coverage.collected} / 전체 ${coverage.total}개 제품</span><span><strong>최근 수집</strong> ${escapeHtml(formatTime(latest))}</span>${oldest!==latest?`<span><strong>가장 오래된 수집</strong> ${escapeHtml(formatTime(oldest))}</span>`:''}<span><strong>${windows.length>1?'혼합 수집 범위':'수집 기간'}</strong> ${windows.map(([window,count])=>`${escapeHtml(window)} (${count}개)`).join(', ')||'-'}</span><span><strong>서버 확인</strong> ${escapeHtml(formatTime(data.checked_at))}</span><span>입출고 이력 순환 수집 · 전체 약 2시간</span></div><div class="history-filters"><label>제품 검색<input id="history-product-search" type="search" value="${escapeHtml(baseOptions.query)}" placeholder="제품명 · 관리코드 · 공급처"></label><label>제품<select id="history-product"><option value="">제품 선택</option>${choices.map(item=>`<option value="${escapeHtml(item.sku)}"${item.sku===String(baseOptions.sku)?' selected':''}>${escapeHtml(productLabel(item))}</option>`).join('')}</select></label><label>시작일<input id="history-from" type="date" value="${escapeHtml(baseOptions.from)}"></label><label>종료일<input id="history-to" type="date" value="${escapeHtml(baseOptions.to)}"></label><label>유형<select id="history-type">${Object.entries(TYPE_LABELS).map(([value,label])=>`<option value="${value}"${value===baseOptions.type?' selected':''}>${label}</option>`).join('')}</select></label></div>${detail}${importPanel(baseOptions)}</div>`;
  }
  function timed(operation,timeoutMs,schedule,cancel){
    let timer=null,rejectDeadline,settled=false;
    const deadline=new Promise((resolve,reject)=>{rejectDeadline=reject;timer=schedule(()=>{const error=new Error('request deadline');error.code='HISTORY_TIMEOUT';reject(error);},timeoutMs);});
    const work=Promise.resolve().then(operation);
    const promise=Promise.race([work,deadline]).finally(()=>{settled=true;if(timer!==null){cancel(timer);timer=null;}});
    return {promise,cancel(){if(settled)return;if(timer!==null){cancel(timer);timer=null;}const error=new Error('request cancelled');error.code='HISTORY_CANCELLED';rejectDeadline(error);}};
  }
  function createController(options){
    const read=options.read,paint=options.render,getNow=options.now||(()=>Date.now()),schedule=options.setTimeout||setTimeout,cancel=options.clearTimeout||clearTimeout;
    const timeoutMs=Number.isFinite(options.timeoutMs)&&options.timeoutMs>0?options.timeoutMs:DEFAULT_TIMEOUT_MS;
    let active=false,generation=0,poll=null,inFlight=null,lastGood=null;
    function clearPoll(){if(poll!==null){cancel(poll);poll=null;}}
    function queue(gen){if(!active||gen!==generation)return;clearPoll();poll=schedule(()=>{poll=null;refresh();},60000);}
    function refresh(force){
      if(!active)return Promise.resolve();
      if(force){generation++;clearPoll();if(inFlight)inFlight.cancel();inFlight=null;}
      const gen=generation;
      if(inFlight&&inFlight.generation===gen)return inFlight.promise;
      paint(lastGood?{kind:'loading',previous:deriveStatus(lastGood.data,getNow())}:{kind:'loading'});
      const bounded=timed(read,timeoutMs,schedule,cancel);
      const promise=bounded.promise.then(result=>{
        if(!active||gen!==generation)return {kind:'cancelled'};
        const next=deriveStatus(result,getNow());
        if(['ready','stale'].includes(next.kind))lastGood=next;
        if(next.kind==='empty')lastGood=null;
        const painted=next.kind==='failed'&&lastGood?{kind:'failed',previous:deriveStatus(lastGood.data,getNow())}:next;
        paint(painted);
        return next;
      }).catch(error=>{
        if(!active||gen!==generation)return {kind:'cancelled'};
        const kind=publicKind(error),failed=lastGood?{kind,previous:deriveStatus(lastGood.data,getNow())}:{kind};
        paint(failed);
        return failed;
      }).finally(()=>{if(inFlight&&inFlight.promise===promise)inFlight=null;queue(gen);});
      inFlight={generation:gen,promise,cancel:bounded.cancel};return promise;
    }
    function show(){active=true;generation++;clearPoll();return refresh();}
    function hide(){active=false;generation++;clearPoll();if(inFlight)inFlight.cancel();inFlight=null;lastGood=null;}
    return {show,hide,refresh};
  }
  function validateSaveResult(result,batch){
    const dayCount=batch.products.reduce((sum,item)=>sum+item.days.length,0);
    if(!result||result.saved!==true||result.collected_at!==batch.collected_at||result.product_count!==batch.products.length||result.day_count!==dayCount)fail('저장 확인 응답이 일치하지 않습니다.');
    return result;
  }
  function equalDays(left,right){
    if(left.length!==right.length)return false;
    const leftSorted=left.slice().sort((a,b)=>a.date.localeCompare(b.date));
    const rightSorted=right.slice().sort((a,b)=>a.date.localeCompare(b.date));
    return leftSorted.every((item,index)=>['date',...QUANTITY_KEYS].every(key=>item[key]===rightSorted[index][key]));
  }
  function confirmsBatch(data,batch){
    try{validateRead(data,Date.now()+MAX_FUTURE_MS);}catch(_error){return false;}
    const catalog=new Map(data.catalog.map(item=>[item.sku,item]));
    if(!batch.catalog.every(item=>{const found=catalog.get(item.sku);return found&&['name','code','supplier'].every(key=>found[key]===item[key]);}))return false;
    return batch.products.every(item=>{const found=data.products.find(product=>product.sku===item.sku);return found&&found.from===batch.from&&found.to===batch.to&&found.collected_at===batch.collected_at&&equalDays(found.days,item.days);});
  }
  function mount(options){
    const doc=options.document,host=doc.getElementById('content'),actions=doc.getElementById('topbar-actions');
    const schedule=options.setTimeout||setTimeout,cancel=options.clearTimeout||clearTimeout;
    const timeoutMs=Number.isFinite(options.timeoutMs)&&options.timeoutMs>0?options.timeoutMs:DEFAULT_TIMEOUT_MS;
    let state={kind:'loading'},filters=defaultFilters(),payload='',saveMessage='',saving=false,active=false,lifecycle=0,pendingWrite=null,pendingIdentity=null,match=null;
    const controller=createController({read:options.read,render:next=>{state=next;applyPendingMatch();paint();},timeoutMs,setTimeout:schedule,clearTimeout:cancel});
    function data(){return state&&state.data||(state&&state.previous&&state.previous.data)||null;}
    function applyPendingMatch(){
      const current=data();if(!pendingIdentity||!current)return;
      match=matchCatalog(pendingIdentity,current.catalog);
      if(match.kind==='matched'){filters.sku=match.sku;match=null;pendingIdentity=null;}
    }
    function paint(){
      if(!active)return;
      const open=!!host.querySelector&&!!host.querySelector('.history-import[open]');
      const focused=doc.activeElement&&['history-product-search','history-payload'].includes(doc.activeElement.id)?{id:doc.activeElement.id,start:doc.activeElement.selectionStart,end:doc.activeElement.selectionEnd}:null;
      host.innerHTML=render(state,{...filters,payload,saveMessage,saving,match});
      if(open){const details=host.querySelector&&host.querySelector('.history-import');if(details)details.open=true;}
      if(focused){const next=doc.getElementById(focused.id);if(next&&next.focus){next.focus();if(next.setSelectionRange&&Number.isInteger(focused.start))next.setSelectionRange(focused.start,Number.isInteger(focused.end)?focused.end:focused.start);}}
      if(actions)actions.innerHTML='';
    }
    async function readbackConfirms(checked){
      const fresh=await controller.refresh(true);
      return active&&fresh&&['ready','stale'].includes(fresh.kind)&&confirmsBatch(fresh.data,checked);
    }
    async function save(){
      if(!active||saving||typeof options.write!=='function')return;
      const saveLifecycle=lifecycle;let saveRequest=null,checked=null;
      try{
        checked=validateBatch(JSON.parse(payload));saving=true;saveMessage='검증 후 반영 중…';paint();
        const bounded=timed(()=>options.write(checked),timeoutMs,schedule,cancel);saveRequest=bounded;pendingWrite=bounded;
        const ack=await bounded.promise;
        if(!active||saveLifecycle!==lifecycle)return;
        validateSaveResult(ack,checked);
        const confirmed=await readbackConfirms(checked);
        if(!active||saveLifecycle!==lifecycle)return;
        if(confirmed){payload='';saveMessage=`${checked.products.length.toLocaleString('ko-KR')}개 제품 · ${ack.day_count.toLocaleString('ko-KR')}건 반영 완료`;}
        else saveMessage='저장 응답은 확인했지만 최신 자료 재조회가 일치하지 않습니다. 저장 여부 확인 필요';
      }catch(error){
        if(!active||saveLifecycle!==lifecycle)return;
        if(error&&error.code==='HISTORY_TIMEOUT'){
          saveMessage='저장 응답이 지연되었습니다. 저장 여부 확인 필요 · 자동 재전송하지 않았습니다.';
          const confirmed=checked&&await readbackConfirms(checked);
          if(!active||saveLifecycle!==lifecycle)return;
          if(confirmed){payload='';saveMessage=`${checked.products.length.toLocaleString('ko-KR')}개 제품 저장 확인 완료`}
        }else if(error instanceof SyntaxError)saveMessage='JSON 형식을 확인해 주세요.';
        else if(error&&/^(입출고|지원하지|수집|카탈로그|제품|\d+번째)/.test(error.message))saveMessage=error.message;
        else saveMessage='입출고 자료를 반영하지 못했습니다. 다시 로그인하거나 잠시 후 시도해 주세요.';
      }finally{if(pendingWrite===saveRequest)pendingWrite=null;if(active&&saveLifecycle===lifecycle){saving=false;paint();}}
    }
    host.addEventListener('click',event=>{
      const matchButton=event.target.closest&&event.target.closest('[data-history-match]');
      if(matchButton&&match&&match.kind==='ambiguous'){
        const selected=match.matches[Number(matchButton.dataset.historyMatch)];if(selected){filters.sku=selected.sku;match=null;pendingIdentity=null;paint();}return;
      }
      const button=event.target.closest&&event.target.closest('[data-history-action]');if(!button)return;
      if(button.dataset.historyAction==='refresh')controller.refresh(true);
      if(button.dataset.historyAction==='save')save();
      if(button.dataset.historyAction==='current'&&typeof options.onCurrent==='function')options.onCurrent();
    });
    host.addEventListener('input',event=>{
      if(!event.target)return;
      if(event.target.id==='history-payload')payload=event.target.value;
      if(event.target.id==='history-product-search'){filters.query=event.target.value;paint();}
    });
    host.addEventListener('change',event=>{
      const map={'history-product':'sku','history-from':'from','history-to':'to','history-type':'type'};
      const key=event.target&&map[event.target.id];if(!key)return;filters[key]=event.target.value;match=null;pendingIdentity=null;paint();
    });
    return {
      show(){active=true;lifecycle++;filters=defaultFilters();payload='';saveMessage='';saving=false;match=null;return controller.show();},
      hide(){active=false;lifecycle++;if(pendingWrite)pendingWrite.cancel();pendingWrite=null;controller.hide();filters=defaultFilters();payload='';saveMessage='';saving=false;state={kind:'loading'};pendingIdentity=null;match=null;},
      refresh:controller.refresh,
      openProduct(identity){pendingIdentity={name:String(identity.name??''),code:String(identity.code??''),supplier:String(identity.supplier??'')};match=null;if(!active)return this.show();applyPendingMatch();paint();return Promise.resolve();}
    };
  }

  return {validateBatch,validateRead,filterHistory,summarizeCoverage,summarizeHistory,matchCatalog,deriveStatus,defaultFilters,displayRangeStatus,render,createController,validateSaveResult,confirmsBatch,mount};
});
