const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs'),vm=require('node:vm');
const ctx={};vm.createContext(ctx);const source=__dirname+'/../outbound-sheet-sync/ReportAmounts.js';if(fs.existsSync(source))vm.runInContext(fs.readFileSync(source,'utf8'),ctx);
const map={Paid:'Revenue',FOC:'Cost',GWP:'Cost',Sample:'Cost',Replacement:'Cost',Lost:'Opportunity'};
test('report reconciles approved Amount rather than reconstructing rounded unit prices',()=>{
 const proof=item('proof','a','Paid',3,33);proof[9]=100;
 const zero=item('zero','a','Paid',1,20);zero[9]=0;
 const credit=item('credit','a','Paid',-2,5);credit[9]=-9;
 const result=ctx.reportExpected({orders:[order('a')],items:[proof,zero,credit]},map);
 assert.equal(result.Revenue,91);assert.equal(result.byOrder.a.Revenue,91);
});
function order(id,revision='1'){return [id,revision,'INV_'+id,'Customer','Manager','2026-01-01','','','Paid','',''];}
function item(id,orderId,type,qty,price){return [orderId,'1',id,'INV_'+orderId,'Product','00123',type,qty,price,qty*price];}
test('reconciles paid sales separately from free goods and lost sales by UUID',()=>{
 assert.equal(typeof ctx.reportExpected,'function');
 const result=ctx.reportExpected({orders:[order('a'),order('b')],items:[item('1','a','Paid',2,10.5),item('2','a','FOC',3,10),item('3','a','Lost',4,10),item('4','b','Sample',1,2)]},map);
 assert.equal(result.orders,2);assert.equal(result.items,4);assert.equal(result.quantity,10);
 assert.equal(result.Revenue,21);assert.equal(result.Cost,32);assert.equal(result.Opportunity,40);assert.equal(result.amount,93);
 assert.equal(result.byOrder.a.Revenue,21);assert.equal(result.byOrder.b.Revenue,0);
});
test('rejects missing or duplicate identities and inconsistent snapshots before writing reports',()=>{
 assert.equal(typeof ctx.reportExpected,'function');
 assert.throws(()=>ctx.reportExpected({orders:[order('a'),order('a')],items:[]},map),/Duplicate order/);
 assert.throws(()=>ctx.reportExpected({orders:[order('a')],items:[item('1','z','Paid',1,1)]},map),/Missing order/);
 assert.throws(()=>ctx.reportExpected({orders:[order('a','2')],items:[item('1','a','Paid',1,1)]},map),/Revision/);
 assert.throws(()=>ctx.reportExpected({orders:[order('a')],items:[item('1','a','Paid',1,1),item('1','a','Paid',1,1)]},map),/Duplicate item/);
});
test('unknown sales types and corrupted amounts cannot silently become zero revenue',()=>{
 assert.equal(typeof ctx.reportExpected,'function');
 assert.throws(()=>ctx.reportExpected({orders:[order('a')],items:[item('1','a','Other',1,1)]},map),/Unknown sales type/);
 const bad=item('1','a','Paid',1,1);bad[9]=NaN;
 assert.throws(()=>ctx.reportExpected({orders:[order('a')],items:[bad]},map),/Amount/);
});
