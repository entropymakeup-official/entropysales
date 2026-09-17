const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
test('submission message shows the server-reserved invoice number',()=>{
 const ctx={};vm.createContext(ctx);vm.runInContext(fs.readFileSync('change-requests.js','utf8'),ctx);
 assert.match(ctx.ChangeRequests.message({status:'pending',invoice_numbers:['BL_20260910_3']}),/BL_20260910_3/);
 assert.match(ctx.ChangeRequests.message({status:'pending',invoice_numbers:['A','B']}),/A, B/);
 assert.equal(ctx.ChangeRequests.message({status:'pending'}),'변경 요청이 접수됐습니다. 관리자 승인 대기 중입니다.');
 assert.match(ctx.ChangeRequests.message({status:'approved',invoice_numbers:['A']}),/이미 승인/);
});
