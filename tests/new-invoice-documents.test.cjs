const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {harness}=require('./helpers/approvals.cjs');
const docs=[{drive_file_id:'synthetic_file_0001',resource_key:null,name:'발주서',type:'기타'}];
const items=[{name:'New',barcode:'123',qty:2,price:3,salesType:'Paid'}];

test('new RAW request carries the evidence in the same operation, never in submit options',async()=>{
 const h=harness();h.load('persistRawInvoice','confirmRawSave');
 h.ctx.window._pendingRaw={cust:'New',c:{},invNo:'NEW',odate:'2026-11-03',items,documents:docs};
 await h.ctx.confirmRawSave();
 const op=h.calls[0].args.p_operations[0];
 assert.equal(op.id,null);assert.equal(op.auto_number,true);
 assert.deepEqual(JSON.parse(JSON.stringify(op.documents)),docs);
 assert.equal('documents' in h.calls[0].args,false);
});

test('RAW edits and requests without evidence keep the previous payload',async()=>{
 const h=harness();h.load('persistRawInvoice');
 await h.ctx.persistRawInvoice(null,{no:'NEW',customer:'Demo',order_date:'2026-11-03',status:'Ordered',ship_status:'준비중'},items,{documents:[]});
 assert.equal('documents' in h.calls[0].args.p_operations[0],false);
 h.ctx.window._editRawBefore={invoice:h.ctx._invoices[0],items:h.ctx._items};
 await h.ctx.persistRawInvoice('inv-a',{...h.ctx._invoices[0]},items,{documents:docs});
 assert.equal('documents' in h.calls[1].args.p_operations[0],false);
});

test('new RAW confirmation stops on an invalid evidence link before showing the confirmation',async()=>{
 const h=harness();h.load('saveRawManual','persistRawInvoice');
 h.element('rm-cust').value='Demo';h.element('rm-date').value='2026-11-03';h.ctx.xgGetItems=()=>items;
 let shown=false;h.ctx._showRawConfirmModal=()=>{shown=true;};
 h.ctx.readNewDocs=()=>{throw Error('Google Drive 파일의 공유 링크를 입력해 주세요.');};
 await h.ctx.saveRawManual();
 assert.equal(shown,false);assert.match(h.notices.at(-1),/공유 링크/);
 h.ctx.readNewDocs=()=>docs;await h.ctx.saveRawManual();
 assert.equal(shown,true);assert.deepEqual(h.ctx.window._pendingRaw.documents,docs);
});

test('invoice form sends evidence only for a new invoice',async()=>{
 const h=harness();h.load('saveInv');
 for(const[k,v]of Object.entries({'inv-no':'NEW','inv-cust-ro':'Demo','inv-odate':'2026-11-03','inv-status':'Ordered','inv-ship':'준비중','inv-note':''}))h.element(k).value=v;
 h.ctx.document.querySelectorAll=()=>[{querySelectorAll:()=>['New','123','2','30'].map(value=>({value})),querySelector:()=>({value:'Paid'})}];
 h.ctx.readNewDocs=prefix=>{assert.equal(prefix,'inv');return docs;};
 h.ctx._editInv=null;await h.ctx.saveInv();
 assert.deepEqual(JSON.parse(JSON.stringify(h.calls[0].args.p_operations[0].documents)),docs);
 h.ctx._editInv=h.ctx._invoices[0];await h.ctx.saveInv();
 assert.equal('documents' in h.calls[1].args.p_operations[0],false);
});

test('evidence rows are read from the form through the shared Drive validation',()=>{
 const h=harness();h.load('readNewDocs');
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../drive-documents.js'),'utf8'),h.ctx);
 const row=(type,name,url)=>({querySelector:()=>({value:type}),querySelectorAll:()=>[{value:name},{value:url}]});
 h.ctx.document.querySelectorAll=selector=>{assert.equal(selector,'#rm-docs .new-docs-row');return [row('기타','발주서','https://drive.google.com/file/d/synthetic_file_0001/view'),row('기타','','')];};
 assert.deepEqual(JSON.parse(JSON.stringify(h.ctx.readNewDocs('rm'))),docs);
});
