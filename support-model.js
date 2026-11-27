(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.SupportModel=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
'use strict';
// 경영지원 요청의 상태 규칙과 입력 검증. 같은 규칙을 DB 트리거(sql/support.sql)가 최종 판정한다.

const TYPES={tax_invoice:'세금계산서 발행',purchase_confirm:'구매확인서',certificate:'수출·은행 증명서',business_doc:'사업자 서류',etc:'기타'};
const STATUSES={requested:'요청',in_progress:'처리중',done:'완료',on_hold:'보류',canceled:'취소'};
const FILE_KINDS={request:'요청 근거',result:'발급본',etc:'기타'};
const OPEN=['requested','in_progress','on_hold'];
const CLOSED=['done','canceled'];
const LIMITS={title:80,counterparty:120,amount:100,note:1000,result:300,statusNote:300,comment:1000,fileBytes:20971520,filesPerRequest:10,fileName:120};
const STATUS_LIST=Object.keys(STATUSES);
const KST=9*60*60*1000,DAY=24*60*60*1000;
const ERRORS={
 SUPPORT_FORBIDDEN:'이 요청을 바꿀 권한이 없어요.',
 SUPPORT_CLOSED:'닫힌 요청은 바꿀 수 없어요.',
 SUPPORT_BAD_TRANSITION:'그 상태로는 바꿀 수 없어요.',
 SUPPORT_RESULT_FILE_REQUIRED:'완료하려면 발급본 파일이 1개 이상 있어야 해요. (완료 중에는 마지막 발급본을 지울 수 없어요)',
 SUPPORT_NOTE_REQUIRED:'보류나 되돌리기에는 사유가 필요해요.',
 SUPPORT_FILE_LIMIT:'첨부는 요청당 10개까지예요.',
 SUPPORT_HANDLER_ONLY:'발급본은 경영지원 담당자만 올릴 수 있어요.',
 SUPPORT_LOGIN_REQUIRED:'회사 계정으로 로그인해 주세요.',
 STALE:'다른 사람이 먼저 바꿨어요. 새로고침한 뒤 다시 해 주세요.',
 UNCONFIRMED:'저장 결과를 확인하지 못했어요. 새로고침해서 저장됐는지 확인해 주세요.'
};
const TRANSITIONS={requested:['in_progress','done','on_hold','canceled'],in_progress:['done','on_hold','canceled'],on_hold:['requested','in_progress','canceled'],done:['in_progress'],canceled:[]};

const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const trim=v=>String(v??'').trim();
const kstToday=nowMs=>new Date(nowMs+KST).toISOString().slice(0,10);
const isDate=v=>{if(!/^\d{4}-\d{2}-\d{2}$/.test(String(v||'')))return false;const [y,m,d]=v.split('-').map(Number);const t=new Date(Date.UTC(y,m-1,d));return t.getUTCFullYear()===y&&t.getUTCMonth()===m-1&&t.getUTCDate()===d;};
const isHandler=(email,handlers)=>{const e=trim(email).toLowerCase();return Boolean(e)&&(handlers||[]).some(h=>h.is_active!==false&&String(h.email||'').toLowerCase()===e);};
const transitionAllowed=(from,to)=>(TRANSITIONS[from]||[]).includes(to);
const needsNote=(from,to)=>to==='on_hold'||(from==='done'&&to==='in_progress');

function checkTransition({isHandler:h,isOwner,from,to,fields,resultFiles=0}){
 const f=fields||{};
 if(!transitionAllowed(from,to))return {ok:false,reason:ERRORS.SUPPORT_BAD_TRANSITION};
 if(!h&&!(isOwner&&from==='requested'&&to==='canceled'))return {ok:false,reason:ERRORS.SUPPORT_FORBIDDEN};
 if(to==='done'&&!resultFiles)return {ok:false,reason:ERRORS.SUPPORT_RESULT_FILE_REQUIRED};
 if(needsNote(from,to)&&!trim(f.status_note_text))return {ok:false,reason:ERRORS.SUPPORT_NOTE_REQUIRED};
 return {ok:true};
}
function allowedNext({isHandler:h,isOwner,from}){
 if(!h)return isOwner&&from==='requested'?['canceled']:[];
 return STATUS_LIST.filter(to=>transitionAllowed(from,to));
}
// 요청자가 고를 수 있는 파일 종류. 발급본은 담당자만.
const fileKindsFor=h=>h?FILE_KINDS:{request:FILE_KINDS.request,etc:FILE_KINDS.etc};

function validateDraft(d){
 const e=[];
 if(!TYPES[d.type_code])e.push('서류 종류를 골라 주세요.');
 const title=trim(d.title_text);if(!title||title.length>LIMITS.title)e.push('제목을 1~80자로 적어 주세요.');
 const cp=trim(d.counterparty_text);if(!cp||cp.length>LIMITS.counterparty)e.push('거래처·제출처를 1~120자로 적어 주세요.');
 if(d.due_date&&!isDate(d.due_date))e.push('필요 기한이 올바른 날짜가 아니에요.');
 if(d.issue_date&&!isDate(d.issue_date))e.push('작성일·기준일이 올바른 날짜가 아니에요.');
 if(trim(d.amount_text).length>LIMITS.amount)e.push('금액은 100자 이하로 적어 주세요.');
 if(trim(d.note_text).length>LIMITS.note)e.push('요청 내용은 1000자 이하로 적어 주세요.');
 return e;
}
function toInsertRow(d){
 return {type_code:d.type_code,title_text:trim(d.title_text),counterparty_text:trim(d.counterparty_text),due_date:d.due_date||null,
  amount_text:trim(d.amount_text),issue_date:d.issue_date||null,note_text:trim(d.note_text),invoice_id:d.invoice_id||null};
}

const isLate=(r,nowMs)=>OPEN.includes(r?.status_code)&&Boolean(r.due_date)&&r.due_date<kstToday(nowMs);
const sortRequests=list=>[...list].sort((a,b)=>String(a.due_date||'9999').localeCompare(String(b.due_date||'9999'))||String(a.created_at||'').localeCompare(String(b.created_at||'')));
function filterTab(list,tab,{email,nowMs}={}){
 const since=new Date(nowMs-30*DAY).toISOString(),me=trim(email).toLowerCase();
 const pick={todo:r=>['requested','in_progress'].includes(r.status_code),hold:r=>r.status_code==='on_hold',
  done:r=>r.status_code==='done'&&String(r.done_at||'')>=since,canceled:r=>r.status_code==='canceled',
  mine:r=>String(r.requester_email||'').toLowerCase()===me}[tab];
 if(!pick)return [];
 const out=list.filter(pick);
 return tab==='done'?out.sort((a,b)=>String(b.done_at).localeCompare(String(a.done_at))):sortRequests(out);
}
function search(list,q){const s=trim(q).toLowerCase();if(!s)return list;return list.filter(r=>[r.title_text,r.counterparty_text,r.result_text,TYPES[r.type_code]].some(v=>String(v||'').toLowerCase().includes(s)));}

function safeFileName(name){
 let n=String(name||'').replace(/[\/\\\u0000-\u001f\u007f]/g,'_').trim();
 if(!n)return 'file';
 if(n.length<=LIMITS.fileName)return n;
 const dot=n.lastIndexOf('.'),ext=dot>0&&n.length-dot<=10?n.slice(dot):'';
 return n.slice(0,LIMITS.fileName-ext.length)+ext;
}
function errorMessage(err){
 const msg=String(err?.message||err||'');
 const code=Object.keys(ERRORS).find(k=>msg.includes(k));
 if(code)return ERRORS[code];
 if(/row-level security/i.test(msg))return ERRORS.SUPPORT_FORBIDDEN;
 if(/invalid input syntax|out of range|violates check constraint/i.test(msg))return '입력값을 확인해 주세요. 날짜 형식이나 글자 수가 맞지 않아요.';
 return '저장하지 못했어요: '+msg;
}

return {TYPES,STATUSES,FILE_KINDS,OPEN,CLOSED,LIMITS,esc,kstToday,isDate,isHandler,transitionAllowed,needsNote,checkTransition,allowedNext,fileKindsFor,
 validateDraft,toInsertRow,isLate,sortRequests,filterTab,search,safeFileName,errorMessage};
});
