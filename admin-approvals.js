(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.AdminApprovals=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const labels={customers:'거래처',products:'제품',invoices:'주문',invoice_items:'주문 품목',stocks:'재고',documents:'서류',schedules:'일정',app_settings:'설정',tax_records:'세금계산서',invoice_drive_documents:'주문 연결 문서',invoice:'주문 정보',items:'품목',id:'식별번호',name:'이름',customer_id:'거래처 식별번호',product_id:'제품 식별번호',invoice_id:'주문 식별번호',invoice_no:'주문번호',qty:'수량',quantity:'수량',price:'단가',unit_price:'단가',amount:'금액',total:'합계',currency:'통화',status:'상태',order_date:'주문일',ship_date:'출고일',ship_status:'출고 상태',tracking_num:'운송장번호',sales_type:'판매 유형',sku:'제품 코드',barcode:'바코드',date:'날짜',month:'월',email:'이메일',phone:'전화번호',country:'국가',manager:'담당자',note:'메모',notes:'메모',memo:'메모',reason:'사유',title:'제목',type:'유형',url:'주소',file_name:'파일명',file_id:'파일 식별번호',value:'설정값',key:'설정 항목',created_at:'등록 시각',updated_at:'수정 시각',tax_status:'세금계산서 상태',address:'주소',brand:'브랜드',discount:'할인',shipping:'배송비',payment_date:'입금일',payment_method:'결제 방식',paid_amount:'입금액',description:'설명',contact:'연락처',contact_name:'연락 담당자'};
  Object.assign(labels,{amount_override:'증빙 금액',amount_reference:'증빙 근거'});
  const statusLabels={pending:'승인 대기',approved:'승인 완료',rejected:'반려'};
  Object.assign(labels,{no:'주문번호',mgr:'담당자',pay_date:'입금일',product_details:'제품 상세',before_items:'함께 삭제되는 주문 품목',before_drive_documents:'함께 삭제되는 연결 문서'});
  const field=key=>labels[key]||`기타 항목 (${key})`;
  function valueText(value){
    if(value==null)return '—';
    if(Array.isArray(value))return value.length?value.map((v,i)=>`${i+1}. ${valueText(v)}`).join('\n'):'(없음)';
    if(typeof value==='object')return Object.entries(value).map(([k,v])=>`${field(k)}: ${valueText(v)}`).join('\n')||'(없음)';
    if(typeof value==='boolean')return value?'예':'아니요';
    return String(value);
  }
  function renderDiff(operation){
    const op=operation||{};
    const cleanItems=items=>Array.isArray(items)?items.map(item=>Object.fromEntries(Object.entries(item).filter(([key])=>!['id','created_at','invoice_id','invoice_no'].includes(key)))):items;
    const before=op.action==='invoice'?{...op.before,items:cleanItems(op.before?.items)}:{...op.before};
    if(op.action==='delete'&&op.table==='invoices'){
      before.before_items=op.before_items||[];
      before.before_drive_documents=op.before_drive_documents||[];
    }
    const after=op.action==='invoice'?{invoice:{...before.invoice,...op.invoice},items:cleanItems(op.items)}:op.action==='delete'?{}:{...before,...op.values};
    const keys=Array.from(new Set([...Object.keys(before),...Object.keys(after)]));
    const rows=keys.map(key=>{
      const old=before[key],next=after[key],changed=JSON.stringify(old)!==JSON.stringify(next);
      return `<tr${changed?' class="changed"':''}><th scope="row">${escape(field(key))}${changed?' <span class="changed-label">변경</span>':''}</th><td><pre>${escape(valueText(old))}</pre></td><td><pre>${escape(valueText(next))}</pre></td></tr>`;
    }).join('');
    const action={insert:'추가',update:'수정',delete:'삭제',invoice:'주문 및 품목 저장'}[op.action]||'변경';
    return `<section class="operation"><h4>${escape(op.action==='invoice'?'주문':field(op.table||''))} · ${escape(action)}</h4>${op.key?`<p class="muted">대상: ${escape(valueText(op.key))}</p>`:''}<div class="diff-scroll" tabindex="0" role="region" aria-label="변경 전후 비교"><table class="diff"><thead><tr><th scope="col">항목</th><th scope="col">변경 전</th><th scope="col">변경 후</th></tr></thead><tbody>${rows||'<tr><td colspan="3">변경 상세가 없습니다.</td></tr>'}</tbody></table></div></section>`;
  }
  function time(value){const d=new Date(value);return Number.isNaN(d.getTime())?'시각 미확인':d.toLocaleString('ko-KR',{timeZone:'Asia/Seoul'})+' KST';}
  function render(state){
    const all=state.requests||[],pending=all.filter(r=>r.status==='pending').length;
    const rows=all.filter(r=>!state.filter||state.filter==='all'||r.status===state.filter);
    const disabled=state.loading||state.reviewing?' disabled':'';
    return `<div class="queue-toolbar"><div><strong>${state.isAdmin===true?'전체 변경 요청':'내 변경 요청'}</strong><p class="muted">현재 페이지 ${all.length}건 · 대기 ${pending}건</p></div><div class="toolbar-controls"><label>현재 페이지 상태 <select data-filter${disabled}>${Object.entries({all:'전체',...statusLabels}).map(([k,v])=>`<option value="${k}"${state.filter===k?' selected':''}>${v}</option>`).join('')}</select></label><button type="button" data-refresh${disabled}>새로고침</button></div></div>
      ${state.error?`<p class="message error" role="alert">${escape(state.error)}</p>`:''}${state.message?`<p class="message success" role="status">${escape(state.message)}</p>`:''}
      ${state.loading?'<p role="status">요청을 불러오는 중입니다…</p>':''}
      ${!state.isAdmin?'<p class="muted">본인이 제출한 요청을 조회합니다. 승인·반려 권한은 서버에서 확인합니다.</p>':''}
      <div class="requests">${rows.map(r=>{
        const id=escape(r.id),knownStatus=Object.hasOwn(statusLabels,r.status)?r.status:'unknown';
        return `<article class="request"><header class="request-head"><div><span class="badge ${knownStatus}">${escape(statusLabels[r.status]||'상태 미확인')}</span><h2>${escape(r.reason||'사유 없음')}</h2></div><span class="request-count">${Array.isArray(r.operations)?r.operations.length:0}개 변경</span></header><p class="request-meta">요청자 ${escape(r.requester_email||r.requester_id)} · ${escape(time(r.created_at))}</p><p class="request-id">요청 번호 ${id}</p><details><summary>변경 전후 상세 확인</summary>${(Array.isArray(r.operations)?r.operations:[]).map(renderDiff).join('')}</details>${r.status!=='pending'?`<p class="review-result">처리자 ${escape(r.reviewer_email||'미확인')} · ${escape(time(r.reviewed_at))}<br>검토 메모: ${escape(r.review_note||'없음')}</p>`:''}${state.isAdmin===true&&r.status==='pending'?`<div class="review-controls"><label>검토 메모 <span class="muted">(반려 시 필수)</span><textarea data-note="${id}" maxlength="2000" rows="2"${disabled}>${escape(state.notes?.[r.id]||'')}</textarea></label><div class="review-buttons"><button type="button" class="reject" data-review="reject" data-id="${id}"${disabled}>반려</button><button type="button" class="approve" data-review="approve" data-id="${id}"${disabled}>승인하여 반영</button></div></div>`:''}</article>`;
      }).join('')||(!state.loading?'<div class="empty">현재 페이지에 해당 상태의 요청이 없습니다.</div>':'')}</div>
      <nav class="pagination" aria-label="요청 목록 페이지"><button type="button" data-page="prev"${disabled||(!state.offset?' disabled':'')}>이전</button><span>${Math.floor((state.offset||0)/(state.pageSize||50))+1}페이지 · 페이지당 ${state.pageSize||50}건</span><button type="button" data-page="next"${disabled||(all.length<(state.pageSize||50)?' disabled':'')}>다음</button></nav>`;
  }
  function createController({rpc,onChange=()=>{},pageSize=50}){
    const state={requests:[],isAdmin:false,notes:Object.create(null),filter:'all',offset:0,pageSize,loading:false,reviewing:false,error:'',message:''};
    let generation=0,sessionEpoch=0;
    const notify=()=>onChange(state);
    async function load(offset=state.offset){
      const ticket=++generation;state.loading=true;state.error='';notify();
      try{
        const {data,error}=await rpc('list_change_requests',{p_limit:pageSize,p_offset:Math.max(0,offset)});
        if(ticket!==generation)return false;
        if(error)throw error;
        if(!data||!Array.isArray(data.requests)||typeof data.is_admin!=='boolean')throw new Error('요청 목록 응답을 확인할 수 없습니다. 새로고침해 주세요.');
        state.requests=data.requests;state.isAdmin=data.is_admin===true;state.offset=Math.max(0,offset);return true;
      }catch(error){if(ticket===generation){state.error='목록 조회 실패: '+(error.message||String(error));state.isAdmin=false;}return false;}
      finally{if(ticket===generation){state.loading=false;notify();}}
    }
    async function review(id,approve,note=''){
      state.error='';state.message='';
      if(!state.isAdmin||state.loading||state.reviewing||!state.requests.some(r=>r.id===id&&r.status==='pending')){state.error='현재 승인할 수 없습니다. 권한과 최신 요청 상태를 새로고침해 주세요.';notify();return false;}
      note=String(note).trim();
      if(!approve&&!note){state.error='반려 사유를 검토 메모에 입력해 주세요.';notify();return false;}
      const epoch=sessionEpoch;
      state.reviewing=true;notify();
      try{
        const {data,error}=await rpc('review_change_request',{p_id:id,p_approve:approve===true,p_note:note});
        if(epoch!==sessionEpoch)return false;
        if(error)throw error;
        if(data?.id!==id||data?.status!==(approve?'approved':'rejected'))throw new Error('처리 응답을 확인할 수 없습니다. 새로고침하여 상태를 확인해 주세요.');
        state.requests=state.requests.map(r=>r.id===id?{...r,status:data.status,review_note:note}:r);
        delete state.notes[id];state.message=approve?'승인되어 확정 자료에 반영되었습니다.':'반려되었습니다. 확정 자료는 변경하지 않았습니다.';
        await load();return true;
      }catch(error){if(epoch===sessionEpoch)state.error='처리 실패: '+(error.message||String(error))+' 요청 상태를 새로고침하여 확인해 주세요.';return false;}
      finally{if(epoch===sessionEpoch){state.reviewing=false;notify();}}
    }
    function reset(){generation++;sessionEpoch++;Object.assign(state,{requests:[],isAdmin:false,loading:false,reviewing:false,notes:Object.create(null),error:'',message:''});notify();}
    return {state,load,review,reset};
  }
  function mount({document,client,confirm=message=>globalThis.confirm(message)}){
    const host=document.getElementById('approval-queue'),sessionPanel=document.getElementById('approval-session');
    const controller=createController({rpc:(...args)=>client.rpc(...args),onChange:state=>{host.innerHTML=render(state);}});
    host.addEventListener('input',event=>{if(event.target.matches('[data-note]'))controller.state.notes[event.target.dataset.note]=event.target.value;});
    host.addEventListener('change',event=>{if(event.target.matches('[data-filter]')){controller.state.filter=event.target.value;host.innerHTML=render(controller.state);}});
    host.addEventListener('click',async event=>{
      const button=event.target.closest('button');if(!button||button.disabled)return;
      if(button.hasAttribute('data-refresh'))await controller.load();
      else if(button.dataset.page)await controller.load(controller.state.offset+(button.dataset.page==='next'?1:-1)*controller.state.pageSize);
      else if(button.dataset.review){
        const approve=button.dataset.review==='approve',id=button.dataset.id,note=controller.state.notes[id]||'';
        if(!approve&&!note.trim()){await controller.review(id,false,note);return;}
        if(confirm(approve?'변경 전후 내용과 증빙을 확인했습니까? 승인하면 확정 자료에 반영됩니다. 본인 요청도 같은 검증을 거칩니다.':'이 요청을 반려하시겠습니까?'))await controller.review(id,approve,note);
      }
    });
    let sessionGeneration=0;
    async function start(){
      const ticket=++sessionGeneration;
      try{
        const {data,error}=await client.auth.getSession();if(ticket!==sessionGeneration)return;if(error)throw error;
        if(!data?.session){controller.reset();host.hidden=true;sessionPanel.hidden=false;return;}
        host.hidden=false;sessionPanel.hidden=true;await controller.load();
      }catch(error){controller.reset();host.hidden=true;sessionPanel.hidden=false;document.getElementById('session-message').textContent='로그인을 확인할 수 없습니다. 대시보드에서 다시 로그인해 주세요. '+(error.message||'');}
    }
    client.auth.onAuthStateChange((event)=>{if(event==='SIGNED_OUT'){sessionGeneration++;controller.reset();host.hidden=true;sessionPanel.hidden=false;}else if(event==='SIGNED_IN'){setTimeout(start,0);}});
    start();return controller;
  }
  return {escape,valueText,renderDiff,render,createController,mount};
});
