(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.TeamTasks=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
'use strict';
// 글로벌 영업팀 업무 목록. 승인 없이 바로 수정하며, 변경 이력은 DB 트리거가 남긴다(sql/team-tasks.sql).

const STATUS_CODES=['todo','in_progress','done','on_hold','canceled'];
const STATUS_LABELS={todo:'할 일',in_progress:'진행 중',done:'완료',on_hold:'보류',canceled:'취소'};
const SOURCE_LABELS={slack:'슬랙',gmail:'메일',drive:'드라이브',manual:'직접 입력'};
const FIELD_LABELS={created:'등록',title:'제목',assignee:'담당자',due:'기한',status:'상태',archived:'숨김'};
const OPEN=['todo','in_progress','on_hold'];
const TITLE_LIMIT=80,SUMMARY_LIMIT=300,NOTE_LIMIT=1000;
const DAY=24*60*60*1000,KST=9*60*60*1000;

const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const kstToday=nowMs=>new Date(nowMs+KST).toISOString().slice(0,10);
const kstEndOf=day=>{const [y,m,d]=day.split('-').map(Number);return Date.UTC(y,m-1,d,23,59)-KST;};
const addDays=(day,n)=>{const [y,m,d]=day.split('-').map(Number);return new Date(Date.UTC(y,m-1,d+n)).toISOString().slice(0,10);};
const isOpen=t=>OPEN.includes(t?.status_code);
const isOverdue=(t,nowMs)=>isOpen(t)&&Boolean(t.due_on)&&kstEndOf(t.due_on)<nowMs;
const byDue=(a,b)=>String(a.due_on||'9999').localeCompare(String(b.due_on||'9999'));

function buildTodayView(tasks,nowMs,{meEmail=null,onlyMine=false}={}){
 const today=kstToday(nowMs),recentFrom=nowMs-3*DAY;
 const visible=tasks.filter(t=>!t.is_archived&&(!onlyMine||t.assignee_email===meEmail));
 return{
  due:visible.filter(t=>isOpen(t)&&t.due_on&&t.due_on<=today).sort(byDue),
  unassigned:visible.filter(t=>isOpen(t)&&!t.assignee_email),
  recent:visible.filter(t=>Date.parse(t.created_at)>=recentFrom).sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at))),
 };
}

function filterTasks(tasks,{assignee='*',status='',kind='',query='',includeClosed=false}={}){
 const q=String(query||'').trim().toLowerCase();
 return tasks.filter(t=>{
  if(t.is_archived)return false;
  if(!includeClosed&&!status&&!isOpen(t))return false;
  if(assignee!=='*'&&(t.assignee_email||'')!==assignee)return false;
  if(status&&t.status_code!==status)return false;
  if(kind&&t.source_kind_code!==kind)return false;
  if(q&&!`${t.title_text||''} ${t.summary_text||''}`.toLowerCase().includes(q))return false;
  return true;
 }).sort(byDue);
}

function summarizeByAssignee(tasks,nowMs){
 const today=kstToday(nowMs),dow=new Date(today+'T00:00:00Z').getUTCDay();
 const [y,m,d]=addDays(today,dow===0?-6:1-dow).split('-').map(Number);
 const from=Date.UTC(y,m-1,d)-KST;
 const out=new Map();
 for(const t of tasks){
  if(t.is_archived)continue;
  const key=t.assignee_email||'';
  if(!out.has(key))out.set(key,{todo:0,inProgress:0,onHold:0,overdue:0,doneThisWeek:0});
  const s=out.get(key);
  if(t.status_code==='todo')s.todo++;
  if(t.status_code==='in_progress')s.inProgress++;
  if(t.status_code==='on_hold')s.onHold++;
  if(isOverdue(t,nowMs))s.overdue++;
  if(t.status_code==='done'&&Date.parse(t.done_at)>=from)s.doneThisWeek++;
 }
 return out;
}

const SENSITIVE=[
 ['통화와 붙은 숫자',/[$₩]\s?\d|\d[\d,]*(?:\.\d+)?\s?원|\d[\d,]*(?:\.\d+)?\s?(?:USD|KRW|JPY|EUR)\b|\b(?:USD|KRW|JPY|EUR)\s?\d/i],
 ['단가·금액 숫자',/(?:단가|금액|가격|price|amount)\s*[:：=]?\s*\d/i],
 ['전화번호',/(?:\+\d{1,3}[\s-]?)?\b0\d{1,2}[\s-]\d{3,4}[\s-]\d{4}\b/],
 ['이메일',/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/],
];
const findSensitive=(...texts)=>SENSITIVE.filter(([,re])=>texts.some(t=>re.test(String(t||'')))).map(([label])=>label);

function validateInput(raw){
 const title=String(raw.title_text||'').trim(),summary=String(raw.summary_text||'').trim(),note=String(raw.note_text||'').trim();
 if(!title)throw Error('제목을 입력하세요.');
 if(title.length>TITLE_LIMIT)throw Error(`제목은 ${TITLE_LIMIT}자까지 쓸 수 있습니다.`);
 if(summary.length>SUMMARY_LIMIT)throw Error(`요약은 ${SUMMARY_LIMIT}자까지 쓸 수 있습니다.`);
 if(note.length>NOTE_LIMIT)throw Error(`처리 메모는 ${NOTE_LIMIT}자까지 쓸 수 있습니다.`);
 const due=String(raw.due_on||'').trim();
 if(due&&!/^\d{4}-\d{2}-\d{2}$/.test(due))throw Error('기한 날짜를 다시 선택하세요.');
 const url=String(raw.source_url||'').trim();
 if(url&&!/^https:\/\//.test(url))throw Error('원문 링크는 https:// 로 시작해야 합니다.');
 const status=raw.status_code||'todo';
 if(!STATUS_CODES.includes(status))throw Error('상태를 다시 선택하세요.');
 return{title_text:title,summary_text:summary,note_text:note,due_on:due||null,source_url:url,status_code:status,assignee_email:raw.assignee_email||null};
}

function memberName(members,email){
 if(!email)return'담당 미지정';
 return members.find(m=>m.email===email)?.display_name||email.split('@')[0];
}

function historyText(h,members){
 const label=FIELD_LABELS[h.field_code]||h.field_code;
 const show=v=>h.field_code==='assignee'?memberName(members,v||null):h.field_code==='status'?(STATUS_LABELS[v]||v):h.field_code==='archived'?(v==='true'?'숨김':'표시'):(v||'없음');
 const when=new Date(Date.parse(h.changed_at)+KST).toISOString().slice(0,16).replace('T',' ');
 const by=String(h.changed_by_text||'');
 const who=by.includes('@')?memberName(members,by):(by||'알 수 없음');
 if(h.field_code==='created')return`${when} · ${who} · 등록`;
 return`${when} · ${who} · ${label}: ${show(h.from_text)} → ${show(h.to_text)}`;
}

function renderTaskList(tasks,members,nowMs,emptyText){
 if(!tasks.length)return`<p class="tt-empty">${esc(emptyText)}</p>`;
 return`<ul class="tt-list">${tasks.map(t=>{const late=isOverdue(t,nowMs);return`<li class="tt-item${late?' tt-late':''}">`
  +`<span class="badge tt-status tt-${esc(t.status_code)}">${esc(STATUS_LABELS[t.status_code]||t.status_code)}</span>`
  +`<div class="tt-body"><button type="button" class="tt-title" data-task-open="${esc(t.id)}">${esc(t.title_text)}</button>`
  +`<div class="tt-sub"><span>${esc(memberName(members,t.assignee_email))}</span>`
  +(!t.assignee_email&&t.suggested_assignee_text?`<span>제안: ${esc(t.suggested_assignee_text)}</span>`:'')
  +`<span class="tt-chip">${esc(SOURCE_LABELS[t.source_kind_code]||'기타')}</span>`
  +(t.requester_text?`<span>${esc(t.requester_text)}</span>`:'')
  +(t.source_url?`<a href="${esc(t.source_url)}" target="_blank" rel="noopener">원문</a>`:'')
  +`</div></div><span class="tt-due">${late?'지연 · ':''}${esc(t.due_on||'기한 없음')}</span></li>`;}).join('')}</ul>`;
}

function group(title,count,body){return`<section class="tt-group"><header><h3>${esc(title)}</h3><span class="tt-count">${count}건</span></header>${body}</section>`;}

function mount({document,sb,onMessage=()=>{}}){
 const state={active:false,tab:'today',tasks:[],members:[],loading:false,error:'',meEmail:null,onlyMine:false,
  filter:{assignee:'*',status:'',kind:'',query:'',includeClosed:false},dialog:null};
 const $=id=>document.getElementById(id);

 async function load(){
  state.loading=true;state.error='';paint();
  try{
   const session=(await sb.auth.getSession())?.data?.session;
   state.meEmail=session?.user?.email?.toLowerCase()||null;
   const [tasks,members]=await Promise.all([
    sb.from('team_tasks').select('*').eq('is_archived',false).order('created_at',{ascending:false}).limit(2000),
    sb.from('team_task_members').select('*').eq('is_active',true).order('sort_order').order('display_name'),
   ]);
   if(tasks.error)throw tasks.error;
   if(members.error)throw members.error;
   state.tasks=tasks.data||[];state.members=members.data||[];
  }catch(e){state.error='업무 목록을 불러오지 못했습니다: '+(e.message||e);}
  state.loading=false;paint();
 }

 function memberOptions(selected){
  return`<option value="">담당 미지정</option>`+state.members.map(m=>`<option value="${esc(m.email)}"${m.email===selected?' selected':''}>${esc(m.display_name)}</option>`).join('');
 }

 function viewToday(nowMs){
  const v=buildTodayView(state.tasks,nowMs,{meEmail:state.meEmail,onlyMine:state.onlyMine});
  return`<div class="tt-toolbar"><label><input type="checkbox" id="tt-only-mine"${state.onlyMine?' checked':''}> 내 담당만 보기</label></div>`
   +group('오늘까지 · 지연',v.due.length,renderTaskList(v.due,state.members,nowMs,'오늘까지 처리할 할 일이 없습니다.'))
   +(state.onlyMine?'':group('담당 미지정',v.unassigned.length,renderTaskList(v.unassigned,state.members,nowMs,'담당자가 없는 할 일이 없습니다.')))
   +group('최근 3일 등록',v.recent.length,renderTaskList(v.recent,state.members,nowMs,'최근 등록된 할 일이 없습니다. 수집 페이지에서 보내거나 직접 추가하세요.'));
 }

 function viewAll(nowMs){
  const f=state.filter,list=filterTasks(state.tasks,f);
  return`<div class="tt-toolbar">`
   +`<select id="tt-f-assignee" aria-label="담당자"><option value="*"${f.assignee==='*'?' selected':''}>모든 담당자</option><option value=""${f.assignee===''?' selected':''}>담당 미지정</option>${state.members.map(m=>`<option value="${esc(m.email)}"${f.assignee===m.email?' selected':''}>${esc(m.display_name)}</option>`).join('')}</select>`
   +`<select id="tt-f-status" aria-label="상태"><option value="">열린 상태 전체</option>${STATUS_CODES.map(s=>`<option value="${s}"${f.status===s?' selected':''}>${STATUS_LABELS[s]}</option>`).join('')}</select>`
   +`<select id="tt-f-kind" aria-label="출처"><option value="">모든 출처</option>${Object.entries(SOURCE_LABELS).map(([k,l])=>`<option value="${k}"${f.kind===k?' selected':''}>${l}</option>`).join('')}</select>`
   +`<input id="tt-f-query" type="search" placeholder="제목·요약 검색" value="${esc(f.query)}">`
   +`<label><input type="checkbox" id="tt-f-closed"${f.includeClosed?' checked':''}> 완료·취소 포함</label></div>`
   +group('할 일',list.length,renderTaskList(list,state.members,nowMs,'조건에 맞는 할 일이 없습니다.'));
 }

 function viewPeople(nowMs){
  const rows=[...summarizeByAssignee(state.tasks,nowMs).entries()].sort((a,b)=>b[1].overdue-a[1].overdue||(b[1].todo+b[1].inProgress)-(a[1].todo+a[1].inProgress));
  if(!rows.length)return'<p class="tt-empty">아직 등록된 할 일이 없습니다.</p>';
  return`<div class="tw"><table class="tt-table"><thead><tr><th>담당자</th><th class="tt-num">할 일</th><th class="tt-num">진행 중</th><th class="tt-num">보류</th><th class="tt-num">지연</th><th class="tt-num">이번 주 완료</th></tr></thead><tbody>`
   +rows.map(([email,s])=>`<tr><td><button type="button" class="alink tt-person" data-person="${esc(email)}">${esc(memberName(state.members,email||null))}</button></td><td class="tt-num">${s.todo}</td><td class="tt-num">${s.inProgress}</td><td class="tt-num">${s.onHold}</td><td class="tt-num${s.overdue?' tt-late-num':''}">${s.overdue}</td><td class="tt-num">${s.doneThisWeek}</td></tr>`).join('')
   +'</tbody></table></div>';
 }

 function paint(){
  if(!state.active)return;
  const host=$('tt-view');if(!host)return;
  document.querySelectorAll('[data-tt-tab]').forEach(b=>b.setAttribute('aria-selected',String(b.dataset.ttTab===state.tab)));
  if(state.loading){host.innerHTML='<p role="status" class="tt-empty">업무 목록을 불러오는 중입니다…</p>';return;}
  if(state.error){host.innerHTML=`<p class="tt-error" role="alert">${esc(state.error)}</p>`;return;}
  const nowMs=Date.now();
  host.innerHTML=state.tab==='all'?viewAll(nowMs):state.tab==='people'?viewPeople(nowMs):viewToday(nowMs);
 }

 function closeDialog(){if(state.dialog){state.dialog.close();state.dialog.remove();state.dialog=null;}}

 function openDialog(html,onSubmit){
  closeDialog();
  const d=document.createElement('dialog');d.className='tt-dialog';d.innerHTML=html;document.body.append(d);state.dialog=d;
  d.querySelector('[data-close]').onclick=()=>closeDialog();
  d.addEventListener('cancel',e=>{e.preventDefault();closeDialog();});
  for(const type of ['keydown','paste'])d.addEventListener(type,e=>e.stopPropagation());
  const form=d.querySelector('form');
  form.onsubmit=async e=>{
   e.preventDefault();
   const err=d.querySelector('[data-form-error]');err.textContent='';
   const confirmBox=d.querySelector('[data-confirm]');
   let input;try{input=validateInput(Object.fromEntries(new FormData(form)));}catch(x){err.textContent=x.message;return;}
   const warn=findSensitive(input.title_text,input.summary_text,input.note_text);
   if(warn.length&&confirmBox.hidden){confirmBox.hidden=false;confirmBox.querySelector('span').textContent=`${warn.join(', ')}로 보이는 내용이 있습니다. 금액·단가·연락처는 쓰지 않는 것이 원칙입니다. 그래도 저장하려면 저장을 한 번 더 누르세요.`;return;}
   form.querySelectorAll('button,input,select,textarea').forEach(el=>{el.disabled=true;});
   try{await onSubmit(input);closeDialog();await load();}
   catch(x){err.textContent='저장하지 못했습니다: '+(x.message||x);form.querySelectorAll('button,input,select,textarea').forEach(el=>{el.disabled=false;});}
  };
  d.showModal();
  return d;
 }

 const formFields=t=>`<label>제목<input name="title_text" maxlength="${TITLE_LIMIT}" required value="${esc(t?.title_text||'')}"></label>`
  +`<label>요약<textarea name="summary_text" maxlength="${SUMMARY_LIMIT}">${esc(t?.summary_text||'')}</textarea></label>`
  +`<div class="tt-grid"><label>담당자<select name="assignee_email">${memberOptions(t?t.assignee_email:state.meEmail)}</select></label>`
  +`<label>기한<input type="date" name="due_on" value="${esc(t?.due_on||'')}"></label>`
  +`<label>상태<select name="status_code">${STATUS_CODES.map(s=>`<option value="${s}"${(t?.status_code||'todo')===s?' selected':''}>${STATUS_LABELS[s]}</option>`).join('')}</select></label></div>`;

 const confirmBlock='<p class="tt-warn" data-confirm hidden><span></span></p><p class="tt-error" data-form-error role="alert"></p>';

 function openNew(){
  openDialog(`<form><header><h2>할 일 직접 추가</h2><button type="button" class="btn" data-close>닫기</button></header>${formFields(null)}`
   +`<label>원문 링크(선택)<input name="source_url" type="url" placeholder="https://"></label>`
   +`<input type="hidden" name="note_text" value="">${confirmBlock}<footer><button class="btn btn-primary" type="submit">추가</button></footer></form>`,
   async input=>{
    const {error}=await sb.from('team_tasks').insert({...input,source_kind_code:'manual'}).select('id').single();
    if(error)throw error;onMessage('할 일을 추가했습니다.');
   });
 }

 async function openTask(id){
  const t=state.tasks.find(x=>x.id===id);if(!t)return;
  const d=openDialog(`<form><header><h2>할 일 상세</h2><button type="button" class="btn" data-close>닫기</button></header>${formFields(t)}`
   +`<label>처리 메모<textarea name="note_text" maxlength="${NOTE_LIMIT}">${esc(t.note_text||'')}</textarea></label>`
   +`<input type="hidden" name="source_url" value="${esc(t.source_url||'')}">`
   +`<p class="tt-meta">${esc(SOURCE_LABELS[t.source_kind_code]||'기타')} · ${esc(t.requester_text||'요청 출처 없음')} · 등록 ${esc(String(t.created_by_text||'').includes('@')?memberName(state.members,t.created_by_text):(t.created_by_text||'알 수 없음'))}`
   +(!t.assignee_email&&t.suggested_assignee_text?` · 제안 담당: ${esc(t.suggested_assignee_text)}`:'')
   +(t.source_url?` · <a href="${esc(t.source_url)}" target="_blank" rel="noopener">원문 보기</a>`:'')+`</p>`
   +`${confirmBlock}<footer><button type="button" class="btn" data-archive>목록에서 숨기기</button><button class="btn btn-primary" type="submit">저장</button></footer>`
   +`<h3>변경 이력</h3><ol class="tt-history" data-history><li>불러오는 중…</li></ol></form>`,
   async input=>{
    const patch={title_text:input.title_text,summary_text:input.summary_text,note_text:input.note_text,due_on:input.due_on,status_code:input.status_code,assignee_email:input.assignee_email};
    const {error}=await sb.from('team_tasks').update(patch).eq('id',id).select('id').single();
    if(error)throw error;onMessage('저장했습니다.');
   });
  const archive=d.querySelector('[data-archive]');
  archive.onclick=async()=>{
   if(archive.dataset.armed!=='1'){archive.dataset.armed='1';archive.textContent='한 번 더 누르면 숨깁니다';return;}
   const {error}=await sb.from('team_tasks').update({is_archived:true}).eq('id',id).select('id').single();
   if(error){d.querySelector('[data-form-error]').textContent='숨기지 못했습니다: '+error.message;return;}
   closeDialog();onMessage('목록에서 숨겼습니다. 기록은 남아 있습니다.');await load();
  };
  const {data,error}=await sb.from('team_task_history').select('*').eq('task_id',id).order('changed_at');
  const host=d.querySelector('[data-history]');if(!host)return;
  host.innerHTML=error?`<li>이력을 불러오지 못했습니다: ${esc(error.message)}</li>`:(data||[]).map(h=>`<li>${esc(historyText(h,state.members))}</li>`).join('')||'<li>아직 바뀐 내용이 없습니다.</li>';
 }

 function show(){
  state.active=true;
  $('topbar-actions').innerHTML='<button class="btn" id="tt-refresh">새로고침</button><button class="btn btn-primary" id="tt-new">직접 추가</button>';
  $('content').innerHTML='<section class="tt"><p class="tt-help">슬랙·메일·드라이브에서 모은 할 일과 직접 추가한 할 일입니다. 승인 없이 바로 저장되고, 바꾼 내용은 이력으로 남습니다.</p>'
   +'<nav class="tt-tabs" role="tablist"><button type="button" role="tab" data-tt-tab="today">오늘</button><button type="button" role="tab" data-tt-tab="all">전체 목록</button><button type="button" role="tab" data-tt-tab="people">담당자별</button></nav>'
   +'<div id="tt-view"></div></section>';
  $('tt-refresh').onclick=()=>load();
  $('tt-new').onclick=()=>openNew();
  const root=$('content');
  root.onclick=e=>{
   const tab=e.target.closest('[data-tt-tab]');if(tab){state.tab=tab.dataset.ttTab;paint();return;}
   const open=e.target.closest('[data-task-open]');if(open){openTask(open.dataset.taskOpen);return;}
   const person=e.target.closest('[data-person]');if(person){state.filter={...state.filter,assignee:person.dataset.person,status:'',includeClosed:false};state.tab='all';paint();}
  };
  root.onchange=e=>{
   const id=e.target.id,f=state.filter;
   if(id==='tt-only-mine')state.onlyMine=e.target.checked;
   else if(id==='tt-f-assignee')f.assignee=e.target.value;
   else if(id==='tt-f-status')f.status=e.target.value;
   else if(id==='tt-f-kind')f.kind=e.target.value;
   else if(id==='tt-f-query')f.query=e.target.value;
   else if(id==='tt-f-closed')f.includeClosed=e.target.checked;
   else return;
   paint();
  };
  paint();load();
 }

 sb.auth?.onAuthStateChange?.(()=>{if(state.active)load();});
 return{show,hide(){state.active=false;closeDialog();const c=$('content');if(c){c.onclick=null;c.onchange=null;}},reload:load,state};
}

return{STATUS_CODES,STATUS_LABELS,SOURCE_LABELS,isOpen,isOverdue,kstToday,buildTodayView,filterTasks,summarizeByAssignee,findSensitive,validateInput,memberName,historyText,renderTaskList,mount,esc};
});
