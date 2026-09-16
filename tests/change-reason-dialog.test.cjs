const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm'),fs=require('node:fs');
function setup(){
 const elements={};let dialog;
 const context={crypto:require('node:crypto').webcrypto,TextEncoder,
  prompt(){throw Error('prompt() is not supported.');},
  document:{activeElement:{focus(){}},body:{appendChild(el){dialog=el;}},createElement(){
   return {style:{},setAttribute(){},addEventListener(name,fn){this[name]=fn;},
    querySelector(selector){return elements[selector]??={value:'',focus(){},addEventListener(name,fn){this[name]=fn;},setCustomValidity(){},reportValidity(){}};},
    showModal(){this.open=true;},close(){this.open=false;this.closeEvent?.();},remove(){this.removed=true;}};
  }}
 };
 vm.createContext(context);vm.runInContext(fs.readFileSync('change-requests.js','utf8'),context);
 const calls=[];
 const client=context.ChangeRequests.createClient({sb:{rpc:async(name,args)=>{calls.push({name,args});return {data:{id:'request',status:'pending'}};}}});
 return {client,calls,elements,get dialog(){return dialog;}};
}
test('default reason form submits typed reason without native prompt and keeps approval pending',async()=>{
 const h=setup();const pending=h.client.submit([{table:'tax_records',action:'update'}]);
 // Observe the promise now so a missing implementation is an ordinary assertion failure.
 pending.catch(()=>{});await new Promise(setImmediate);
 assert.ok(h.dialog,'reason form should open');assert.equal(h.calls.length,0);
 h.elements.textarea.value='  직접입금 증빙 확인  ';
 h.elements.form.submit({preventDefault(){}});
 assert.equal((await pending).status,'pending');
 assert.equal(h.calls[0].args.p_reason,'직접입금 증빙 확인');
 assert.equal(h.dialog.removed,true);
});
test('blank reason stays open; cancel sends no business change',async()=>{
 const h=setup();const pending=h.client.submit([{action:'insert'}]);pending.catch(()=>{});
 await new Promise(setImmediate);assert.ok(h.dialog);
 h.elements.textarea.value='  ';h.elements.form.submit({preventDefault(){}});
 assert.equal(h.calls.length,0);assert.equal(h.dialog.removed,undefined);
 h.elements['[data-cancel]'].click();assert.equal(await pending,null);assert.equal(h.calls.length,0);
});
test('reason dialog isolates paste and editing keys from the underlying spreadsheet editor',async()=>{
 const h=setup();const pending=h.client.submit([{action:'insert'}]);await new Promise(setImmediate);
 for(const name of ['paste','keydown']){
  let stopped=false;const event={stopPropagation(){stopped=true;},preventDefault(){assert.fail('textarea default editing must work');}};
  h.dialog[name]?.(event);
  assert.equal(stopped,true,name+' must not bubble to grid document listeners');
 }
 h.elements['[data-cancel]'].click();await pending;
});
