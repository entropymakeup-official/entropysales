(function(root,factory){const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;else root.SupportPage=api;})(typeof globalThis!=='undefined'?globalThis:this,function(root){
'use strict';
// 경영지원 요청 화면(대시보드 "경영지원" 탭과 support.html). 데이터 계층(createApi), 렌더링(render*), 화면 연결(mountTab).
// 규칙은 support-model.js, 화면 모양은 logistics.css의 lg-* 클래스를 같이 쓰고 요소 id만 sp-*로 둔다(물류 탭과 겹치지 않게).
const M=root.SupportModel||(typeof require==='function'?require('./support-model.js'):null);
const {esc}=M;
const BUCKET='support-docs',T='support_requests';
const opt=(map,sel)=>Object.entries(map).map(([k,v])=>`<option value="${esc(k)}"${k===sel?' selected':''}>${esc(v)}</option>`).join('');
const nameOf=(email,people)=>String(email||'')==='system'?'시스템':(people||[]).find(p=>p.email===String(email||'').toLowerCase())?.display_name||String(email||'').split('@')[0];
const storageName=n=>M.safeFileName(n).replace(/[^A-Za-z0-9._-]/g,'_');
const fmtDay=d=>d?String(d).slice(5).replace('-','/'):'미정';
const DAY=86400000,HOUR=3600000,KST=9*HOUR;

function createApi(client,{uuid,now=()=>Date.now()}={}){
 const newId=uuid||(()=>root.crypto.randomUUID());
 const need=async q=>{const {data,error}=await q;if(error)throw new Error(error.message||String(error));return data;};
 return {
  async loadAll(){
   // select는 1000행에서 잘리므로 열린 요청과 최근 180일 닫힌 요청을 따로 받는다. 첨부는 RLS가 요청자·담당자 것만 준다.
   const cutoff=new Date(now()-180*DAY).toISOString();
   const [open,closed,handlers,people,invoices]=await Promise.all([
    need(client.from(T).select('*').in('status_code',M.OPEN).order('created_at',{ascending:false}).limit(1000)),
    need(client.from(T).select('*').in('status_code',M.CLOSED).gte('created_at',cutoff).order('created_at',{ascending:false}).limit(1000)),
    need(client.from('support_handlers').select('email,display_name,is_active')),
    need(client.from('logistics_people').select('email,display_name')),
    need(client.from('invoices').select('id,no,customer').order('order_date',{ascending:false}).limit(500))]);
   const seen=new Set(),requests=[];
   for(const r of [...(open||[]),...(closed||[])])if(!seen.has(r.id)){seen.add(r.id);requests.push(r);}
   const ids=requests.map(r=>r.id),chunks=[];
   for(let i=0;i<ids.length;i+=100)chunks.push(ids.slice(i,i+100));
   const files=(await Promise.all(chunks.map(c=>need(client.from('support_request_files').select('*').in('request_id',c).order('created_at'))))).flat().filter(Boolean)
    .sort((a,b)=>String(a.created_at||'').localeCompare(String(b.created_at||'')));
   return {requests,files,handlers:(handlers||[]).filter(h=>h.is_active),people:people||[],invoices:invoices||[]};
  },
  async loadDetail(id){
   const [comments,history]=await Promise.all([
    need(client.from('support_request_comments').select('*').eq('request_id',id).order('created_at')),
    need(client.from('support_request_history').select('*').eq('request_id',id).order('changed_at'))]);
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
    const row=await need(client.from('support_request_files').insert({request_id:requestId,kind_code:kind,storage_path:path,name_text:String(file.name||'file').slice(0,200),size_bytes:file.size}).select().single());
    if(!row?.id)throw new Error('UNCONFIRMED');return row;
   }catch(e){try{await client.storage.from(BUCKET).remove([path]);}catch(_){} throw e;}
  },
  // 행을 먼저 지운다: 완료 중 마지막 발급본처럼 DB가 막는 경우 파일은 남아야 한다.
  async removeFile(f){
   const rows=await need(client.from('support_request_files').delete().eq('id',f.id).select());
   if(!Array.isArray(rows)||rows.length!==1)throw new Error('STALE');
   const gone=await need(client.storage.from(BUCKET).remove([f.storage_path]));
   if(!Array.isArray(gone)||gone.length!==1)throw new Error('UNCONFIRMED');
  },
  async fileUrl(path){const d=await need(client.storage.from(BUCKET).createSignedUrl(path,300));return d?.signedUrl;},
  async addComment(requestId,body){
   const row=await need(client.from('support_request_comments').insert({request_id:requestId,body_text:body}).select().single());
   if(!row?.id)throw new Error('UNCONFIRMED');return row;
  },
  async deleteComment(id){
   const rows=await need(client.from('support_request_comments').delete().eq('id',id).select());
   if(!Array.isArray(rows)||rows.length!==1)throw new Error('STALE');
  }
 };
}

// ── 순수 렌더링(테스트 대상) ──
const STATUS_BADGE={requested:'bg-blue',in_progress:'bg-amber',done:'bg-green',on_hold:'bg-coral',canceled:'bg-gray'};
const TAB_LABELS={todo:'처리할 일',hold:'보류',done:'완료',canceled:'취소',mine:'내 요청'};
const HISTORY_LABELS={created:'등록',status:'상태',due_date:'기한',result:'결과',invoice:'연결 주문'};
const EMPTY_TEXT={todo:'처리할 요청이 없어요.',hold:'보류 중인 요청이 없어요.',done:'최근 30일 완료가 없어요.',canceled:'취소된 요청이 없어요.',mine:'내가 올린 요청이 없어요.'};
const kstTime=v=>{const t=Date.parse(v);return Number.isFinite(t)?new Date(t+KST).toISOString().slice(5,16).replace('T',' ').replace('-','/'):String(v||'');};
const pendingKey=p=>p?p.kind+':'+(p.to||''):'';
const badge=code=>`<span class="badge lg-st st-${esc(code)} ${STATUS_BADGE[code]||'bg-gray'}">${esc(M.STATUSES[code]||code)}</span>`;
const sizeText=b=>!b?'':b<1024*1024?Math.max(1,Math.round(b/1024))+'KB':(b/1024/1024).toFixed(1)+'MB';
const resultCount=(files,id)=>(files||[]).filter(f=>f.request_id===id&&f.kind_code==='result').length;

function renderTabs(active,counts){
 return Object.entries(TAB_LABELS).map(([k,v])=>`<button type="button" role="tab" class="tab${active===k?' active':''}" data-tab="${k}" aria-selected="${active===k}">${esc(v)}${counts&&counts[k]!=null?` <span class="lg-count">${esc(counts[k])}</span>`:''}</button>`).join('');
}
function renderList(rows,ctx){
 if(!rows.length)return `<div class="lg-empty"><p>${esc(ctx.q?'검색 결과가 없어요.':(EMPTY_TEXT[ctx.tab]||'요청이 없어요.'))}</p>${ctx.q?'':'<button type="button" class="btn btn-primary" data-act="new"><i class="ti ti-plus"></i> 새 요청</button>'}</div>`;
 const people=[...(ctx.people||[]),...(ctx.handlers||[])];
 return `<div class="tw"><table class="lg-table"><thead><tr><th>종류</th><th>제목</th><th>거래처·제출처</th><th>기한</th><th>요청자</th><th>상태</th></tr></thead><tbody>${rows.map(r=>{
  const late=M.isLate(r,ctx.nowMs),n=resultCount(ctx.files,r.id);
  return `<tr class="lg-row${late?' late':''}" data-open="${esc(r.id)}"><td class="lg-nowrap">${esc(M.TYPES[r.type_code]||r.type_code)}</td>`
   +`<td class="lg-title-cell"><button type="button" class="lg-link" data-open="${esc(r.id)}">${esc(r.title_text)}</button>${n?` <span class="lg-muted" title="발급본 ${n}개"><i class="ti ti-file-check"></i>${n}</span>`:''}${r.slack_state_code==='failed'?' <span class="badge bg-red lg-warn" title="슬랙 알림을 보내지 못했어요">알림 실패</span>':''}</td>`
   +`<td>${esc(r.counterparty_text)}</td><td class="lg-nowrap${late?' lg-late':''}">${esc(fmtDay(r.due_date))}${late?' · 지남':''}</td>`
   +`<td class="lg-nowrap">${esc(nameOf(r.requester_email,people))}</td><td>${badge(r.status_code)}</td></tr>`;}).join('')}</tbody></table></div>`;
}

function renderPending(r,p){
 if(!p)return '';
 const v=(name,def)=>p.values&&name in p.values?p.values[name]:def;
 const ta=(name,label,val,max,opts='')=>`<div class="fg lg-wide"><label for="sp-p-${name}">${label}</label><textarea id="sp-p-${name}" name="${name}" maxlength="${max}"${opts}>${esc(v(name,val))}</textarea></div>`;
 let title,body='';
 if(p.kind==='result'){title='결과 수정';body=ta('result_text','결과 <small>승인번호 등 · 슬랙에 보여요</small>',r.result_text||'',M.LIMITS.result,' data-autofocus');}
 else{
  const to=p.to;title=`${M.STATUSES[to]}(으)로 바꾸기`;
  if(to==='done')body+=ta('result_text','결과 <small>선택 · 승인번호 등 · 슬랙에 보여요</small>',r.result_text||'',M.LIMITS.result,' data-autofocus');
  if(M.needsNote(r.status_code,to))body+=ta('status_note_text','사유 <small>필수</small>','',M.LIMITS.statusNote,' required data-autofocus');
  else if(to==='canceled')body+=ta('status_note_text','취소 사유 <small>선택</small>','',M.LIMITS.statusNote,' data-autofocus');
 }
 return `<form class="lg-pending" data-form="${p.kind==='result'?'result':'status'}" data-key="${esc(pendingKey(p))}" novalidate><h4>${esc(title)}</h4><div class="lg-form-grid">${body}</div>`
  +`<div class="lg-row-btns"><button type="button" class="btn" data-act="pending-cancel">그만두기</button><button type="submit" class="btn btn-primary">저장</button></div></form>`;
}

function renderDetail(r,ctx){
 const people=[...(ctx.people||[]),...(ctx.handlers||[])];
 const me=String(ctx.email||'').toLowerCase();
 const owner=me===String(r.requester_email||'').toLowerCase();
 const canSeeFiles=ctx.isHandler||owner;
 const next=M.allowedNext({isHandler:ctx.isHandler,isOwner:owner,from:r.status_code});
 const files=(ctx.files||[]).filter(f=>f.request_id===r.id);
 const inv=(ctx.invoices||[]).find(i=>i.id===r.invoice_id);
 const closed=M.CLOSED.includes(r.status_code),late=M.isLate(r,ctx.nowMs);
 const canEdit=(owner&&r.status_code==='requested')||(ctx.isHandler&&!closed);
 const canResult=ctx.isHandler&&r.status_code!=='canceled';
 const canUpload=r.status_code!=='canceled'&&(ctx.isHandler||(owner&&!closed));
 const field=(label,val,cls='')=>`<div class="lg-f${cls}"><dt>${esc(label)}</dt><dd>${esc(val||'-')}</dd></div>`;
 const canDelFile=f=>ctx.isHandler||(String(f.created_by||'').toLowerCase()===me&&!closed);
 const canDelComment=c=>String(c.author_email||'').toLowerCase()===me&&ctx.nowMs-Date.parse(c.created_at)<24*HOUR;
 const pendingTo=ctx.pending?.to;
 const needResult=ctx.isHandler&&next.includes('done')&&!resultCount(files,r.id);
 return `<header class="lg-dh"><div><p class="lg-kicker">${esc(M.TYPES[r.type_code]||r.type_code)}</p><h2 id="sp-detail-title">${esc(r.title_text)}</h2></div><button type="button" class="btn" data-act="close-detail">닫기</button></header>`
 +`<div class="lg-status">${badge(r.status_code)}${late?' <span class="badge bg-red">기한 지남</span>':''}${r.slack_state_code==='failed'?' <span class="badge bg-red lg-warn">알림 실패</span> <span class="lg-muted">슬랙 알림을 보내지 못했어요. 담당자에게 직접 알려 주세요.</span>':''}</div>`
 +(ctx.note?`<p class="lg-note" role="status">${esc(ctx.note)}</p>`:'')
 +`<dl class="lg-fields">${field('거래처·제출처',r.counterparty_text)}${field('요청',nameOf(r.requester_email,people))}`
 +`${field('필요 기한',fmtDay(r.due_date)+(late?' (지남)':''),late?' lg-late':'')}${field('작성일·기준일',r.issue_date)}${field('금액',r.amount_text)}`
 +`${field('연결 주문',inv?`${inv.no} ${inv.customer||''}`:(r.invoice_id?'목록에 없는 주문':''))}${field('요청 내용',r.note_text,' lg-wide')}`
 +`${field('결과(승인번호 등)',r.result_text,' lg-wide')}${r.done_at?field('완료',kstTime(r.done_at)):''}${r.status_note_text?field('사유',r.status_note_text,' lg-wide'):''}</dl>`
 +((next.length||canEdit||canResult)?`<section class="lg-sec"><h3>처리</h3><div class="lg-actions">${next.map(to=>`<button type="button" class="btn${pendingTo===to?' btn-primary':''}" data-to="${esc(to)}">${esc(M.STATUSES[to])}</button>`).join('')}`
  +`${canEdit?'<button type="button" class="btn" data-act="edit-summary"><i class="ti ti-pencil"></i> 요약 수정</button>':''}${canResult?'<button type="button" class="btn" data-act="edit-result">결과 수정</button>':''}</div>`
  +(needResult?'<p class="lg-hint">완료하려면 아래 첨부에서 종류를 "발급본"으로 골라 파일을 먼저 올려 주세요.</p>':'')
  +renderPending(r,ctx.pending)+`</section>`:'')
 +(ctx.error?`<p class="lg-error" role="alert">${esc(ctx.error)}</p>`:'')
 +`<section class="lg-sec"><h3>첨부${canSeeFiles?` <span class="lg-count">${files.length}</span>`:''}</h3>`
 +(canSeeFiles?`<ul class="lg-files">${files.map(f=>`<li><button type="button" class="lg-link" data-file="${esc(f.id)}"><i class="ti ti-file${f.kind_code==='result'?'-check':''}"></i> ${esc(M.FILE_KINDS[f.kind_code]||'기타')} · ${esc(f.name_text)}</button> <span class="lg-muted">${esc(sizeText(f.size_bytes))}</span>${canDelFile(f)?` <button type="button" class="btn btn-sm" data-file-del="${esc(f.id)}" aria-label="${esc(f.name_text)} 지우기">지우기</button>`:''}</li>`).join('')||'<li class="lg-muted">첨부가 없어요.</li>'}</ul>`
  +(canUpload?`<div class="lg-upload"><select id="sp-file-kind" aria-label="올릴 파일 종류">${opt(M.fileKindsFor(ctx.isHandler),ctx.isHandler&&!closed&&r.status_code!=='requested'?'result':'request')}</select><label class="btn"><input type="file" id="sp-file-input" data-act="file" class="lg-sr"><i class="ti ti-upload"></i> 파일 올리기</label><span class="lg-muted">파일당 20MB, 요청당 10개까지</span></div>`:'')
  :'<p class="lg-muted">첨부는 요청자와 경영지원 담당자만 볼 수 있어요.</p>')+`</section>`
 +`<section class="lg-sec"><h3>댓글 <span class="lg-count">${(ctx.comments||[]).length}</span></h3>${ctx.loading?'<p class="lg-muted">불러오는 중…</p>':''}<ul class="lg-comments">${(ctx.comments||[]).map(c=>`<li><div class="lg-cmeta"><b>${esc(nameOf(c.author_email,people))}</b> <time>${esc(kstTime(c.created_at))}</time>${canDelComment(c)?` <button type="button" class="lg-link lg-del" data-comment-del="${esc(c.id)}">지우기</button>`:''}</div><p>${esc(c.body_text)}</p></li>`).join('')}</ul>`
 +`<form class="lg-comment-form" data-form="comment"><input id="sp-comment-body" name="body" maxlength="${M.LIMITS.comment}" value="${esc(ctx.commentDraft||'')}" placeholder="댓글을 남겨 주세요" aria-label="댓글"><button type="submit" class="btn">남기기</button></form></section>`
 +`<details class="lg-sec lg-history"><summary>변경 이력 ${(ctx.history||[]).length}건</summary><ol>${(ctx.history||[]).map(h=>{
   const show=v=>h.field_code==='status'?(M.STATUSES[v]||v):(v||'없음');
   return `<li>${esc(kstTime(h.changed_at))} · ${esc(nameOf(h.changed_by_text,people))} · ${esc(HISTORY_LABELS[h.field_code]||h.field_code)}${h.field_code==='created'?'':`: ${esc(show(h.from_text))} → ${esc(show(h.to_text))}`}</li>`;}).join('')}</ol></details>`;
}

function renderForm(d,ctx){
 const edit=ctx.mode==='edit';
 const fg=(name,label,input,wide)=>`<div class="fg${wide?' lg-wide':''}"><label for="sp-f-${name}">${label}</label>${input}</div>`;
 const id=n=>`id="sp-f-${n}" name="${n}"`;
 return `<form class="lg-form" data-form="${edit?'edit':'create'}" novalidate><header class="lg-dh"><h2>${edit?'요약 수정':'새 경영지원 요청'}</h2><button type="button" class="btn" data-act="close-form">닫기</button></header>`
 +`<div class="lg-form-grid">${fg('type_code','서류 종류',`<select ${id('type_code')}>${opt({'':'선택',...M.TYPES},d.type_code||'')}</select>`)}`
 +fg('due_date','필요 기한 <small>비워 두면 미정</small>',`<input type="date" ${id('due_date')} value="${esc(d.due_date||'')}">`)
 +fg('title_text','제목',`<input ${id('title_text')} maxlength="${M.LIMITS.title}" value="${esc(d.title_text||'')}" placeholder="예: 데모거래처 11월 세금계산서">`,true)
 +fg('counterparty_text','거래처·제출처',`<input ${id('counterparty_text')} maxlength="${M.LIMITS.counterparty}" value="${esc(d.counterparty_text||'')}">`,true)
 +fg('amount_text','금액 <small>선택 · 통화 포함</small>',`<input ${id('amount_text')} maxlength="${M.LIMITS.amount}" value="${esc(d.amount_text||'')}" placeholder="예: 공급가 12,000,000원 + VAT">`)
 +fg('issue_date','작성일·기준일 <small>선택</small>',`<input type="date" ${id('issue_date')} value="${esc(d.issue_date||'')}">`)
 +fg('note_text','요청 내용',`<textarea ${id('note_text')} maxlength="${M.LIMITS.note}" placeholder="품목·사업자번호·제출처 요구사항 등">${esc(d.note_text||'')}</textarea>`,true)
 +fg('invoice_id','연결 주문 <small>선택</small>',`<select ${id('invoice_id')}><option value="">없음</option>${d.invoice_id&&!(ctx.invoices||[]).some(i=>i.id===d.invoice_id)?`<option value="${esc(d.invoice_id)}" selected>현재 연결 주문(목록에 없음)</option>`:''}${(ctx.invoices||[]).map(i=>`<option value="${esc(i.id)}"${i.id===d.invoice_id?' selected':''}>${esc(i.no)} ${esc(i.customer||'')}</option>`).join('')}</select>`,true)
 +`</div>`
 +(edit?'':fg('files','첨부 <small>발주서·CI 등 근거 · 요청자와 담당자만 봐요 · 파일당 20MB</small>','<input type="file" id="sp-f-files" name="files" multiple>',true))
 +`<p class="lg-error" id="sp-form-error" role="alert"></p>`
 +`<footer class="lg-row-btns"><button type="button" class="btn" data-act="close-form">취소</button><button type="submit" class="btn btn-primary">${edit?'수정 저장':'요청 올리기'}</button></footer></form>`;
}

// ── 화면 연결 ──
function mountTab({document,client,onMessage=()=>{},now=()=>Date.now(),confirm=m=>root.confirm(m),open=u=>root.open(u,'_blank'),pageUrl=''}){
 const $=id=>document.getElementById(id);
 const api=createApi(client,{now});
 const EMPTY=()=>({requests:[],files:[],handlers:[],people:[],invoices:[]});
 const state={active:false,loaded:false,loading:false,error:'',email:'',isHandler:false,data:EMPTY(),tab:'todo',q:'',
  selected:null,detail:{comments:[],history:[]},detailLoading:false,pending:null,detailError:'',detailNote:'',busy:false,form:null,editTarget:null,pendingOpen:null,ready:Promise.resolve(),commentDraft:'',renderedId:null};
 let generation=0;
 const say=t=>{if(t)onMessage(t);};
 const current=()=>state.data.requests.find(r=>r.id===state.selected);
 const ctx=()=>({email:state.email,isHandler:state.isHandler,nowMs:now(),files:state.data.files,people:state.data.people,handlers:state.data.handlers,invoices:state.data.invoices});
 const buttons=el=>el?.querySelectorAll?.('button')||[];
 function setBusy(v){state.busy=v;for(const id of ['sp-detail','sp-form'])for(const b of buttons($(id)))b.disabled=v;}
 const dlgOpen=d=>{if(d&&!d.open){try{d.showModal();}catch(_){d.setAttribute?.('open','');}}};
 const dlgClose=d=>{if(d?.open){try{d.close();}catch(_){d.removeAttribute?.('open');}}};

 function paint(){
  if(!state.active)return;
  const t=$('sp-tabs'),nowMs=now();
  if(t){const c={};for(const key of Object.keys(TAB_LABELS))c[key]=M.filterTab(state.data.requests,key,{email:state.email,nowMs}).length;t.innerHTML=renderTabs(state.tab,state.loaded?c:null);}
  drawList();
 }
 function drawList(){
  const host=$('sp-list');if(!state.active||!host)return;
  if(state.error){host.innerHTML=`<div class="card"><div class="lg-empty"><p class="lg-error" role="alert">${esc(state.error)}</p><button type="button" class="btn" data-act="refresh">다시 불러오기</button></div></div>`;return;}
  if(!state.loaded){host.innerHTML='<div class="card"><p class="lg-empty lg-muted" role="status">경영지원 요청을 불러오는 중…</p></div>';return;}
  const rows=M.search(M.filterTab(state.data.requests,state.tab,{email:state.email,nowMs:now()}),state.q);
  host.innerHTML=`<div class="card"><div class="card-hd"><h3>${esc(TAB_LABELS[state.tab])} <span class="lg-count">${rows.length}건</span></h3></div>`
   +renderList(rows,{...ctx(),tab:state.tab,q:state.q})+`</div>`;
 }
 function readForm(form){const d={};for(const el of form.querySelectorAll('[name]'))if(el.type!=='file')d[el.name]=el.value;return d;}
 function captureInputs(){
  const d=$('sp-detail');if(!d||!state.selected||state.renderedId!==state.selected)return;
  const pf=d.querySelector?.('form.lg-pending');
  if(pf&&state.pending&&pf.dataset?.key===pendingKey(state.pending))state.pending.values=readForm(pf);
  const cb=$('sp-comment-body');if(cb&&typeof cb.value==='string')state.commentDraft=cb.value;
 }
 function drawDetail(){
  const d=$('sp-detail'),r=current();if(!d||!r)return;
  captureInputs();
  d.innerHTML=renderDetail(r,{...ctx(),...state.detail,loading:state.detailLoading,pending:state.pending,error:state.detailError,note:state.detailNote,commentDraft:state.commentDraft});
  state.renderedId=r.id;
  if(state.busy)setBusy(true);
 }
 function focusPending(){try{$('sp-detail')?.querySelector?.('[data-autofocus]')?.focus?.();}catch(_){}}
 function closeDetail(){state.selected=null;state.renderedId=null;state.commentDraft='';state.pending=null;state.detailError='';state.detailNote='';state.detail={comments:[],history:[]};const d=$('sp-detail');dlgClose(d);if(d)d.innerHTML='';}
 function closeForm(){state.form=null;state.editTarget=null;const f=$('sp-form');dlgClose(f);if(f)f.innerHTML='';}

 async function openDetail(id,{keep=false}={}){
  if(!state.active)return;
  const same=state.selected===id;
  state.selected=id;
  if(!keep||!same){captureInputs();state.pending=null;state.detailError='';state.detailNote='';state.commentDraft='';state.renderedId=null;}
  if(!current()){closeDetail();say('요청을 찾지 못했어요. 닫힌 지 180일이 지났거나 지워진 요청일 수 있어요.');return;}
  state.detail={comments:[],history:[]};state.detailLoading=true;
  const g=generation;
  drawDetail();dlgOpen($('sp-detail'));
  try{const det=await api.loadDetail(id);if(g!==generation||state.selected!==id)return;state.detail=det;}
  catch(e){if(g!==generation||state.selected!==id)return;state.detailError='댓글과 이력을 불러오지 못했어요: '+(e?.message||e);}
  state.detailLoading=false;drawDetail();
 }
 async function load(){
  const g=++generation;state.loading=true;state.error='';paint();
  try{
   const {data,error}=await client.auth.getSession();if(g!==generation)return;if(error)throw error;
   const email=String(data?.session?.user?.email||'').toLowerCase();
   if(!email)throw new Error('로그인 정보를 확인하지 못했어요. 다시 로그인해 주세요.');
   const d=await api.loadAll();if(g!==generation)return;
   state.email=email;state.data=d;state.isHandler=M.isHandler(email,d.handlers);state.loaded=true;
  }catch(e){if(g!==generation)return;state.error='경영지원 요청을 불러오지 못했어요. '+(e?.message||e);}
  state.loading=false;paint();
  if(!state.active)return;
  if(state.selected&&state.loaded)await openDetail(state.selected,{keep:true});
  if(state.pendingOpen&&state.loaded){const id=state.pendingOpen;state.pendingOpen=null;await openDetail(id);}
 }
 function reload(){return state.ready=load();}
 const isStale=e=>/STALE/.test(String(e?.message||e||''));
 const STALE_TEXT='다른 사람이 먼저 바꿨어요. 최신 내용을 다시 불러왔으니 확인하고 다시 해 주세요.';
 const fail=msg=>{state.detailError=msg;drawDetail();};
 async function detailFail(e){
  if(!isStale(e)){fail(M.errorMessage(e));return;}
  state.detailError=STALE_TEXT;captureInputs();
  await reload();
  const r=current(),p=state.pending;
  if(r&&p?.kind==='status'&&!M.allowedNext({isHandler:state.isHandler,isOwner:state.email===String(r.requester_email||'').toLowerCase(),from:r.status_code}).includes(p.to)){state.pending=null;drawDetail();}
 }
 async function run(fn,note){
  if(state.busy)return;
  setBusy(true);
  try{await fn();state.detailError='';state.detailNote=note;say(note);await reload();}
  catch(e){await detailFail(e);}
  finally{setBusy(false);}
 }

 function chooseStatus(to){
  const r=current();if(!r||state.busy)return;
  if(to==='done'||to==='canceled'||M.needsNote(r.status_code,to)){
   if(to==='done'&&!resultCount(state.data.files,r.id))return fail(M.errorMessage('SUPPORT_RESULT_FILE_REQUIRED'));
   state.pending={kind:'status',to};state.detailError='';drawDetail();focusPending();return;
  }
  return saveStatus(r,to,{});
 }
 function saveStatus(r,to,fields){
  const owner=state.email===String(r.requester_email||'').toLowerCase();
  const patch={status_code:to,...fields};
  const check=M.checkTransition({isHandler:state.isHandler,isOwner:owner,from:r.status_code,to,fields:{...r,...patch},resultFiles:resultCount(state.data.files,r.id)});
  if(!check.ok)return fail(check.reason);
  return run(async()=>{await api.update(r.id,r.status_code,patch);state.pending=null;},`${M.STATUSES[to]}(으)로 바꿨어요.`);
 }
 function submitStatus(form){
  const r=current(),p=state.pending;if(!r||!p||p.kind!=='status'||state.busy)return;
  const v=readForm(form),fields={};p.values=v;
  if(p.to==='done')fields.result_text=String(v.result_text||'').trim();
  if(M.needsNote(r.status_code,p.to)||p.to==='canceled')fields.status_note_text=String(v.status_note_text||'').trim();
  return saveStatus(r,p.to,fields);
 }
 function submitResult(form){
  const r=current();if(!r||state.pending?.kind!=='result'||state.busy)return;
  const v=readForm(form);state.pending.values=v;
  return run(async()=>{await api.update(r.id,r.status_code,{result_text:String(v.result_text||'').trim()});state.pending=null;},'결과를 저장했어요.');
 }

 function openForm(mode,draft){
  const f=$('sp-form');if(!state.active||!f)return;
  state.form={mode};
  f.innerHTML=renderForm(draft,{invoices:state.data.invoices,mode});dlgOpen(f);
  try{f.querySelector?.('select,input')?.focus?.();}catch(_){}
 }
 function openNew(){if(!state.active||!state.loaded)return;state.editTarget=null;openForm('create',{});}
 function openEdit(){const r=current();if(!r)return;state.editTarget={id:r.id,status_code:r.status_code};openForm('edit',{...r});}
 const formError=t=>{const el=$('sp-form-error');if(el)el.textContent=t||'';};
 async function submitEdit(form){
  if(state.busy)return;const t=state.editTarget;if(!t)return;
  const draft=readForm(form),errors=M.validateDraft(draft);
  if(errors.length)return formError(errors.join(' '));
  setBusy(true);formError('');
  try{await api.update(t.id,t.status_code,M.toInsertRow(draft));closeForm();state.detailNote='요약을 저장했어요.';say(state.detailNote);await reload();}
  catch(e){
   if(!isStale(e)){formError(M.errorMessage(e));return;}
   formError(STALE_TEXT);await reload();
   const fresh=state.data.requests.find(x=>x.id===t.id);
   if(fresh&&state.editTarget===t)t.status_code=fresh.status_code;else if(!fresh)formError('요청을 찾지 못했어요. 창을 닫고 목록을 확인해 주세요.');
  }
  finally{setBusy(false);}
 }
 async function submitCreate(form){
  if(state.busy)return;
  const draft=readForm(form),errors=M.validateDraft(draft);
  if(errors.length)return formError(errors.join(' '));
  const picked=Array.from($('sp-f-files')?.files||[]);
  setBusy(true);formError('');
  let row=null;
  try{
   row=await api.create(draft);const failed=[];
   for(const f of picked){try{await api.uploadFile(row.id,f,'request');}catch(e){failed.push(f.name);}}
   closeForm();state.tab='mine';state.selected=row.id;state.pending=null;state.detailError='';
   state.detailNote=failed.length?`요청은 올라갔고, ${failed.join(', ')} 파일은 올리지 못했어요. 아래 첨부에서 다시 올려 주세요.`:'요청을 올렸어요. 슬랙에도 곧 알림이 가요.';
   say(state.detailNote);
   await reload();
  }catch(e){if(row)say('요청은 올라갔어요. 목록을 새로고침해 주세요. ('+M.errorMessage(e)+')');else formError(M.errorMessage(e));}
  finally{setBusy(false);}
 }

 async function openFile(fid){
  const f=state.data.files.find(x=>x.id===fid);if(!f)return;
  const w=open('about:blank'); // 클릭 안에서 먼저 창을 열어야 팝업으로 막히지 않는다
  try{
   const u=await api.fileUrl(f.storage_path);if(!u)throw new Error('UNCONFIRMED');
   if(!w){fail('팝업이 막혀 파일을 열지 못했어요. 팝업을 허용해 주세요.');return;}
   try{w.opener=null;}catch(_){} w.location.href=u;
  }catch(e){try{w?.close();}catch(_){} fail(M.errorMessage(e));}
 }
 function deleteFile(fid){
  const f=state.data.files.find(x=>x.id===fid);if(!f||state.busy)return;
  if(!confirm(`'${f.name_text}' 파일을 지울까요? 되돌릴 수 없어요.`))return;
  return run(()=>api.removeFile(f),'파일을 지웠어요.');
 }
 function uploadFile(input){
  const r=current(),file=input.files?.[0];if(!r||!file)return;
  if(state.busy){try{input.value='';}catch(_){}return;}
  const kind=$('sp-file-kind')?.value||'etc';
  return run(()=>api.uploadFile(r.id,file,kind),kind==='result'?'발급본을 올렸어요.':'파일을 올렸어요.').finally(()=>{try{input.value='';}catch(_){}});
 }
 async function addComment(){
  const r=current(),input=$('sp-comment-body'),body=String(input?.value||'').trim();
  if(!r||!body||state.busy)return;
  setBusy(true);
  try{await api.addComment(r.id,body);if(input)input.value='';state.commentDraft='';state.detailError='';state.detailNote='';await openDetail(r.id,{keep:true});}
  catch(e){await detailFail(e);}
  finally{setBusy(false);}
 }
 async function deleteComment(cid){
  const r=current();if(!r||state.busy)return;
  if(!confirm('이 댓글을 지울까요? 되돌릴 수 없어요.'))return;
  setBusy(true);
  try{await api.deleteComment(cid);state.detailError='';state.detailNote='댓글을 지웠어요.';await openDetail(r.id,{keep:true});}
  catch(e){await detailFail(e);}
  finally{setBusy(false);}
 }

 function onClick(e){
  const at=s=>e.target?.closest?.(s);let el;
  if((el=at('[data-tab]'))){state.tab=el.dataset.tab;paint();return;}
  if((el=at('[data-act]'))){
   const act=el.dataset.act;
   if(act==='new')return openNew();
   if(act==='refresh')return reload();
   if(act==='close-detail'){if(!state.busy)closeDetail();return;}
   if(act==='close-form'){if(!state.busy)closeForm();return;}
   if(act==='pending-cancel'){state.pending=null;state.detailError='';drawDetail();return;}
   if(act==='edit-summary')return openEdit();
   if(act==='edit-result'){if(state.busy)return;state.pending={kind:'result'};state.detailError='';drawDetail();focusPending();return;}
   return;
  }
  if((el=at('[data-to]')))return chooseStatus(el.dataset.to);
  if((el=at('[data-file-del]')))return deleteFile(el.dataset.fileDel);
  if((el=at('[data-file]'))){e.preventDefault?.();return openFile(el.dataset.file);}
  if((el=at('[data-comment-del]')))return deleteComment(el.dataset.commentDel);
  if((el=at('[data-open]')))return openDetail(el.dataset.open);
 }
 function onChange(e){if(e.target?.dataset?.act==='file')return uploadFile(e.target);}
 function onInput(e){
  if(e.target?.id==='sp-search'){state.q=e.target.value;drawList();return;}
  if(e.target?.id==='sp-comment-body')state.commentDraft=e.target.value;
 }
 function onSubmit(e){
  e.preventDefault?.();
  const form=e.target,kind=form?.dataset?.form;
  if(kind==='create')return submitCreate(form);
  if(kind==='edit')return submitEdit(form);
  if(kind==='status')return submitStatus(form);
  if(kind==='result')return submitResult(form);
  if(kind==='comment')return addComment();
 }

 function show(){
  state.active=true;state.form=null;state.editTarget=null;state.renderedId=null;
  $('topbar-actions').innerHTML='<button type="button" class="btn btn-primary" id="sp-new"><i class="ti ti-plus"></i> 새 요청</button><button type="button" class="btn" id="sp-refresh"><i class="ti ti-refresh"></i> 새로고침</button>'
   +(pageUrl?`<a class="btn" id="sp-standalone" href="${esc(pageUrl)}" target="_blank" rel="noopener"><i class="ti ti-external-link"></i> 별도 페이지로 열기</a>`:'');
  $('content').innerHTML='<section class="lg sp"><p class="lg-hint">세금계산서·구매확인서처럼 공인인증서가 필요한 서류를 경영지원팀에 요청해요. 완료되면 발급본이 첨부되고 슬랙으로 알려 드려요.</p>'
   +'<div class="lg-bar"><nav class="tab-bar lg-tabs" id="sp-tabs" role="tablist" aria-label="경영지원 요청 보기"></nav><input type="search" id="sp-search" class="lg-search" placeholder="제목·거래처·승인번호 검색" aria-label="경영지원 요청 검색"></div>'
   +'<div id="sp-list"></div>'
   +'<dialog class="lg-dialog" id="sp-detail" aria-labelledby="sp-detail-title"></dialog><dialog class="lg-dialog lg-form-dialog" id="sp-form" aria-label="경영지원 요청 입력"></dialog></section>';
  const search=$('sp-search');if(search)search.value=state.q;
  $('sp-new').onclick=()=>openNew();
  $('sp-refresh').onclick=()=>{if(state.active)reload();};
  const c=$('content');c.onclick=onClick;c.onchange=onChange;c.oninput=onInput;c.onsubmit=onSubmit;
  const d=$('sp-detail'),f=$('sp-form');
  d.oncancel=e=>{e.preventDefault?.();if(state.busy||state.form)return;closeDetail();};
  f.oncancel=e=>{e.preventDefault?.();if(state.busy)return;closeForm();};
  for(const el of [d,f]){el.onkeydown=e=>e.stopPropagation?.();el.onpaste=e=>e.stopPropagation?.();}
  paint();
  return reload();
 }
 function hide(){
  if(!state.active)return;
  state.active=false;closeForm();closeDetail();state.pendingOpen=null;
  const c=$('content');if(c){c.onclick=null;c.onchange=null;c.oninput=null;c.onsubmit=null;}
  const tb=$('topbar-actions');if(tb&&String(tb.innerHTML||'').includes('id="sp-new"'))tb.innerHTML='';
 }
 function openRequest(id){
  if(!id)return state.ready;
  if(!state.active||state.loading||!state.loaded){state.pendingOpen=id;return state.ready;}
  return openDetail(id);
 }
 client.auth?.onAuthStateChange?.((ev,session)=>{
  if(ev==='SIGNED_OUT'){hide();generation++;Object.assign(state,{loaded:false,loading:false,error:'',email:'',isHandler:false,data:EMPTY(),tab:'todo',q:'',busy:false});}
  else if(ev==='SIGNED_IN'&&state.active&&String(session?.user?.email||'').toLowerCase()!==state.email)reload();
 });
 return {show,hide,reload,openRequest,state,changeStatus:chooseStatus,openDetail};
}

return {createApi,renderTabs,renderList,renderDetail,renderForm,mountTab};
});
