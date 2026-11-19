(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.LogisticsModel=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
'use strict';
// 물류 요청 대시보드의 상태 규칙과 입력 검증. 같은 규칙을 DB 트리거(sql/logistics.sql)가 최종 판정한다.

const TYPES={b2b:'B2B출고',sample:'샘플',quick:'퀵',seeding:'마케팅·시딩',cs:'CS·교체',return:'회송·재입고',etc:'기타'};
const TEAMS={global:'글로벌',domestic:'국내',marketing:'마케팅·크리에이티브',cs:'CS',etc:'기타'};
const SHIP_MODES={parcel:'택배',quick:'퀵',air:'Air',ocean:'Ocean',direct:'직납',express:'해외특송',etc:'기타'};
const STATUSES={requested:'요청',accepted:'접수',preparing:'준비중',shipped:'출고완료',on_hold:'보류',canceled:'취소'};
const PACKING={waiting:'대기',done:'작성완료',replied:'거래처회신'};
const FILE_KINDS={request:'출고요청서',packing:'패킹리스트',receipt:'입고증',etc:'기타'};
const OPEN=['requested','accepted','preparing','on_hold'];
const CLOSED=['shipped','canceled'];
const LIMITS={title:80,counterparty:120,qty:300,note:1000,result:500,statusNote:300,forwarder:120,comment:1000,fileBytes:20971520,filesPerRequest:10,fileName:120};
const STATUS_ORDER=['requested','accepted','preparing','shipped'];
const STATUS_LIST=Object.keys(STATUSES);
const KST=9*60*60*1000,DAY=24*60*60*1000;
const ERRORS={
 LOGISTICS_FORBIDDEN:'이 요청을 바꿀 권한이 없어요.',
 LOGISTICS_CLOSED:'닫힌 요청은 요약 내용을 바꿀 수 없어요.',
 LOGISTICS_BAD_TRANSITION:'그 상태로는 바꿀 수 없어요.',
 LOGISTICS_RESULT_REQUIRED:'출고완료에는 송장·배차·BL과 출고일이 필요해요.',
 LOGISTICS_NOTE_REQUIRED:'보류나 되돌리기에는 사유가 필요해요.',
 LOGISTICS_FILE_LIMIT:'첨부는 요청당 10개까지예요.',
 LOGISTICS_LOGIN_REQUIRED:'회사 계정으로 로그인해 주세요.',
 STALE:'다른 사람이 먼저 바꿨어요. 새로고침한 뒤 다시 해 주세요.',
 UNCONFIRMED:'저장 결과를 확인하지 못했어요. 새로고침해서 저장됐는지 확인해 주세요.'
};

const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const trim=v=>String(v??'').trim();
const kstToday=nowMs=>new Date(nowMs+KST).toISOString().slice(0,10);
const isDate=v=>{if(!/^\d{4}-\d{2}-\d{2}$/.test(String(v||'')))return false;const [y,m,d]=v.split('-').map(Number);const t=new Date(Date.UTC(y,m-1,d));return t.getUTCFullYear()===y&&t.getUTCMonth()===m-1&&t.getUTCDate()===d;};
const isHandler=(email,handlers)=>{const e=trim(email).toLowerCase();return Boolean(e)&&(handlers||[]).some(h=>h.is_active!==false&&String(h.email||'').toLowerCase()===e);};

function transitionAllowed(from,to){
 if(from===to)return false;
 const fi=STATUS_ORDER.indexOf(from),ti=STATUS_ORDER.indexOf(to);
 if(fi>=0&&ti>fi&&from!=='shipped')return true;                       // 앞으로(건너뛰기 허용)
 if(['requested','accepted','preparing'].includes(from)&&(to==='on_hold'||to==='canceled'))return true;
 if(from==='on_hold'&&['requested','accepted','preparing','canceled'].includes(to))return true;
 if(from==='shipped'&&to==='preparing')return true;                    // 출고완료 되돌리기(사유 필수)
 return false;
}
function needsNote(from,to){return to==='on_hold'||(from==='shipped'&&to==='preparing');}
function checkTransition({isHandler:h,isOwner,from,to,fields}){
 const f=fields||{};
 if(!transitionAllowed(from,to))return {ok:false,reason:ERRORS.LOGISTICS_BAD_TRANSITION};
 if(!h&&!(isOwner&&from==='requested'&&to==='canceled'))return {ok:false,reason:ERRORS.LOGISTICS_FORBIDDEN};
 if(to==='shipped'&&(!trim(f.result_text)||!isDate(f.shipped_on)))return {ok:false,reason:ERRORS.LOGISTICS_RESULT_REQUIRED};
 if(needsNote(from,to)&&!trim(f.status_note_text))return {ok:false,reason:ERRORS.LOGISTICS_NOTE_REQUIRED};
 return {ok:true};
}
function allowedNext({isHandler:h,isOwner,from}){
 if(!h)return isOwner&&from==='requested'?['canceled']:[];
 return STATUS_LIST.filter(to=>transitionAllowed(from,to));
}

function validateDraft(d){
 const e=[];
 if(!TYPES[d.type_code])e.push('유형을 골라 주세요.');
 const title=trim(d.title_text);if(!title||title.length>LIMITS.title)e.push('제목을 1~80자로 적어 주세요.');
 if(!TEAMS[d.team_code])e.push('요청팀을 골라 주세요.');
 const cp=trim(d.counterparty_text);if(!cp||cp.length>LIMITS.counterparty)e.push('거래처·수신처를 1~120자로 적어 주세요.');
 if(d.want_date&&!isDate(d.want_date))e.push('희망 출고일이 올바른 날짜가 아니에요.');
 if(!SHIP_MODES[d.ship_mode_code])e.push('운송 방식을 골라 주세요.');
 if(trim(d.qty_summary_text).length>LIMITS.qty)e.push('수량 요약은 300자 이하로 적어 주세요.');
 if(trim(d.note_text).length>LIMITS.note)e.push('특이사항은 1000자 이하로 적어 주세요.');
 if(trim(d.forwarder_text).length>LIMITS.forwarder)e.push('포워더는 120자 이하로 적어 주세요.');
 if(d.etd_on&&!isDate(d.etd_on))e.push('ETD가 올바른 날짜가 아니에요.');
 if(d.packing_code&&!PACKING[d.packing_code])e.push('패킹리스트 상태를 다시 골라 주세요.');
 return e;
}
const needsOverseas=d=>d.type_code==='b2b'||d.ship_mode_code==='air'||d.ship_mode_code==='ocean';
function toInsertRow(d){
 const overseas=needsOverseas(d);
 return {type_code:d.type_code,title_text:trim(d.title_text),team_code:d.team_code,counterparty_text:trim(d.counterparty_text),
  want_date:d.want_date||null,ship_mode_code:d.ship_mode_code,qty_summary_text:trim(d.qty_summary_text),note_text:trim(d.note_text),
  invoice_id:d.invoice_id||null,packing_code:overseas&&d.packing_code?d.packing_code:null,etd_on:overseas&&d.etd_on?d.etd_on:null,
  forwarder_text:overseas?trim(d.forwarder_text):''};
}

const isLate=(r,nowMs)=>OPEN.includes(r?.status_code)&&Boolean(r.want_date)&&r.want_date<kstToday(nowMs);
const sortRequests=list=>[...list].sort((a,b)=>String(a.want_date||'9999').localeCompare(String(b.want_date||'9999'))||String(a.created_at||'').localeCompare(String(b.created_at||'')));
function filterTab(list,tab,{email,nowMs}={}){
 const since=kstToday(nowMs-30*DAY),me=trim(email).toLowerCase();
 const pick={todo:r=>['requested','accepted','preparing'].includes(r.status_code),hold:r=>r.status_code==='on_hold',
  shipped:r=>r.status_code==='shipped'&&String(r.shipped_on||'')>=since,canceled:r=>r.status_code==='canceled',
  mine:r=>String(r.requester_email||'').toLowerCase()===me}[tab];
 if(!pick)return [];
 const out=list.filter(pick);
 return tab==='shipped'?out.sort((a,b)=>String(b.shipped_on).localeCompare(String(a.shipped_on))):sortRequests(out);
}
function search(list,q){const s=trim(q).toLowerCase();if(!s)return list;return list.filter(r=>[r.title_text,r.counterparty_text,r.result_text].some(v=>String(v||'').toLowerCase().includes(s)));}

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
 return code?ERRORS[code]:'저장하지 못했어요: '+msg;
}

return {TYPES,TEAMS,SHIP_MODES,STATUSES,PACKING,FILE_KINDS,OPEN,CLOSED,LIMITS,esc,kstToday,isDate,isHandler,transitionAllowed,checkTransition,allowedNext,
 validateDraft,toInsertRow,needsOverseas,isLate,sortRequests,filterTab,search,safeFileName,errorMessage};
});
