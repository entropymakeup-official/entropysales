const {test}=require('node:test');const assert=require('node:assert/strict');
const T=require('../team-tasks.js');

const KST=9*60*60*1000,DAY=24*60*60*1000;
const kst=(day,hh=10)=>{const [y,m,d]=day.split('-').map(Number);return Date.UTC(y,m-1,d,hh)-KST;};
const NOW=kst('2026-10-15'); // 목요일
const task=o=>({title_text:'할 일',summary_text:'',status_code:'todo',is_archived:false,created_at:'2026-10-01T00:00:00Z',...o});
const TASKS=[
 task({id:'a',assignee_email:'u1@entropymakeup.com',due_on:'2026-10-14'}),
 task({id:'b',assignee_email:'u1@entropymakeup.com',due_on:'2026-10-15',status_code:'in_progress'}),
 task({id:'c',due_on:'2026-10-20'}),
 task({id:'d',assignee_email:'u2@entropymakeup.com',created_at:new Date(NOW-DAY).toISOString(),title_text:'바이어 견적'}),
 task({id:'e',assignee_email:'u2@entropymakeup.com',status_code:'done',done_at:new Date(NOW-DAY).toISOString()}),
 task({id:'f',assignee_email:'u1@entropymakeup.com',is_archived:true,due_on:'2026-10-01'}),
 task({id:'g',assignee_email:'u2@entropymakeup.com',status_code:'done',done_at:'2026-10-11T00:00:00Z'}),
];
const MEMBERS=[{email:'u1@entropymakeup.com',display_name:'가짜 하나'},{email:'u2@entropymakeup.com',display_name:'가짜 둘'}];

test('지연은 기한 날짜가 한국 시간으로 지난 열린 할 일',()=>{
 assert.equal(T.isOverdue({status_code:'todo',due_on:'2026-10-14'},NOW),true);
 assert.equal(T.isOverdue({status_code:'todo',due_on:'2026-10-15'},NOW),false);
 assert.equal(T.isOverdue({status_code:'done',due_on:'2026-10-01'},NOW),false);
 assert.equal(T.kstToday(Date.UTC(2026,9,13,15,0)),'2026-10-14');
});

test('오늘 보기: 오늘까지 기한·담당 미지정·최근 3일, 숨김 제외',()=>{
 const v=T.buildTodayView(TASKS,NOW);
 assert.deepEqual(v.due.map(t=>t.id),['a','b']);
 assert.deepEqual(v.unassigned.map(t=>t.id),['c']);
 assert.deepEqual(v.recent.map(t=>t.id),['d']);
 const mine=T.buildTodayView(TASKS,NOW,{meEmail:'u2@entropymakeup.com',onlyMine:true});
 assert.deepEqual(mine.due,[]);
 assert.deepEqual(mine.recent.map(t=>t.id),['d']);
});

test('전체 목록 거르기',()=>{
 assert.deepEqual(T.filterTasks(TASKS).map(t=>t.id),['a','b','c','d']);
 assert.deepEqual(T.filterTasks(TASKS,{includeClosed:true}).map(t=>t.id),['a','b','c','d','e','g']);
 assert.deepEqual(T.filterTasks(TASKS,{assignee:'u1@entropymakeup.com'}).map(t=>t.id),['a','b']);
 assert.deepEqual(T.filterTasks(TASKS,{assignee:''}).map(t=>t.id),['c']);
 assert.deepEqual(T.filterTasks(TASKS,{status:'in_progress'}).map(t=>t.id),['b']);
 assert.deepEqual(T.filterTasks(TASKS,{query:'견적'}).map(t=>t.id),['d']);
});

test('담당자별 집계: 이번 주는 월요일부터',()=>{
 const s=T.summarizeByAssignee(TASKS,NOW);
 assert.deepEqual(s.get('u1@entropymakeup.com'),{todo:1,inProgress:1,onHold:0,overdue:1,doneThisWeek:0});
 assert.deepEqual(s.get('u2@entropymakeup.com'),{todo:1,inProgress:0,onHold:0,overdue:0,doneThisWeek:1});
 assert.deepEqual(s.get(''),{todo:1,inProgress:0,onHold:0,overdue:0,doneThisWeek:0});
});

test('입력 검증과 민감정보 경고',()=>{
 assert.throws(()=>T.validateInput({title_text:'  '}),/제목/);
 assert.throws(()=>T.validateInput({title_text:'x'.repeat(81)}),/80자/);
 assert.throws(()=>T.validateInput({title_text:'a',due_on:'10/20'}),/기한/);
 assert.throws(()=>T.validateInput({title_text:'a',source_url:'javascript:alert(1)'}),/https/);
 assert.deepEqual(T.validateInput({title_text:' 회신 ',assignee_email:''}),{title_text:'회신',summary_text:'',note_text:'',due_on:null,source_url:'',status_code:'todo',assignee_email:null});
 assert.deepEqual(T.findSensitive('합계 $1,200','010-1234-5678'),['통화와 붙은 숫자','전화번호']);
 assert.deepEqual(T.findSensitive('박스 12개'),[]);
});

test('이력 문장과 목록 HTML은 이름을 보여 주고 이스케이프한다',()=>{
 assert.equal(T.historyText({field_code:'assignee',from_text:'',to_text:'u1@entropymakeup.com',changed_by_text:'u2@entropymakeup.com',changed_at:'2026-10-15T01:00:00Z'},MEMBERS),
  '2026-10-15 10:00 · 가짜 둘 · 담당자: 담당 미지정 → 가짜 하나');
 assert.equal(T.historyText({field_code:'created',from_text:'',to_text:'x',changed_by_text:'이예진(수집 페이지)',changed_at:'2026-10-15T01:00:00Z'},MEMBERS),
  '2026-10-15 10:00 · 이예진(수집 페이지) · 등록');
 const html=T.renderTaskList([task({id:'x',title_text:'<img src=x>',suggested_assignee_text:'가짜 셋',source_kind_code:'slack',source_url:'https://s/1'})],MEMBERS,NOW,'없음');
 assert.ok(html.includes('&lt;img src=x&gt;'));
 assert.ok(html.includes('제안: 가짜 셋'));
 assert.ok(html.includes('슬랙'));
 assert.equal(T.renderTaskList([],MEMBERS,NOW,'없음'),'<p class="tt-empty">없음</p>');
});
