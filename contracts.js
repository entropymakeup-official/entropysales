(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.Contracts=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
'use strict';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uuid=v=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const enums={status:['초안','협의중','서명대기','유효','만료','해지'],contract_type:['공급','총판','독점','기타'],auto_renewal:['미확정','있음','없음'],exclusive:['미확정','있음','없음'],foc_status:['미확정','있음','없음'],payment_type:['미확정','전액 선입금','분할','후불','기타']};
const groups=[
 ['기본정보',[['customer_id','거래처','customer'],['name','계약명'],['contract_type','계약유형','select'],['status','계약 상태','select'],['manager','내부 담당자'],['counterparty_contact','거래처 담당자']]],
 ['계약기간 · 갱신',[['start_date','시작일','date'],['end_date','종료일','date'],['auto_renewal','자동갱신','select'],['notice_date','갱신거절 통보기한','date'],['renewal_terms','갱신 조건','textarea'],['previous_contract_id','이전 계약 (갱신·변경 이력)','previous']]],
 ['계약조건 · 판매 범위',[['territory','대상 국가'],['channels','허용 판매채널'],['exclusive','독점 여부','select'],['price_terms','공급가격 기준','textarea'],['minimum_order','최소발주금액·수량'],['incoterms','인도조건 / 지정 장소'],['annual_commitment','연간 최소구매액·달성기한','textarea'],['exclusivity_terms','독점 유지 조건','textarea']]],
 ['수금조건',[['payment_type','수금 방식','select'],['currency','결제통화 (예: USD)'],['payment_method','결제수단 (예: T/T, L/C)'],['deposit_pct','선금 비율 (%)','number'],['balance_pct','잔금 비율 (%)','number'],['deposit_due','선금 지급 기준·기한'],['balance_due','잔금 / 후불 지급 기준·기한'],['bank_fee','송금수수료 부담'],['payment_terms','수금 특약','textarea']]],
 ['FOC 조건',[['foc_status','FOC 유무','select'],['foc_terms','제공 비율·수량 / 산정 기준 / 적용 시점','textarea'],['foc_products','대상 제품'],['foc_limit','제공 한도']]],
 ['계약서 · 특약',[['document_id','계약서 서명본','document'],['amendment_document_id','부속합의서 / 변경계약서','document'],['special_terms','반품·불량 대응 등 주요 특약','textarea']]]
];
const fields=groups.flatMap(g=>g[1]);
function validDate(v){if(!/^\d{4}-\d{2}-\d{2}$/.test(v))return false;const d=new Date(v+'T00:00:00Z');return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===v&&v>='1900-01-01'&&v<='9999-12-31';}
function normalize(raw){
 const out={};
 for(const [key,label,type]of fields){
  const v=String(raw[key]??'').trim();
  if(type==='number'){
   if(v==='')out[key]=null;else{if(!/^\d+(\.\d{1,2})?$/.test(v)||Number(v)>100)throw Error(label+'은 0~100 사이 숫자(소수 둘째 자리까지)로 입력하세요.');out[key]=Number(v);}
  }else if(type==='date'){if(v&&!validDate(v))throw Error(label+'을 실제 날짜로 입력하세요.');out[key]=v||null;}
  else if(['customer','document','previous'].includes(type)){if(v&&!uuid(v))throw Error(label+'을 목록에서 선택하세요.');out[key]=v||null;}
  else if(enums[key]){const value=v||enums[key][0];if(!enums[key].includes(value))throw Error(label+'을 다시 선택하세요.');out[key]=value;}
  else{if(v.length>4000)throw Error(label+'은 4,000자 이하로 입력하세요.');out[key]=v;}
 }
 if(!out.customer_id||!out.name)throw Error('거래처와 계약명을 입력하세요.');
 if(out.status==='유효'&&(!out.start_date||!out.end_date))throw Error('유효 계약은 시작일과 종료일이 필요합니다.');
 if(out.start_date&&out.end_date&&out.end_date<out.start_date)throw Error('종료일은 시작일 이후여야 합니다.');
 if(out.notice_date&&out.end_date&&out.notice_date>out.end_date)throw Error('갱신거절 통보기한은 종료일 이내로 입력하세요.');
 if(out.payment_type==='분할'&&(out.deposit_pct===null||out.balance_pct===null||Math.abs(out.deposit_pct+out.balance_pct-100)>0.00001||!out.deposit_due||!out.balance_due))throw Error('분할 수금은 선금·잔금 합계 100%와 각각의 지급 기준·기한이 필요합니다.');
 if(out.payment_type==='후불'&&!out.balance_due)throw Error('후불 지급 기준·기한을 입력하세요. 예: 선적일로부터 30일 이내');
 if(out.payment_type==='전액 선입금'&&!out.deposit_due)throw Error('선입금 지급 기준·기한을 입력하세요. 예: 출고 전 전액 입금');
 if(out.foc_status==='있음'&&!out.foc_terms)throw Error('FOC 제공 비율·수량, 산정 기준과 적용 시점을 입력하세요.');
 return out;
}
function daysUntil(date,today){return validDate(date)&&validDate(today)?Math.round((Date.parse(date+'T00:00:00Z')-Date.parse(today+'T00:00:00Z'))/86400000):null;}
function effectiveStatus(row,today){return row.status==='유효'&&row.end_date&&row.end_date<today?'만료':row.status;}
function alerts(row,today){
 if(row.status!=='유효')return [];
 const result=[];const end=daysUntil(row.end_date,today),notice=daysUntil(row.notice_date,today);
 if(end!==null&&end>=0&&end<=90)result.push({kind:'expiry',days:end,label:`만료 ${end===0?'오늘':'D-'+end}`});
 if(notice!==null&&notice<=90&&(end===null||end>=0))result.push({kind:'notice',days:notice,label:notice<0?'통보기한 경과':`통보 ${notice===0?'오늘':'D-'+notice}`});
 return result;
}
function paymentSummary(row){if(row.payment_type==='분할')return `선금 ${row.deposit_pct??'?'}% (${row.deposit_due||'기한 미정'}) / 잔금 ${row.balance_pct??'?'}% (${row.balance_due||'기한 미정'})`;return [row.payment_type||'미확정',row.payment_type==='전액 선입금'?row.deposit_due:row.balance_due,row.payment_terms].filter(Boolean).join(' · ');}
function isBlank(value){return value===null||value===undefined||String(value).trim()==='';}
function isNotApplicable(row,key){return (row.foc_status==='없음'&&['foc_terms','foc_products','foc_limit'].includes(key))||(row.auto_renewal==='없음'&&['notice_date','renewal_terms'].includes(key))||(row.exclusive==='없음'&&key==='exclusivity_terms');}
function needsInput(row){return fields.some(([key])=>!['customer_id','name'].includes(key)&&isBlank(row[key])&&!isNotApplicable(row,key));}
function renderDetails(row,rows,documents,today){
 const sourceLinks=[...new Set((row.special_terms||'').match(/https:\/\/(?:drive\.google\.com|docs\.google\.com)\/[^\s<>"']+/g)||[])];
 const docButtons=[['document_id','계약서 서명본 열기'],['amendment_document_id','부속합의서 열기']].filter(([key])=>documents.some(d=>d.id===row[key])).map(([key,label])=>`<button class="btn btn-sm" data-contract-document="${esc(row[key])}">${label}</button>`).join('');
 const sections=groups.map(([title,list])=>{
  const entries=list.filter(([key])=>!['customer_id','name'].includes(key)).map(([key,label,type])=>{
   let value=key==='status'?effectiveStatus(row,today):row[key];if(key==='previous_contract_id'&&value)value=rows.find(r=>r.id===value)?.name||'이전 계약 확인 필요';
   if(type==='document'&&value)value=documents.find(d=>d.id===value)?.name||'연결된 서류 확인 필요';
   const blank=isBlank(value);
   const notApplicable=isNotApplicable(row,key);
   const display=blank?(notApplicable?'<span class="contract-not-applicable">해당 없음</span>':'<span class="contract-missing">입력 필요</span>'):esc(value)+(['deposit_pct','balance_pct'].includes(key)?'%':'')+(value==='미확정'?' <span class="contract-missing">확인 필요</span>':'');
   return `<div><dt>${esc(label)}</dt><dd>${display}</dd></div>`;
  }).filter(Boolean).join('');
  return entries?`<section class="contract-detail-section"><h4>${esc(title)}</h4><dl>${entries}</dl></section>`:'';
 }).join('');
 return `<div class="contract-detail-body"><div class="contract-detail-actions"><span>계약 원문과 확인 사항</span><div>${docButtons}${sourceLinks.map((url,i)=>`<a class="btn btn-sm" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Drive 자료 ${i+1} ↗</a>`).join('')}<button class="btn btn-primary btn-sm" data-contract-edit="${esc(row.id)}">계약 수정</button></div></div><p class="contracts-help">입력 필요: 등록된 값이 없습니다. 원문을 확인한 뒤 계약 수정에서 보완하세요. 원문에 없으면 추정하지 말고 미기재 여부를 확인하세요. 이전 계약·부속합의서는 해당하는 경우에 연결합니다. 서명본 연결 여부는 위 Drive 자료와 별도입니다.</p><div class="contract-detail-grid">${sections}</div></div>`;
}
function renderList({rows=[],customers=[],documents=[],today,filter={},expanded={}}){
 const names=new Map(customers.map(c=>[c.id,c.name]));
 const visible=rows.filter(r=>(!filter.customer||r.customer_id===filter.customer)&&(!filter.status||effectiveStatus(r,today)===filter.status)&&(!filter.q||[r.name,names.get(r.customer_id),r.manager].join(' ').toLowerCase().includes(filter.q.toLowerCase()))&&(!filter.urgent||alerts(r,today).length));
 const count=rows.filter(r=>alerts(r,today).length).length;
 const byCustomer=new Map();for(const r of visible){if(!byCustomer.has(r.customer_id))byCustomer.set(r.customer_id,[]);byCustomer.get(r.customer_id).push(r);}
 const metrics=[['등록 계약',rows.length+'건'],['등록 거래처',new Set(rows.map(r=>r.customer_id)).size+'곳'],['유효 상태',rows.filter(r=>effectiveStatus(r,today)==='유효').length+'건'],['기한 확인 필요',count+'건']];
 return `<div class="contract-metrics" aria-label="전체 계약 현황">${metrics.map(([label,value])=>`<div><span>${label}</span><strong>${value}</strong></div>`).join('')}</div><div class="contract-list-caption"><p>현재 표시 ${visible.length}건 · ${byCustomer.size}개 거래처</p><span>계약명을 클릭하면 상세 내용을 볼 수 있습니다</span></div><div class="contract-customer-list">${[...byCustomer].sort(([a],[b])=>(names.get(a)||'').localeCompare(names.get(b)||'','ko')).map(([id,list])=>`<section class="contract-customer-group"><header><h3>${esc(names.get(id)||'거래처 확인 필요')}</h3>${rows.some(r=>r.customer_id===id&&needsInput(r))?'<span class="contract-missing" data-contract-customer-missing>입력 필요</span>':''}<span>${list.length}건</span></header>${list.map(r=>`<details class="contract-row" data-contract-row="${esc(r.id)}"${expanded[r.id]?' open':''}><summary><span class="contract-arrow" aria-hidden="true">›</span><span class="contract-summary-name"><strong>${esc(r.name)}</strong><small>${esc(r.contract_type||'')} · ${esc(r.manager||'담당자 미지정')}${r.territory?' · '+esc(r.territory):''}</small></span><span class="contract-summary-status"><span class="badge ${effectiveStatus(r,today)==='유효'?'bg-green':'bg-gray'}">${esc(effectiveStatus(r,today)||'미확정')}</span>${alerts(r,today).map(a=>`<span class="badge bg-amber">${esc(a.label)}</span>`).join('')}</span><span class="contract-summary-terms"><span>${esc(r.start_date||'시작일 미확정')} ~ ${esc(r.end_date||'종료일 미확정')}</span><small>${esc(r.payment_type||'수금 미확정')}${r.currency?' · '+esc(r.currency):''} · FOC ${esc(r.foc_status||'미확정')}</small></span></summary>${renderDetails(r,rows,documents,today)}</details>`).join('')}</section>`).join('')||'<div class="contracts-empty">등록된 계약이 없거나 검색 결과가 없습니다.</div>'}</div><p class="contracts-help">등록·수정은 관리자 승인 후 반영됩니다. 초안·서명대기·확인 필요 사항은 각 계약에 표시됩니다.</p>`;
}
function createController({read,submit,onChange=()=>{}}){
 const state={rows:[],loading:false,saving:false,error:'',message:''};let generation=0,epoch=0;
 async function load(){const ticket=++generation;state.loading=true;state.error='';onChange(state);try{const rows=await read();if(ticket!==generation)return false;if(!Array.isArray(rows))throw Error('계약 목록 응답을 확인할 수 없습니다.');state.rows=rows;return true;}catch(e){if(ticket===generation)state.error='계약 조회 실패: '+e.message;return false;}finally{if(ticket===generation){state.loading=false;onChange(state);}}}
 async function save(raw,before=null){if(state.saving)return null;state.saving=true;state.error='';state.message='';const started=epoch;onChange(state);try{const values=normalize(raw);if(before?.id===values.previous_contract_id)throw Error('자기 자신을 이전 계약으로 선택할 수 없습니다.');const result=await submit({table:'contracts',action:before?'update':'insert',key:before?{id:before.id}:{},before:before?JSON.parse(JSON.stringify(before)):null,values});if(started!==epoch)return null;if(result){state.message='변경 요청이 접수됐습니다. 관리자 승인 후 반영됩니다.';}return result;}catch(e){if(started===epoch)state.error=e.message+' — 입력을 유지했습니다. 접수 여부가 불확실하면 변경 요청 목록을 확인하세요.';return null;}finally{if(started===epoch){state.saving=false;onChange(state);}}}
 function reset(){epoch++;generation++;Object.assign(state,{rows:[],loading:false,saving:false,error:'',message:''});onChange(state);}
 return {state,load,save,reset};
}
function mount({document,sb,client,getCustomers,getDocuments,openDocument,onMessage=()=>{},today=()=>new Date(Date.now()+9*3600000).toISOString().slice(0,10)}){
 let active=false,filter={},expanded=Object.create(null),dialog=null,editing=null,actor=null;
 const controller=createController({read:async()=>{let rows=[];for(let from=0;;from+=1000){const{data,error}=await sb.from('contracts').select('*').order('created_at',{ascending:false}).order('id').range(from,from+999);if(error)throw error;rows.push(...data);if(data.length<1000)return rows;}},submit:op=>client.submit([op]),onChange:paint});
 function paint(){
  if(!active)return;
  const host=document.getElementById('contracts-results');
  if(host)host.innerHTML=controller.state.loading?'<p role="status">계약서를 불러오는 중입니다…</p>':renderList({rows:controller.state.rows,customers:getCustomers(),documents:getDocuments(),today:today(),filter,expanded});
  const error=document.getElementById('contracts-error');if(error)error.textContent=controller.state.error;
  if(dialog){dialog.querySelector('[data-form-error]').textContent=controller.state.error;dialog.querySelector('[type="submit"]').disabled=controller.state.saving;dialog.querySelector('[data-close]').disabled=controller.state.saving;}
 }
 function show(customerId=''){
  active=true;filter={customer:customerId};
  document.getElementById('topbar-actions').innerHTML='<button class="btn" id="contracts-refresh">새로고침</button><button class="btn btn-primary" id="contracts-new">계약서 등록</button>';
  document.getElementById('content').innerHTML=`<section class="contracts"><div class="fb"><input id="contracts-q" aria-label="계약 검색" placeholder="거래처 / 계약명 / 담당자 검색"><select id="contracts-customer" aria-label="거래처 필터"><option value="">거래처 전체</option>${getCustomers().map(c=>`<option value="${esc(c.id)}"${c.id===customerId?' selected':''}>${esc(c.name)}</option>`).join('')}</select><select id="contracts-status" aria-label="계약 상태 필터"><option value="">상태 전체</option>${enums.status.map(s=>`<option>${s}</option>`).join('')}</select><label><input type="checkbox" id="contracts-urgent"> 기한 확인 필요</label></div><p id="contracts-error" role="alert" class="contracts-error"></p><div id="contracts-results"></div></section>`;
  document.getElementById('contracts-new').onclick=()=>open();
  document.getElementById('contracts-refresh').onclick=()=>controller.load();
  const update=()=>{filter={q:document.getElementById('contracts-q').value,customer:document.getElementById('contracts-customer').value,status:document.getElementById('contracts-status').value,urgent:document.getElementById('contracts-urgent').checked};paint();};
  document.getElementById('contracts-q').oninput=update;for(const key of ['customer','status','urgent'])document.getElementById('contracts-'+key).onchange=update;
  const results=document.getElementById('contracts-results');
  results.addEventListener('toggle',e=>{if(e.target.matches('[data-contract-row]')&&results.contains(e.target))expanded[e.target.dataset.contractRow]=e.target.open;},true);
  results.onclick=e=>{const button=e.target.closest('[data-contract-edit]');if(button)open(button.dataset.contractEdit);const docButton=e.target.closest('[data-contract-document]');if(docButton){const doc=getDocuments().find(d=>d.id===docButton.dataset.contractDocument);if(doc)openDocument(doc);}};
  controller.load();
 }
 function close(force=false){if(controller.state.saving&&!force)return;if(dialog){dialog.close();dialog.remove();dialog=null;}editing=null;}
 function open(id){
  close();const row=id?controller.state.rows.find(r=>r.id===id):null;if(id&&!row)return;
  editing=row?JSON.parse(JSON.stringify(row)):null;
  const value=row||{customer_id:filter.customer||'',status:'초안',contract_type:'공급'};
  dialog=document.createElement('dialog');dialog.className='contracts-dialog';dialog.setAttribute('aria-label',row?'계약서 상세 및 수정':'계약서 등록');
  const option=(val,text)=>`<option value="${esc(val)}">${esc(text)}</option>`;
  const input=([key,label,type])=>{
   let html;const attr=`id="contract-${key}" name="${key}"`;
   if(type==='select')html=`<select ${attr}>${enums[key].map(v=>option(v,v)).join('')}</select>`;
   else if(['customer','document','previous'].includes(type))html=`<select ${attr}>${option('','선택 안 함')}</select>`;
   else if(type==='textarea')html=`<textarea ${attr} rows="2" maxlength="4000"></textarea>`;
   else html=`<input ${attr} type="${type||'text'}"${type==='number'?' min="0" max="100" step="0.01"':type==='date'?' min="1900-01-01" max="9999-12-31"':' maxlength="4000"'}>`;
   return `<div class="fg ${type==='textarea'?'contract-full':''}"><label for="contract-${key}">${esc(label)}${['name','customer_id'].includes(key)?' *':''}</label>${html}${type==='document'?`<button type="button" class="btn btn-sm" data-open-document="${key}">선택한 서류 열기</button>`:''}</div>`;
  };
  dialog.innerHTML=`<form><header><h2>${row?'계약서 상세 / 수정':'계약서 등록'}</h2><button class="btn" type="button" data-close>닫기</button></header><p class="contracts-help">계약 약정을 입력하세요. 실제 입금 내역은 변경하지 않습니다. 저장은 관리자 승인 요청으로 접수됩니다.</p>${groups.map(([title,list])=>`<fieldset><legend>${title}</legend><div class="contract-grid">${list.map(input).join('')}</div></fieldset>`).join('')}<p class="contracts-help">원본은 서류 관리에 등록·승인된 해당 거래처의 계약서를 선택합니다. 갱신 계약은 새로 등록하고 이전 계약을 연결하세요.</p><p class="contracts-error" role="alert" data-form-error></p><footer><button type="submit" class="btn btn-primary">변경 요청 제출</button></footer></form>`;
  const form=dialog.querySelector('form');
  for(const [key]of fields){const el=form.elements.namedItem(key);if(!['customer_id','previous_contract_id','document_id','amendment_document_id'].includes(key))el.value=value[key]??(enums[key]?.[0]||'');}
  form.elements.namedItem('customer_id').innerHTML=option('','거래처 선택')+getCustomers().map(c=>option(c.id,c.name)).join('');
  form.elements.namedItem('customer_id').value=value.customer_id||'';
  function refreshLinks(initial=false){
   const custId=form.elements.namedItem('customer_id').value,cust=getCustomers().find(c=>c.id===custId);
   for(const key of ['document_id','amendment_document_id']){
    const el=form.elements.namedItem(key);el.innerHTML=option('','선택 안 함')+getDocuments().filter(d=>d.type==='계약서'&&d.customer===cust?.name).map(d=>option(d.id,d.name)).join('');
    const selected=initial?value[key]:'';if(selected&&!Array.from(el.options).some(o=>o.value===selected))el.insertAdjacentHTML('beforeend',option(selected,'기존 연결 서류 (서류 관리에서 확인)'));el.value=selected||'';
   }
   const el=form.elements.namedItem('previous_contract_id');el.innerHTML=option('','선택 안 함')+controller.state.rows.filter(r=>r.customer_id===custId&&r.id!==id).map(r=>option(r.id,r.name+' · '+(r.start_date||'기간 미정'))).join('');el.value=initial?(value.previous_contract_id||''):'';
  }
  refreshLinks(true);form.elements.namedItem('customer_id').onchange=()=>refreshLinks();
  dialog.querySelector('[data-close]').onclick=()=>close();dialog.addEventListener('cancel',e=>{e.preventDefault();close();});
  for(const type of ['keydown','paste'])dialog.addEventListener(type,e=>e.stopPropagation());
  dialog.querySelectorAll('[data-open-document]').forEach(btn=>{btn.onclick=()=>{const docId=form.elements.namedItem(btn.dataset.openDocument).value;const doc=getDocuments().find(d=>d.id===docId);if(doc)openDocument(doc);else onMessage('연결할 서류를 선택하세요.');};});
  form.addEventListener('submit',async e=>{e.preventDefault();const raw=Object.fromEntries(new FormData(form));const result=await controller.save(raw,editing);if(result){onMessage(controller.state.message);close();}});
  controller.state.error='';document.body.appendChild(dialog);dialog.showModal();form.elements.namedItem('name').focus();
 }
 sb.auth?.onAuthStateChange?.((_event,session)=>{const next=session?.user?.id||null;if(next!==actor){actor=next;expanded=Object.create(null);close(true);controller.reset();}});
 return {show,hide(){active=false;close();},open,controller};
}
return {normalize,daysUntil,effectiveStatus,alerts,paymentSummary,renderList,createController,mount,fields,enums};
});
