(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.TeamTasks=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
'use strict';
// 글로벌 영업팀 업무 목록. 승인 없이 바로 수정하며, 변경 이력은 DB 트리거가 남긴다(sql/team-tasks.sql).

const STATUS_CODES=['todo','in_progress','done','on_hold','canceled'];
const STATUS_LABELS={todo:'할 일',in_progress:'진행 중',done:'완료',on_hold:'보류',canceled:'취소'};
const SOURCE_LABELS={slack:'슬랙',gmail:'메일',drive:'드라이브',manual:'직접 입력'};
const FIELD_LABELS={created:'등록',title:'제목',assignee:'담당자',due:'기한',status:'상태',archived:'숨김'};
const OPEN=['todo','in_progress','on_hold'];
// 팀 밖 업무를 모으는 명단 항목(실제 사람 계정이 아님). DB 명단에 같은 메일로 등록한다.
const OTHER_TEAM_EMAIL='other-team@entropymakeup.com';
const TITLE_LIMIT=80,SUMMARY_LIMIT=300,NOTE_LIMIT=1000;
const DAY=24*60*60*1000,KST=9*60*60*1000;

const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const kstToday=nowMs=>new Date(nowMs+KST).toISOString().slice(0,10);
const kstEndOf=day=>{const [y,m,d]=day.split('-').map(Number);return Date.UTC(y,m-1,d,23,59)-KST;};
const addDays=(day,n)=>{const [y,m,d]=day.split('-').map(Number);return new Date(Date.UTC(y,m-1,d+n)).toISOString().slice(0,10);};
const isOpen=t=>OPEN.includes(t?.status_code);
const isOverdue=(t,nowMs)=>isOpen(t)&&Boolean(t.due_on)&&kstEndOf(t.due_on)<nowMs;
const byDue=(a,b)=>String(a.due_on||'9999').localeCompare(String(b.due_on||'9999'));

function weekStartMs(nowMs){
 const today=kstToday(nowMs),dow=new Date(today+'T00:00:00Z').getUTCDay();
 const [y,m,d]=addDays(today,dow===0?-6:1-dow).split('-').map(Number);
 return Date.UTC(y,m-1,d)-KST;
}
function monthStartMs(nowMs){
 const [y,m]=kstToday(nowMs).split('-').map(Number);
 return Date.UTC(y,m-1,1)-KST;
}

// 완료 탭: 끝난 할 일만, 최근 완료 순. period: 'week' | 'month' | 'all'
function filterDone(tasks,{assignee='*',period='week'}={},nowMs){
 const from=period==='week'?weekStartMs(nowMs):period==='month'?monthStartMs(nowMs):-Infinity;
 return tasks.filter(t=>!t.is_archived&&t.status_code==='done'&&(assignee==='*'||(t.assignee_email||'')===assignee)&&Date.parse(t.done_at)>=from)
  .sort((a,b)=>String(b.done_at).localeCompare(String(a.done_at)));
}

// 탭 이름에 붙일 열린 할 일·지연 건수
function openCounts(tasks,assignee,nowMs){
 const mine=tasks.filter(t=>!t.is_archived&&isOpen(t)&&(t.assignee_email||'')===assignee);
 return{open:mine.length,overdue:mine.filter(t=>isOverdue(t,nowMs)).length};
}

function filterTasks(tasks,{assignee='*',status='',kind='',query='',includeClosed=false}={}){
 const q=String(query||'').trim().toLowerCase();
 return tasks.filter(t=>{
  if(t.is_archived)return false;
  if(!includeClosed&&!status&&!isOpen(t))return false;
  if(assignee==='*'&&t.assignee_email===OTHER_TEAM_EMAIL)return false; // 전체 목록에는 타팀업무를 빼고 타팀업무 탭에서만 본다
  if(assignee!=='*'&&(t.assignee_email||'')!==assignee)return false;
  if(status&&t.status_code!==status)return false;
  if(kind&&t.source_kind_code!==kind)return false;
  if(q&&!`${t.title_text||''} ${t.summary_text||''}`.toLowerCase().includes(q))return false;
  return true;
 }).sort(byDue);
}

function summarizeByAssignee(tasks,nowMs){
 const from=weekStartMs(nowMs);
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

function renderTaskList(tasks,members,nowMs,emptyText,{selectable=false,selected=new Set()}={}){
 if(!tasks.length)return`<p class="tt-empty">${esc(emptyText)}</p>`;
 return`<ul class="tt-list${selectable?' tt-selectable':''}">${tasks.map(t=>{const late=isOverdue(t,nowMs);return`<li class="tt-item${late?' tt-late':''}">`
  +(selectable?`<input type="checkbox" class="tt-pick" data-pick="${esc(t.id)}" aria-label="삭제할 할 일로 선택"${selected.has(t.id)?' checked':''}>`:'')
  +`<span class="badge tt-status tt-${esc(t.status_code)}">${esc(STATUS_LABELS[t.status_code]||t.status_code)}</span>`
  +`<div class="tt-body"><button type="button" class="tt-title" data-task-open="${esc(t.id)}" title="${esc(t.title_text)}">${esc(t.title_text)}</button>`
  +`<div class="tt-sub"><select class="tt-assign" data-assign="${esc(t.id)}" aria-label="담당자 바꾸기"><option value="">담당 미지정</option>${members.map(m=>`<option value="${esc(m.email)}"${m.email===t.assignee_email?' selected':''}>${esc(m.display_name)}</option>`).join('')}${t.assignee_email&&!members.some(m=>m.email===t.assignee_email)?`<option value="${esc(t.assignee_email)}" selected>${esc(memberName(members,t.assignee_email))}</option>`:''}</select>`
  +(!t.assignee_email&&t.suggested_assignee_text?`<span>제안: ${esc(t.suggested_assignee_text)}</span>`:'')
  +`<span class="tt-chip">${esc(SOURCE_LABELS[t.source_kind_code]||'기타')}</span>`
  +(t.requester_text?`<span class="tt-req" title="${esc(t.requester_text)}">${esc(t.requester_text)}</span>`:'')
  +(t.source_url?`<a href="${esc(t.source_url)}" target="_blank" rel="noopener">원문</a>`:'')
  +`</div></div><div class="tt-side"><input type="date" class="tt-due-input${late?' tt-late-due':''}" data-due="${esc(t.id)}" value="${esc(t.due_on||'')}" aria-label="기한 바꾸기${late?' (기한 지남)':''}" title="${late?'기한이 지났습니다. 날짜를 바꿀 수 있습니다.':'기한 바꾸기'}">`
  +(isOpen(t)?`<button type="button" class="btn tt-done-btn" data-set-status="done" data-task="${esc(t.id)}">완료</button>`:'')
  +`</div></li>`;}).join('')}</ul>`;
}

// 업무 리스트업 프롬프트: {{MY_NAME}}·{{MY_EMAIL}} 자리를 로그인한 사람으로 채운다.
function fillRoutine(template,{name,email}){
 return String(template||'').split('{{MY_NAME}}').join(String(name||'')).split('{{MY_EMAIL}}').join(String(email||''));
}

// 대시보드에서 확인할 수 있는 설정만 판정한다. 나머지는 각자의 Claude가 실행 첫 단계에서 점검한다.
function listupChecks({meEmail,members}){
 const email=String(meEmail||'').toLowerCase();
 const me=(members||[]).find(m=>String(m.email||'').toLowerCase()===email);
 return[
  {label:'회사 계정 로그인',ok:email.endsWith('@entropymakeup.com'),fix:'회사 구글 계정으로 다시 로그인하세요.'},
  {label:'업무 목록 담당자 명단 등록',ok:!!me,fix:'본부장에게 담당자 명단 등록을 요청하세요.'},
  {label:'Claude 커넥터(슬랙·Gmail·구글 캘린더·구글 드라이브)',ok:null,fix:'claude.ai 설정 → 커넥터에서 연결합니다. 실행하면 Claude가 확인합니다.'},
  {label:'수집 페이지 초대',ok:null,fix:'본부장에게 수집 페이지 초대를 요청하세요. 실행하면 Claude가 확인합니다.'},
  {label:'평일 오전 9시 자동 실행',ok:null,fix:'처음 실행하면 Claude가 등록할지 물어봅니다.'},
 ];
}

function group(title,count,body){return`<section class="tt-group"><header><h3>${esc(title)}</h3><span class="tt-count">${count}건</span></header>${body}</section>`;}

function mount({document,sb,onMessage=()=>{},collectorUrl='',routineUrl=''}){
 // 탭: 'all' 전체 목록 · 'p:<메일>' 담당자별 페이지 · 'p:' 담당 미지정 · 'done' 완료
 const state={active:false,tab:'all',tasks:[],members:[],loading:false,error:'',meEmail:null,
  filter:{status:'',kind:'',query:''},doneFilter:{assignee:'*',period:'week'},dialog:null,isAdmin:false,selected:new Set(),deleteArmed:false};
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
   state.isAdmin=!!state.members.find(m=>m.email===state.meEmail)?.is_admin;
   const ids=new Set(state.tasks.map(t=>t.id));state.selected=new Set([...state.selected].filter(id=>ids.has(id)));state.deleteArmed=false;
  }catch(e){state.error='업무 목록을 불러오지 못했습니다: '+(e.message||e);}
  state.loading=false;paint();
 }

 function memberOptions(selected){
  return`<option value="">담당 미지정</option>`+state.members.map(m=>`<option value="${esc(m.email)}"${m.email===selected?' selected':''}>${esc(m.display_name)}</option>`).join('');
 }

 function tabs(nowMs){
  const tab=(key,label,extra='')=>`<button type="button" role="tab" data-tt-tab="${esc(key)}" aria-selected="${state.tab===key}">${esc(label)}${extra}</button>`;
  const badge=assignee=>{const c=openCounts(state.tasks,assignee,nowMs);return` <span class="tt-count">${c.open}</span>`+(c.overdue?` <span class="tt-count tt-late-num">지연 ${c.overdue}</span>`:'');};
  return tab('all','전체 목록')
   +state.members.map(m=>tab('p:'+m.email,m.display_name,badge(m.email))).join('')
   +tab('p:','담당 미지정',badge(''))
   +tab('done','완료');
 }

 function filterBar(){
  const f=state.filter;
  return`<div class="tt-toolbar">`
   +`<select id="tt-f-status" aria-label="상태"><option value="">열린 상태 전체</option>${STATUS_CODES.filter(s=>s!=='done').map(s=>`<option value="${s}"${f.status===s?' selected':''}>${STATUS_LABELS[s]}</option>`).join('')}</select>`
   +`<select id="tt-f-kind" aria-label="출처"><option value="">모든 출처</option>${Object.entries(SOURCE_LABELS).map(([k,l])=>`<option value="${k}"${f.kind===k?' selected':''}>${l}</option>`).join('')}</select>`
   +`<input id="tt-f-query" type="search" placeholder="제목·요약 검색" value="${esc(f.query)}">`
   +`</div>`;
 }

 function viewList(assignee,nowMs){
  const list=filterTasks(state.tasks,{...state.filter,assignee});
  const title=assignee==='*'?'열린 할 일':assignee===''?'담당 미지정':assignee===OTHER_TEAM_EMAIL?'타팀업무':memberName(state.members,assignee)+'님의 할 일';
  return filterBar()+deleteBar(list)+group(title,list.length,renderTaskList(list,state.members,nowMs,assignee==='*'?'열린 할 일이 없습니다. 업무 리스트업으로 모으거나 직접 추가하세요.':'열린 할 일이 없습니다.',{selectable:state.isAdmin,selected:state.selected}));
 }

 function deleteBar(list){
  if(!state.isAdmin)return'';
  const n=state.selected.size,allOn=list.length>0&&list.every(t=>state.selected.has(t.id));
  return`<div class="tt-toolbar tt-delete-bar"><label class="tt-pick-all"><input type="checkbox" data-pick-all="${esc(list.map(t=>t.id).join(','))}"${allOn?' checked':''}> 이 화면 전체 선택</label>`
   +`<button type="button" class="btn${state.deleteArmed?' tt-danger':''}" data-delete-selected${n?'':' disabled'}>${state.deleteArmed?`한 번 더 누르면 ${n}건을 완전히 삭제합니다`:`선택 삭제 (${n})`}</button>`
   +(n?'<button type="button" class="btn" data-clear-selected>선택 해제</button>':'')
   +'<span class="tt-meta">삭제는 되돌릴 수 없고, 누가 지웠는지는 변경 이력에 남습니다.</span></div>';
 }

 async function deleteTasks(ids){
  if(!ids.length)return;
  const {data,error}=await sb.from('team_tasks').delete().in('id',ids).select('id');
  if(error){onMessage('삭제하지 못했습니다: '+error.message);return false;}
  const n=(data||[]).length;
  onMessage(n===ids.length?`${n}건을 삭제했습니다.`:`${ids.length}건 중 ${n}건만 삭제했습니다. 삭제 권한을 확인하세요.`);
  state.selected.clear();state.deleteArmed=false;await load();return true;
 }

 function viewDone(nowMs){
  const f=state.doneFilter,list=filterDone(state.tasks,f,nowMs);
  const doneBy=t=>{const by=String(t.done_by_text||'');return by.includes('@')?memberName(state.members,by):(by||'알 수 없음');};
  const rows=list.map(t=>`<tr><td><button type="button" class="tt-title" data-task-open="${esc(t.id)}">${esc(t.title_text)}</button></td>`
   +`<td>${esc(memberName(state.members,t.assignee_email))}</td><td>${esc(doneBy(t))}</td>`
   +`<td class="tt-num">${esc(new Date(Date.parse(t.done_at)+KST).toISOString().slice(0,16).replace('T',' '))}</td>`
   +`<td>${esc(SOURCE_LABELS[t.source_kind_code]||'기타')}</td>`
   +`<td><button type="button" class="btn" data-set-status="todo" data-task="${esc(t.id)}">되돌리기</button></td></tr>`).join('');
  return`<div class="tt-toolbar">`
   +`<select id="tt-d-assignee" aria-label="담당자"><option value="*"${f.assignee==='*'?' selected':''}>모든 담당자</option><option value=""${f.assignee===''?' selected':''}>담당 미지정</option>${state.members.map(m=>`<option value="${esc(m.email)}"${f.assignee===m.email?' selected':''}>${esc(m.display_name)}</option>`).join('')}</select>`
   +`<select id="tt-d-period" aria-label="완료 기간"><option value="week"${f.period==='week'?' selected':''}>이번 주</option><option value="month"${f.period==='month'?' selected':''}>이번 달</option><option value="all"${f.period==='all'?' selected':''}>전체</option></select></div>`
   +group('완료한 할 일',list.length,list.length?`<div class="tw"><table class="tt-table"><thead><tr><th>할 일</th><th>담당자</th><th>완료한 사람</th><th class="tt-num">완료 시각</th><th>출처</th><th><span class="sr-only">처리</span></th></tr></thead><tbody>${rows}</tbody></table></div>`:'<p class="tt-empty">이 기간에 완료한 할 일이 없습니다.</p>');
 }

 function paint(){
  if(!state.active)return;
  const host=$('tt-view'),bar=$('tt-tabs');if(!host||!bar)return;
  const nowMs=Date.now();
  if(state.tab.startsWith('p:')&&state.tab!=='p:'&&state.members.length&&!state.members.some(m=>'p:'+m.email===state.tab))state.tab='all';
  bar.innerHTML=tabs(nowMs);
  if(state.loading){host.innerHTML='<p role="status" class="tt-empty">업무 목록을 불러오는 중입니다…</p>';return;}
  if(state.error){host.innerHTML=`<p class="tt-error" role="alert">${esc(state.error)}</p>`;return;}
  host.innerHTML=state.tab==='done'?viewDone(nowMs):state.tab==='all'?viewList('*',nowMs):viewList(state.tab.slice(2),nowMs);
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

 async function openListup(){
  closeDialog();
  const me=state.members.find(m=>m.email===state.meEmail);
  const name=me?.display_name||(state.meEmail||'').split('@')[0];
  const mark=ok=>ok===true?'✓':ok===false?'✗':'·';
  const checks=listupChecks({meEmail:state.meEmail,members:state.members});
  const d=document.createElement('dialog');d.className='tt-dialog';
  d.innerHTML=`<form method="dialog"><header><h2>업무 리스트업</h2><button type="button" class="btn" data-close>닫기</button></header>`
   +`<p class="tt-help">내 Claude가 지난 목록을 이어받아 슬랙(스레드 답글 포함)·받은/보낸 메일·캘린더·드라이브·이 PC의 다른 Claude 대화와 메모리를 확인합니다. 내 할 일마다 해결됨·진행 중·근거 없음을 판정해 상태를 갱신하고, 새로 생긴 할 일을 이 목록에 추가한 뒤 아침 브리핑을 씁니다. 메시지를 보내지는 않습니다. 반영까지 10분 정도 걸립니다.</p>`
   +`<h3>설정 점검</h3><ul class="tt-checks">${checks.map(c=>`<li data-ok="${c.ok}"><b>${mark(c.ok)}</b> ${esc(c.label)}${c.ok===true?'':` — <span>${esc(c.fix)}</span>`}</li>`).join('')}</ul>`
   +`<h3>시작하는 법</h3><ol class="tt-steps"><li>아래 프롬프트를 복사합니다.</li><li>Claude 데스크톱 앱의 Code 탭에서 새 대화에 붙여 넣고 실행합니다(대화 기록을 함께 보려면 Code 탭이어야 합니다). 첫 실행에서 설정을 점검하고 빠진 것을 알려 줍니다.</li><li>평일 오전 9시 자동 실행을 등록할지 물으면 동의합니다. 그 뒤로는 필요할 때 예약 작업의 "지금 실행"을 누르면 됩니다.</li></ol>`
   +`<textarea class="tt-prompt" readonly rows="10" data-prompt>프롬프트를 불러오는 중…</textarea>`
   +`<p class="tt-error" data-form-error role="alert"></p><footer><button type="button" class="btn btn-primary" data-copy disabled>프롬프트 복사</button></footer></form>`;
  document.body.append(d);state.dialog=d;
  d.querySelector('[data-close]').onclick=()=>closeDialog();
  d.addEventListener('cancel',e=>{e.preventDefault();closeDialog();});
  for(const type of ['keydown','paste'])d.addEventListener(type,e=>e.stopPropagation());
  d.showModal();
  const area=d.querySelector('[data-prompt]'),copy=d.querySelector('[data-copy]'),err=d.querySelector('[data-form-error]');
  try{
   const res=await fetch(routineUrl,{cache:'no-cache'});
   if(!res.ok)throw new Error('HTTP '+res.status);
   area.value=fillRoutine(await res.text(),{name,email:state.meEmail});copy.disabled=false;
  }catch(x){area.value='';err.textContent='프롬프트를 불러오지 못했습니다: '+(x.message||x);return;}
  copy.onclick=async()=>{
   try{await navigator.clipboard.writeText(area.value);onMessage('프롬프트를 복사했습니다.');}
   catch{area.focus();area.select();err.textContent='자동 복사가 막혀 있습니다. 선택된 글을 Ctrl+C로 복사하세요.';}
  };
 }

 async function openTask(id){
  const t=state.tasks.find(x=>x.id===id);if(!t)return;
  const d=openDialog(`<form><header><h2>할 일 상세</h2><button type="button" class="btn" data-close>닫기</button></header>${formFields(t)}`
   +`<label>처리 메모<textarea name="note_text" maxlength="${NOTE_LIMIT}">${esc(t.note_text||'')}</textarea></label>`
   +`<input type="hidden" name="source_url" value="${esc(t.source_url||'')}">`
   +`<p class="tt-meta">${esc(SOURCE_LABELS[t.source_kind_code]||'기타')} · ${esc(t.requester_text||'요청 출처 없음')} · 등록 ${esc(String(t.created_by_text||'').includes('@')?memberName(state.members,t.created_by_text):(t.created_by_text||'알 수 없음'))}`
   +(!t.assignee_email&&t.suggested_assignee_text?` · 제안 담당: ${esc(t.suggested_assignee_text)}`:'')
   +(t.source_url?` · <a href="${esc(t.source_url)}" target="_blank" rel="noopener">원문 보기</a>`:'')+`</p>`
   +`${confirmBlock}<footer>${state.isAdmin?'<button type="button" class="btn" data-delete>삭제</button>':''}<button type="button" class="btn" data-archive>목록에서 숨기기</button><button class="btn btn-primary" type="submit">저장</button></footer>`
   +`<h3>변경 이력</h3><ol class="tt-history" data-history><li>불러오는 중…</li></ol></form>`,
   async input=>{
    const patch={title_text:input.title_text,summary_text:input.summary_text,note_text:input.note_text,due_on:input.due_on,status_code:input.status_code,assignee_email:input.assignee_email};
    const {error}=await sb.from('team_tasks').update(patch).eq('id',id).select('id').single();
    if(error)throw error;onMessage('저장했습니다.');
   });
  const del=d.querySelector('[data-delete]');
  if(del)del.onclick=async()=>{
   if(del.dataset.armed!=='1'){del.dataset.armed='1';del.textContent='한 번 더 누르면 완전히 삭제합니다';del.classList.add('tt-danger');return;}
   closeDialog();await deleteTasks([id]);
  };
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

 // 목록에서 바로 완료 처리하거나 완료를 되돌린다. 완료자·시각과 이력은 DB 트리거가 남긴다.
 async function setStatus(button){
  const id=button.dataset.task,to=button.dataset.setStatus;
  button.disabled=true;
  const {error}=await sb.from('team_tasks').update({status_code:to}).eq('id',id).select('id').single();
  if(error){button.disabled=false;onMessage('상태를 바꾸지 못했습니다: '+error.message);return;}
  onMessage(to==='done'?'완료로 바꿨습니다. 완료 탭에서 볼 수 있습니다.':'열린 할 일로 되돌렸습니다.');
  await load();
 }

 // 목록에서 바로 기한을 바꾼다. 비우면 기한 없음. 이력은 DB 트리거가 남긴다.
 async function changeDue(input){
  const id=input.dataset.due,t=state.tasks.find(x=>x.id===id);if(!t)return;
  const to=input.value||null;input.disabled=true;
  const {error}=await sb.from('team_tasks').update({due_on:to}).eq('id',id).select('id').single();
  if(error){input.disabled=false;input.value=t.due_on||'';onMessage('기한을 바꾸지 못했습니다: '+error.message);return;}
  onMessage(to?`기한을 ${to}(으)로 바꿨습니다.`:'기한을 지웠습니다.');
  await load();
 }

 // 목록에서 바로 담당자를 바꾼다. 이력은 DB 트리거가 남긴다.
 async function reassign(select){
  const id=select.dataset.assign,t=state.tasks.find(x=>x.id===id);if(!t)return;
  const to=select.value||null;select.disabled=true;
  const {error}=await sb.from('team_tasks').update({assignee_email:to}).eq('id',id).select('id').single();
  if(error){select.disabled=false;select.value=t.assignee_email||'';onMessage('담당자를 바꾸지 못했습니다: '+error.message);return;}
  onMessage(`담당자를 ${to?memberName(state.members,to):'담당 미지정'}(으)로 바꿨습니다.`);
  await load();
 }

 function show(){
  state.active=true;
  $('topbar-actions').innerHTML=(collectorUrl?`<a class="btn" href="${esc(collectorUrl)}" target="_blank" rel="noopener" title="웹에서 빠르게 모으는 보조 수집">수집 페이지</a>`:'')
   +(routineUrl?'<button class="btn btn-primary" id="tt-listup">업무 리스트업</button>':'')
   +'<button class="btn" id="tt-refresh">새로고침</button><button class="btn" id="tt-new">직접 추가</button>';
  $('content').innerHTML='<section class="tt"><p class="tt-help">각자의 Claude가 "업무 리스트업"으로 슬랙·메일·캘린더·드라이브와 대화 기록을 확인해 올린 할 일과 직접 추가한 할 일입니다. 담당자를 정하면 그 사람의 탭에 모이고, 끝낸 일은 완료 탭에서 봅니다. 승인 없이 바로 저장되고, 바꾼 내용은 이력으로 남습니다.</p>'
   +'<nav class="tt-tabs" role="tablist" id="tt-tabs"></nav><div id="tt-view"></div></section>';
  $('tt-refresh').onclick=()=>load();
  $('tt-new').onclick=()=>openNew();
  if($('tt-listup'))$('tt-listup').onclick=()=>openListup();
  const root=$('content');
  root.onclick=e=>{
   const tab=e.target.closest('[data-tt-tab]');if(tab){state.tab=tab.dataset.ttTab;state.deleteArmed=false;paint();return;}
   const status=e.target.closest('[data-set-status]');if(status){setStatus(status);return;}
   if(e.target.closest('[data-clear-selected]')){state.selected.clear();state.deleteArmed=false;paint();return;}
   if(e.target.closest('[data-delete-selected]')){
    if(!state.deleteArmed){state.deleteArmed=true;paint();return;}
    deleteTasks([...state.selected]);return;
   }
   const open=e.target.closest('[data-task-open]');if(open){openTask(open.dataset.taskOpen);}
  };
  root.onchange=e=>{
   if(e.target.dataset.assign){reassign(e.target);return;}
   if(e.target.dataset.due){changeDue(e.target);return;}
   if(e.target.dataset.pick){e.target.checked?state.selected.add(e.target.dataset.pick):state.selected.delete(e.target.dataset.pick);state.deleteArmed=false;paint();return;}
   if(e.target.dataset.pickAll!==undefined){const ids=e.target.dataset.pickAll.split(',').filter(Boolean);ids.forEach(id=>e.target.checked?state.selected.add(id):state.selected.delete(id));state.deleteArmed=false;paint();return;}
   const id=e.target.id,f=state.filter;
   if(id==='tt-f-status')f.status=e.target.value;
   else if(id==='tt-f-kind')f.kind=e.target.value;
   else if(id==='tt-f-query')f.query=e.target.value;
   else if(id==='tt-d-assignee')state.doneFilter.assignee=e.target.value;
   else if(id==='tt-d-period')state.doneFilter.period=e.target.value;
   else return;
   paint();
  };
  paint();load();
 }

 sb.auth?.onAuthStateChange?.(()=>{if(state.active)load();});
 return{show,hide(){state.active=false;closeDialog();const c=$('content');if(c){c.onclick=null;c.onchange=null;}},reload:load,state};
}

return{OTHER_TEAM_EMAIL,STATUS_CODES,STATUS_LABELS,SOURCE_LABELS,fillRoutine,listupChecks,isOpen,isOverdue,kstToday,filterTasks,filterDone,openCounts,summarizeByAssignee,findSensitive,validateInput,memberName,historyText,renderTaskList,mount,esc};
});
