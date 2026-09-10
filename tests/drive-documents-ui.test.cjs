const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const invoiceId='00000000-0000-0000-0000-000000000001';
const row={id:'00000000-0000-0000-0000-000000000002',invoice_id:invoiceId,drive_file_id:'test_file_1234567890',resource_key:null,name:'<img src=x onerror=alert(1)>',type:'거래명세서',created_at:'2026-09-10T00:00:00Z'};
function harness({save,list}={}){
 const elements={};for(const id of ['drive-name','drive-url','drive-invoice','drive-type','drive-save','drive-error','m-drive-doc','docs-drive-list','inv-drive-list','m-inv-view','fd-c','fd-t'])elements[id]={value:'',textContent:'',innerHTML:'',disabled:false,dataset:{},classList:{add(){},remove(){}}};
 elements['drive-name'].value='Statement';elements['drive-url'].value='https://drive.google.com/file/d/test_file_1234567890/view';elements['drive-invoice'].value=invoiceId;elements['drive-type'].value='거래명세서';elements['m-inv-view'].dataset.invoiceId=invoiceId;
 const notices=[],closed=[];let writes=0,serverRows=[];
 const ctx={URL,setTimeout,clearTimeout,_invoices:[{id:invoiceId,no:'TEST_001',customer:'Demo'}],_invFileCache:{},document:{getElementById:id=>elements[id],querySelectorAll:()=>[]},sb:{},esc:s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;'),toast:s=>notices.push(s),om(){},cm:id=>closed.push(id),confirm:()=>true,updateInvFileIcon(){}};
 vm.createContext(ctx);vm.runInContext(fs.readFileSync(path.join(__dirname,'../drive-documents.js'),'utf8'),ctx);
 ctx.ChangeRequests={message:r=>r.status==='pending'?'관리자 승인 대기':'요청 상태 확인'};ctx.DriveDocuments.save=async()=>{writes++;return save?await save():{id:'r',status:'pending'};};ctx.DriveDocuments.list=list||async function(){return serverRows;};
 const src=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8'),start=src.indexOf('// ─── DRIVE EVIDENCE ───'),end=src.indexOf('// ─── END DRIVE EVIDENCE ───');
 assert.ok(start>=0&&end>start,'Drive evidence is connected to the UI');vm.runInContext(src.slice(start,end),ctx);
 return {ctx,elements,notices,closed,writes:()=>writes,rows:()=>JSON.parse(vm.runInContext('JSON.stringify(_driveRows)',ctx))};
}
test('pending duplicate clicks submit once without making an unapproved link visible',async()=>{
 let done;const h=harness({save:()=>new Promise(r=>done=r)});const pending=h.ctx.saveDriveDoc();await h.ctx.saveDriveDoc();assert.equal(h.writes(),1);assert.equal(h.elements['drive-save'].disabled,true);done({id:'r',status:'pending'});await pending;assert.equal(h.rows().length,0);assert.equal(h.elements['drive-save'].disabled,false);assert.ok(h.closed.includes('m-drive-doc'));assert.match(h.notices.join(' '),/승인 대기/);assert.doesNotMatch(h.elements['inv-drive-list'].innerHTML,/test_file_1234567890/);
});
test('failed save retains the form and never displays a successful connection',async()=>{
 const h=harness({save:()=>Promise.reject(Error('rejected'))});await h.ctx.saveDriveDoc();assert.equal(h.rows().length,0);assert.equal(h.elements['drive-name'].value,'Statement');assert.equal(h.closed.length,0);assert.ok(h.elements['drive-error'].textContent);assert.equal(h.elements['drive-save'].disabled,false);
});
test('a pre-request read still shows only confirmed links',async()=>{
 let done,reads=0;const h=harness({list:()=>++reads===1?new Promise(r=>done=r):Promise.resolve([row])});const pending=h.ctx.loadDriveDocs();await h.ctx.saveDriveDoc();done([]);await pending;assert.equal(h.rows().length,0);
});
test('logout invalidates pending reads and writes and clears document labels',async()=>{
 let done;const h=harness({save:()=>new Promise(r=>done=r)});const pending=h.ctx.saveDriveDoc();h.ctx.resetDriveDocs();done(row);await pending;assert.equal(h.rows().length,0);assert.deepEqual(h.closed,['m-drive-doc']);assert.equal(h.elements['drive-save'].disabled,false);assert.equal(h.elements['drive-url'].value,'');assert.equal(h.elements['drive-name'].value,'');assert.doesNotMatch(h.elements['inv-drive-list'].innerHTML,/test_file_1234567890/);
});
test('a failed read visibly reports an error instead of claiming there are no links',async()=>{
 const h=harness({list:()=>Promise.reject(Error('offline'))});await h.ctx.loadDriveDocs();assert.match(h.elements['inv-drive-list'].innerHTML,/조회|불러오/);assert.doesNotMatch(h.elements['inv-drive-list'].innerHTML,/연결된 증빙 없음/);
});
test('requesting before initial read completes preserves the confirmed result',async()=>{
 let done,reads=0;const existing={...row,id:'00000000-0000-0000-0000-000000000003',drive_file_id:'existing_file_123456',name:'Existing.pdf'};
 const h=harness({list:()=>++reads===1?new Promise(r=>done=r):Promise.resolve([existing,row])});
 const pending=h.ctx.loadDriveDocs();await h.ctx.saveDriveDoc();done([existing]);await pending;
 assert.equal(h.rows().length,1);assert.match(h.elements['docs-drive-list'].innerHTML,/Existing.pdf/);
});

test('confirmed Drive link rendering escapes document names',async()=>{const h=harness({list:async()=>[row]});await h.ctx.loadDriveDocs();assert.match(h.elements['inv-drive-list'].innerHTML,/test_file_1234567890/);assert.doesNotMatch(h.elements['inv-drive-list'].innerHTML,/<img/);assert.match(h.elements['inv-drive-list'].innerHTML,/&lt;img/);});
