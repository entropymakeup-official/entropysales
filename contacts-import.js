(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.ContactsImport=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
'use strict';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const COLUMNS=[
 ['company',['업체명','회사명','거래처','회사','organization 1 - name','organization name','organization','company','company name']],
 ['person',['담당자','담당자명','이름','성명','name','full name','display name','contact name']],
 ['first',['first name','given name','이름(영문)']],['last',['last name','family name','성(영문)']],
 ['person_en',['영문명','영문 이름','english name']],['title',['직책','직위','job title','organization 1 - title','organization title','title','position']],
 ['duty',['담당 업무','담당업무','업무','role','responsibility']],['department',['부서','소속','department','organization 1 - department','organization department']],
 ['country',['국가','지역','country','country/region','region']],['mobile',['휴대폰','핸드폰','휴대전화','mobile phone','mobile','cell phone','phone 1 - value','mobile number']],
 ['phone',['유선','전화','전화번호','일반전화','대표전화','business phone','work phone','phone','telephone','phone 2 - value']],
 ['fax',['팩스','fax','business fax']],['email',['이메일','메일','이메일주소','e-mail','email','e-mail address','e-mail 1 - value','email 1 - value','email address']],
 ['messenger',['메신저','카톡','카카오톡','whatsapp','wechat','line','messenger','im 1 - value']],['website',['웹사이트','홈페이지','website','web page','url','website 1 - value']],
 ['address',['주소','address','business street','address 1 - formatted','business address']],['tags',['키워드','태그','tags','labels','group membership','categories']],
 ['note',['비고','메모','특이사항','notes','note','comment','description']],['status',['상태','status']]
];
const key=v=>String(v??'').trim().toLowerCase();
const nameKey=r=>JSON.stringify([key(r.company),key(r.person)]);
const normalizeHeader=h=>key(String(h??'').replace(/\uFEFF/g,'')).replace(/\s+/g,' ');
function mapHeaders(headers){const cells=headers.map(normalizeHeader),used=new Set(),map={};for(const [field,names] of COLUMNS)for(const name of names){const at=cells.findIndex((c,i)=>c===name&&!used.has(i));if(at>=0){map[field]=at;used.add(at);break;}}return map;}
function parseTable(table){
 const nonempty=(table||[]).map((r,i)=>({r,i})).filter(({r})=>Array.isArray(r)&&r.some(c=>String(c??'').trim()));
 if(nonempty.length<2)return {contacts:[],map:{},error:'머리글 한 줄과 자료 한 줄 이상이 필요합니다.'};
 const map=mapHeaders(nonempty[0].r);
 if(!['company','person','email','first','last'].some(f=>map[f]!==undefined))return {contacts:[],map,error:'머리글을 알아보지 못했습니다. 양식의 업체명·담당자·이메일 열 이름을 확인하세요.'};
 if(nonempty.length>5001)return {contacts:[],map,error:'한 번에 5,000줄까지 가져올 수 있습니다.'};
 const contacts=nonempty.slice(1).map(({r,i})=>{const out={};for(const [field]of COLUMNS)out[field]=map[field]===undefined?'':String(r[map[field]]??'').trim();if(!out.person)out.person=[out.first,out.last].filter(Boolean).join(' ');delete out.first;delete out.last;out.status=out.status||'활성';out.customer_id=null;out._line=i+1;return out;});
 return {map,contacts,error:''};
}
function parseCSV(text){
 text=String(text).replace(/^\uFEFF/,'');
 // Detect a delimiter only outside quoted fields, on the first logical line.
 const counts={',':0,';':0,'\t':0};let quoted=false;
 for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){i++;continue;}quoted=!quoted;}else if(!quoted){if(c==='\n'||c==='\r')break;if(c in counts)counts[c]++;}}
 const delimiter=Object.keys(counts).sort((a,b)=>counts[b]-counts[a])[0];
 const rows=[];let row=[],cell='',inside=false,ended=false;
 for(let i=0;i<text.length;i++){
  const c=text[i];
  if(inside){if(c==='"'){if(text[i+1]==='"'){cell+='"';i++;}else{inside=false;ended=true;}}else cell+=c;continue;}
  if(c==='"'&&!cell&&!ended){inside=true;continue;}
  if(c===delimiter){row.push(cell);cell='';ended=false;continue;}
  if(c==='\r'||c==='\n'){row.push(cell);rows.push(row);row=[];cell='';ended=false;if(c==='\r'&&text[i+1]==='\n')i++;if(rows.length>5002)throw Error('한 번에 5,000줄까지 가져올 수 있습니다.');continue;}
  if(ended&&!/\s/.test(c))throw Error('CSV 따옴표 뒤의 구분 기호를 확인하세요.');
  if(!ended)cell+=c;
 }
 if(inside)throw Error('CSV 따옴표가 닫히지 않았습니다. 파일을 확인하세요.');
 if(cell||row.length||ended){row.push(cell);rows.push(row);}return rows;
}
function classify(candidates,existing){
 const emails=new Map(),names=new Map(),seenEmail=new Set(),seenName=new Set();
 for(const r of existing||[]){if(r.email)emails.set(key(r.email),r);names.set(nameKey(r),r);}
 return (candidates||[]).map(r=>{
  const problems=[];if(!String(r.company||'').trim())problems.push('업체명 없음');if(!String(r.person||'').trim())problems.push('담당자 이름 없음');
  if(![r.mobile,r.phone,r.email,r.messenger].some(v=>String(v||'').trim()))problems.push('연락 수단 없음');
  if(r.email&&!/^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(r.email))problems.push('이메일 형식 확인');
  if(!['활성','퇴사·변경','보류'].includes(r.status||'활성'))problems.push('상태 확인');
  for(const [field]of COLUMNS)if(String(r[field]||'').length>(field==='email'?254:4000))problems.push(field==='email'?'이메일 254자 초과':'항목 4,000자 초과');
  let state='new',reason='';const e=key(r.email),n=nameKey(r),found=(e&&emails.get(e))||names.get(n);
  if(problems.length){state='invalid';reason=problems.join(' · ');}
  else if(found){state=found._pending?'pending':'exists';reason=found._pending?'이미 승인 대기 중입니다':'같은 이메일 또는 업체·담당자가 이미 있습니다';}
  else if((e&&seenEmail.has(e))||seenName.has(n)){state='dup';reason='파일 내 이메일 또는 업체·담당자 중복';}
  if(!problems.length){if(e)seenEmail.add(e);seenName.add(n);}
  return {...r,_state:state,_reason:reason};
 });
}
const strip=row=>Object.fromEntries(COLUMNS.filter(([f])=>!['first','last'].includes(f)).map(([f])=>[f,String(row[f]??'')]).concat([['customer_id',row.customer_id||null]]));
const LABEL={new:'추가 가능',exists:'이미 있음',pending:'승인 대기',dup:'파일 내 중복',invalid:'확인 필요'};
function renderReview(list){
 const counts=Object.fromEntries(Object.keys(LABEL).map(k=>[k,list.filter(r=>r._state===k).length]));
 return `<p class="ci-help">총 ${list.length.toLocaleString()}건 · 추가 가능 ${counts.new}건 · 이미 있음 ${counts.exists}건 · 승인 대기 ${counts.pending}건 · 중복 ${counts.dup}건 · 확인 필요 ${counts.invalid}건</p>`+(list.length?`<div class="tw ci-table" tabindex="0" aria-label="가져올 연락처 검토"><table><thead><tr><th><input id="ci-all" type="checkbox" aria-label="추가 가능한 연락처 전체 선택"${counts.new?' checked':''}></th><th>줄</th><th>업체명</th><th>담당자</th><th>직책</th><th>이메일</th><th>전화</th><th>검토 결과</th></tr></thead><tbody>${list.map((r,i)=>`<tr><td>${r._state==='new'?`<input class="ci-pick" type="checkbox" data-at="${i}" aria-label="${esc(r.person)} 선택" checked>`:''}</td><td>${esc(r._line)}</td><td>${esc(r.company)}</td><td>${esc(r.person)}</td><td>${esc(r.title)}</td><td>${esc(r.email)}</td><td>${esc(r.mobile||r.phone)}</td><td><span class="badge ${r._state==='new'?'bg-green':r._state==='invalid'?'bg-red':'bg-gray'}">${LABEL[r._state]}</span><small>${esc(r._reason)}</small></td></tr>`).join('')}</tbody></table></div>`:'');
}
function validateFile(file){if(!file)throw Error('파일을 선택하세요.');if(file.size>15*1024*1024)throw Error('15MB 이하 파일만 읽을 수 있습니다.');if(!/\.(xlsx|xls|csv)$/i.test(file.name))throw Error('지원 형식은 엑셀(.xlsx/.xls)과 CSV입니다.');}
function decodeCSV(buffer,encoding='auto'){
 const bytes=new Uint8Array(buffer);if(encoding!=='auto')return new TextDecoder(encoding,{fatal:true}).decode(bytes);
 if(bytes[0]===255&&bytes[1]===254)return new TextDecoder('utf-16le').decode(bytes);
 if(bytes[0]===254&&bytes[1]===255)return new TextDecoder('utf-16be').decode(bytes);
 try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{return new TextDecoder('euc-kr',{fatal:true}).decode(bytes);}
}
function mount({document,phonebook,getXLSX=()=>globalThis.XLSX,getCustomers=()=>[],auth,onMessage=()=>{}}){
 let dialog=null,list=[],busy=false,reading=false,generation=0,buffer=null,file=null,workbook=null;
 const find=s=>dialog?.querySelector(s);
 const status=text=>{if(find('[data-status]'))find('[data-status]').textContent=text;};
 const error=text=>{if(find('[data-error]'))find('[data-error]').textContent=text;};
 function close(force=false){if((busy||reading)&&!force)return;generation++;if(dialog){dialog.close();dialog.remove();dialog=null;}list=[];buffer=null;file=null;workbook=null;busy=false;reading=false;}
 function picked(){return [...(dialog?.querySelectorAll('.ci-pick')||[])].filter(b=>b.checked).map(b=>list[Number(b.dataset.at)]).filter(Boolean);}
 function update(){
  if(!dialog)return;const n=picked().length,button=find('[data-save]');button.disabled=busy||reading||!n;button.textContent=busy?'접수 중…':n?`선택한 ${n}건 등록 요청`:'저장할 항목을 선택하세요';
  for(const el of dialog.querySelectorAll('[data-close],#ci-file,#ci-sheet,#ci-encoding,.ci-pick,#ci-all,#ci-reason'))el.disabled=busy||reading;
  const boxes=[...dialog.querySelectorAll('.ci-pick')],all=find('#ci-all');if(all){all.checked=!!boxes.length&&n===boxes.length;all.indeterminate=n>0&&n<boxes.length;}
 }
 function paint(){if(!dialog)return;find('[data-review]').innerHTML=renderReview(list);const all=find('#ci-all');if(all)all.onchange=()=>{for(const b of dialog.querySelectorAll('.ci-pick'))b.checked=all.checked;update();};for(const b of dialog.querySelectorAll('.ci-pick'))b.onchange=update;update();}
 function reviewTable(table){
  const parsed=parseTable(table);if(parsed.error)throw Error(parsed.error);
  const customers=getCustomers();for(const row of parsed.contacts){const matches=customers.filter(c=>key(c.name)===key(row.company));if(matches.length===1)row.customer_id=matches[0].id;}
  list=classify(parsed.contacts,phonebook.rows());paint();status(`${file.name} · ${parsed.contacts.length}건을 읽었습니다. 체크한 항목만 관리자 승인 요청으로 접수됩니다.`);
 }
 function readSelection(){
  if(!file||!buffer)return;error('');list=[];paint();
  try{if(/\.csv$/i.test(file.name))reviewTable(parseCSV(decodeCSV(buffer,find('#ci-encoding').value)));
   else{const X=getXLSX(),sheet=workbook.Sheets[find('#ci-sheet').value];if(sheet?.['!ref']){const bounds=X.utils.decode_range(sheet['!ref']);if(bounds.e.r>20000||bounds.e.c>200)throw Error('사용 범위가 너무 큽니다. 연락처 열과 행만 새 시트에 복사하세요.');}reviewTable(X.utils.sheet_to_json(sheet,{header:1,defval:'',raw:false,blankrows:true}));}
  }catch(e){error(e.message||String(e));status('파일을 확인한 뒤 다시 선택하세요.');}update();
 }
 async function handleFile(selected){
  if(busy||reading)return;const ticket=++generation;file=selected;buffer=null;workbook=null;list=[];paint();error('');
  try{validateFile(file);reading=true;update();status('파일과 기존 연락처를 확인하는 중입니다…');
   const bytes=await file.arrayBuffer();if(ticket!==generation)return;
   const loaded=await phonebook.reload();if(ticket!==generation)return;if(loaded===false)throw Error('기존 연락처를 확인하지 못했습니다. 새로고침 후 다시 시도하세요.');buffer=bytes;
   const csv=/\.csv$/i.test(file.name);find('[data-sheet]').hidden=csv;find('[data-encoding]').hidden=!csv;
   if(!csv){const X=getXLSX();if(!X?.read)throw Error('엑셀 읽기 기능을 불러오지 못했습니다. 새로고침하세요.');workbook=X.read(bytes,{type:'array',cellHTML:false,cellStyles:false,sheetRows:20002});if(!workbook.SheetNames.length)throw Error('시트가 없습니다.');find('#ci-sheet').innerHTML=workbook.SheetNames.map(s=>`<option value="${esc(s)}">${esc(s)}</option>`).join('');}
   readSelection();
  }catch(e){if(ticket===generation){error(e.message||String(e));status('');}}
  finally{if(ticket===generation){reading=false;update();}}
 }
 async function run(){
  if(busy||reading)return;const chosen=picked();if(!chosen.length)return;const reason=find('#ci-reason').value.trim();if(!reason){error('등록 사유를 입력하세요.');find('#ci-reason').focus();return;}
  const ticket=generation;busy=true;update();error('');
  try{
   const result=await phonebook.controller.saveMany(chosen.map(strip),{reason,onProgress:({done,failed,total})=>{if(ticket===generation)status(`등록 요청 접수 중… ${done+failed} / ${total} (접수 ${done} · 미접수 ${failed})`);}});
   if(ticket!==generation)return;
   const done=result.done?.length||0;const failed=result.failed||[];
   list=classify(list,phonebook.rows());
   status(`${done}건 접수 · ${failed.length}건 미접수${result.cancelled?' · 작업 중단':''}. 접수된 연락처는 관리자 승인 후 목록에 표시됩니다.`);
   if(failed.length)error(failed.slice(0,4).map(f=>(f.row.person||'?')+': '+f.error).join(' / '));
   if(done)onMessage(`${done}건의 연락처 등록 요청이 접수됐습니다. 관리자 승인 대기 중입니다.`);
   paint();
   // Keep the user's selection after a partial failure; never opt unchecked rows in.
   const selectedLines=new Set(chosen.map(r=>r._line));
   for(const box of dialog.querySelectorAll('.ci-pick'))box.checked=selectedLines.has(list[Number(box.dataset.at)]._line);
  }catch(e){if(ticket===generation)error((e.message||String(e))+' — 접수 여부를 확인한 뒤 다시 시도하세요.');}
  finally{if(ticket===generation){busy=false;update();}}
 }
 function downloadTemplate(){
  const headers=COLUMNS.filter(([f])=>!['first','last'].includes(f)).map(([,names])=>names[0]);
  const blob=new Blob(['\ufeff'+headers.join(',')+'\r\n'],{type:'text/csv;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='거래처_연락처_입력양식.csv';document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
 }
 function open(){
  if(busy||reading)return;close(true);dialog=document.createElement('dialog');dialog.className='ci-dialog';dialog.setAttribute('aria-label','엑셀·CSV 연락처 가져오기');
  dialog.innerHTML=`<form><header><h2>엑셀·CSV 연락처 가져오기</h2><button class="btn" type="button" data-close>닫기</button></header><p class="ci-help">엑셀(.xlsx/.xls) · CSV · Google/Outlook 연락처 내보내기 파일을 읽습니다. 첫 줄은 머리글이어야 합니다.<br>업체명·담당자·연락 수단 하나는 필수입니다. 기존 연락처는 덮어쓰지 않습니다. 최대 15MB / 5,000행.</p><div class="ci-options"><label>파일 선택<input id="ci-file" type="file" accept=".xlsx,.xls,.csv"></label><button type="button" class="btn" data-template>입력 양식 다운로드</button><label data-sheet hidden>시트<select id="ci-sheet"></select></label><label data-encoding hidden>CSV 문자 인코딩<select id="ci-encoding"><option value="auto">자동 감지</option value="utf-8">UTF-8</option><option value="euc-kr">한국어 (CP949/EUC-KR)</option><option value="utf-16le">UTF-16 LE</option></select></label></div><p class="ci-help" data-status role="status"></p><p class="ci-error" data-error role="alert"></p><div data-review></div><label class="ci-reason">등록 사유<textarea id="ci-reason" maxlength="2000" rows="2" placeholder="예: 거래처 담당자 연락처 파일 등록"></textarea></label><footer><button class="btn" type="button" data-close>닫기</button><button class="btn btn-primary" type="submit" data-save disabled>저장할 항목을 선택하세요</button></footer></form>`;
  find('#ci-file').onchange=e=>handleFile(e.target.files?.[0]);find('#ci-sheet').onchange=readSelection;find('#ci-encoding').onchange=readSelection;find('[data-template]').onclick=downloadTemplate;
  for(const b of dialog.querySelectorAll('[data-close]'))b.onclick=()=>close();dialog.querySelector('form').onsubmit=e=>{e.preventDefault();run();};dialog.addEventListener('cancel',e=>{e.preventDefault();close();});for(const type of ['keydown','paste'])dialog.addEventListener(type,e=>e.stopPropagation());document.body.appendChild(dialog);dialog.showModal();find('#ci-file').focus();
 }
 let actor=null;auth?.onAuthStateChange?.((_event,session)=>{const next=session?.user?.id||null;if(next!==actor){actor=next;close(true);}});
 return {open,close,downloadTemplate,handleFile,review:()=>list};
}
return {COLUMNS,normalizeHeader,mapHeaders,parseTable,parseCSV,classify,strip,renderReview,validateFile,decodeCSV,mount};
});
