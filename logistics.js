(function(root,factory){const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;else root.LogisticsPage=api;})(typeof globalThis!=='undefined'?globalThis:this,function(root){
'use strict';
// 물류 요청 페이지. 데이터 계층(createApi), HTML 렌더링(render*), 화면 연결(mount). 규칙은 logistics-model.js.
const M=root.LogisticsModel||(typeof require==='function'?require('./logistics-model.js'):null);
const {esc}=M;
const BUCKET='logistics-docs',T='logistics_requests';
const opt=(map,sel)=>Object.entries(map).map(([k,v])=>`<option value="${esc(k)}"${k===sel?' selected':''}>${esc(v)}</option>`).join('');
const nameOf=(email,people)=>(people||[]).find(p=>p.email===String(email||'').toLowerCase())?.display_name||String(email||'').split('@')[0];
const storageName=n=>M.safeFileName(n).replace(/[^A-Za-z0-9._-]/g,'_');
const fmtDay=d=>d?String(d).slice(5).replace('-','/'):'미정';

const DAY=86400000,OPEN_STATUSES=['requested','accepted','preparing','on_hold'],CLOSED_STATUSES=['shipped','canceled'];
function createApi(client,{uuid,now=()=>Date.now()}={}){
 const newId=uuid||(()=>root.crypto.randomUUID());
 const need=async q=>{const {data,error}=await q;if(error)throw new Error(error.message||String(error));return data;};
 return {
  async loadAll(){
   // Supabase는 select를 1000행에서 조용히 자르므로 열린 요청과 최근 180일 닫힌 요청을 따로 받고, 첨부는 요청 id 묶음으로 받는다.
   const cutoff=new Date(now()-180*DAY).toISOString();
   const [open,closed,handlers,people,invoices]=await Promise.all([
    need(client.from(T).select('*').in('status_code',OPEN_STATUSES).order('created_at',{ascending:false}).limit(1000)),
    need(client.from(T).select('*').in('status_code',CLOSED_STATUSES).gte('created_at',cutoff).order('created_at',{ascending:false}).limit(1000)),
    need(client.from('logistics_handlers').select('email,display_name,is_active')),
    need(client.from('logistics_people').select('email,display_name')),
    need(client.from('invoices').select('id,no,customer').order('order_date',{ascending:false}).limit(500))]);
   const seen=new Set(),requests=[];
   for(const r of [...(open||[]),...(closed||[])])if(!seen.has(r.id)){seen.add(r.id);requests.push(r);}
   const ids=requests.map(r=>r.id),chunks=[];
   for(let i=0;i<ids.length;i+=100)chunks.push(ids.slice(i,i+100));
   const files=(await Promise.all(chunks.map(c=>need(client.from('logistics_request_files').select('*').in('request_id',c).order('created_at'))))).flat().filter(Boolean)
    .sort((a,b)=>String(a.created_at||'').localeCompare(String(b.created_at||'')));
   return {requests,files,handlers:(handlers||[]).filter(h=>h.is_active),people:people||[],invoices:invoices||[]};
  },
  async loadInvoice(id){
   const rows=await need(client.from('invoices').select('id,no,customer').eq('id',id));
   return Array.isArray(rows)?rows[0]||null:null;
  },
  async loadDetail(id){
   const [comments,history]=await Promise.all([
    need(client.from('logistics_request_comments').select('*').eq('request_id',id).order('created_at')),
    need(client.from('logistics_request_history').select('*').eq('request_id',id).order('changed_at'))]);
   return {comments:comments||[],history:history||[]};
  },
  async create(draft){
   const errors=M.validateDraft(draft);if(errors.length)throw new Error(errors.join(' '));
   const row=await need(client.from(T).insert(M.toInsertRow(draft)).select().single());
   if(!row?.id)throw new Error('UNCONFIRMED');return row;
  },
  async update(id,fromStatus,patch){
   const rows=await need(client.from(T).update(patch).eq('id',id).eq('status_code',fromStatus).select());
   if(!Array.isArray(rows)||rows.length!==1)throw new Error('STALE');return rows[0];
  },
  async uploadFile(requestId,file,kind){
   if(!file||file.size>M.LIMITS.fileBytes)throw new Error('파일은 20MB 이하만 올릴 수 있어요.');
   const path=`${requestId}/${newId()}-${storageName(file.name)}`;
   await need(client.storage.from(BUCKET).upload(path,file,{upsert:false}));
   try{
    const row=await need(client.from('logistics_request_files').insert({request_id:requestId,kind_code:kind,storage_path:path,name_text:String(file.name||'file').slice(0,200),size_bytes:file.size}).select().single());
    if(!row?.id)throw new Error('UNCONFIRMED');return row;
   }catch(e){try{await client.storage.from(BUCKET).remove([path]);}catch(_){} throw e;}
  },
  async removeFile(f){
   const gone=await need(client.storage.from(BUCKET).remove([f.storage_path]));
   if(!Array.isArray(gone)||gone.length!==1)throw new Error('UNCONFIRMED');
   const rows=await need(client.from('logistics_request_files').delete().eq('id',f.id).select());
   if(!Array.isArray(rows)||rows.length!==1)throw new Error('STALE');
  },
  async fileUrl(path){const d=await need(client.storage.from(BUCKET).createSignedUrl(path,300));return d?.signedUrl;},
  async addComment(requestId,body){
   const row=await need(client.from('logistics_request_comments').insert({request_id:requestId,body_text:body}).select().single());
   if(!row?.id)throw new Error('UNCONFIRMED');return row;
  },
  async deleteComment(id){
   const rows=await need(client.from('logistics_request_comments').delete().eq('id',id).select());
   if(!Array.isArray(rows)||rows.length!==1)throw new Error('STALE');
  }
 };
}

function renderList(rows,ctx){
 if(!rows.length)return '<p class="lg-empty">요청이 없어요.</p>';
 const fileCount=id=>(ctx.files||[]).filter(f=>f.request_id===id).length;
 return `<table class="lg-table"><thead><tr><th>유형</th><th>제목</th><th>거래처·수신처</th><th>요청자</th><th>희망일</th><th>운송</th><th>상태</th><th></th></tr></thead><tbody>${rows.map(r=>{
  const late=M.isLate(r,ctx.nowMs),n=fileCount(r.id);
  return `<tr class="lg-row${late?' late':''}" data-id="${esc(r.id)}"><td>${esc(M.TYPES[r.type_code])}</td><td>${esc(r.title_text)}</td><td>${esc(r.counterparty_text)}</td>
   <td>${esc(nameOf(r.requester_email,ctx.people))}</td><td>${esc(fmtDay(r.want_date))}${late?' <b class="lg-late">지연</b>':''}</td><td>${esc(M.SHIP_MODES[r.ship_mode_code])}</td>
   <td><span class="lg-st st-${esc(r.status_code)}">${esc(M.STATUSES[r.status_code])}</span></td>
   <td>${n?`📎 ${n}`:''}${r.slack_state_code==='failed'?' <span class="lg-warn">알림 실패</span>':''}</td></tr>`;}).join('')}</tbody></table>`;
}

function renderDetail(r,ctx){
 const owner=String(ctx.email||'').toLowerCase()===String(r.requester_email||'').toLowerCase();
 const next=M.allowedNext({isHandler:ctx.isHandler,isOwner:owner,from:r.status_code});
 const files=(ctx.files||[]).filter(f=>f.request_id===r.id);
 const inv=(ctx.invoices||[]).find(i=>i.id===r.invoice_id);
 const overseas=M.needsOverseas(r);
 const canEdit=(owner&&r.status_code==='requested')||(ctx.isHandler&&!M.CLOSED.includes(r.status_code));
 const field=(label,val)=>`<div class="lg-f"><span>${esc(label)}</span><b>${esc(val||'-')}</b></div>`;
 return `<div class="lg-detail" data-id="${esc(r.id)}">
 <h2>[${esc(M.TYPES[r.type_code])}] ${esc(r.title_text)} <span class="lg-st st-${esc(r.status_code)}">${esc(M.STATUSES[r.status_code])}</span></h2>
 ${field('거래처·수신처',r.counterparty_text)}${field('요청',nameOf(r.requester_email,ctx.people)+' · '+(M.TEAMS[r.team_code]||''))}
 ${field('희망 출고일',fmtDay(r.want_date))}${field('운송',M.SHIP_MODES[r.ship_mode_code])}${field('수량',r.qty_summary_text)}
 ${field('특이사항',r.note_text)}${field('연결 주문',inv?`${inv.no} ${inv.customer||''}`:'')}
 ${overseas?field('패킹리스트',M.PACKING[r.packing_code]||'')+field('ETD',r.etd_on)+field('포워더',r.forwarder_text):''}
 ${field('결과(송장·배차·BL)',r.result_text)}${field('출고일',r.shipped_on)}${r.status_note_text?field('사유',r.status_note_text):''}
 ${r.slack_state_code==='failed'?'<p class="lg-warn">슬랙 알림을 보내지 못했어요. 담당자에게 직접 알려 주세요.</p>':''}
 <div class="lg-actions">${next.map(to=>`<button type="button" class="lg-btn" data-to="${esc(to)}">${esc(M.STATUSES[to])}</button>`).join('')}
  ${canEdit?'<button type="button" class="lg-btn ghost" data-act="edit-summary">요약 수정</button>':''}
  ${ctx.isHandler&&r.status_code!=='canceled'?'<button type="button" class="lg-btn ghost" data-act="edit-result">결과 입력</button>':''}</div>
 <h3>첨부</h3><ul class="lg-files">${files.map(f=>`<li><a href="#" data-file="${esc(f.id)}">${esc(M.FILE_KINDS[f.kind_code])} · ${esc(f.name_text)}</a></li>`).join('')||'<li>없음</li>'}</ul>
 ${M.CLOSED.includes(r.status_code)?'':`<label class="lg-upload">파일 올리기 <select data-act="file-kind">${opt(M.FILE_KINDS,'request')}</select><input type="file" data-act="file"></label>`}
 <h3>댓글</h3><ul class="lg-comments">${(ctx.comments||[]).map(c=>`<li><b>${esc(nameOf(c.author_email,ctx.people))}</b> ${esc(c.body_text)} <time>${esc(String(c.created_at).slice(5,16).replace('T',' '))}</time></li>`).join('')}</ul>
 <form data-act="comment"><input name="body" maxlength="1000" placeholder="댓글"><button class="lg-btn ghost">남기기</button></form>
 <details><summary>변경 이력</summary><ul>${(ctx.history||[]).map(h=>`<li>${esc(String(h.changed_at).slice(5,16).replace('T',' '))} ${esc(h.field_code)} ${esc(h.from_text)} → ${esc(h.to_text)} (${esc(nameOf(h.changed_by_text,ctx.people))})</li>`).join('')}</ul></details>
 </div>`;
}

function renderForm(d,ctx){
 const edit=ctx.mode==='edit';
 const overseas=M.needsOverseas(d)&&(!edit||ctx.isHandler);
 return `<form class="lg-form" data-act="${edit?'edit':'create'}">
 <label>유형<select name="type_code">${opt({'':'선택',...M.TYPES},d.type_code||'')}</select></label>
 <label>제목<input name="title_text" maxlength="80" value="${esc(d.title_text)}"></label>
 <label>요청팀<select name="team_code">${opt({'':'선택',...M.TEAMS},d.team_code||'')}</select></label>
 <label>거래처·수신처<input name="counterparty_text" maxlength="120" value="${esc(d.counterparty_text)}"></label>
 <label>희망 출고일<input type="date" name="want_date" value="${esc(d.want_date)}"> <small>비워 두면 미정</small></label>
 <label>운송 방식<select name="ship_mode_code">${opt({'':'선택',...M.SHIP_MODES},d.ship_mode_code||'')}</select></label>
 <label>수량 요약<input name="qty_summary_text" maxlength="300" value="${esc(d.qty_summary_text)}" placeholder="예: 12 SKU, 3,240ea"></label>
 <label>특이사항<textarea name="note_text" maxlength="1000">${esc(d.note_text)}</textarea></label>
 <label>연결 주문<select name="invoice_id"><option value="">없음</option>${(ctx.invoices||[]).map(i=>`<option value="${esc(i.id)}"${i.id===d.invoice_id?' selected':''}>${esc(i.no)} ${esc(i.customer||'')}</option>`).join('')}</select></label>
 ${overseas?`<fieldset><legend>해외 출고</legend>
  <label>패킹리스트<select name="packing_code">${opt({'':'-',...M.PACKING},d.packing_code||'')}</select></label>
  <label>ETD<input type="date" name="etd_on" value="${esc(d.etd_on)}"></label>
  <label>포워더<input name="forwarder_text" maxlength="120" value="${esc(d.forwarder_text)}"></label></fieldset>`:''}
 ${edit?'':'<label>첨부(출고요청서 등)<input type="file" name="files" multiple></label>'}
 <p class="lg-error" role="alert"></p>
 <button type="submit" class="lg-btn">${edit?'수정 저장':'요청 올리기'}</button>${edit?' <button type="button" class="lg-btn ghost" data-act="cancel-edit">취소</button>':''}</form>`;
}

return {createApi,renderList,renderDetail,renderForm,mount:(...a)=>mount(...a)};
function mount({document,client,now=()=>Date.now(),confirm=(m)=>root.confirm(m),prompt=(m,v)=>root.prompt(m,v),location=root.location,open=(u)=>root.open(u,'_blank')}){
 const $=id=>document.getElementById(id);
 const api=createApi(client,{now});
 const state={email:'',isHandler:false,data:{requests:[],files:[],handlers:[],people:[],invoices:[]},tab:'todo',q:'',selected:null,detail:{comments:[],history:[]},busy:false,draft:{},formMode:'create'};
 let generation=0;
 const say=t=>{$('lg-message').textContent=t||'';};
 const ctx=()=>({email:state.email,isHandler:state.isHandler,nowMs:now(),files:state.data.files,people:state.data.people,invoices:state.data.invoices,...state.detail});
 function setBusy(v){state.busy=v;for(const b of ($('lg-detail').querySelectorAll?.('button')||[]))b.disabled=v;const sb=$('lg-form').querySelector?.('button[type=submit]');if(sb)sb.disabled=v;}
 const current=()=>state.data.requests.find(r=>r.id===state.selected);

 function drawTabs(){for(const b of ($('lg-tabs').querySelectorAll?.('button')||[]))b.setAttribute?.('aria-selected',String(b.dataset?.tab===state.tab));}
 function drawList(){drawTabs();
  const rows=M.search(M.filterTab(state.data.requests,state.tab,{email:state.email,nowMs:now()}),state.q);
  $('lg-list').innerHTML=renderList(rows,ctx());
 }
 function drawDetail(){const r=current();$('lg-detail').innerHTML=r?renderDetail(r,ctx()):'';if(state.busy)setBusy(true);}
 async function openDetail(id){
  state.selected=id;state.detail={comments:[],history:[]};
  const g=generation,r0=current();
  if(r0?.invoice_id&&!state.data.invoices.some(i=>i.id===r0.invoice_id)){
   try{const inv=await api.loadInvoice(r0.invoice_id);if(g!==generation||state.selected!==id)return;if(inv)state.data.invoices=[...state.data.invoices,inv];}catch(e){say(M.errorMessage(e));}
  }
  drawDetail();
  try{const d=await api.loadDetail(id);if(g!==generation||state.selected!==id)return;state.detail=d;drawDetail();}catch(e){say(M.errorMessage(e));}
 }
 async function reload(){
  const g=++generation;
  const data=await api.loadAll();if(g!==generation)return;
  state.data=data;state.isHandler=M.isHandler(state.email,data.handlers);
  $('lg-me').textContent=state.email+(state.isHandler?' · 물류 담당':'');
  drawList();if(state.selected){if(!current())say('요청을 찾지 못했어요.');await openDetail(state.selected);}
 }
 async function changeStatus(id,to){
  if(state.busy)return;const r=state.data.requests.find(x=>x.id===id);if(!r)return;
  const owner=state.email===String(r.requester_email||'').toLowerCase();
  const patch={status_code:to};
  if(to==='shipped'){
   const result=prompt('송장번호·배차정보·BL을 적어 주세요.',r.result_text||'');if(result==null)return;
   const day=prompt('출고일(YYYY-MM-DD)',M.kstToday(now()));if(day==null)return;
   Object.assign(patch,{result_text:result.trim(),shipped_on:day.trim()});
  }
  if(to==='on_hold'||(r.status_code==='shipped'&&to==='preparing')||to==='canceled'){
   const note=prompt(to==='canceled'?'취소 사유(선택)':'사유를 적어 주세요.','');if(note==null)return;patch.status_note_text=note.trim();
  }
  const check=M.checkTransition({isHandler:state.isHandler,isOwner:owner,from:r.status_code,to,fields:{...r,...patch}});
  if(!check.ok){say(check.reason);return;}
  setBusy(true);say('저장 중…');
  try{await api.update(id,r.status_code,patch);say('저장했어요.');await reload();}
  catch(e){say(M.errorMessage(e));}
  finally{setBusy(false);}
 }
 async function editResult(id){
  if(state.busy)return;const r=current();if(!r||r.id!==id)return;
  const result=prompt('결과(송장·배차·BL)',r.result_text||'');if(result==null)return;
  const fee=prompt('퀵비(원, 없으면 비움)',r.quick_fee_krw??'');if(fee==null)return;
  if(fee.trim()!==''&&!/^[0-9]+$/.test(fee.trim().replace(/,/g,''))){say('퀵비는 숫자로 적어 주세요.');return;}
  const patch={result_text:result.trim(),quick_fee_krw:fee.trim()===''?null:Number(fee.replace(/,/g,'').trim())};
  if(M.needsOverseas(r)){
   const etd=prompt('ETD(YYYY-MM-DD, 없으면 비움)',r.etd_on||'');if(etd==null)return;if(etd.trim()&&!M.isDate(etd.trim())){say('ETD는 YYYY-MM-DD 형식으로 적어 주세요.');return;}patch.etd_on=etd.trim()||null;
   const pk=prompt('패킹리스트: waiting(대기)/done(작성완료)/replied(거래처회신), 없으면 비움',r.packing_code||'');if(pk==null)return;if(pk.trim()&&!['waiting','done','replied'].includes(pk.trim())){say('패킹리스트는 waiting, done, replied 중 하나로 적어 주세요.');return;}patch.packing_code=pk.trim()||null;
  }
  setBusy(true);
  try{await api.update(id,r.status_code,patch);say('저장했어요.');await reload();}catch(e){say(M.errorMessage(e));}finally{setBusy(false);}
 }
 function readForm(form){const d={};for(const el of form.querySelectorAll('[name]'))if(el.type!=='file')d[el.name]=el.value;return d;}
 function drawForm(){$('lg-form').innerHTML=renderForm(state.draft,{invoices:state.data.invoices,mode:state.formMode,isHandler:state.isHandler});$('lg-form').hidden=false;}
 function closeForm(){state.draft={};state.formMode='create';$('lg-form').hidden=true;}
 const SUMMARY=['type_code','title_text','team_code','counterparty_text','want_date','ship_mode_code','qty_summary_text','note_text','invoice_id'];
 async function submitEdit(form){
  if(state.busy)return;const r=current();if(!r)return;
  const draft=readForm(form);const errors=M.validateDraft(draft);
  const errEl=form.querySelector('.lg-error');if(errors.length){if(errEl)errEl.textContent=errors.join(' ');return;}
  const row=M.toInsertRow(draft),patch={};
  for(const k of SUMMARY)patch[k]=row[k];
  if(state.isHandler)for(const k of ['packing_code','etd_on','forwarder_text'])patch[k]=row[k];
  setBusy(true);say('수정 내용을 저장하는 중…');
  try{await api.update(r.id,r.status_code,patch);closeForm();say('저장했어요.');await reload();}
  catch(e){if(errEl)errEl.textContent=M.errorMessage(e);say('');}
  finally{setBusy(false);}
 }
 async function submitForm(form){
  if(state.busy)return;const draft=readForm(form);const errors=M.validateDraft(draft);
  const errEl=form.querySelector('.lg-error');if(errors.length){if(errEl)errEl.textContent=errors.join(' ');return;}
  setBusy(true);say('요청을 올리는 중…');
  let row=null;
  try{
   row=await api.create(draft);const failed=[];
   const input=form.querySelector('input[type=file]');
   for(const f of Array.from(input?.files||[])){try{await api.uploadFile(row.id,f,'request');}catch(e){failed.push(f.name);}}
   closeForm();state.tab='mine';state.selected=row.id;
   say(failed.length?`요청은 올라갔고, ${failed.join(', ')} 파일은 올리지 못했어요. 상세에서 다시 올려 주세요.`:'요청을 올렸어요. 슬랙에도 곧 알림이 가요.');
   await reload();
  }catch(e){if(row)say('요청은 올라갔어요. 목록을 새로고침해 주세요. ('+M.errorMessage(e)+')');else{if(errEl)errEl.textContent=M.errorMessage(e);say('');}}
  finally{setBusy(false);}
 }

 $('lg-list').addEventListener('click',ev=>{const tr=ev.target.closest?.('tr[data-id]');if(tr)openDetail(tr.dataset.id);});
 $('lg-detail').addEventListener('click',async ev=>{
  const t=ev.target;const r=current();if(!r)return;
  if(t.dataset?.to){changeStatus(r.id,t.dataset.to);return;}
  if(t.dataset?.act==='edit-result'){editResult(r.id);return;}
  if(t.dataset?.act==='edit-summary'){state.formMode='edit';state.draft={...r};drawForm();return;}
  if(t.dataset?.file){ev.preventDefault();const f=state.data.files.find(x=>x.id===t.dataset.file);if(f){
   const w=open('about:blank'); // 클릭 안에서 먼저 창을 열어야 Safari가 팝업으로 막지 않는다
   try{const u=await api.fileUrl(f.storage_path);if(!u)throw new Error('UNCONFIRMED');
    if(!w){say('팝업이 막혀 파일을 열지 못했어요. 팝업을 허용해 주세요.');return;}
    try{w.opener=null;}catch(_){} w.location.href=u;
   }catch(e){try{w?.close();}catch(_){} say(M.errorMessage(e));}
  }}
 });
 $('lg-detail').addEventListener('change',async ev=>{
  const t=ev.target;const r=current();if(!r||t.dataset?.act!=='file'||!t.files?.[0])return;
  const kind=t.closest('.lg-upload')?.querySelector('[data-act=file-kind]')?.value||'etc';
  if(state.busy)return;setBusy(true);
  try{await api.uploadFile(r.id,t.files[0],kind);say('파일을 올렸어요.');await reload();}catch(e){say(M.errorMessage(e));}finally{try{t.value='';}catch(_){}setBusy(false);}
 });
 $('lg-detail').addEventListener('submit',async ev=>{
  ev.preventDefault();const r=current();const input=ev.target.querySelector('[name=body]');const body=(input?.value||'').trim();
  if(!r||!body||state.busy)return;setBusy(true);
  try{await api.addComment(r.id,body);input.value='';await openDetail(r.id);}catch(e){say(M.errorMessage(e));}finally{setBusy(false);}
 });
 $('lg-form').addEventListener('change',ev=>{if(['type_code','ship_mode_code'].includes(ev.target.name)){state.draft=readForm($('lg-form').querySelector('form')||$('lg-form'));drawForm();}});
 $('lg-form').addEventListener('submit',ev=>{ev.preventDefault();return ev.target.dataset?.act==='edit'?submitEdit(ev.target):submitForm(ev.target);});
 $('lg-form').addEventListener('click',ev=>{if(ev.target.dataset?.act==='cancel-edit'){closeForm();$('lg-form').innerHTML='';}});
 $('lg-new').addEventListener('click',()=>{state.formMode='create';state.draft={team_code:'',want_date:''};drawForm();});
 $('lg-search').addEventListener('input',ev=>{state.q=ev.target.value;drawList();});
 $('lg-tabs').addEventListener('click',ev=>{const tab=ev.target.dataset?.tab;if(tab){state.tab=tab;drawList();}});
 $('lg-google').addEventListener('click',async()=>{try{const {error}=await client.auth.signInWithOAuth({provider:'google',options:{redirectTo:location.href,queryParams:{hd:'entropymakeup.com'}}});if(error)say(M.errorMessage(error));}catch(e){say(M.errorMessage(e));}});

 let first=true;
 async function start(){
  const g=++generation;let session=null;
  try{
   const {data,error}=await client.auth.getSession();if(g!==generation)return;if(error)throw error;
   session=data?.session;
  }catch(e){$('lg-login').hidden=false;$('lg-app').hidden=true;say('로그인을 확인하지 못했어요. '+M.errorMessage(e));return;}
  if(!session){$('lg-login').hidden=false;$('lg-app').hidden=true;return;}
  state.email=String(session.user?.email||'').toLowerCase();
  $('lg-login').hidden=true;$('lg-app').hidden=false;
  if(first){first=false;const id=new URLSearchParams(location.search||'').get('id');if(id)state.selected=id;}
  drawTabs();
  try{await reload();}catch(e){say(M.errorMessage(e));}
 }
 client.auth.onAuthStateChange(ev=>{if(ev==='SIGNED_OUT'){generation++;state.email='';state.isHandler=false;state.data={requests:[],files:[],handlers:[],people:[],invoices:[]};state.selected=null;state.detail={comments:[],history:[]};state.draft={};state.formMode='create';state.busy=false;state.tab='todo';state.q='';$('lg-list').innerHTML='';$('lg-detail').innerHTML='';$('lg-form').innerHTML='';$('lg-form').hidden=true;$('lg-me').textContent='';say('');$('lg-login').hidden=false;$('lg-app').hidden=true;}else if(ev==='SIGNED_IN')setTimeout(start,0);});
 const ready=start();
 return {ready,state,reload,changeStatus,openDetail};
}
});
