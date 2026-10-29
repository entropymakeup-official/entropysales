const test=require('node:test'),assert=require('node:assert/strict');
const {harness}=require('./helpers/approvals.cjs');
test('invoice list shows a verifier only when one was recorded, never a missing-record label',()=>{
 const h=harness();h.load('verificationMarkup','invoicePaymentMarkup');Object.assign(h.ctx,{_invoiceStatusPending:new Set()});
 assert.equal(h.ctx.verificationMarkup(null,null),'');
 assert.match(h.ctx.verificationMarkup('tester@example.com','2026-10-29T01:00:00Z'),/검증 tester · 2026-10-29/);
 const old=h.ctx.invoicePaymentMarkup({id:'a',status:'Paid',pay_date:'2026-09-10'},100);
 assert.match(old,/입금완료/);assert.doesNotMatch(old,/검증 기록 없음|inv-verified/);
 assert.doesNotMatch(h.source,/검증 기록 없음/);
});
