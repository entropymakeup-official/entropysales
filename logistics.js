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

function createApi(client,{uuid}={}){
 const newId=uuid||(()=>root.crypto.randomUUID());
 const need=async q=>{const {data,error}=await q;if(error)throw new Error(error.message||String(error));return data;};
 return {
  async loadAll(){
   const [requests,files,handlers,people,invoices]=await Promise.all([
    need(client.from(T).select('*').order('created_at',{ascending:false}).limit(2000)),
    need(client.from('logistics_request_files').select('*').order('created_at')),
    need(client.from('logistics_handlers').select('email,display_name,is_active')),
    need(client.from('logistics_people').select('email,display_name')),
    need(client.from('invoices').select('id,no,customer').order('order_date',{ascending:false}).limit(500))]);
   return {requests:requests||[],files:files||[],handlers:(handlers||[]).filter(h=>h.is_active),people:people||[],invoices:invoices||[]};
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
   await need(client.storage.from(BUCKET).remove([f.storage_path]));
   await need(client.from('logistics_request_files').delete().eq('id',f.id));
  },
  async fileUrl(path){const d=await need(client.storage.from(BUCKET).createSignedUrl(path,300));return d?.signedUrl;},
  async addComment(requestId,body){
   const row=await need(client.from('logistics_request_comments').insert({request_id:requestId,body_text:body}).select().single());
   if(!row?.id)throw new Error('UNCONFIRMED');return row;
  },
  async deleteComment(id){await need(client.from('logistics_request_comments').delete().eq('id',id));}
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
 const field=(label,val)=>`<div class="lg-f"><span>${esc(label)}</span><b>${esc(val||'-')}</b></div>`;
 return `<div class="lg-detail" data-id="${esc(r.id)}">
 <h2>[${esc(M.TYPES[r.type_code])}] ${esc(r.title_text)} <span class="lg-st st-${esc(r.status_code)}">${esc(M.STATUSES[r.status_code])}</span></h2>
 ${field('거래처·수신처',r.counterparty_text)}${field('요청',nameOf(r.requester_email,ctx.people)+' · '+M.TEAMS[r.team_code])}
 ${field('희망 출고일',fmtDay(r.want_date))}${field('운송',M.SHIP_MODES[r.ship_mode_code])}${field('수량',r.qty_summary_text)}
 ${field('특이사항',r.note_text)}${field('연결 주문',inv?`${inv.no} ${inv.customer||''}`:'')}
 ${overseas?field('패킹리스트',M.PACKING[r.packing_code]||'')+field('ETD',r.etd_on)+field('포워더',r.forwarder_text):''}
 ${field('결과(송장·배차·BL)',r.result_text)}${field('출고일',r.shipped_on)}${r.status_note_text?field('사유',r.status_note_text):''}
 ${r.slack_state_code==='failed'?'<p class="lg-warn">슬랙 알림을 보내지 못했어요. 담당자에게 직접 알려 주세요.</p>':''}
 <div class="lg-actions">${next.map(to=>`<button type="button" class="lg-btn" data-to="${esc(to)}">${esc(M.STATUSES[to])}</button>`).join('')}
  ${ctx.isHandler&&r.status_code!=='canceled'?'<button type="button" class="lg-btn ghost" data-act="edit-result">결과 입력</button>':''}</div>
 <h3>첨부</h3><ul class="lg-files">${files.map(f=>`<li><a href="#" data-file="${esc(f.id)}">${esc(M.FILE_KINDS[f.kind_code])} · ${esc(f.name_text)}</a></li>`).join('')||'<li>없음</li>'}</ul>
 ${M.CLOSED.includes(r.status_code)?'':`<label class="lg-upload">파일 올리기 <select data-act="file-kind">${opt(M.FILE_KINDS,'request')}</select><input type="file" data-act="file"></label>`}
 <h3>댓글</h3><ul class="lg-comments">${(ctx.comments||[]).map(c=>`<li><b>${esc(nameOf(c.author_email,ctx.people))}</b> ${esc(c.body_text)} <time>${esc(String(c.created_at).slice(5,16).replace('T',' '))}</time></li>`).join('')}</ul>
 <form data-act="comment"><input name="body" maxlength="1000" placeholder="댓글"><button class="lg-btn ghost">남기기</button></form>
 <details><summary>변경 이력</summary><ul>${(ctx.history||[]).map(h=>`<li>${esc(String(h.changed_at).slice(5,16).replace('T',' '))} ${esc(h.field_code)} ${esc(h.from_text)} → ${esc(h.to_text)} (${esc(nameOf(h.changed_by_text,ctx.people))})</li>`).join('')}</ul></details>
 </div>`;
}

function renderForm(d,ctx){
 const overseas=M.needsOverseas(d);
 return `<form class="lg-form" data-act="create">
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
 <label>첨부(출고요청서 등)<input type="file" name="files" multiple></label>
 <p class="lg-error" role="alert"></p>
 <button class="lg-btn">요청 올리기</button></form>`;
}

return {createApi,renderList,renderDetail,renderForm,mount:(...a)=>mount(...a)};
function mount(){throw new Error('mount는 Task 6에서 구현');}
});
