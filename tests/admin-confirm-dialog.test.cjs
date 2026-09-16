const test=require('node:test');
const assert=require('node:assert/strict');
const UI=require('../admin-approvals.js');
function setup(){
 const handlers={},nodes={},parts={};let dialog,authChange;
 const document={activeElement:{focus(){}},body:{appendChild(el){dialog=el;}},
  getElementById:id=>nodes[id]||(nodes[id]={addEventListener(name,fn){handlers[name]=fn;}}),
  createElement(){return {style:{},setAttribute(){},addEventListener(name,fn){this[name]=fn;},querySelector(s){return parts[s]??={focus(){},addEventListener(name,fn){this[name]=fn;}};},showModal(){},close(){},remove(){this.removed=true;}};}};
 const calls=[];const client={auth:{getSession:async()=>({data:{session:{}}}),onAuthStateChange(fn){authChange=fn;}},rpc:async(name,args)=>{calls.push({name,args});return name==='list_change_requests'?{data:{is_admin:true,requests:[{id:'r1',status:'pending',reason:'정정',operations:[]}]}}:{data:{id:'r1',status:'approved'}};}};
 UI.mount({document,client});
 return {calls,parts,get dialog(){return dialog;},signOut(){authChange('SIGNED_OUT');},click(){return handlers.click({target:{closest:()=>({disabled:false,hasAttribute:()=>false,dataset:{review:'approve',id:'r1'}})}});}};
}
test('approval waits for explicit inline confirmation; cancelling makes no mutation',async()=>{
 const h=setup();await new Promise(setImmediate);const pending=h.click();pending.catch(()=>{});await new Promise(setImmediate);
 assert.ok(h.dialog);assert.equal(h.calls.length,1);h.parts['[data-cancel]'].click();await pending;assert.equal(h.calls.length,1);
});
test('explicit inline approval submits once, suppressing duplicate confirmation clicks',async()=>{
 const h=setup();await new Promise(setImmediate);const pending=h.click();pending.catch(()=>{});await new Promise(setImmediate);
 assert.ok(h.dialog);await h.click();assert.equal(h.calls.length,1);h.parts['[data-confirm]'].click();await pending;
 assert.equal(h.calls.filter(x=>x.name==='review_change_request').length,1);assert.equal(h.dialog.removed,true);
});
test('sign-out while confirming cannot approve under a changed session',async()=>{
 const h=setup();await new Promise(setImmediate);const pending=h.click();pending.catch(()=>{});await new Promise(setImmediate);
 assert.ok(h.dialog);h.signOut();h.parts['[data-confirm]'].click();await pending;assert.equal(h.calls.length,1);
});
