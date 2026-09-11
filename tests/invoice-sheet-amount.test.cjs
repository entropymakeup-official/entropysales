const {test}=require('node:test');
const assert=require('node:assert/strict');
const {applyJobs}=require('../outbound-sheet-sync/Core.js');
const snapshot=items=>({invoice_id:'order',revision:'2',deleted:false,invoice:{id:'order',no:'DEMO'},items});
const current=()=>({orders:[],items:[],state:[]});
test('sheet amount honors proof including zero and credit without changing quantity or price',()=>{
 const items=[
  {id:'a',qty:3,price:33,amount_override:100},
  {id:'b',qty:2,price:8,amount_override:0},
  {id:'c',qty:-2,price:8,amount_override:-15.5},
  {id:'d',qty:2,price:8,amount_override:null},
  {id:'e',qty:2,price:8}
 ];
 const result=applyJobs(current(),[snapshot(items)],'now');
 assert.deepEqual(result.items.map(r=>r.slice(7)),[[3,33,100],[2,8,0],[-2,8,-15.5],[2,8,16],[2,8,16]]);
 assert.deepEqual(applyJobs(result,[snapshot(items)],'later'),result,'replay is idempotent');
});
test('invalid proof aborts the plan without changing managed rows or checkpoint',()=>{
 for(const value of ['',false,'NaN','Infinity',Infinity]){
  const state=current();
  assert.throws(()=>applyJobs(state,[snapshot([{id:'a',qty:3,price:33,amount_override:value}])],'now'),/number/);
  assert.deepEqual(state,current());
 }
});
