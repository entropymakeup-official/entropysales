const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const modelPath=path.join(__dirname,'../drive-documents.js');
function model(){const ctx={URL,setTimeout,clearTimeout,TextEncoder,crypto:require("node:crypto").webcrypto,prompt:()=>"연결 사유"};vm.createContext(ctx);vm.runInContext(fs.readFileSync(path.join(__dirname,'../change-requests.js'),'utf8'),ctx);if(fs.existsSync(modelPath))vm.runInContext(fs.readFileSync(modelPath,'utf8'),ctx);assert.ok(ctx.DriveDocuments,'Drive document behavior is available');return ctx.DriveDocuments;}
const fileId='test_file_1234567890',invoiceId='00000000-0000-0000-0000-000000000001';
const form={name:'  Statement.pdf  ',type:'거래명세서',invoice_id:invoiceId,url:'https://drive.google.com/file/d/'+fileId+'/view?usp=sharing'};
const invoice={id:invoiceId,no:'TEST_001',customer:'테스트 거래처'};
test('Drive links preserve file identity across share URL forms and retain resource keys',()=>{
 const m=model();for(const url of [form.url,'https://drive.google.com/open?id='+fileId,'https://drive.google.com/uc?id='+fileId,'https://docs.google.com/spreadsheets/d/'+fileId+'/edit#gid=123']){
  const p=m.parseLink(url);assert.equal(p.fileId,fileId);assert.equal(p.url,'https://drive.google.com/file/d/'+fileId+'/view');
 }
 assert.equal(m.parseLink(form.url+'&resourcekey=0-example_key').url,'https://drive.google.com/file/d/'+fileId+'/view?resourcekey=0-example_key');
});
test('unsafe, ambiguous and folder URLs cannot become document links',()=>{
 const m=model();for(const url of ['javascript:alert(1)','http://drive.google.com/file/d/'+fileId+'/view','https://drive.google.com.evil.test/file/d/'+fileId+'/view','https://user@drive.google.com/file/d/'+fileId+'/view','https://drive.google.com:444/file/d/'+fileId+'/view','https://drive.google.com/drive/folders/'+fileId,'https://drive.google.com/open?id='+fileId+'&id=another_file_123','https://drive.google.com/file/d/%2f/view','https://drive.google.com/file/d/'+fileId+'/../view','https://drive.google.com\\@evil.test/file/d/'+fileId+'/view','https://drive.google.com/file/d/'+fileId+'/view?resourcekey=bad%22key'])assert.throws(()=>m.parseLink(url),undefined,url);
});
test('a link requires a real selected invoice, a bounded name and a known document type',()=>{
 const m=model(),p=m.prepare(form,[invoice]);assert.equal(p.name,'Statement.pdf');assert.equal(p.invoice_id,invoiceId);assert.equal(p.drive_file_id,fileId);assert.equal(p.resource_key,null);
 for(const change of [{name:' '},{name:'x'.repeat(251)},{type:'<script>'},{invoice_id:'missing'},{url:''}])assert.throws(()=>m.prepare({...form,...change},[invoice]));
});
test('save submits validated link metadata as pending operation, without invoice or storage writes',async()=>{
 const m=model(),calls=[];const sb={rpc:async(name,args)=>{calls.push({name,args});return {data:{id:'r',status:'pending'}};},from(){throw Error('direct write');}};
 const result=await m.save(sb,form,[invoice]);assert.equal(result.status,'pending');assert.equal(calls[0].name,'submit_change_request');const op=calls[0].args.p_operations[0];assert.equal(op.table,'invoice_drive_documents');assert.equal(op.before,null);assert.equal(op.values.invoice_id,invoiceId);
});
test('rejected, malformed and lost responses never become successful links',async()=>{
 const m=model();for(const response of [{error:{code:'23505'}},{error:{code:'42501'}},{data:null},{data:{id:'r',status:'wrong'}}]){const sb={rpc:async()=>response};await assert.rejects(m.save(sb,form,[invoice]));}
 await assert.rejects(m.save({rpc:async()=>{throw Error('offline')}},form,[invoice]));
});
test('remove submits full before snapshot without deleting Drive file',async()=>{
 const m=model(),calls=[],id='00000000-0000-0000-0000-000000000002',before={id,...m.prepare(form,[invoice]),created_at:'2026-09-11'};
 const sb={rpc:async(name,args)=>{calls.push({name,args});return {data:{id:'r',status:'pending'}};},from(){throw Error('unexpected write');}};
 const result=await m.remove(sb,id,before);assert.equal(result.status,'pending');assert.equal(calls[0].args.p_operations[0].before.created_at,'2026-09-11');assert.equal(calls[0].args.p_operations[0].action,'delete');await assert.rejects(m.remove(sb,'bad-id',before));
});
