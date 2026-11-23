(function(root,factory){const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;else root.LogisticsPage=api;})(typeof globalThis!=='undefined'?globalThis:this,function(root){
'use strict';
// 영업 대시보드의 물류 요청 탭. 데이터 계층(createApi), 계산·HTML 렌더링(summarize·render*), 탭 연결(mountTab). 규칙은 logistics-model.js.
const M=root.LogisticsModel||(typeof require==='function'?require('./logistics-model.js'):null);
const F=root.FasstoForms||(typeof require==='function'?require('./fassto-forms.js'):null);
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
  },
  // 파스토 상품 목록. select가 1000행에서 잘리므로 1000행씩 나눠 받는다.
  async loadStock(){
   const rows=[];
   for(let from=0;from<20000;from+=1000){
    const page=(await need(client.from('logistics_fassto_stock').select('product_code,barcode,product_name,kind_text,lot_text,expires_on,available_qty').order('id').range(from,from+999)))||[];
    rows.push(...page);if(page.length<1000)break;
   }
   const sync=await need(client.from('logistics_fassto_sync').select('synced_at,source_text,row_count').order('synced_at',{ascending:false}).limit(1));
   return {rows,sync:Array.isArray(sync)?sync[0]||null:null};
  },
  // 볼 권한이 없으면 RLS가 빈 결과를 준다(null). 볼 수 없음과 입력 안 됨은 화면이 요청자·담당자 여부로 나눈다.
  async loadRecipient(id){
   const rows=await need(client.from('logistics_request_recipients').select('*').eq('request_id',id));
   return Array.isArray(rows)?rows[0]||null:null;
  },
  async loadItems(id){return (await need(client.from('logistics_request_items').select('*').eq('request_id',id).order('line_no')))||[];},
  // 요청자는 담당자 칸을 빼고 보낸다: F.toRecipientRow(values,{isHandler}) 가 만든 행만 넘길 것.
  async saveRecipient(id,row){
   const rows=await need(client.from('logistics_request_recipients').upsert({...row,request_id:id},{onConflict:'request_id'}).select());
   if(!Array.isArray(rows)||rows.length!==1)throw new Error('UNCONFIRMED');return rows[0];
  },
  // 품목은 통째로 바꾼다(DB 함수 하나 = 한 트랜잭션). 돌려준 줄 수가 보낸 줄 수와 같아야 성공이다.
  async saveItems(id,items){
   const rows=F.toItemRows(items);
   const n=await need(client.rpc('logistics_replace_items',{p_request:id,p_items:rows}));
   if(Number(n)!==rows.length)throw new Error('UNCONFIRMED');return rows.length;
  }
 };
}

// ── 순수 계산·렌더링(테스트 대상) ──
const HOUR=3600000,KST=9*HOUR;
const STATUS_BADGE={requested:'bg-blue',accepted:'bg-teal',preparing:'bg-amber',shipped:'bg-green',on_hold:'bg-coral',canceled:'bg-gray'};
const TAB_LABELS={todo:'처리할 일',hold:'보류',shipped:'출고완료',canceled:'취소',mine:'내 요청'};
const QUICK_LABELS={late:'희망일 지남',today:'오늘 출고 예정',week:'이번 주 출고완료'};
const HISTORY_LABELS={created:'등록',status:'상태',want_date:'희망일',result:'결과',packing:'패킹리스트',invoice:'연결 주문'};
const EMPTY_TEXT={todo:'처리할 요청이 없어요.',hold:'보류 중인 요청이 없어요.',shipped:'최근 30일 출고완료가 없어요.',canceled:'취소된 요청이 없어요.',mine:'내가 올린 요청이 없어요.',late:'희망일이 지난 요청이 없어요.',today:'오늘 출고 예정인 요청이 없어요.',week:'이번 주 출고완료가 없어요.'};
const addDays=(day,n)=>{const [y,m,d]=day.split('-').map(Number);return new Date(Date.UTC(y,m-1,d+n)).toISOString().slice(0,10);};
const kstTime=v=>{const t=Date.parse(v);return Number.isFinite(t)?new Date(t+KST).toISOString().slice(5,16).replace('T',' ').replace('-','/'):String(v||'');};
const pendingKey=p=>p?p.kind+':'+(p.to||''):'';
const needsNote=(from,to)=>to==='on_hold'||(from==='shipped'&&to==='preparing');
const badge=code=>`<span class="badge lg-st st-${esc(code)} ${STATUS_BADGE[code]||'bg-gray'}">${esc(M.STATUSES[code]||code)}</span>`;
const won=n=>n==null||n===''?'':Number(n).toLocaleString('ko-KR')+'원';
const sizeText=b=>!b?'':b<1024*1024?Math.max(1,Math.round(b/1024))+'KB':(b/1024/1024).toFixed(1)+'MB';

// 이번 주(KST 월~일)
function kstWeek(nowMs){
 const today=M.kstToday(nowMs),dow=new Date(today+'T00:00:00Z').getUTCDay();
 const start=addDays(today,dow===0?-6:1-dow);
 return {start,end:addDays(start,6)};
}
const QUICK={
 late:(r,{nowMs})=>M.isLate(r,nowMs),
 today:(r,{today})=>M.OPEN.includes(r.status_code)&&r.want_date===today,
 week:(r,{week})=>r.status_code==='shipped'&&String(r.shipped_on||'')>=week.start&&String(r.shipped_on||'')<=week.end
};
function summarize(requests,nowMs){
 const c={nowMs,today:M.kstToday(nowMs),week:kstWeek(nowMs)},list=requests||[];
 return {todo:list.filter(r=>['requested','accepted','preparing'].includes(r.status_code)).length,
  late:list.filter(r=>QUICK.late(r,c)).length,today:list.filter(r=>QUICK.today(r,c)).length,week:list.filter(r=>QUICK.week(r,c)).length};
}
// 탭(todo/hold/shipped/canceled/mine) 또는 KPI 필터(late/today/week) + 검색
function listView(requests,{tab='todo',quick='',q='',email='',nowMs}={}){
 let rows;
 if(QUICK[quick]){
  const c={nowMs,today:M.kstToday(nowMs),week:kstWeek(nowMs)};
  rows=(requests||[]).filter(r=>QUICK[quick](r,c));
  rows=quick==='week'?rows.sort((a,b)=>String(b.shipped_on).localeCompare(String(a.shipped_on))):M.sortRequests(rows);
 }else rows=M.filterTab(requests||[],tab,{email,nowMs});
 return M.search(rows,q);
}

function renderKpis(counts,active){
 const card=(key,label,sub,val,warn)=>`<button type="button" class="kpi lg-kpi${active===key?' on':''}${warn&&val?' warn':''}" data-kpi="${key}" aria-pressed="${active===key}"><span class="lbl">${esc(label)}</span><span class="val">${esc(val)}</span><span class="sub">${esc(sub)}</span></button>`;
 return card('todo','처리할 일','요청·접수·준비중',counts.todo)+card('late','희망일 지남','출고 전, 보류 포함',counts.late,true)
  +card('today','오늘 출고 예정','희망 출고일이 오늘',counts.today)+card('week','이번 주 출고완료','월요일부터',counts.week);
}
function renderTabs(active,counts){
 return Object.entries(TAB_LABELS).map(([k,v])=>`<button type="button" role="tab" class="tab${active===k?' active':''}" data-tab="${k}" aria-selected="${active===k}">${esc(v)}${counts&&counts[k]!=null?` <span class="lg-count">${esc(counts[k])}</span>`:''}</button>`).join('');
}

function renderList(rows,ctx){
 if(!rows.length)return `<div class="lg-empty"><p>${esc(ctx.q?'검색 결과가 없어요.':(EMPTY_TEXT[ctx.view]||'요청이 없어요.'))}</p>${ctx.q?'':'<button type="button" class="btn btn-primary" data-act="new"><i class="ti ti-plus"></i> 새 요청</button>'}</div>`;
 const people=[...(ctx.people||[]),...(ctx.handlers||[])];
 const fileCount=id=>(ctx.files||[]).filter(f=>f.request_id===id).length;
 return `<div class="tw"><table class="lg-table"><thead><tr><th>유형</th><th>제목</th><th>거래처·수신처</th><th>희망일</th><th>요청자</th><th>상태</th></tr></thead><tbody>${rows.map(r=>{
  const late=M.isLate(r,ctx.nowMs),n=fileCount(r.id);
  return `<tr class="lg-row${late?' late':''}" data-open="${esc(r.id)}"><td class="lg-nowrap">${esc(M.TYPES[r.type_code]||r.type_code)}</td>`
   +`<td class="lg-title-cell"><button type="button" class="lg-link" data-open="${esc(r.id)}">${esc(r.title_text)}</button>${n?` <span class="lg-muted" title="첨부 ${n}개"><i class="ti ti-paperclip"></i>${n}</span>`:''}${r.slack_state_code==='failed'?' <span class="badge bg-red lg-warn" title="슬랙 알림을 보내지 못했어요">알림 실패</span>':''}</td>`
   +`<td>${esc(r.counterparty_text)}</td><td class="lg-nowrap${late?' lg-late':''}">${esc(fmtDay(r.want_date))}${late?' · 지남':''}</td>`
   +`<td class="lg-nowrap">${esc(nameOf(r.requester_email,people))}</td><td>${badge(r.status_code)}</td></tr>`;}).join('')}</tbody></table></div>`;
}

function renderPending(r,p,ctx){
 if(!p)return '';
 const today=M.kstToday(ctx.nowMs);
 const v=(name,def)=>p.values&&name in p.values?p.values[name]:def; // 검사·저장이 실패해도 적은 값을 지우지 않는다
 const ta=(name,label,val,max,opts='')=>`<div class="fg lg-wide"><label for="lg-p-${name}">${label}</label><textarea id="lg-p-${name}" name="${name}" maxlength="${max}"${opts}>${esc(v(name,val))}</textarea></div>`;
 let title,body;
 if(p.kind==='result'){
  title='결과 수정';
  body=ta('result_text','결과(송장·배차·BL)',r.result_text||'',M.LIMITS.result,' data-autofocus')
   +`<div class="fg"><label for="lg-p-quick_fee_krw">퀵비(원)</label><input id="lg-p-quick_fee_krw" name="quick_fee_krw" inputmode="numeric" value="${esc(v('quick_fee_krw',r.quick_fee_krw??''))}" placeholder="없으면 비워 두세요"></div>`
   +(M.needsOverseas(r)?`<div class="fg"><label for="lg-p-etd_on">ETD</label><input type="date" id="lg-p-etd_on" name="etd_on" value="${esc(v('etd_on',r.etd_on||''))}"></div>`
    +`<div class="fg"><label for="lg-p-packing_code">패킹리스트</label><select id="lg-p-packing_code" name="packing_code">${opt({'':'-',...M.PACKING},v('packing_code',r.packing_code||''))}</select></div>`:'');
 }else{
  const to=p.to;title=`${M.STATUSES[to]}(으)로 바꾸기`;body='';
  if(to==='shipped')body+=ta('result_text','결과(송장·배차·BL) <small>필수 · 슬랙 채널에 그대로 보여요</small>',r.result_text||'',M.LIMITS.result,' required data-autofocus')
   +`<div class="fg"><label for="lg-p-shipped_on">출고일 <small>필수</small></label><input type="date" id="lg-p-shipped_on" name="shipped_on" value="${esc(v('shipped_on',r.shipped_on||today))}" required></div>`;
  if(needsNote(r.status_code,to))body+=ta('status_note_text','사유 <small>필수</small>','',M.LIMITS.statusNote,' required data-autofocus');
  else if(to==='canceled')body+=ta('status_note_text','취소 사유 <small>선택</small>','',M.LIMITS.statusNote,' data-autofocus');
 }
 return `<form class="lg-pending" data-form="${p.kind==='result'?'result':'status'}" data-key="${esc(pendingKey(p))}" novalidate><h4>${esc(title)}</h4><div class="lg-form-grid">${body}</div>`
  +`<div class="lg-row-btns"><button type="button" class="btn" data-act="pending-cancel">그만두기</button><button type="submit" class="btn btn-primary">저장</button></div></form>`;
}

// ── 파스토 양식(받는 곳·품목) ──
// 목록이 비었거나 못 불러왔으면 모든 줄이 "없는 상품"이 되므로 그 경고는 건너뛴다
const itemWarn=(it,groups)=>F.qtyWarning(it,groups)||(!(groups||[]).length||groups.some(g=>g.product_code===String(it.product_code||'').trim())?'':'파스토 목록에 없는 상품이에요.');
function renderStockBanner(stock,nowMs){
 if(!stock)return '';
 if(stock.error)return `<p class="lg-stock warn" role="status">파스토 목록을 불러오지 못했어요: ${esc(stock.error)}</p>`;
 const a=F.stockAge(stock.sync,stock.groups,nowMs);
 return `<p class="lg-stock${a.stale?' warn':''}" role="status">${esc(a.text)}</p>`;
}
function renderStockResults(list,q){
 if(!String(q||'').trim())return '';
 if(!list.length)return '<p class="lg-muted">찾는 상품이 없어요. 파스토 목록에 있는 상품만 넣을 수 있어요.</p>';
 return `<ul class="lg-stock-results">${list.map(g=>`<li><button type="button" class="lg-link" data-item-add="${esc(g.product_code)}">${esc(g.product_name||g.product_code)} <span class="lg-muted">${esc(g.product_code)}${g.barcode?' · '+esc(g.barcode):''}${g.kind_text?' · '+esc(g.kind_text):''} · 출고 가능 ${esc(g.total_qty.toLocaleString('ko-KR'))}개</span></button></li>`).join('')}</ul>`;
}
function renderItemRow(it,i,{form,groups}){
 const g=(groups||[]).find(x=>x.product_code===it.product_code),lots=g?.lots||[];
 const box=(field,label,val,mode='decimal')=>`<input name="item_${field}_${i}" data-item-field="${field}" data-line="${i}" inputmode="${mode}" value="${esc(val??'')}" aria-label="${i+1}번째 ${label}">`;
 const lotOpts=`<option value="">로트 지정 안 함</option>`+lots.map(l=>`<option value="${esc(l.lot_text)}"${l.lot_text===it.lot_text?' selected':''}>${esc(l.lot_text)} · ${esc(l.expires_on||'유통기한 없음')} · ${esc(l.available_qty)}개</option>`).join('')
  +(it.lot_text&&!lots.some(l=>l.lot_text===it.lot_text)?`<option value="${esc(it.lot_text)}" selected>${esc(it.lot_text)} (목록에 없음)</option>`:'');
 return `<tr><td><b>${esc(it.product_name_text||g?.product_name||'')}</b><br><span class="lg-muted">${esc(it.product_code)}</span></td>`
  +`<td>${box('qty','수량',it.qty,'numeric')}</td>`
  +`<td><select name="item_lot_${i}" data-item-field="lot" data-line="${i}" aria-label="${i+1}번째 로트">${lotOpts}</select></td>`
  +(form==='overseas'?`<td>${box('unit_price','단가',it.unit_price)}</td><td>${box('weight_kg','무게',it.weight_kg)}</td><td><input name="item_en_name_text_${i}" data-item-field="en_name_text" data-line="${i}" maxlength="200" value="${esc(it.en_name_text||'')}" aria-label="${i+1}번째 영문 상품명"></td>`:'')
  +`<td><span class="lg-item-warn" id="lg-item-warn-${i}">${esc(itemWarn(it,groups))}</span> <button type="button" class="btn btn-sm" data-item-del="${i}" aria-label="${i+1}번째 품목 빼기">빼기</button></td></tr>`;
}
function renderItems(items,ctx){
 if(!items.length)return '<p class="lg-muted">아직 넣은 품목이 없어요. 위에서 상품을 찾아 넣어 주세요.</p>';
 const head=`<tr><th>상품</th><th>수량</th><th>로트</th>${ctx.form==='overseas'?'<th>단가 <small>필수</small></th><th>무게(kg)</th><th>영문 상품명</th>':''}<th>${items.length}/${F.MAX_ITEMS}줄</th></tr>`;
 return `<div class="tw"><table class="lg-items"><thead>${head}</thead><tbody>${items.map((it,i)=>renderItemRow(it,i,ctx)).join('')}</tbody></table></div>`;
}
// 새 요청·요약 수정 창의 파스토 칸. mode=운송 방식 코드, fx=null이면 받는 곳·품목을 못 불러와 고칠 수 없다.
function renderFasstoFields(mode,fx,ctx){
 if(!mode)return '';
 const form=F.formFor(mode);
 if(!form)return `<p class="lg-hint">${esc(F.formHint(null))}</p>`;
 if(!fx)return `<p class="lg-hint">${esc(F.formHint(form))}</p><p class="lg-muted">받는 곳·품목을 불러오지 못해 이번에는 고칠 수 없어요. 상세를 다시 열어 주세요.</p>`;
 const r=fx.recipient||{};
 const inp=([key,label,max])=>`<div class="fg"><label for="lg-r-${key}">${label}</label><input id="lg-r-${key}" name="r_${key}" data-recipient="${key}" maxlength="${max}" value="${esc(r[key]||'')}"></div>`;
 const sel=(key,label,list)=>`<div class="fg"><label for="lg-r-${key}">${label}</label><select id="lg-r-${key}" name="r_${key}" data-recipient="${key}"><option value="">선택</option>${list.map(v=>`<option value="${esc(v)}"${r[key]===v?' selected':''}>${esc(v)}</option>`).join('')}</select></div>`;
 let rec='';
 if(form!=='vehicle'){
  rec=`<fieldset class="lg-fassto-box"><legend>받는 곳 <small>요청자와 물류 담당자만 봐요</small></legend><div class="lg-form-grid">${F.RECIPIENT_FIELDS[form].map(inp).join('')}${form==='overseas'?sel('currency_code','화폐',F.CURRENCIES):''}</div>`
   +(form==='overseas'?(ctx.isHandler?`<div class="lg-form-grid lg-handler-only">${inp(F.HANDLER_FIELDS[0])}${sel('incoterms_code','Incoterms',F.INCOTERMS)}${F.HANDLER_FIELDS.slice(1).map(inp).join('')}</div>`
    :'<p class="lg-muted">운송사·Incoterms·발송인은 물류 담당자가 정해요.</p>'):'')+`</fieldset>`;
 }else rec='<p class="lg-muted">차량배송은 받는 곳 칸이 없어요. 도착지는 특이사항에 적어 주세요.</p>';
 const groups=ctx.groups||[],stockLine=ctx.stock?.error?'파스토 목록을 불러오지 못했어요.':F.stockAge(ctx.stock?.sync,groups,ctx.nowMs);
 const stale=typeof stockLine==='string'||stockLine.stale;
 return `<p class="lg-hint">${esc(F.formHint(form))}</p>${rec}`
  +`<fieldset class="lg-fassto-box"><legend>품목 <small>파스토 목록에서 골라요</small></legend>`
  +`<p class="lg-stock${stale?' warn':''}">${esc(typeof stockLine==='string'?stockLine:stockLine.text)}</p>`
  +`<div class="fg"><label for="lg-item-q">상품 찾기 <small>상품명·바코드·상품코드</small></label><input type="search" id="lg-item-q" autocomplete="off" value="${esc(fx.q||'')}"></div>`
  +`<div id="lg-item-results">${renderStockResults(F.searchStock(groups,fx.q),fx.q)}</div>`
  +`<div id="lg-item-lines">${renderItems(fx.items||[],{form,groups})}</div></fieldset>`;
}
// 상세 창의 파스토 칸: 받는 곳(권한), 품목 표, 내려받기 버튼, 검사 결과
function renderFasstoSection(r,ctx){
 const form=F.formFor(r.ship_mode_code),fx=ctx.fassto||{},items=fx.items||[];
 if(!form&&!items.length)return '';
 const owner=String(ctx.email||'').toLowerCase()===String(r.requester_email||'').toLowerCase(),canSee=Boolean(ctx.isHandler||owner);
 const groups=ctx.groups||[],wait=!fx.loaded&&!fx.error; // 아직 못 불러온 것은 "입력 안 됨"이 아니라 불러오는 중
 const f=(l,v,c='')=>`<div class="lg-f${c}"><dt>${esc(l)}</dt><dd>${esc(v||'-')}</dd></div>`;
 let rec='';
 if(form==='parcel'||form==='overseas'){
  let body;
  if(!canSee)body='<p class="lg-muted">요청자와 물류 담당자만 볼 수 있어요.</p>';
  else if(fx.loading||wait)body='<p class="lg-muted">불러오는 중…</p>';
  else if(fx.error)body='';
  else if(!fx.recipient)body='<p class="lg-muted">입력 안 됨</p>';
  else{
   const x=fx.recipient;
   body=`<dl class="lg-fields">${f('받는 분',x.name_text)}${f('전화',x.phone_text)}`
    +(form==='overseas'?f('이메일',x.email_text)+f('국가',x.country_code)+f('주·시·구',[x.state_text,x.city_text,x.district_text].filter(Boolean).join(', '))+f('화폐',x.currency_code)+(x.tax_id_text?f('신분번호',x.tax_id_text):''):'')
    +`${f('우편번호',x.postal_text)}${f('주소',[x.address1_text,x.address2_text].filter(Boolean).join(' '),' lg-wide')}`
    +(form==='overseas'?(()=>{const snd=F.senderOf(x);return f('운송사',x.courier_text||'담당자가 정해요')+f('Incoterms',x.incoterms_code)+f('발송인',`${snd.name_text} · ${snd.phone_text} · ${snd.email_text}`,' lg-wide');})():'')+`</dl>`;
  }
  rec=`<h4>받는 곳</h4>${body}`;
 }
 const list=fx.error?'':items.length?`<div class="tw"><table class="lg-items"><thead><tr><th>#</th><th>상품코드</th><th>상품명</th><th>수량</th><th>로트·유통기한</th>${form==='overseas'?'<th>단가</th><th>무게(kg)</th>':''}<th>확인</th></tr></thead><tbody>${items.map((it,i)=>
   `<tr><td>${i+1}</td><td>${esc(it.product_code)}</td><td>${esc(it.product_name_text)}</td><td>${esc(it.qty)}</td><td>${esc(it.lot_text?`${it.lot_text} · ${it.expires_on||'유통기한 없음'}`:'지정 안 함')}</td>`
   +(form==='overseas'?`<td>${esc(it.unit_price??'')}</td><td>${esc(it.weight_kg??'1')}</td>`:'')+`<td class="lg-item-warn">${esc(itemWarn(it,groups))}</td></tr>`).join('')}</tbody></table></div>`
  :(fx.loading||wait?'<p class="lg-muted">불러오는 중…</p>':'<p class="lg-muted">품목이 없어요.</p>');
 const canDownload=Boolean(form&&canSee&&fx.loaded);
 const errs=ctx.fasstoErrors||[];
 return `<section class="lg-sec lg-fassto"><h3>파스토 양식${r.fassto_order_no?` <span class="lg-muted">주문번호 ${esc(r.fassto_order_no)}</span>`:''}</h3><p class="lg-hint">${esc(F.formHint(form))}</p>`
  +(fx.error?`<p class="lg-error">${esc(fx.error)}</p>`:'')+rec+`<h4>품목 <span class="lg-count">${items.length}</span></h4>${list}`
  +(canDownload?`<div class="lg-actions"><button type="button" class="btn" data-act="fassto-download"><i class="ti ti-download"></i> 파스토 양식 내려받기</button></div>`:'')
  +(errs.length?`<div class="lg-error" role="alert"><p>내려받지 않았어요. 아래 칸을 채워 주세요.</p><ul>${errs.map(x=>`<li>${esc(x)}</li>`).join('')}</ul></div>`:'')
  +`</section>`;
}

function renderDetail(r,ctx){
 const people=[...(ctx.people||[]),...(ctx.handlers||[])];
 const me=String(ctx.email||'').toLowerCase();
 const owner=me===String(r.requester_email||'').toLowerCase();
 const next=M.allowedNext({isHandler:ctx.isHandler,isOwner:owner,from:r.status_code});
 const files=(ctx.files||[]).filter(f=>f.request_id===r.id);
 const inv=(ctx.invoices||[]).find(i=>i.id===r.invoice_id);
 const overseas=M.needsOverseas(r),closed=M.CLOSED.includes(r.status_code),late=M.isLate(r,ctx.nowMs);
 const canEdit=(owner&&r.status_code==='requested')||(ctx.isHandler&&!closed);
 const canResult=ctx.isHandler&&r.status_code!=='canceled';
 const field=(label,val,cls='')=>`<div class="lg-f${cls}"><dt>${esc(label)}</dt><dd>${esc(val||'-')}</dd></div>`;
 const canDelFile=f=>ctx.isHandler||(String(f.created_by||'').toLowerCase()===me&&!closed);
 const canDelComment=c=>String(c.author_email||'').toLowerCase()===me&&ctx.nowMs-Date.parse(c.created_at)<24*HOUR;
 const pendingTo=ctx.pending?.to;
 return `<header class="lg-dh"><div><p class="lg-kicker">${esc(M.TYPES[r.type_code]||r.type_code)} · ${esc(M.SHIP_MODES[r.ship_mode_code]||r.ship_mode_code)}</p><h2 id="lg-detail-title">${esc(r.title_text)}</h2></div><button type="button" class="btn" data-act="close-detail">닫기</button></header>`
 +`<div class="lg-status">${badge(r.status_code)}${late?' <span class="badge bg-red">희망일 지남</span>':''}${r.slack_state_code==='failed'?' <span class="badge bg-red lg-warn">알림 실패</span> <span class="lg-muted">슬랙 알림을 보내지 못했어요. 담당자에게 직접 알려 주세요.</span>':''}</div>`
 +(ctx.note?`<p class="lg-note" role="status">${esc(ctx.note)}</p>`:'')
 +`<dl class="lg-fields">${field('거래처·수신처',r.counterparty_text)}${field('요청',nameOf(r.requester_email,people)+(M.TEAMS[r.team_code]?' · '+M.TEAMS[r.team_code]:''))}`
 +`${field('희망 출고일',fmtDay(r.want_date)+(late?' (지남)':''),late?' lg-late':'')}${field('운송',M.SHIP_MODES[r.ship_mode_code])}${field('수량',r.qty_summary_text)}`
 +`${field('연결 주문',inv?`${inv.no} ${inv.customer||''}`:(r.invoice_id?'불러오는 중…':''))}${field('특이사항',r.note_text,' lg-wide')}`
 +(overseas?field('패킹리스트',M.PACKING[r.packing_code]||'')+field('ETD',r.etd_on)+field('포워더',r.forwarder_text):'')
 +`${field('결과(송장·배차·BL)',r.result_text,' lg-wide')}${field('출고일',r.shipped_on)}${r.quick_fee_krw!=null?field('퀵비',won(r.quick_fee_krw)):''}${r.status_note_text?field('사유',r.status_note_text,' lg-wide'):''}</dl>`
 +renderFasstoSection(r,ctx)
 +((next.length||canEdit||canResult)?`<section class="lg-sec"><h3>처리</h3><div class="lg-actions">${next.map(to=>`<button type="button" class="btn${pendingTo===to?' btn-primary':''}" data-to="${esc(to)}">${esc(M.STATUSES[to])}</button>`).join('')}`
  +`${canEdit?'<button type="button" class="btn" data-act="edit-summary"><i class="ti ti-pencil"></i> 요약 수정</button>':''}${canResult?'<button type="button" class="btn" data-act="edit-result">결과 수정</button>':''}</div>`
  +renderPending(r,ctx.pending,ctx)+`</section>`:'')
 +(ctx.error?`<p class="lg-error" role="alert">${esc(ctx.error)}</p>`:'')
 +`<section class="lg-sec"><h3>첨부 <span class="lg-count">${files.length}</span></h3><ul class="lg-files">${files.map(f=>`<li><button type="button" class="lg-link" data-file="${esc(f.id)}"><i class="ti ti-file"></i> ${esc(M.FILE_KINDS[f.kind_code]||'기타')} · ${esc(f.name_text)}</button> <span class="lg-muted">${esc(sizeText(f.size_bytes))}</span>${canDelFile(f)?` <button type="button" class="btn btn-sm" data-file-del="${esc(f.id)}" aria-label="${esc(f.name_text)} 지우기">지우기</button>`:''}</li>`).join('')||'<li class="lg-muted">첨부가 없어요.</li>'}</ul>`
 +(closed?'':`<div class="lg-upload"><select id="lg-file-kind" data-act="file-kind" aria-label="올릴 파일 종류">${opt(M.FILE_KINDS,'request')}</select><label class="btn"><input type="file" id="lg-file-input" data-act="file" class="lg-sr"><i class="ti ti-upload"></i> 파일 올리기</label><span class="lg-muted">파일당 20MB, 요청당 10개까지</span></div>`)+`</section>`
 +`<section class="lg-sec"><h3>댓글 <span class="lg-count">${(ctx.comments||[]).length}</span></h3>${ctx.loading?'<p class="lg-muted">불러오는 중…</p>':''}<ul class="lg-comments">${(ctx.comments||[]).map(c=>`<li><div class="lg-cmeta"><b>${esc(nameOf(c.author_email,people))}</b> <time>${esc(kstTime(c.created_at))}</time>${canDelComment(c)?` <button type="button" class="lg-link lg-del" data-comment-del="${esc(c.id)}">지우기</button>`:''}</div><p>${esc(c.body_text)}</p></li>`).join('')}</ul>`
 +`<form class="lg-comment-form" data-form="comment"><input id="lg-comment-body" name="body" maxlength="${M.LIMITS.comment}" value="${esc(ctx.commentDraft||'')}" placeholder="댓글을 남겨 주세요" aria-label="댓글"><button type="submit" class="btn">남기기</button></form></section>`
 +`<details class="lg-sec lg-history"><summary>변경 이력 ${(ctx.history||[]).length}건</summary><ol>${(ctx.history||[]).map(h=>{
   const show=v=>h.field_code==='status'?(M.STATUSES[v]||v):h.field_code==='packing'?(M.PACKING[v]||v||'없음'):(v||'없음');
   return `<li>${esc(kstTime(h.changed_at))} · ${esc(nameOf(h.changed_by_text,people))} · ${esc(HISTORY_LABELS[h.field_code]||h.field_code)}${h.field_code==='created'?'':`: ${esc(show(h.from_text))} → ${esc(show(h.to_text))}`}</li>`;}).join('')}</ol></details>`;
}

function renderForm(d,ctx){
 const edit=ctx.mode==='edit';
 const showOverseas=!edit||ctx.isHandler; // 요청자는 해외 칸(패킹·ETD·포워더)을 고칠 수 없다
 const fg=(name,label,input,wide)=>`<div class="fg${wide?' lg-wide':''}"><label for="lg-f-${name}">${label}</label>${input}</div>`;
 const id=n=>`id="lg-f-${n}" name="${n}"`;
 return `<form class="lg-form" data-form="${edit?'edit':'create'}" novalidate><header class="lg-dh"><h2>${edit?'요약 수정':'새 물류 요청'}</h2><button type="button" class="btn" data-act="close-form">닫기</button></header>`
 +`<div class="lg-form-grid">${fg('type_code','유형',`<select ${id('type_code')}>${opt({'':'선택',...M.TYPES},d.type_code||'')}</select>`)}`
 +fg('team_code','요청팀',`<select ${id('team_code')}>${opt({'':'선택',...M.TEAMS},d.team_code||'')}</select>`)
 +fg('title_text','제목',`<input ${id('title_text')} maxlength="${M.LIMITS.title}" value="${esc(d.title_text)}" placeholder="예: 비주그룹 11월 2차 출고">`,true)
 +fg('counterparty_text','거래처·수신처',`<input ${id('counterparty_text')} maxlength="${M.LIMITS.counterparty}" value="${esc(d.counterparty_text)}">`,true)
 +fg('want_date','희망 출고일 <small>비워 두면 미정</small>',`<input type="date" ${id('want_date')} value="${esc(d.want_date)}">`)
 +fg('ship_mode_code','운송 방식',`<select ${id('ship_mode_code')}>${opt({'':'선택',...M.SHIP_MODES},d.ship_mode_code||'')}</select>`)
 +fg('qty_summary_text','수량 요약',`<input ${id('qty_summary_text')} maxlength="${M.LIMITS.qty}" value="${esc(d.qty_summary_text)}" placeholder="예: 12 SKU, 3,240ea">`,true)
 +fg('note_text','특이사항',`<textarea ${id('note_text')} maxlength="${M.LIMITS.note}">${esc(d.note_text)}</textarea>`,true)
 +fg('invoice_id','연결 주문',`<select ${id('invoice_id')}><option value="">없음</option>${d.invoice_id&&!(ctx.invoices||[]).some(i=>i.id===d.invoice_id)?`<option value="${esc(d.invoice_id)}" selected>현재 연결 주문(목록에 없음)</option>`:''}${(ctx.invoices||[]).map(i=>`<option value="${esc(i.id)}"${i.id===d.invoice_id?' selected':''}>${esc(i.no)} ${esc(i.customer||'')}</option>`).join('')}</select>`,true)
 +`</div>`
 +`<div class="lg-fassto" id="lg-f-fassto">${renderFasstoFields(d.ship_mode_code,ctx.fassto!==undefined?ctx.fassto:(edit?null:{recipient:{},items:[],q:''}),ctx)}</div>`
 +(showOverseas?`<fieldset class="lg-overseas" id="lg-f-overseas"${M.needsOverseas(d)?'':' hidden'}><legend>해외 출고</legend><div class="lg-form-grid">`
  +fg('packing_code','패킹리스트',`<select ${id('packing_code')}>${opt({'':'-',...M.PACKING},d.packing_code||'')}</select>`)
  +fg('etd_on','ETD',`<input type="date" ${id('etd_on')} value="${esc(d.etd_on)}">`)
  +fg('forwarder_text','포워더',`<input ${id('forwarder_text')} maxlength="${M.LIMITS.forwarder}" value="${esc(d.forwarder_text)}">`,true)+`</div></fieldset>`:'')
 +(edit?'':fg('files','첨부 <small>출고요청서 등 · 파일당 20MB, 10개까지</small>','<input type="file" id="lg-f-files" name="files" multiple>',true))
 +`<p class="lg-error" id="lg-form-error" role="alert"></p>`
 +`<footer class="lg-row-btns"><button type="button" class="btn" data-act="close-form">취소</button><button type="submit" class="btn btn-primary">${edit?'수정 저장':'요청 올리기'}</button></footer></form>`;
}

// ── 대시보드 탭 ──
function mountTab({document,client,onMessage=()=>{},now=()=>Date.now(),confirm=m=>root.confirm(m),location=root.location,history=root.history,open=u=>root.open(u,'_blank'),xlsx=null,saveWorkbook=null,pageUrl=''}){
 const $=id=>document.getElementById(id);
 const api=createApi(client,{now});
 const EMPTY=()=>({requests:[],files:[],handlers:[],people:[],invoices:[]});
 const NO_STOCK=()=>({rows:[],groups:[],sync:null,error:''});
 const NO_FASSTO=()=>({loaded:false,loading:false,recipient:null,items:[],error:''});
 const XL=()=>xlsx||root.XLSX;
 const save=saveWorkbook||((wb,name)=>XL().writeFile(wb,name));
 const state={active:false,loaded:false,loading:false,error:'',email:'',isHandler:false,data:EMPTY(),tab:'todo',quick:'',q:'',
  selected:null,detail:{comments:[],history:[]},detailLoading:false,pending:null,detailError:'',detailNote:'',busy:false,form:null,editTarget:null,pendingOpen:null,ready:Promise.resolve(),commentDraft:'',renderedId:null,
  stock:NO_STOCK(),fassto:NO_FASSTO(),fasstoErrors:[],formFassto:null};
 let generation=0;
 const say=t=>{if(t)onMessage(t);};
 const current=()=>state.data.requests.find(r=>r.id===state.selected);
 const ctx=()=>({email:state.email,isHandler:state.isHandler,nowMs:now(),files:state.data.files,people:state.data.people,handlers:state.data.handlers,invoices:state.data.invoices,groups:state.stock.groups,stock:state.stock});
 const buttons=el=>el?.querySelectorAll?.('button')||[];
 function setBusy(v){state.busy=v;for(const id of ['lg-detail','lg-form'])for(const b of buttons($(id)))b.disabled=v;}
 const dlgOpen=d=>{if(d&&!d.open){try{d.showModal();}catch(_){d.setAttribute?.('open','');}}};
 const dlgClose=d=>{if(d?.open){try{d.close();}catch(_){d.removeAttribute?.('open');}}};

 function paint(){
  if(!state.active)return;
  const k=$('lg-kpis'),t=$('lg-tabs'),sl=$('lg-stock-line'),nowMs=now();
  if(k)k.innerHTML=state.loaded?renderKpis(summarize(state.data.requests,nowMs),state.quick||(state.tab==='todo'?'todo':'')):'';
  if(sl)sl.innerHTML=state.loaded?renderStockBanner(state.stock,nowMs):'';
  if(t){const c={};for(const key of Object.keys(TAB_LABELS))c[key]=M.filterTab(state.data.requests,key,{email:state.email,nowMs}).length;t.innerHTML=renderTabs(state.quick?'':state.tab,state.loaded?c:null);}
  drawList();
 }
 function drawList(){
  const host=$('lg-list');if(!state.active||!host)return;
  if(state.error){host.innerHTML=`<div class="card"><div class="lg-empty"><p class="lg-error" role="alert">${esc(state.error)}</p><button type="button" class="btn" data-act="refresh">다시 불러오기</button></div></div>`;return;}
  if(!state.loaded){host.innerHTML='<div class="card"><p class="lg-empty lg-muted" role="status">물류 요청을 불러오는 중…</p></div>';return;}
  const view=state.quick||state.tab;
  const rows=listView(state.data.requests,{tab:state.tab,quick:state.quick,q:state.q,email:state.email,nowMs:now()});
  host.innerHTML=`<div class="card"><div class="card-hd"><h3>${esc(QUICK_LABELS[state.quick]||TAB_LABELS[state.tab])} <span class="lg-count">${rows.length}건</span></h3>${state.quick?'<button type="button" class="btn btn-sm" data-act="clear-quick">필터 해제</button>':''}</div>`
   +renderList(rows,{...ctx(),view,q:state.q})+`</div>`;
 }
 function captureInputs(){
  const d=$('lg-detail');if(!d||!state.selected||state.renderedId!==state.selected)return;
  const pf=d.querySelector?.('form.lg-pending');
  if(pf&&state.pending&&pf.dataset?.key===pendingKey(state.pending))state.pending.values=readForm(pf);
  const cb=$('lg-comment-body');if(cb&&typeof cb.value==='string')state.commentDraft=cb.value;
 }
 function drawDetail(){
  const d=$('lg-detail'),r=current();if(!d||!r)return;
  captureInputs();
  const ae=document.activeElement,fid=ae&&ae.id&&d.contains?.(ae)?ae.id:'',sel=fid?[ae.selectionStart,ae.selectionEnd]:null;
  d.innerHTML=renderDetail(r,{...ctx(),...state.detail,loading:state.detailLoading,pending:state.pending,error:state.detailError,note:state.detailNote,commentDraft:state.commentDraft,fassto:state.fassto,fasstoErrors:state.fasstoErrors});
  state.renderedId=r.id;
  if(state.busy)setBusy(true);
  if(fid){try{const el=$(fid);el?.focus?.();if(sel&&sel[0]!=null)el?.setSelectionRange?.(sel[0],sel[1]);}catch(_){}}
 }
 function focusPending(){try{$('lg-detail')?.querySelector?.('[data-autofocus]')?.focus?.();}catch(_){}}
 function closeDetail(){state.selected=null;state.renderedId=null;state.commentDraft='';state.pending=null;state.detailError='';state.detailNote='';state.detail={comments:[],history:[]};state.fassto=NO_FASSTO();state.fasstoErrors=[];const d=$('lg-detail');dlgClose(d);if(d)d.innerHTML='';}
 function closeForm(){state.form=null;state.editTarget=null;state.formFassto=null;const f=$('lg-form');dlgClose(f);if(f)f.innerHTML='';}

 async function openDetail(id,{keep=false}={}){
  if(!state.active)return;
  const same=state.selected===id;
  state.selected=id;
  if(!keep||!same){captureInputs();state.pending=null;state.detailError='';state.detailNote='';state.commentDraft='';state.renderedId=null;state.fasstoErrors=[];}
  const r0=current();
  if(!r0){closeDetail();say('요청을 찾지 못했어요. 닫힌 지 180일이 지났거나 지워진 요청일 수 있어요.');return;}
  state.detail={comments:[],history:[]};state.detailLoading=true;state.fassto={...NO_FASSTO(),loading:true};
  const g=generation;
  drawDetail();dlgOpen($('lg-detail'));
  if(r0.invoice_id&&!state.data.invoices.some(i=>i.id===r0.invoice_id)){
   try{const inv=await api.loadInvoice(r0.invoice_id);if(g!==generation||state.selected!==id)return;if(inv){state.data.invoices=[...state.data.invoices,inv];drawDetail();}}
   catch(e){if(g!==generation||state.selected!==id)return;state.detailError='연결 주문을 불러오지 못했어요: '+(e?.message||e);}
  }
  // 받는 곳은 요청자·담당자만 부른다(다른 사람은 RLS가 0행). 품목은 운송 방식이 바뀌었을 때도 보이게 늘 부른다.
  const canSee=state.isHandler||state.email===String(r0.requester_email||'').toLowerCase();
  const [det,rec,its]=await Promise.allSettled([api.loadDetail(id),canSee?api.loadRecipient(id):Promise.resolve(null),api.loadItems(id)]);
  if(g!==generation||state.selected!==id)return;
  if(det.status==='fulfilled')state.detail=det.value;else state.detailError='댓글과 이력을 불러오지 못했어요: '+(det.reason?.message||det.reason);
  state.fasstoErrors=[]; // 받는 곳·품목을 다시 불러왔으니 지난 내려받기 오류는 낡았다
  if(rec.status==='fulfilled'&&its.status==='fulfilled')state.fassto={loaded:true,loading:false,recipient:rec.value,items:its.value||[],error:''};
  else{const e=rec.status==='rejected'?rec.reason:its.reason;state.fassto={...NO_FASSTO(),error:'받는 곳과 품목을 불러오지 못했어요: '+(e?.message||e)};}
  state.detailLoading=false;drawDetail();
 }

 async function load(){
  const g=++generation;state.loading=true;state.error='';paint();
  try{
   const {data,error}=await client.auth.getSession();if(g!==generation)return;if(error)throw error;
   const email=String(data?.session?.user?.email||'').toLowerCase();
   if(!email)throw new Error('로그인 정보를 확인하지 못했어요. 다시 로그인해 주세요.');
   // 파스토 목록을 못 받아도 물류 요청 화면은 연다(목록 줄에 오류를 보인다)
   const [d,stock]=await Promise.all([api.loadAll(),api.loadStock().then(x=>({...x,groups:F.groupStock(x.rows),error:''}),e=>({...NO_STOCK(),error:String(e?.message||e)}))]);
   if(g!==generation)return;
   state.email=email;state.data=d;state.stock=stock;state.isHandler=M.isHandler(email,d.handlers);state.loaded=true;
  }catch(e){if(g!==generation)return;state.error='물류 요청을 불러오지 못했어요. '+(e?.message||e);}
  state.loading=false;paint();
  if(!state.active)return;
  if(state.selected&&state.loaded)await openDetail(state.selected,{keep:true});
  if(state.pendingOpen&&state.loaded){const id=state.pendingOpen;state.pendingOpen=null;await openDetail(id);}
 }
 function reload(){return state.ready=load();}
 const isStale=e=>/STALE/.test(String(e?.message||e||''));
 const STALE_TEXT='다른 사람이 먼저 바꿨어요. 최신 내용을 다시 불러왔으니 확인하고 다시 해 주세요.';
 // 상세 창에서 저장 실패: 문구를 창 안에 남기고, STALE이면 최신 행으로 다시 그린다(적던 값은 captureInputs가 지킨다)
 async function detailFail(e){
  if(!isStale(e)){fail(M.errorMessage(e));return;}
  state.detailError=STALE_TEXT;captureInputs();
  await reload();
  const r=current(),p=state.pending;
  if(r&&p?.kind==='status'&&!M.allowedNext({isHandler:state.isHandler,isOwner:state.email===String(r.requester_email||'').toLowerCase(),from:r.status_code}).includes(p.to)){state.pending=null;drawDetail();}
 }

 function chooseStatus(to){
  const r=current();if(!r||state.busy)return;
  if(to==='shipped'||to==='canceled'||needsNote(r.status_code,to)){state.pending={kind:'status',to};state.detailError='';drawDetail();focusPending();return;}
  return saveStatus(r,to,{});
 }
 async function saveStatus(r,to,fields){
  if(state.busy)return;
  const owner=state.email===String(r.requester_email||'').toLowerCase();
  const patch={status_code:to,...fields};
  const check=M.checkTransition({isHandler:state.isHandler,isOwner:owner,from:r.status_code,to,fields:{...r,...patch}});
  if(!check.ok){state.detailError=check.reason;drawDetail();return;}
  setBusy(true);
  try{await api.update(r.id,r.status_code,patch);state.pending=null;state.detailError='';state.detailNote=`${M.STATUSES[to]}(으)로 바꿨어요.`;say(state.detailNote);await reload();}
  catch(e){await detailFail(e);}
  finally{setBusy(false);}
 }
 function readForm(form){const d={};for(const el of form.querySelectorAll('[name]'))if(el.type!=='file')d[el.name]=el.value;return d;}
 const fail=msg=>{state.detailError=msg;drawDetail();};
 function submitStatus(form){
  const r=current(),p=state.pending;if(!r||!p||p.kind!=='status'||state.busy)return;
  const v=readForm(form),fields={};p.values=v;
  if(p.to==='shipped'){
   fields.result_text=String(v.result_text||'').trim();fields.shipped_on=String(v.shipped_on||'').trim();
   if(!fields.result_text)return fail('결과(송장·배차·BL)를 적어 주세요.');
   if(!M.isDate(fields.shipped_on))return fail('출고일을 골라 주세요.');
  }
  if(needsNote(r.status_code,p.to)||p.to==='canceled')fields.status_note_text=String(v.status_note_text||'').trim();
  return saveStatus(r,p.to,fields);
 }
 async function submitResult(form){
  const r=current();if(!r||state.pending?.kind!=='result'||state.busy)return;
  const v=readForm(form);state.pending.values=v;
  const result=String(v.result_text||'').trim(),fee=String(v.quick_fee_krw??'').replace(/,/g,'').trim();
  if(r.status_code==='shipped'&&!result)return fail('출고완료 요청은 결과를 비울 수 없어요.');
  if(fee&&!/^[0-9]+$/.test(fee))return fail('퀵비는 숫자로 적어 주세요.');
  const patch={result_text:result,quick_fee_krw:fee?Number(fee):null};
  if(M.needsOverseas(r)){
   const etd=String(v.etd_on||'').trim(),pk=String(v.packing_code||'').trim();
   if(etd&&!M.isDate(etd))return fail('ETD는 YYYY-MM-DD 형식으로 적어 주세요.');
   if(pk&&!M.PACKING[pk])return fail('패킹리스트 상태를 다시 골라 주세요.');
   patch.etd_on=etd||null;patch.packing_code=pk||null;
  }
  setBusy(true);
  try{await api.update(r.id,r.status_code,patch);state.pending=null;state.detailError='';state.detailNote='결과를 저장했어요.';say(state.detailNote);await reload();}
  catch(e){await detailFail(e);}
  finally{setBusy(false);}
 }

 const fasstoCtx=()=>({isHandler:state.isHandler,groups:state.stock.groups,stock:state.stock,nowMs:now()});
 function openForm(mode,draft){
  const f=$('lg-form');if(!state.active||!f)return;
  state.form={mode};
  f.innerHTML=renderForm(draft,{invoices:state.data.invoices,mode,...fasstoCtx(),fassto:state.formFassto});dlgOpen(f);
  try{f.querySelector?.('select,input')?.focus?.();}catch(_){}
 }
 // 창에서 고치는 받는 곳·품목의 사본. orig*는 바뀌지 않았으면 저장하지 않으려고 둔다.
 function formFasstoFrom(recipient,items,mode){
  return {form:F.formFor(mode),recipient:{...(recipient||{})},items:(items||[]).map(x=>({...x})),q:'',hadRecipient:Boolean(recipient),
   origRecipient:JSON.stringify(F.toRecipientRow(recipient||{},{isHandler:state.isHandler})),origItems:JSON.stringify(F.toItemRows(items||[]))};
 }
 function openNew(){if(!state.active||!state.loaded)return;state.editTarget=null;state.formFassto=formFasstoFrom(null,[],'');openForm('create',{team_code:'',want_date:''});}
 function openEdit(){
  const r=current();if(!r)return;
  state.editTarget={id:r.id,status_code:r.status_code};
  state.formFassto=state.fassto.loaded?formFasstoFrom(state.fassto.recipient,state.fassto.items,r.ship_mode_code):null; // 못 불러왔으면 받는 곳·품목은 건드리지 않는다
  openForm('edit',{...r});
 }
 const lotExpiry=(it,lot)=>{const l=state.stock.groups.find(g=>g.product_code===it.product_code)?.lots.find(x=>x.lot_text===lot);return lot?(l?l.expires_on:(it.lot_text===lot?it.expires_on:null)):null;};
 // 폼 값(r_*, item_*_<줄>)을 창 사본에 덮어 받는 곳·품목을 만든다. 입력 이벤트를 놓쳐도 제출 순간의 값이 이긴다.
 function fasstoFromForm(draft){
  const fx=state.formFassto;if(!fx)return null;
  const recipient={...fx.recipient};
  for(const k of [...F.RECIPIENT_KEYS,...F.HANDLER_KEYS])if(('r_'+k) in draft)recipient[k]=draft['r_'+k];
  const items=fx.items.map((it,i)=>{
   const o={...it};
   for(const k of ['qty','unit_price','weight_kg','en_name_text'])if(`item_${k}_${i}` in draft)o[k]=draft[`item_${k}_${i}`];
   if(`item_lot_${i}` in draft){const lot=draft[`item_lot_${i}`];o.expires_on=lotExpiry(it,lot);o.lot_text=lot;}
   return o;});
  return {...fx,recipient,items};
 }
 const hasRecipientValues=r=>F.RECIPIENT_KEYS.some(k=>String(r?.[k]??'').trim());
 // 요청 저장 뒤 받는 곳 → 품목 순서로 저장한다. 바뀌지 않은 것은 보내지 않는다.
 async function saveFassto(id,form,fx){
  if(!form||!fx)return;
  const rec=F.toRecipientRow(fx.recipient,{isHandler:state.isHandler});
  if(form!=='vehicle'&&(fx.hadRecipient||hasRecipientValues(fx.recipient))&&JSON.stringify(rec)!==fx.origRecipient)await api.saveRecipient(id,rec);
  if(JSON.stringify(F.toItemRows(fx.items))!==fx.origItems)await api.saveItems(id,fx.items);
 }
 function drawItems(){const host=$('lg-item-lines'),fx=state.formFassto;if(host&&fx)host.innerHTML=renderItems(fx.items,{form:fx.form,groups:state.stock.groups});}
 function addItem(code){
  const fx=state.formFassto;if(!fx||state.busy)return;
  if(fx.items.length>=F.MAX_ITEMS)return formError('품목은 50줄까지 넣을 수 있어요.');
  const g=state.stock.groups.find(x=>x.product_code===code);if(!g)return;
  fx.items.push({product_code:g.product_code,product_name_text:g.product_name,qty:1,lot_text:'',expires_on:null,en_name_text:'',weight_kg:'',unit_price:''});
  fx.q='';const q=$('lg-item-q');if(q)q.value='';const res=$('lg-item-results');if(res)res.innerHTML='';
  formError('');drawItems();
 }
 function removeItem(i){const fx=state.formFassto;if(!fx||state.busy||!fx.items[i])return;fx.items.splice(i,1);drawItems();}
 function updateItem(i,field,value){
  const it=state.formFassto?.items[i];if(!it)return;
  if(field==='lot'){it.expires_on=lotExpiry(it,value);it.lot_text=value;}else it[field]=value;
  const w=$('lg-item-warn-'+i);if(w)w.textContent=itemWarn(it,state.stock.groups);
 }
 function downloadFassto(){
  const r=current();if(!r||state.busy)return;
  const form=F.formFor(r.ship_mode_code);if(!form||!state.fassto.loaded)return;
  const {recipient,items}=state.fassto;
  const errors=F.validate(form,r,recipient,items);
  state.detailError='';state.detailNote='';
  if(errors.length){state.fasstoErrors=errors;drawDetail();return;}
  if(!XL()){state.fasstoErrors=[];state.detailError='엑셀 도구를 불러오지 못했어요. 페이지를 새로고침한 뒤 다시 해 주세요.';drawDetail();return;}
  try{
   save(F.toWorkbook(form,F.buildRows(form,r,recipient,items),XL()),F.fileName(form,r));
   const warn=F.stockWarnings(items,state.stock.groups);
   state.fasstoErrors=[];state.detailNote='파스토 양식을 내려받았어요.'+(warn.length?' 확인할 점: '+warn.join(' '):'');
  }catch(e){state.fasstoErrors=[];state.detailError='파스토 양식을 만들지 못했어요: '+String(e?.message||e);}
  drawDetail();
 }
 const formError=t=>{const el=$('lg-form-error');if(el)el.textContent=t||'';};
 const SUMMARY=['type_code','title_text','team_code','counterparty_text','want_date','ship_mode_code','qty_summary_text','note_text','invoice_id'];
 async function submitEdit(form){
  if(state.busy)return;const t=state.editTarget;if(!t)return; // 폼을 연 요청과 그때의 상태 — 그 사이 다른 요청을 골라도 바뀌지 않는다
  const draft=readForm(form),errors=M.validateDraft(draft);
  const fform=F.formFor(draft.ship_mode_code),fx=fasstoFromForm(draft);
  if(fform&&fx)errors.push(...F.checkInput(fform,fx.recipient,fx.items));
  if(errors.length)return formError(errors.join(' '));
  const row=M.toInsertRow(draft),patch={};
  for(const k of SUMMARY)patch[k]=row[k];
  if(state.isHandler)for(const k of ['packing_code','etd_on','forwarder_text'])patch[k]=row[k];
  setBusy(true);formError('');
  let summarySaved=false;
  try{
   await api.update(t.id,t.status_code,patch);summarySaved=true;
   await saveFassto(t.id,fform,fx);
   closeForm();state.detailNote='요약을 저장했어요.';say(state.detailNote);await reload();
  }
  catch(e){
   if(summarySaved){await reload();formError('요약은 저장했지만 받는 곳·품목은 저장하지 못했어요. 다시 저장해 주세요. ('+M.errorMessage(e)+')');return;} // 목록·상세는 저장된 요약으로 새로 그리고, 창과 입력은 그대로 둔다
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
  const fform=F.formFor(draft.ship_mode_code),fx=fasstoFromForm(draft);
  if(fform&&fx)errors.push(...F.checkInput(fform,fx.recipient,fx.items));
  if(errors.length)return formError(errors.join(' '));
  const picked=Array.from($('lg-f-files')?.files||[]); // 기다리는 동안 창이 바뀌어도 고른 파일을 잃지 않게 먼저 읽는다
  setBusy(true);formError('');
  let row=null;
  try{
   row=await api.create(draft);const failed=[];let fasstoFailed=false;
   try{await saveFassto(row.id,fform,fx);}catch(e){fasstoFailed=true;} // 저장 순서: 요청 → 받는 곳 → 품목
   for(const f of picked){try{await api.uploadFile(row.id,f,'request');}catch(e){failed.push(f.name);}}
   closeForm();state.tab='mine';state.quick='';state.selected=row.id;state.pending=null;state.detailError='';
   const notes=[];
   if(fasstoFailed)notes.push('요청은 올라갔고 품목은 저장하지 못했어요. 상세에서 다시 입력해 주세요.');
   if(failed.length)notes.push(`요청은 올라갔고, ${failed.join(', ')} 파일은 올리지 못했어요. 아래 첨부에서 다시 올려 주세요.`);
   state.detailNote=notes.length?notes.join(' '):'요청을 올렸어요. 슬랙에도 곧 알림이 가요.';
   say(state.detailNote);
   await reload();
  }catch(e){if(row)say('요청은 올라갔어요. 목록을 새로고침해 주세요. ('+M.errorMessage(e)+')');else formError(M.errorMessage(e));}
  finally{setBusy(false);}
 }

 async function openFile(fid){
  const f=state.data.files.find(x=>x.id===fid);if(!f)return;
  const w=open('about:blank'); // 클릭 안에서 먼저 창을 열어야 Safari가 팝업으로 막지 않는다
  try{
   const u=await api.fileUrl(f.storage_path);if(!u)throw new Error('UNCONFIRMED');
   if(!w){fail('팝업이 막혀 파일을 열지 못했어요. 팝업을 허용해 주세요.');return;}
   try{w.opener=null;}catch(_){} w.location.href=u;
  }catch(e){try{w?.close();}catch(_){} fail(M.errorMessage(e));}
 }
 async function deleteFile(fid){
  const f=state.data.files.find(x=>x.id===fid);if(!f||state.busy)return;
  if(!confirm(`'${f.name_text}' 파일을 지울까요? 되돌릴 수 없어요.`))return;
  setBusy(true);
  try{await api.removeFile(f);state.detailError='';state.detailNote='파일을 지웠어요.';say(state.detailNote);await reload();}
  catch(e){await detailFail(e);}
  finally{setBusy(false);}
 }
 async function uploadFile(input){
  const r=current(),file=input.files?.[0];if(!r||!file)return;
  if(state.busy){try{input.value='';}catch(_){}return;}
  const kind=$('lg-file-kind')?.value||'etc';
  setBusy(true);
  try{await api.uploadFile(r.id,file,kind);state.detailError='';state.detailNote='파일을 올렸어요.';say(state.detailNote);await reload();}
  catch(e){await detailFail(e);}
  finally{try{input.value='';}catch(_){}setBusy(false);}
 }
 async function addComment(){
  const r=current(),input=$('lg-comment-body'),body=String(input?.value||'').trim();
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
  if((el=at('[data-kpi]'))){const k=el.dataset.kpi;if(k==='todo'){state.tab='todo';state.quick='';}else state.quick=state.quick===k?'':k;paint();return;}
  if((el=at('[data-tab]'))){state.tab=el.dataset.tab;state.quick='';paint();return;}
  if((el=at('[data-act]'))){
   const act=el.dataset.act;
   if(act==='new')return openNew();
   if(act==='refresh')return reload();
   if(act==='clear-quick'){state.quick='';paint();return;}
   if(act==='close-detail'){if(!state.busy)closeDetail();return;}
   if(act==='close-form'){if(!state.busy)closeForm();return;}
   if(act==='pending-cancel'){state.pending=null;state.detailError='';drawDetail();return;}
   if(act==='edit-summary')return openEdit();
   if(act==='edit-result'){if(state.busy)return;state.pending={kind:'result'};state.detailError='';drawDetail();focusPending();return;}
   if(act==='fassto-download')return downloadFassto();
   return;
  }
  if((el=at('[data-item-add]')))return addItem(el.dataset.itemAdd);
  if((el=at('[data-item-del]')))return removeItem(Number(el.dataset.itemDel));
  if((el=at('[data-to]')))return chooseStatus(el.dataset.to);
  if((el=at('[data-file-del]')))return deleteFile(el.dataset.fileDel);
  if((el=at('[data-file]'))){e.preventDefault?.();return openFile(el.dataset.file);}
  if((el=at('[data-comment-del]')))return deleteComment(el.dataset.commentDel);
  if((el=at('[data-open]')))return openDetail(el.dataset.open);
 }
 function onChange(e){
  const t=e.target;
  if(t?.dataset?.act==='file')return uploadFile(t);
  if(t?.name==='type_code'||t?.name==='ship_mode_code'){
   const fs=$('lg-f-overseas');if(fs)fs.hidden=!M.needsOverseas({type_code:$('lg-f-type_code')?.value,ship_mode_code:$('lg-f-ship_mode_code')?.value});
  }
  if(t?.name==='ship_mode_code'){
   if(state.formFassto)state.formFassto.form=F.formFor(t.value);
   const host=$('lg-f-fassto');if(host)host.innerHTML=renderFasstoFields(t.value,state.formFassto,fasstoCtx());
   return;
  }
  if(t?.dataset?.recipient&&state.formFassto){state.formFassto.recipient[t.dataset.recipient]=t.value;return;}
  if(t?.dataset?.itemField)return updateItem(Number(t.dataset.line),t.dataset.itemField,t.value);
 }
 function onInput(e){
  const t=e.target;
  if(t?.id==='lg-item-q'&&state.formFassto){state.formFassto.q=t.value;const host=$('lg-item-results');if(host)host.innerHTML=renderStockResults(F.searchStock(state.stock.groups,t.value),t.value);return;}
  if(t?.dataset?.recipient&&state.formFassto){state.formFassto.recipient[t.dataset.recipient]=t.value;return;}
  if(t?.dataset?.itemField&&t.dataset.itemField!=='lot')return updateItem(Number(t.dataset.line),t.dataset.itemField,t.value);
  if(e.target?.id==='lg-search'){state.q=e.target.value;drawList();return;}
  if(e.target?.id==='lg-comment-body')state.commentDraft=e.target.value;
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
  $('topbar-actions').innerHTML='<button type="button" class="btn btn-primary" id="lg-new"><i class="ti ti-plus"></i> 새 요청</button><button type="button" class="btn" id="lg-refresh"><i class="ti ti-refresh"></i> 새로고침</button>'
   +(pageUrl?`<a class="btn" id="lg-standalone" href="${esc(pageUrl)}" target="_blank" rel="noopener"><i class="ti ti-external-link"></i> 별도 페이지로 열기</a>`:'');
  $('content').innerHTML='<section class="lg"><div class="kpi-grid lg-kpis" id="lg-kpis"></div><div id="lg-stock-line"></div>'
   +'<div class="lg-bar"><nav class="tab-bar lg-tabs" id="lg-tabs" role="tablist" aria-label="물류 요청 보기"></nav><input type="search" id="lg-search" class="lg-search" placeholder="제목·거래처·송장 검색" aria-label="물류 요청 검색"></div>'
   +'<div id="lg-list"></div>'
   +'<dialog class="lg-dialog" id="lg-detail" aria-labelledby="lg-detail-title"></dialog><dialog class="lg-dialog lg-form-dialog" id="lg-form" aria-label="물류 요청 입력"></dialog></section>';
  const search=$('lg-search');if(search)search.value=state.q;
  $('lg-new').onclick=()=>openNew();
  $('lg-refresh').onclick=()=>{if(state.active)reload();};
  const c=$('content');c.onclick=onClick;c.onchange=onChange;c.oninput=onInput;c.onsubmit=onSubmit;
  const d=$('lg-detail'),f=$('lg-form');
  d.oncancel=e=>{e.preventDefault?.();if(state.busy||state.form)return;closeDetail();};
  f.oncancel=e=>{e.preventDefault?.();if(state.busy)return;closeForm();};
  for(const el of [d,f]){el.onkeydown=e=>e.stopPropagation?.();el.onpaste=e=>e.stopPropagation?.();}
  f.onkeydown=e=>{e.stopPropagation?.();if(e.key==='Enter'&&e.target?.id==='lg-item-q')e.preventDefault?.();}; // 상품 찾기에서 Enter가 요청을 올리지 않게
  paint();
  return reload();
 }
 function hide(){
  if(!state.active)return;
  state.active=false;closeForm();closeDetail();state.pendingOpen=null;
  const c=$('content');if(c){c.onclick=null;c.onchange=null;c.oninput=null;c.onsubmit=null;}
  // 다른 화면이 상단 버튼을 바꾸지 않는 경우(면세점 정산 등)에도 물류 버튼이 남지 않게, 아직 우리 버튼이면 비운다
  const tb=$('topbar-actions');if(tb&&String(tb.innerHTML||'').includes('id="lg-new"'))tb.innerHTML='';
 }
 // 슬랙 링크(logistics.html?id=…)가 넘겨 준 index.html?logistics=<id>를 읽고 주소에서 지운다. 없으면 null, id 없이 왔으면 ''.
 function takeUrlRequest(){
  let p;try{p=new URLSearchParams(location?.search||'');}catch(_){return null;}
  if(!p.has('logistics'))return null;
  const v=p.get('logistics')||'';p.delete('logistics');
  try{const qs=p.toString();history?.replaceState?.(history.state??null,'',(location.pathname||'')+(qs?'?'+qs:'')+(location.hash||''));}catch(_){}
  return v==='1'?'':v;
 }
 function openRequest(id){
  if(!id)return state.ready;
  if(!state.active||state.loading||!state.loaded){state.pendingOpen=id;return state.ready;}
  return openDetail(id);
 }
 client.auth?.onAuthStateChange?.((ev,session)=>{
  if(ev==='SIGNED_OUT'){hide();generation++;Object.assign(state,{loaded:false,loading:false,error:'',email:'',isHandler:false,data:EMPTY(),tab:'todo',quick:'',q:'',busy:false,stock:NO_STOCK(),fassto:NO_FASSTO(),fasstoErrors:[],formFassto:null});}
  else if(ev==='SIGNED_IN'&&state.active&&String(session?.user?.email||'').toLowerCase()!==state.email)reload();
 });
 return {show,hide,reload,openRequest,takeUrlRequest,state,changeStatus:chooseStatus,openDetail,downloadFassto};
}

return {createApi,kstWeek,summarize,listView,renderKpis,renderTabs,renderList,renderDetail,renderForm,renderStockBanner,renderStockResults,renderItems,renderFasstoFields,renderFasstoSection,mountTab};
});
