(function(root,factory){
  const api=factory(typeof module==='object'&&module.exports?require('./inventory-history.js'):root.InventoryHistory);
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.InventoryMonthly=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(history){
  'use strict';
  const FLOWS=['inbound','returned','faulty','damaged','outbound'];
  const LABELS=['입고','반품입고','하자입고','불량입고','출고'];
  const esc=value=>String(value??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  const number=value=>value===null?'—':value.toLocaleString('ko-KR');
  const kstToday=now=>new Date((now===undefined?Date.now():Number(now))+9*3600000).toISOString().slice(0,10);
  const fail=()=>{throw new Error('월별 이력 조회 응답이 올바르지 않습니다.');};
  function date(value){
    if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))fail();
    const ms=Date.parse(value+'T00:00:00Z');
    if(!Number.isFinite(ms)||new Date(ms).toISOString().slice(0,10)!==value)fail();
    return value;
  }
  function monthPeriod(year,month,today){
    const start=`${year}-${String(month).padStart(2,'0')}-01`;
    const end=new Date(Date.UTC(year,month,0)).toISOString().slice(0,10);
    const expectedEnd=end<today?end:today;
    return {expectedEnd:start>today?null:expectedEnd,days:start>today?0:Number(expectedEnd.slice(8)),period:start>today?'future':end>=today?'current':'past'};
  }
  function validateAnnual(value){
    if(!value||typeof value!=='object'||Array.isArray(value))fail();
    date(value.today);
    if(!Number.isInteger(value.year)||value.year<2000||value.year>Number(value.today.slice(0,4)))fail();
    // Reuse the original catalog and server timestamp validation without window data.
    history.validateRead({catalog:value.catalog,products:[],checked_at:value.checked_at});
    if(!Array.isArray(value.months)||value.months.length>value.catalog.length*12)fail();
    const skus=new Set(value.catalog.map(item=>item.sku)),seen=new Set();
    for(const row of value.months){
      if(!row||!skus.has(row.sku)||!Number.isInteger(row.month)||row.month<1||row.month>12)fail();
      const key=`${row.sku}:${row.month}`;if(seen.has(key))fail();seen.add(key);
      const period=monthPeriod(value.year,row.month,value.today);
      if(!Number.isInteger(row.covered_days)||row.covered_days<1||row.covered_days>period.days||!Number.isInteger(row.record_days)||row.record_days<0||row.record_days>row.covered_days)fail();
      for(const flow of FLOWS)if(row.record_days===0?row[flow]!==null:!Number.isSafeInteger(row[flow]))fail();
      if(row.balance===null){if(row.balance_date!==null)fail();}
      else if(!row.record_days||!Number.isSafeInteger(row.balance)||row.balance_date!==period.expectedEnd)fail();
      if(typeof row.oldest_collected_at!=='string'||typeof row.last_collected_at!=='string'||!Number.isFinite(Date.parse(row.oldest_collected_at))||!Number.isFinite(Date.parse(row.last_collected_at))||Date.parse(row.oldest_collected_at)>Date.parse(row.last_collected_at)||Date.parse(row.last_collected_at)>Date.parse(value.checked_at)+5*60000)fail();
    }
    return value;
  }
  function sum(rows,key){
    const values=rows.map(row=>row[key]).filter(value=>value!==null);
    if(!values.length)return null;
    const total=values.reduce((total,value)=>total+BigInt(value),0n);
    if(total>BigInt(Number.MAX_SAFE_INTEGER)||total<BigInt(Number.MIN_SAFE_INTEGER))fail();
    return Number(total);
  }
  function summarizeMonthly(data,sku=''){
    validateAnnual(data);
    const catalog=data.catalog.filter(item=>!sku||item.sku===sku),selected=new Set(catalog.map(item=>item.sku));
    return Array.from({length:12},(_,index)=>{
      const month=index+1,period=monthPeriod(data.year,month,data.today);
      const rows=data.months.filter(item=>item.month===month&&selected.has(item.sku));
      const covered=rows.reduce((n,row)=>n+row.covered_days,0),records=rows.reduce((n,row)=>n+row.record_days,0),expected=period.days*catalog.length;
      const balanceKnown=catalog.length>0&&rows.length===catalog.length&&rows.every(row=>row.balance!==null&&row.balance_date===period.expectedEnd);
      return {month,period:period.period,expected_days:expected,covered_days:covered,record_days:records,
        status:period.period==='future'?'future':!catalog.length?'empty':!covered?'unqueried':!records?'no-record':records<expected?'partial':'complete',
        ...Object.fromEntries(FLOWS.map(key=>[key,sum(rows,key)])),balance:balanceKnown?sum(rows,'balance'):null,balance_date:balanceKnown?period.expectedEnd:null};
    });
  }
  function statusLabel(row){return {future:'예정',empty:'제품 없음',unqueried:'미수집','no-record':'조회됨 · 원본 기록 없음',partial:'부분 · 기록 소계',complete:'기록 합계'}[row.status];}
  function charts(rows){
    const scale=Math.max(1,...rows.flatMap(row=>[Math.abs(row.inbound||0),Math.abs(row.outbound||0)]));
    const flow=rows.map(row=>`<div class="history-chart-row"><span>${row.month}월</span><span class="history-bar inbound" style="width:${Math.abs(row.inbound||0)/scale*100}%" aria-hidden="true"></span><span class="history-chart-value">${number(row.inbound)}</span><span class="history-bar outbound" style="width:${Math.abs(row.outbound||0)/scale*100}%" aria-hidden="true"></span><span class="history-chart-value">${number(row.outbound)}</span></div>`).join('');
    const values=rows.filter(row=>row.balance!==null),min=Math.min(0,...values.map(row=>row.balance)),max=Math.max(1,...values.map(row=>row.balance)),span=max-min;
    const points=values.map(row=>({x:5+(row.month-1)*90/11,y:90-(row.balance-min)/span*75,row}));
    const lines=points.map((point,index)=>{const prev=points[index-1];return prev&&prev.row.month+1===point.row.month?`<line x1="${prev.x}" y1="${prev.y}" x2="${point.x}" y2="${point.y}" stroke="currentColor" stroke-width="1"/>`:'';}).join('');
    return `<div class="history-charts"><section class="card history-chart"><div class="card-hd"><h3>월별 입고 / 출고</h3><span class="inventory-muted">입고 · 출고 순 / 부호 유지</span></div><div class="history-flow-chart">${flow}</div></section><section class="card history-chart"><div class="card-hd"><h3>월말 잔고 · 이번 달 최신 기준</h3></div><svg viewBox="0 0 100 100" role="img" aria-label="1월부터 12월까지 월별 잔고. 미확인 월은 연결하지 않습니다.">${lines}${points.map(point=>`<circle cx="${point.x}" cy="${point.y}" r="1.8" fill="currentColor"><title>${esc(point.row.balance_date)} 잔고 ${number(point.row.balance)}</title></circle>`).join('')}${rows.map(row=>`<text x="${5+(row.month-1)*90/11}" y="99" text-anchor="middle" font-size="3" fill="currentColor">${row.month}</text>`).join('')}</svg><div class="history-balance-range">${values.length?'확인된 기준일 잔고만 표시':'확인된 기준일 잔고 없음'} · — 미확인</div></section></div>`;
  }
  function render(state,options={}){
    const year=Number(options.year)||Number(kstToday().slice(0,4)),data=state.kind==='ready'?state.data:null;
    const maxYear=Number((data?.today||kstToday()).slice(0,4));
    const catalog=data?.catalog||[],query=String(options.query||'').toLocaleLowerCase();
    const filtered=catalog.filter(item=>item.sku===options.sku||[item.name,item.code,item.supplier,item.sku].join(' ').toLocaleLowerCase().includes(query));
    const years=Array.from({length:maxYear-1999},(_,i)=>maxYear-i);
    const controls=`<div class="history-filters monthly-filters"><label>연도<select id="monthly-year">${years.map(item=>`<option value="${item}"${item===year?' selected':''}>${item}년</option>`).join('')}</select></label><label>제품 검색<input id="monthly-search" value="${esc(options.query||'')}" placeholder="제품명 · 코드 · 공급처 · SKU"/></label><label>제품<select id="monthly-product"><option value="">전체 제품 (${catalog.length})</option>${filtered.map(item=>`<option value="${esc(item.sku)}"${item.sku===options.sku?' selected':''}>${esc([item.name,item.code||'(빈 코드)',item.supplier,`SKU ${item.sku}`].join(' · '))}</option>`).join('')}</select></label></div>`;
    const match=options.match;
    const banner=match&&match.kind!=='matched'?`<div class="inventory-stale">${match.kind==='missing'?'이름·관리코드·공급처가 모두 일치하는 보관 제품이 없습니다.':'같은 제품 후보가 여러 개입니다. 확인할 제품을 선택해 주세요.'}${match.matches.map((item,index)=>`<button type="button" class="btn btn-sm" data-monthly-match="${index}">후보 ${index+1} · ${esc(item.name)} · SKU ${esc(item.sku)}</button>`).join('')}</div>`:'';
    let body='';
    if(data){
      const rows=summarizeMonthly(data,options.sku||'');
      body=`<div class="inventory-muted">보관된 제품 목록 기준으로 수집 범위를 계산합니다. 연초 이전부터 존재한 제품 수를 뜻하지 않습니다. 서버 확인 ${esc(data.checked_at)} · 미수집·원본 기록 없음은 0으로 계산하지 않습니다.</div>${charts(rows)}<section class="card monthly-table"><div class="card-hd"><h3>월별 입출고 통계</h3></div><div class="table-wrap"><table aria-label="월별 입출고 이력"><thead><tr><th>월</th>${LABELS.map(label=>`<th>${label}</th>`).join('')}<th>잔고</th><th>수집 범위 / 원본 기록</th><th>집계 상태</th></tr></thead><tbody>${rows.map(row=>`<tr data-month="${row.month}"><td>${row.month}월${row.period==='current'?'<small>진행 중</small>':''}</td>${[...FLOWS,'balance'].map(key=>`<td class="num${row[key]<0?' negative':''}">${number(row[key])}${key==='balance'&&row.balance_date?`<small>${esc(row.balance_date)}${row.period==='current'?' 최신 기준':' 월말'}</small>`:''}</td>`).join('')}<td>${row.covered_days} / ${row.expected_days} 제품·일<small>기록 ${row.record_days}일 · 원본 없음 ${row.covered_days-row.record_days}일</small></td><td>${statusLabel(row)}</td></tr>`).join('')}</tbody></table></div></section>`;
    }else body=`<div class="inventory-state"><strong>${state.kind==='loading'?'월별 이력을 확인하고 있습니다.':state.kind==='session-expired'?'로그인 세션이 만료되었습니다.':state.kind==='uninstalled'?'연간 이력 저장소가 아직 설치되지 않았습니다.':'월별 이력을 불러오지 못했습니다.'}</strong><p>조회할 연도를 선택하거나 새로고침해 주세요.</p></div>`;
    return `<div class="inventory-live inventory-monthly"><div class="inventory-view-tabs" role="tablist" aria-label="실시간 재고 보기"><button type="button" data-monthly-action="current" role="tab" aria-selected="false">현재 재고</button><button type="button" role="tab" aria-selected="true">입출고 이력</button></div><div class="history-product-heading"><strong>${year}년 월별 입출고</strong><button type="button" class="btn btn-sm" data-monthly-action="refresh">새로고침</button></div>${controls}${banner}${body}<details class="inventory-import monthly-import"><summary>입출고 수집 자료 반영</summary><div class="inventory-import-body"><label for="monthly-payload">입출고 수집 자료 (최대 31일)</label><textarea id="monthly-payload" aria-label="입출고 수집 자료" rows="7" spellcheck="false">${esc(options.payload||'')}</textarea><div class="inventory-import-actions"><button class="btn btn-primary" type="button" data-monthly-action="save"${options.saving?' disabled':''}>${options.saving?'반영 중…':'입출고 검증 후 반영'}</button><span role="status">${esc(options.saveMessage||'')}</span></div></div></details></div>`;
  }
  function mount(options){
    const doc=options.document,host=doc.getElementById('content'),actions=doc.getElementById('topbar-actions');
    const schedule=options.setTimeout||setTimeout,cancel=options.clearTimeout||clearTimeout,now=options.now||Date.now;
    const timeout=Number.isFinite(options.timeoutMs)&&options.timeoutMs>0?options.timeoutMs:15000;
    let active=false,lifecycle=0,readId=0,poll=null,pendingRead=null,state={kind:'loading'},year=Number(kstToday(now()).slice(0,4)),sku='',query='',payload='',saveMessage='',saving=false,pendingIdentity=null,match=null;
    const jobs=new Set();
    function bounded(fn){
      let timer,rejectPromise,settled=false;
      const job={cancel(){if(!settled){settled=true;cancel(timer);jobs.delete(job);rejectPromise(new Error('cancelled'));}}};
      job.promise=new Promise((resolve,reject)=>{
        rejectPromise=reject;
        const finish=(method,value)=>{if(settled)return;settled=true;cancel(timer);jobs.delete(job);method(value);};
        timer=schedule(()=>finish(reject,new Error('timeout')),timeout);
        Promise.resolve().then(fn).then(value=>finish(resolve,value),error=>finish(reject,error));
      });jobs.add(job);return job;
    }
    function paint(){
      if(!active)return;
      const opened=!!host.querySelector?.('.monthly-import[open]'),focused=doc.activeElement;
      const focus=focused&&['monthly-search','monthly-payload'].includes(focused.id)?{id:focused.id,start:focused.selectionStart,end:focused.selectionEnd}:null;
      host.innerHTML=render(state,{year,sku,query,payload,saveMessage,saving,match});if(actions)actions.innerHTML='';
      if(opened){const details=host.querySelector?.('.monthly-import');if(details)details.open=true;}
      if(focus){const node=doc.getElementById(focus.id);node?.focus?.();if(Number.isInteger(focus.start))node?.setSelectionRange?.(focus.start,focus.end);}
    }
    function applyMatch(){
      if(!pendingIdentity||!state.data)return;
      match=history.matchCatalog(pendingIdentity,state.data.catalog);
      if(match.kind==='matched'){sku=match.sku;pendingIdentity=null;match=null;}
    }
    async function refresh(){
      if(!active)return;
      const id=++readId,epoch=lifecycle,requestedYear=year;
      if(poll!==null){cancel(poll);poll=null;}pendingRead?.cancel();
      const request=bounded(()=>options.read(requestedYear));pendingRead=request;state={kind:'loading'};paint();
      try{
        const data=validateAnnual(await request.promise);
        if(!active||epoch!==lifecycle||id!==readId)return;
        if(data.year!==requestedYear)fail();state={kind:'ready',data};applyMatch();
      }catch(error){
        if(!active||epoch!==lifecycle||id!==readId)return;
        state={kind:history.deriveStatus({error}).kind};
      }finally{
        if(pendingRead===request)pendingRead=null;
        if(active&&epoch===lifecycle&&id===readId){paint();poll=schedule(()=>{poll=null;refresh();},60000);}
      }
    }
    async function save(){
      if(!active||saving)return;
      let batch;try{batch=history.validateBatch(JSON.parse(payload));}catch(error){saveMessage=error instanceof SyntaxError?'JSON 형식을 확인해 주세요.':error.message;paint();return;}
      const epoch=lifecycle;saving=true;saveMessage='검증 후 반영 중…';paint();
      const current=()=>active&&lifecycle===epoch;
      try{
        let ackValid=false;
        try{const ack=await bounded(()=>options.write(batch)).promise;if(!current())return;history.validateSaveResult(ack,batch);ackValid=true;}catch(_error){if(!current())return;}
        // Even a timed-out write may have committed. Read the original window RPC once,
        // bounded separately, without retrying or trusting annual aggregate totals.
        let confirmed=false;
        try{const readback=await bounded(()=>options.verify(batch)).promise;if(!current())return;confirmed=history.confirmsBatch(readback,batch);}catch(_error){if(!current())return;}
        if(confirmed){payload='';saveMessage=ackValid?'반영 완료 · 원본 저장 자료 확인':'저장 확인 완료 · 원본 저장 자료 확인';}
        else saveMessage='저장 여부 확인 필요 · 원본 재조회가 일치하지 않거나 응답이 지연되었습니다. 자동 재전송하지 않았습니다.';
        if(current())await refresh();
      }finally{if(current()){saving=false;paint();}}
    }
    host.addEventListener('click',event=>{
      if(!active)return;
      const candidate=event.target.closest?.('[data-monthly-match]');
      if(candidate&&match?.kind==='ambiguous'){const item=match.matches[Number(candidate.dataset.monthlyMatch)];if(item){sku=item.sku;match=null;pendingIdentity=null;paint();}return;}
      const action=event.target.closest?.('[data-monthly-action]')?.dataset.monthlyAction;
      if(action==='refresh')refresh();if(action==='save')save();if(action==='current')options.onCurrent?.();
    });
    host.addEventListener('input',event=>{
      if(!active)return;if(event.target.id==='monthly-payload')payload=event.target.value;
      if(event.target.id==='monthly-search'){query=event.target.value;paint();}
    });
    host.addEventListener('change',event=>{
      if(!active)return;
      if(event.target.id==='monthly-year'){const next=Number(event.target.value);if(Number.isInteger(next)&&next>=2000&&next<=Number(kstToday(now()).slice(0,4))){year=next;refresh();}}
      if(event.target.id==='monthly-product'){sku=event.target.value;pendingIdentity=null;match=null;paint();}
    });
    return {
      show(){if(active)return refresh();active=true;lifecycle++;return refresh();},
      hide(){active=false;lifecycle++;readId++;if(poll!==null)cancel(poll);poll=null;for(const job of [...jobs])job.cancel();pendingRead=null;state={kind:'loading'};saving=false;payload='';saveMessage='';sku='';query='';match=null;pendingIdentity=null;year=Number(kstToday(now()).slice(0,4));},
      refresh,save,
      openProduct(identity){pendingIdentity={name:String(identity.name??''),code:String(identity.code??''),supplier:String(identity.supplier??'')};if(!active)return this.show();applyMatch();paint();return Promise.resolve();}
    };
  }
  return {validateAnnual,summarizeMonthly,render,mount,monthPeriod};
});
