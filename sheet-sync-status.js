(function(root,factory){
 const api=factory();
 if(typeof module==='object'&&module.exports)module.exports=api;
 else root.SheetSyncStatus=api;
})(globalThis,function(){
 'use strict';
 const sheetUrl='https://docs.google.com/spreadsheets/d/1t7pvT-HnTHscmHti7GYn1zPk0K7dvAJeegkizmvJfEc/edit#gid=980901';
 const messages={
  checking:['상태 확인 중','저장된 주문의 시트 반영 상태를 확인하고 있습니다.','neutral'],
  unavailable:['상태 확인 불가','연결 상태를 확인하지 못했습니다. 잠시 후 다시 확인해 주세요.','warning'],
  complete:['시트 반영 완료','확인 시점까지 저장된 주문 변경이 반영됐습니다.','success'],
  pending:['시트 반영 대기','5분마다 자동 반영됩니다. 변경한 주문이 많으면 여러 차례에 걸쳐 반영됩니다.','warning'],
  delayed:['시트 반영 지연','15분 이상 기다리는 주문이 있습니다. 관리자에게 자동 실행 상태 확인을 요청해 주세요.','warning'],
  missing:['연결 확인 필요','동기화 기록이 없는 주문이 있습니다. 관리자에게 연결 확인을 요청해 주세요.','warning'],
  error:['시트 반영 오류','실패한 반영은 자동 재시도합니다. 오류가 계속되면 관리자에게 확인을 요청해 주세요.','error'],
  paused:['시트 자동 반영 중지','자동 반영이 중지되어 있습니다. 관리자에게 재개 여부를 확인해 주세요.','warning'],
  empty:['반영 이력 없음','아직 시트 반영 완료 이력이 없습니다.','neutral']
 };
 const errors={DESTINATION_READ_FAILED:'시트 읽기 실패',DESTINATION_WRITE_FAILED:'시트 쓰기 실패',INVALID_SNAPSHOT:'주문 데이터 확인 필요',ACK_UNCERTAIN:'반영 완료 확인 지연'};
 const escape=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
 function model(kind,data=null){const [title,message,tone]=messages[kind];return {kind,title,message,tone,data};}
 function describe(data){
  const counts=['pending_count','failed_count','delayed_count','missing_count'];
  if(!data||typeof data.enabled!=='boolean'||!counts.every(k=>Number.isSafeInteger(data[k])&&data[k]>=0)
   ||data.failed_count+data.delayed_count+data.missing_count>data.pending_count
   ||typeof data.checked_at!=='string'||!Number.isFinite(Date.parse(data.checked_at))
   ||(data.last_synced_at!==null&&(typeof data.last_synced_at!=='string'||!Number.isFinite(Date.parse(data.last_synced_at))))
   ||!Array.isArray(data.problems))return model('unavailable');
  const kind=!data.enabled?'paused':data.failed_count?'error':data.missing_count?'missing':data.delayed_count?'delayed':data.pending_count?'pending':data.last_synced_at?'complete':'empty';
  return model(kind,data);
 }
 function time(value){
  return value?new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(value)):'이력 없음';
 }
 function renderPanel(view){
  const data=view.data;
  const problems=data?data.problems.slice(0,10):[];
  return `<div class="sheet-sync-main">
   <div class="sheet-sync-copy"><div class="sheet-sync-heading"><strong>Google 시트 반영</strong><span class="sheet-sync-badge ${view.tone}" role="status" aria-live="polite">${view.title}</span>${data?`<span>대기 ${data.pending_count-data.failed_count}건 · 오류 ${data.failed_count}건</span>`:''}</div>
   <p>${view.message}</p>${data?`<p class="sheet-sync-time">마지막 반영 ${time(data.last_synced_at)} · 상태 확인 ${time(data.checked_at)} (한국 시간) · 전체 주문 기준</p>`:''}</div>
   <div class="sheet-sync-actions"><button type="button" class="btn btn-sm" data-sync-refresh ${view.kind==='checking'?'disabled':''}>상태 다시 확인</button><a class="btn btn-sm" href="${sheetUrl}" target="_blank" rel="noopener noreferrer">시트 열기</a></div>
  </div>${problems.length?`<details class="sheet-sync-problems"><summary>확인이 필요한 주문 ${data.failed_count+data.delayed_count+data.missing_count}건${data.failed_count+data.delayed_count+data.missing_count>10?' (최대 10건 표시)':''}</summary><ul>${problems.map(p=>`<li><strong>${escape(p?.invoice_no||'삭제된 주문')}</strong>${p?.customer?' · '+escape(p.customer):''}<span>${p?.state==='error'?(errors[p.error_code]||'반영 오류'):p?.state==='missing'?'동기화 연결 확인 필요':'15분 이상 반영 대기'}</span></li>`).join('')}</ul></details>`:''}`;
 }
 function createController(options){
  const set=options.setTimeout||setTimeout,clear=options.clearTimeout||clearTimeout;
  let active=false,request=null,generation=0,poll=null,cancel=null;
  const schedule=()=>{clear(poll);if(active)poll=set(()=>refresh(),60000);};
  function refresh(){
   if(!active)return Promise.resolve();
   if(options.isHidden?.()){schedule();return Promise.resolve();}
   if(request)return request;
   clear(poll);const current=++generation;
   options.render(model('checking'));
   let deadline,rejectTimeout,response;
   const timeout=new Promise((_,reject)=>{rejectTimeout=reject;deadline=set(()=>reject(Error('timeout')),20000);});
   cancel=()=>{clear(deadline);rejectTimeout(Error('cancelled'));};
   try{response=options.read();}catch(error){response=Promise.reject(error);}
   request=Promise.race([Promise.resolve(response),timeout]).then(data=>{
    if(active&&current===generation)options.render(describe(data));
   },()=>{if(active&&current===generation)options.render(model('unavailable'));}).finally(()=>{
    clear(deadline);
    if(current===generation){request=null;cancel=null;schedule();}
   });
   return request;
  }
  function hide(){active=false;++generation;clear(poll);cancel?.();cancel=null;request=null;}
  return {refresh,hide,show(){active=true;return refresh();},saved(){
   if(!active)return Promise.resolve();++generation;cancel?.();request=null;cancel=null;return refresh();
  }};
 }
 function mount(options){
  const host=options.document.getElementById('sheet-sync-status');
  if(!host)return null;
  let selected=false,expanded=false;
  const controller=createController({read:options.read,isHidden:()=>options.document.hidden,render:view=>{
   const currentDetails=host.querySelector('details');
   if(currentDetails)expanded=currentDetails.open;
   const focused=options.document.activeElement?.hasAttribute('data-sync-refresh');
   host.innerHTML=renderPanel(view);
   if(expanded&&host.querySelector('details'))host.querySelector('details').open=true;
   if(focused)host.querySelector('[data-sync-refresh]')?.focus();
  }});
  host.addEventListener('click',event=>{if(event.target.closest('[data-sync-refresh]'))controller.refresh();});
  options.document.addEventListener('visibilitychange',()=>{
   if(options.document.hidden)controller.hide();else if(selected)controller.show();
  });
  return {refresh:controller.refresh,saved:controller.saved,hide(){selected=false;expanded=false;host.hidden=true;controller.hide();host.innerHTML='';},show(page){
   if(!['dash','raw','invoices'].includes(page)){this.hide();return;}
   selected=true;host.hidden=false;
   if(options.document.hidden){controller.hide();return;}
   return controller.show();
  }};
 }
 return {describe,renderPanel,createController,mount};
});
