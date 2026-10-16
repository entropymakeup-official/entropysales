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

test('완료 탭: 끝난 할 일만 최근 완료 순, 기간·담당자 거르기',()=>{
 const tasks=[...TASKS,task({id:'h',assignee_email:'u1@entropymakeup.com',status_code:'done',done_at:'2026-09-20T00:00:00Z'}),task({id:'i',status_code:'done',done_at:'2026-10-02T00:00:00Z'})];
 assert.deepEqual(T.filterDone(tasks,{},NOW).map(t=>t.id),['e']);
 assert.deepEqual(T.filterDone(tasks,{period:'month'},NOW).map(t=>t.id),['e','g','i']);
 assert.deepEqual(T.filterDone(tasks,{period:'all'},NOW).map(t=>t.id),['e','g','i','h']);
 assert.deepEqual(T.filterDone(tasks,{period:'all',assignee:'u1@entropymakeup.com'},NOW).map(t=>t.id),['h']);
 assert.deepEqual(T.filterDone(tasks,{period:'all',assignee:''},NOW).map(t=>t.id),['i']);
});

test('담당자 탭 건수: 열린 할 일과 지연, 숨김 제외',()=>{
 assert.deepEqual(T.openCounts(TASKS,'u1@entropymakeup.com',NOW),{open:2,overdue:1});
 assert.deepEqual(T.openCounts(TASKS,'u2@entropymakeup.com',NOW),{open:1,overdue:0});
 assert.deepEqual(T.openCounts(TASKS,'',NOW),{open:1,overdue:0});
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

test('업무 리스트업: 프롬프트를 로그인한 사람으로 채우고 설정을 점검한다',()=>{
 const fs=require('node:fs'),path=require('node:path');
 const template=fs.readFileSync(path.join(__dirname,'..','team-tasks-routine.txt'),'utf8');
 const filled=T.fillRoutine(template,{name:'레이',email:'raye@entropymakeup.com'});
 assert.ok(!filled.includes('{{'));
 assert.ok(filled.includes('나(레이, raye@entropymakeup.com)'));
 assert.ok(filled.includes('0. 설정 점검'));
 const members=[{email:'raye@entropymakeup.com',display_name:'레이'}];
 const ok=T.listupChecks({meEmail:'raye@entropymakeup.com',members});
 assert.deepEqual(ok.slice(0,2).map(c=>c.ok),[true,true]);
 assert.ok(ok.slice(2).every(c=>c.ok===null&&c.fix));
 const missing=T.listupChecks({meEmail:'new@entropymakeup.com',members});
 assert.equal(missing[1].ok,false);
 assert.equal(T.listupChecks({meEmail:'',members})[0].ok,false);
});

test('목록 행에서 담당자를 바로 고를 수 있다',()=>{
 const html=T.renderTaskList([task({id:'r1',assignee_email:'u1@entropymakeup.com'})],[{email:'u1@entropymakeup.com',display_name:'하나'},{email:'u2@entropymakeup.com',display_name:'둘'}],NOW,'없음');
 assert.match(html,/<select class="tt-assign" data-assign="r1"/);
 assert.match(html,/<option value="u1@entropymakeup.com" selected>하나<\/option>/);
 assert.match(html,/<option value="u2@entropymakeup.com">둘<\/option>/);
});

test('관리자에게만 삭제 선택 상자를 보여 준다',()=>{
 const list=[task({id:'k1'})];
 assert.doesNotMatch(T.renderTaskList(list,[],NOW,'없음'),/data-pick/);
 const html=T.renderTaskList(list,[],NOW,'없음',{selectable:true,selected:new Set(['k1'])});
 assert.match(html,/data-pick="k1"[^>]*checked/);
});
