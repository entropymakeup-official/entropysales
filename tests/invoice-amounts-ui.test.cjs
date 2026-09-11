const test=require('node:test'),assert=require('node:assert/strict');
const A=require('../invoice-amounts.js');
function fixture({execute=async()=>({id:'request',status:'pending'}),timeoutMs}={}){
 const nodes={},calls=[],options=[],notices=[];let auth;
 const node=id=>nodes[id]||(nodes[id]={value:'',textContent:'',innerHTML:'',disabled:false,required:false,hidden:false,dataset:{},events:{},classList:{add(){},remove(){}},addEventListener(name,handler){this.events[name]=handler;},querySelectorAll(){return Object.entries(nodes).filter(([key])=>/^invoice-amount-(value|reference)-/.test(key)).map(([,value])=>value);}});
 const document={getElementById:node};
 const client={row:async(table,action,key,values,before)=>({table,action,key,values,before}),submit:async (ops,opts)=>{calls.push(ops);options.push(opts);return execute();}};
 assert.equal(typeof A.mount,'function');const ui=A.mount({document,client,auth:{onAuthStateChange(fn){auth=fn;}},onMessage:m=>notices.push(m),timeoutMs});
 const line={id:'synthetic-line',invoice_id:'synthetic-inv',name:'Synthetic <item>',barcode:'TEST',sales_type:'Paid',qty:3,price:40,amount_override:91.25,amount_reference:'Original <proof>'};
 ui.open({id:'synthetic-inv',no:'SYNTHETIC'},[line,{...line,id:'free',sales_type:'FOC'}]);
 node('invoice-amount-reason').value='Synthetic correction';
 return {ui,node,nodes,calls,options,notices,line,auth:(...args)=>auth(...args)};
}
test('modal renders only Paid originals, effective amount and editable escaped proof',()=>{
 const f=fixture(),html=f.node('invoice-amount-rows').innerHTML;
 assert.match(html,/Synthetic &lt;item&gt;/);assert.doesNotMatch(html,/<item>|<proof>/);assert.match(html,/120/);assert.match(html,/91\.25/);assert.match(html,/Original &lt;proof&gt;/);assert.equal((html.match(/data-amount-row/g)||[]).length,1);
});
test('modal error retains editable DOM values, success queues only and closes without changing source',async()=>{
 let succeed=false;const f=fixture({execute:async()=>{if(!succeed)throw Error('offline');return {id:'request',status:'pending'};}});
 f.node('invoice-amount-value-0').value='0';f.node('invoice-amount-reference-0').value='New proof';await f.ui.submit();
 assert.equal(f.node('invoice-amount-value-0').value,'0');assert.match(f.node('invoice-amount-error').textContent,/offline/);assert.equal(f.node('invoice-amount-submit').disabled,false);
 succeed=true;await f.ui.submit();assert.equal(f.calls[1][0].values.amount_override,0);assert.equal(f.line.amount_override,91.25);assert.match(f.notices.join(' '),/승인 대기/);
});
test('logout clears modal data and prevents old completion from closing a newly opened draft',async()=>{
 let finish;const f=fixture({execute:()=>new Promise(r=>finish=r)});f.auth('SIGNED_IN',{user:{id:'user-a'}});
 f.node('invoice-amount-value-0').value='80';f.node('invoice-amount-reference-0').value='Proof';const pending=f.ui.submit();await new Promise(setImmediate);
 f.auth('SIGNED_OUT',null);assert.equal(f.node('invoice-amount-rows').innerHTML,'');assert.equal(f.node('invoice-amount-title').textContent,'');
 assert.equal(f.node('invoice-amount-reason').value,'');
 f.ui.open({id:'next',no:'NEXT'},[{...f.line,id:'next-line'}]);finish({id:'request',status:'pending'});await pending;assert.equal(f.notices.length,0);assert.match(f.node('invoice-amount-title').textContent,/NEXT/);
});
test('embedded reason reaches approval client without a native prompt, locks while pending and clears on success',async()=>{
 let finish;const f=fixture({execute:()=>new Promise(r=>finish=r)});
 f.node('invoice-amount-value-0').value='80';f.node('invoice-amount-reference-0').value='Proof';f.node('invoice-amount-reason').value='  Evidence correction  ';
 const pending=f.ui.submit();await new Promise(setImmediate);
 assert.deepEqual(f.options,[{reason:'Evidence correction'}]);assert.equal(f.node('invoice-amount-reason').disabled,true);
 finish({id:'request',status:'pending'});await pending;assert.equal(f.node('invoice-amount-reason').value,'');
});
test('blank or oversized reasons prevent submission while retaining the evidence draft',async()=>{
 for(const reason of ['  ','x'.repeat(2001)]){
  const f=fixture();f.node('invoice-amount-value-0').value='80';f.node('invoice-amount-reference-0').value='Proof';f.node('invoice-amount-reason').value=reason;
  await f.ui.submit();assert.equal(f.calls.length,0);assert.match(f.node('invoice-amount-error').textContent,/사유/);assert.equal(f.node('invoice-amount-value-0').value,'80');assert.equal(f.node('invoice-amount-reason').value,reason);
 }
});
