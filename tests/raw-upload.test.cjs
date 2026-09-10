const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
function group(date='2026-09-10'){
 return {customer:'Customer',custExact:true,orderDate:date,payDate:'',shipDate:'',items:[{name:'Product',barcode:'123',salesType:'Paid',qty:2,price:12.5}]};
}
function setup(groups,reply){
 const calls=[],legacy=[],messages=[],closed=[],opened=[];
 const button={disabled:false,innerHTML:'저장',textContent:'저장'};
 const nodes={'raw-upload-save':button,'raw-upload-status':{innerHTML:''},'raw-upload-area':{innerHTML:''}};
 const c={window:{_rawUploadData:groups},_invoices:[],_items:[],_customers:[],_products:[],
  document:{getElementById:id=>nodes[id]||null,querySelectorAll:selector=>selector.startsWith('#m-raw-preview')?[button]:[],removeEventListener:()=>{}},
  custByName:()=>({code:'C',mgr:''}),today:()=> '2026-09-10',toast:m=>messages.push(m),cm:id=>closed.push(id),om:id=>opened.push(id),renderRaw:()=>{},setTimeout:()=>{},xgKeydownGlobal:()=>{},xgHandlePaste:()=>{},FileReader:class{readAsBinaryString(){}},
  esc:v=>String(v??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])),
  sb:{rpc:async(name,args)=>{calls.push({name,args});return reply(args,calls.length);},from:table=>({insert:rows=>{legacy.push({table,rows});const data={...rows,id:'legacy'};return {select:()=>({single:async()=>({data,error:null})}),then:(resolve)=>resolve({error:{code:'23514',message:'item rejected'}})};}})}
 };
 vm.createContext(c);
 vm.runInContext(source.slice(source.indexOf('let _savingRaw=false;'),source.indexOf('// ── Paid → 인보이스 연동')),c);
 return {c,calls,legacy,messages,closed,opened,nodes,button};
}
function success(args,n){return {data:{invoice:{...args.p_invoice,id:'invoice-'+n},items:args.p_items.map((it,i)=>({...it,id:'item-'+n+'-'+i,invoice_id:'invoice-'+n,invoice_no:args.p_invoice.no}))},error:null};}

test('Excel upload saves each complete order through the atomic RPC and uses server IDs',async()=>{
 const s=setup([group(),group()],success);await s.c.confirmRawUpload();
 assert.equal(s.calls.length,2);assert.equal(s.legacy.length,0);
 assert.deepEqual(s.calls.map(x=>x.args.p_invoice.no),['C_20260910','C_20260910_2']);
 assert.ok(s.calls.every(x=>x.name==='save_invoice_atomic'&&x.args.p_id===null));
 assert.equal(s.calls[0].args.p_items[0].price,12.5);
 assert.deepEqual(Array.from(s.c._items,x=>x.id),['item-1-0','item-2-0']);
 assert.equal(s.c.window._rawUploadData,null);assert.equal(s.button.disabled,false);
});

test('item rejection never reports full completion and retains the failed and unprocessed orders',async()=>{
 const groups=[group(),group('2026-09-11'),group('2026-09-12')];
 const s=setup(groups,(args,n)=>n===2?{error:{code:'23514',message:'item rejected'}}:success(args,n));
 await s.c.confirmRawUpload();
 assert.equal(s.calls.length,2);assert.equal(s.legacy.length,0);
 assert.equal(s.c._invoices.length,1);assert.equal(s.c._items.length,1);
 assert.equal(s.c.window._rawUploadData,groups);
 assert.deepEqual(groups.map(g=>g._saveStatus||'pending'),['saved','failed','pending']);
 assert.doesNotMatch(s.messages.join(' '),/RAW 저장 완료/);
 assert.match(s.nodes['raw-upload-status'].innerHTML,/item rejected/);
 assert.equal(s.closed.includes('m-raw-preview'),false);assert.equal(s.button.disabled,false);
});

test('retry skips confirmed orders and keeps the reserved number even if the cache changed',async()=>{
 const groups=[group(),group()];let reject=true;
 const s=setup(groups,(args,n)=>n===2&&reject?{error:{code:'23514',message:'rejected'}}:success(args,n));
 await s.c.confirmRawUpload();
 assert.equal(s.calls.length,2);
 const failedNumber=s.calls[1].args.p_invoice.no;
 s.c._invoices.push({id:'concurrent',no:failedNumber});reject=false;
 await s.c.confirmRawUpload();
 assert.equal(s.calls.length,3);assert.equal(s.calls[2].args.p_invoice.no,failedNumber);
 assert.equal(s.c._items.filter(i=>i.invoice_id==='invoice-1').length,1);
 assert.equal(s.c.window._rawUploadData,null);
});

test('duplicate confirm clicks produce only one batch while the save is pending',async()=>{
 let resolve;const s=setup([group()],args=>new Promise(r=>{resolve=()=>r(success(args,1));}));
 const first=s.c.confirmRawUpload();await s.c.confirmRawUpload();
 assert.equal(s.calls.length,1);assert.equal(s.button.disabled,true);
 resolve();await first;assert.equal(s.button.disabled,false);
});

test('lost response is marked unconfirmed and does not send subsequent orders',async()=>{
 const groups=[group(),group('2026-09-11')];const s=setup(groups,()=>{throw Error('network unavailable');});
 await s.c.confirmRawUpload();
 assert.equal(s.calls.length,1);assert.equal(groups[0]._saveStatus,'unknown');
 assert.equal(s.c._invoices.length,0);assert.equal(s.c._items.length,0);
 assert.match(s.nodes['raw-upload-status'].innerHTML,/확인 필요/);
 assert.equal(s.c.window._rawUploadData,groups);assert.equal(s.button.disabled,false);
});

test('malformed success response cannot populate the cache with missing or unrelated item IDs',async()=>{
 const groups=[group()];const s=setup(groups,args=>({data:{invoice:{...args.p_invoice,id:'new'},items:[{invoice_id:'other'}]}}));
 await s.c.confirmRawUpload();
 assert.equal(groups[0]._saveStatus,'unknown');assert.equal(s.c._items.length,0);assert.equal(s.c._invoices.length,0);
});

test('upload input and manual cancellation cannot replace a batch in progress',async()=>{
 let resolve;const groups=[group()];const s=setup(groups,args=>new Promise(r=>{resolve=()=>r(success(args,1));}));
 const first=s.c.confirmRawUpload();s.c.cancelRawUpload();s.c.handleRawUpload({files:[{}]});
 assert.equal(s.c.window._rawUploadData,groups);resolve();await first;
});

test('reopening upload resumes the retained batch after inspecting the order list',async()=>{
 const groups=[group(),group(),group()];
 const s=setup(groups,(args,n)=>n===2?{error:{code:'23514',message:'rejected'}}:success(args,n));
 await s.c.confirmRawUpload();
 let previewed=false;s.c._showRawPreviewModal=()=>{previewed=true;};
 s.c.openRawUploadModal();
 assert.equal(previewed,true);assert.equal(s.opened.includes('m-raw-upload'),false);
 s.c.cancelRawUpload();
 assert.equal(s.c.window._rawUploadData,groups,'manual form cleanup must preserve Excel recovery');
});

test('replacing an incomplete upload requires an explicit discard and keeps saved orders',async()=>{
 const groups=[group(),group()];
 const s=setup(groups,(args,n)=>n===2?{error:{code:'23514',message:'rejected'}}:success(args,n));
 await s.c.confirmRawUpload();
 s.c.confirm=()=>false;s.c.discardRawUpload();
 assert.equal(s.c.window._rawUploadData,groups);
 s.c.confirm=()=>true;s.c.discardRawUpload();
 assert.equal(s.c.window._rawUploadData,null);assert.equal(s.c._invoices.length,1);assert.equal(s.c._items.length,1);
 s.c.openRawUploadModal();assert.equal(s.opened.at(-1),'m-raw-upload');
});

test('a new file cannot silently replace retained upload results',()=>{
 const groups=[group()];groups[0]._saveStatus='unknown';const s=setup(groups,success);
 let reads=0;s.c.FileReader=class{readAsBinaryString(){reads++;}};
 s.c.handleRawUpload({files:[{}]});
 assert.equal(reads,0);assert.equal(s.c.window._rawUploadData,groups);
});
