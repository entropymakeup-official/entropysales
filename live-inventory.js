(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.LiveInventory=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';

  const MAX_ROWS=10000;
  const MAX_BYTES=4*1024*1024;
  const MAX_AGE_MS=24*60*60*1000;
  const MAX_FUTURE_MS=5*60*1000;
  const STALE_MS=15*60*1000;
  const DEFAULT_TIMEOUT_MS=15000;

  function fail(message){throw new Error(message);}
  function timeMs(value,label){
    if(typeof value!=='string'||!value.trim())fail(label+'이 올바른 ISO 시각이 아닙니다.');
    const result=Date.parse(value);
    if(!Number.isFinite(result))fail(label+'이 올바른 ISO 시각이 아닙니다.');
    return result;
  }
  function nowMs(now){
    const result=now===undefined?Date.now():(typeof now==='number'?now:Date.parse(now));
    if(!Number.isFinite(result))fail('현재 시각이 올바르지 않습니다.');
    return result;
  }
  function byteLength(value){
    const json=JSON.stringify(value);
    if(typeof TextEncoder!=='undefined')return new TextEncoder().encode(json).length;
    if(typeof Buffer!=='undefined')return Buffer.byteLength(json,'utf8');
    return unescape(encodeURIComponent(json)).length;
  }
  function hasOnlyKeys(value,expected){
    const keys=Object.keys(value);
    return keys.length===expected.length&&keys.every(key=>expected.includes(key));
  }
  function validateSnapshot(value,now,allowOld){
    if(!value||typeof value!=='object'||Array.isArray(value))fail('스냅샷 형식이 올바르지 않습니다.');
    if(value.version!==1||value.source!=='wekeep')fail('지원하지 않는 스냅샷입니다.');
    if(!hasOnlyKeys(value,['version','source','collected_at','expected_count','rows']))fail('스냅샷에 알 수 없는 항목이 있습니다.');
    const collected=timeMs(value.collected_at,'수집 시각');
    const current=nowMs(now);
    if(!allowOld&&collected<current-MAX_AGE_MS)fail('수집 시각이 24시간보다 오래되었습니다.');
    if(collected>current+MAX_FUTURE_MS)fail('수집 시각이 5분보다 먼 미래입니다.');
    if(!Number.isInteger(value.expected_count)||value.expected_count<1||value.expected_count>MAX_ROWS)fail('예상 건수가 올바르지 않습니다.');
    if(!Array.isArray(value.rows)||value.rows.length!==value.expected_count)fail('수집 건수와 예상 건수가 일치하지 않습니다.');
    value.rows.forEach((item,index)=>{
      if(!item||typeof item!=='object'||Array.isArray(item))fail(`${index+1}행 형식이 올바르지 않습니다.`);
      if(!hasOnlyKeys(item,['name','code','supplier','available','safety','held','defective']))fail(`${index+1}행에 알 수 없는 항목이 있습니다.`);
      for(const key of ['name','code','supplier'])if(typeof item[key]!=='string')fail(`${index+1}행 ${key} 값이 문자열이 아닙니다.`);
      if(!item.name.trim()||item.name.length>1000||item.code.length>300||item.supplier.length>500)fail(`${index+1}행 문자열 길이 또는 제품명이 올바르지 않습니다.`);
      for(const key of ['available','safety','held','defective'])if(!Number.isInteger(item[key])||item[key]<-2147483648||item[key]>2147483647)fail(`${index+1}행 수량이 올바른 정수가 아닙니다.`);
    });
    if(byteLength(value)>MAX_BYTES)fail('스냅샷이 4MB 제한을 초과합니다.');
    return value;
  }
  function parseQuantity(value,rowIndex,columnIndex){
    if(typeof value==='number'){
      if(Number.isSafeInteger(value))return value;
      fail(`${rowIndex+1}행 ${columnIndex+1}열 수량이 올바르지 않습니다.`);
    }
    if(typeof value!=='string')fail(`${rowIndex+1}행 ${columnIndex+1}열 수량이 올바르지 않습니다.`);
    const normalized=value.trim().replace(/,/g,'');
    if(!/^[+-]?\d+$/.test(normalized))fail(`${rowIndex+1}행 ${columnIndex+1}열 수량이 올바르지 않습니다.`);
    const parsed=Number(normalized);
    if(!Number.isSafeInteger(parsed))fail(`${rowIndex+1}행 ${columnIndex+1}열 수량이 올바르지 않습니다.`);
    return parsed;
  }
  function fromCells(cells,collectedAt,expectedCount){
    if(!Array.isArray(cells))fail('표 셀 자료가 배열이 아닙니다.');
    if(!Number.isInteger(expectedCount)||expectedCount<1||cells.length!==expectedCount)fail('수집 건수와 예상 건수가 일치하지 않습니다.');
    const rows=cells.map((cellsRow,index)=>{
      if(!Array.isArray(cellsRow)||cellsRow.length<11)fail(`${index+1}행은 11열 표가 아닙니다.`);
      return {
        name:String(cellsRow[0]??''),
        code:String(cellsRow[1]??''),
        supplier:String(cellsRow[2]??''),
        available:parseQuantity(cellsRow[6],index,6),
        safety:parseQuantity(cellsRow[7],index,7),
        held:parseQuantity(cellsRow[8],index,8),
        defective:parseQuantity(cellsRow[9],index,9)
      };
    });
    return validateSnapshot({version:1,source:'wekeep',collected_at:collectedAt,expected_count:expectedCount,rows});
  }
  function publicKind(error){
    const code=String(error&&error.code||'');
    const status=Number(error&&error.status||0);
    const message=String(error&&error.message||'').toLowerCase();
    if(code==='PGRST301'||status===401||message.includes('jwt expired'))return 'session-expired';
    if(code==='42883'||code==='PGRST202'||message.includes('could not find the function'))return 'uninstalled';
    return 'failed';
  }
  function timed(operation,timeoutMs,schedule,cancel){
    let timer=null,rejectDeadline,settled=false;
    const deadline=new Promise((resolve,reject)=>{
      rejectDeadline=reject;
      timer=schedule(()=>{const error=new Error('request deadline');error.code='LIVE_TIMEOUT';reject(error);},timeoutMs);
    });
    const work=Promise.resolve().then(operation);
    const promise=Promise.race([work,deadline]).finally(()=>{settled=true;if(timer!==null){cancel(timer);timer=null;}});
    return {promise,cancel(){if(settled)return;if(timer!==null){cancel(timer);timer=null;}const error=new Error('request cancelled');error.code='LIVE_CANCELLED';rejectDeadline(error);}};
  }
  function deriveStatus(result,now){
    const current=nowMs(now);
    if(result&&['rpc-missing','session-expired'].includes(result.kind))return {kind:result.kind==='rpc-missing'?'uninstalled':'session-expired'};
    if(result&&result.error)return {kind:publicKind(result.error)};
    try{
      if(!result||typeof result!=='object'||Array.isArray(result))fail('읽기 응답이 없습니다.');
      const checked=timeMs(result.checked_at,'서버 확인 시각');
      if(checked>current+MAX_FUTURE_MS)fail('서버 확인 시각이 미래입니다.');
      if(result.snapshot===null)return {kind:'empty',checked_at:result.checked_at};
      const checkedSnapshot=validateSnapshot(result.snapshot,current,true);
      return {kind:current-Date.parse(checkedSnapshot.collected_at)>=STALE_MS?'stale':'ready',snapshot:checkedSnapshot,checked_at:result.checked_at};
    }catch(_error){return {kind:'failed'};}
  }
  function escapeHtml(value){
    return String(value??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }
  function formatTime(value){
    if(!value)return '-';
    try{return new Intl.DateTimeFormat('ko-KR',{dateStyle:'medium',timeStyle:'medium',timeZone:'Asia/Seoul'}).format(new Date(value));}
    catch(_error){return escapeHtml(value);}
  }
  function messagePage(kind){
    const copy={
      loading:['저장된 재고를 확인하고 있습니다.','잠시만 기다려 주세요.'],
      uninstalled:['실시간 재고 저장소가 아직 설치되지 않았습니다.','운영 DB 설치가 끝나면 이 화면에서 확인할 수 있습니다.'],
      empty:['아직 저장된 위킵 재고가 없습니다.','수집 자료를 검증하여 처음 반영해 주세요.'],
      failed:['실시간 재고를 불러오지 못했습니다.','잠시 후 새로고침해 주세요. 마지막 성공 자료를 최신으로 표시하지 않습니다.'],
      'session-expired':['로그인 세션이 만료되었습니다.','다시 로그인한 뒤 재고를 확인해 주세요.']
    }[kind]||['자료를 표시할 수 없습니다.','새로고침해 주세요.'];
    return `<div class="inventory-state inventory-state-${escapeHtml(kind)}"><strong>${copy[0]}</strong><p>${copy[1]}</p></div>`;
  }
  function collectionPanel(saveMessage,payload,saving){
    return `<details class="inventory-import"><summary>수집 자료 반영</summary><div class="inventory-import-body"><label for="inventory-payload">수집 자료</label><textarea id="inventory-payload" aria-label="수집 자료" rows="7" spellcheck="false" placeholder="{&quot;version&quot;:1,...}">${escapeHtml(payload||'')}</textarea><div class="inventory-import-actions"><button class="btn btn-primary" type="button" data-inventory-action="save"${saving?' disabled':''}>${saving?'저장 중…':'검증 후 반영'}</button><span class="inventory-save-message" role="status">${escapeHtml(saveMessage||'')}</span></div></div></details>`;
  }
  function render(state,options={}){
    let kind=state&&state.kind||'failed';
    let failureBanner='';
    const transient=kind;
    if(['failed','loading'].includes(kind)&&state.previous&&['ready','stale'].includes(state.previous.kind)){
      failureBanner=kind==='failed'?'<div class="inventory-stale inventory-read-failed"><i class="ti ti-alert-triangle"></i> <strong>확인 실패</strong> · 아래 표는 마지막 확인 성공 자료입니다.</div>':'<div class="inventory-checking"><i class="ti ti-loader"></i> 저장된 새 자료를 확인 중입니다. 아래 표는 마지막 확인 성공 자료입니다.</div>';
      state=state.previous;
      kind=state.kind;
    }
    const query=String(options.query||'').trim().toLocaleLowerCase('ko');
    const sourceLink='<a class="btn btn-sm" href="https://fbw.wekeep.co.kr/fbw/admin/v2/inventory/search.do" target="_blank" rel="noopener noreferrer"><i class="ti ti-external-link"></i> 위킵 원본</a>';
    if(!['ready','stale'].includes(kind))return `<div class="inventory-page"><div class="inventory-toolbar"><button class="btn" type="button" data-inventory-action="refresh"><i class="ti ti-refresh"></i> 새로고침</button>${sourceLink}</div>${messagePage(kind)}${kind!=='session-expired'?collectionPanel(options.saveMessage,options.payload,options.saving):''}</div>`;
    const snapshot=state.snapshot;
    const visible=snapshot.rows.filter(item=>!query||[item.name,item.code,item.supplier].some(value=>value.toLocaleLowerCase('ko').includes(query)));
    const totals=snapshot.rows.reduce((sum,item)=>{for(const key of ['available','safety','held','defective'])sum[key]+=item[key];return sum;},{available:0,safety:0,held:0,defective:0});
    const negative=snapshot.rows.filter(item=>['available','safety','held','defective'].some(key=>item[key]<0)).length;
    const blank=snapshot.rows.filter(item=>item.code.trim()==='').length;
    const rows=visible.map(item=>`<tr><td>${escapeHtml(item.name)}</td><td>${escapeHtml(item.code)||'<span class="inventory-muted">(빈 코드)</span>'}</td><td>${escapeHtml(item.supplier)}</td><td class="num${item.available<0?' negative':''}">${item.available.toLocaleString('ko-KR')}</td><td class="num${item.safety<0?' negative':''}">${item.safety.toLocaleString('ko-KR')}</td><td class="num${item.held<0?' negative':''}">${item.held.toLocaleString('ko-KR')}</td><td class="num${item.defective<0?' negative':''}">${item.defective.toLocaleString('ko-KR')}</td></tr>`).join('');
    const freshness=kind==='stale'?'<div class="inventory-stale"><i class="ti ti-alert-triangle"></i> <strong>지연</strong> · 마지막 수집 후 15분 이상 지났습니다.</div>':(['failed','loading'].includes(transient)?'':'<div class="inventory-fresh"><i class="ti ti-circle-check"></i> <strong>최신</strong> · 마지막 수집이 15분 이내입니다.</div>');
    return `<div class="inventory-page"><div class="inventory-toolbar"><input id="inventory-search" type="search" value="${escapeHtml(options.query||'')}" placeholder="제품명 · 관리코드 · 공급처 검색" aria-label="실시간 재고 검색"><button class="btn" type="button" data-inventory-action="refresh"><i class="ti ti-refresh"></i> 새로고침</button>${sourceLink}</div>${failureBanner}${freshness}<div class="inventory-meta"><span><strong>마지막 수집</strong> ${escapeHtml(formatTime(snapshot.collected_at))}</span><span><strong>서버 확인</strong> ${escapeHtml(formatTime(state.checked_at))}</span><span>전체 ${snapshot.rows.length.toLocaleString('ko-KR')}행 · 검색 ${visible.length.toLocaleString('ko-KR')}행</span><span>저장 자료를 60초마다 확인 · 위킵 원본 수집 목표 10분</span></div><div class="inventory-kpis">${[['가용',totals.available],['안전',totals.safety],['유보',totals.held],['하자',totals.defective]].map(([label,value])=>`<div class="kpi"><div class="lbl">전체 ${label} 합계</div><div class="val">${value.toLocaleString('ko-KR')}</div></div>`).join('')}<div class="kpi"><div class="lbl">음수 행</div><div class="val${negative?' negative':''}">${negative.toLocaleString('ko-KR')}</div></div><div class="kpi"><div class="lbl">빈 관리코드</div><div class="val">${blank.toLocaleString('ko-KR')}</div></div></div><div class="card inventory-table-card"><div class="tw"><table class="inventory-table"><thead><tr><th>제품명</th><th>관리코드</th><th>공급처</th><th>가용</th><th>안전</th><th>유보</th><th>하자</th></tr></thead><tbody>${rows||'<tr><td colspan="7" class="inventory-no-results">검색 결과가 없습니다.</td></tr>'}</tbody></table></div></div>${collectionPanel(options.saveMessage,options.payload,options.saving)}</div>`;
  }
  function validateSaveResult(result,snapshot){
    if(!result||result.saved!==true||result.collected_at!==snapshot.collected_at||result.row_count!==snapshot.rows.length)fail('저장 확인 응답이 일치하지 않습니다.');
    return result;
  }
  function createController(options){
    const read=options.read,paint=options.render;
    const getNow=options.now||(()=>Date.now());
    const schedule=options.setTimeout||setTimeout;
    const cancel=options.clearTimeout||clearTimeout;
    const timeoutMs=Number.isFinite(options.timeoutMs)&&options.timeoutMs>0?options.timeoutMs:DEFAULT_TIMEOUT_MS;
    let active=false,generation=0,poll=null,inFlight=null,lastGood=null;
    function clearPoll(){if(poll!==null){cancel(poll);poll=null;}}
    function queue(gen){if(!active||gen!==generation)return;clearPoll();poll=schedule(()=>{poll=null;refresh();},60000);}
    function refresh(force){
      if(!active)return Promise.resolve();
      if(force){
        generation++;clearPoll();
        if(inFlight)inFlight.cancel();
        inFlight=null;
      }
      const gen=generation;
      if(inFlight&&inFlight.generation===gen)return inFlight.promise;
      const cached=lastGood?deriveStatus({snapshot:lastGood.snapshot,checked_at:lastGood.checked_at},getNow()):null;
      paint(cached?{kind:'loading',previous:cached}:{kind:'loading'});
      const bounded=timed(read,timeoutMs,schedule,cancel);
      const promise=bounded.promise.then(result=>{
        if(active&&gen===generation){
          const next=deriveStatus(result,getNow());
          if(['ready','stale'].includes(next.kind))lastGood=next;
          if(next.kind==='empty')lastGood=null;
          const previous=lastGood?deriveStatus({snapshot:lastGood.snapshot,checked_at:lastGood.checked_at},getNow()):null;
          paint(next.kind==='failed'&&previous?{kind:'failed',previous}:next);
        }
      }).catch(error=>{
        if(active&&gen===generation){const kind=publicKind(error),previous=lastGood?deriveStatus({snapshot:lastGood.snapshot,checked_at:lastGood.checked_at},getNow()):null;paint(kind==='failed'&&previous?{kind,previous}:{kind});}
      }).finally(()=>{
        if(inFlight&&inFlight.promise===promise)inFlight=null;
        queue(gen);
      });
      inFlight={generation:gen,promise,cancel:bounded.cancel};
      return promise;
    }
    function show(){active=true;generation++;clearPoll();return refresh();}
    function hide(){active=false;generation++;clearPoll();if(inFlight)inFlight.cancel();inFlight=null;lastGood=null;}
    return {show,hide,refresh};
  }
  function mount(options){
    const doc=options.document;
    const host=doc.getElementById('content');
    const actions=doc.getElementById('topbar-actions');
    let state={kind:'loading'},query='',payload='',saveMessage='',saving=false,active=false,lifecycle=0,pendingWrite=null;
    const schedule=options.setTimeout||setTimeout,cancel=options.clearTimeout||clearTimeout;
    const timeoutMs=Number.isFinite(options.timeoutMs)&&options.timeoutMs>0?options.timeoutMs:DEFAULT_TIMEOUT_MS;
    const controller=createController({read:options.read,render:next=>{state=next;paint();},timeoutMs,setTimeout:schedule,clearTimeout:cancel});
    function paint(){
      if(!active)return;
      const open=!!host.querySelector&&!!host.querySelector('.inventory-import[open]');
      const focused=doc.activeElement&&['inventory-search','inventory-payload'].includes(doc.activeElement.id)?{id:doc.activeElement.id,start:doc.activeElement.selectionStart,end:doc.activeElement.selectionEnd}:null;
      host.innerHTML=render(state,{query,payload,saveMessage,saving});
      if(open){const details=host.querySelector&&host.querySelector('.inventory-import');if(details)details.open=true;}
      if(focused){const next=doc.getElementById(focused.id);if(next&&next.focus){next.focus();if(next.setSelectionRange&&Number.isInteger(focused.start))next.setSelectionRange(focused.start,Number.isInteger(focused.end)?focused.end:focused.start);}}
      if(actions)actions.innerHTML='';
    }
    async function save(){
      if(!active||saving||typeof options.write!=='function')return;
      const saveLifecycle=lifecycle;
      let saveRequest=null;
      try{
        const parsed=JSON.parse(payload);
        const checked=validateSnapshot(parsed);
        saving=true;saveMessage='검증 후 저장 중…';paint();
        const bounded=timed(()=>options.write(checked),timeoutMs,schedule,cancel);
        saveRequest=bounded;
        pendingWrite=bounded;
        const result=await bounded.promise;
        if(!active||saveLifecycle!==lifecycle)return;
        validateSaveResult(result,checked);
        payload='';
        saveMessage=`${checked.rows.length.toLocaleString('ko-KR')}행 저장 완료`;
        await controller.refresh(true);
      }catch(error){
        if(!active||saveLifecycle!==lifecycle)return;
        if(error&&error.code==='LIVE_TIMEOUT'){
          saveMessage='저장 응답이 지연되었습니다. 저장 여부 확인 필요 · 자동 재전송하지 않았습니다.';
          await controller.refresh(true);
          if(!active||saveLifecycle!==lifecycle)return;
          if(['ready','stale'].includes(state.kind)&&JSON.stringify(state.snapshot)===JSON.stringify(checked)){
            payload='';saveMessage=`${checked.rows.length.toLocaleString('ko-KR')}행 저장 확인 완료`;
          }
        }else saveMessage=error instanceof SyntaxError?'JSON 형식을 확인해 주세요.':(error&&error.message&&/^(스냅샷|지원하지|수집|예상|\d+행)/.test(error.message)?error.message:'저장하지 못했습니다. 다시 로그인하거나 잠시 후 시도해 주세요.');
        paint();
      }finally{if(pendingWrite===saveRequest)pendingWrite=null;if(active&&saveLifecycle===lifecycle){saving=false;paint();}}
    }
    host.addEventListener('click',event=>{
      const button=event.target.closest&&event.target.closest('[data-inventory-action]');
      if(!button)return;
      if(button.dataset.inventoryAction==='refresh')controller.refresh();
      if(button.dataset.inventoryAction==='save')save();
    });
    host.addEventListener('input',event=>{
      if(event.target&&event.target.id==='inventory-search'){query=event.target.value;paint();const input=doc.getElementById('inventory-search');if(input){input.focus();input.setSelectionRange(input.value.length,input.value.length);}}
      if(event.target&&event.target.id==='inventory-payload')payload=event.target.value;
    });
    return {
      show(){active=true;lifecycle++;query='';payload='';saveMessage='';saving=false;return controller.show();},
      hide(){active=false;lifecycle++;if(pendingWrite)pendingWrite.cancel();pendingWrite=null;controller.hide();query='';payload='';saveMessage='';saving=false;state={kind:'loading'};},
      refresh:controller.refresh
    };
  }

  return {validateSnapshot,fromCells,deriveStatus,render,validateSaveResult,createController,mount};
});
