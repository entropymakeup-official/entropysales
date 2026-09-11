const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const file=require('node:path').join(__dirname,'../invoice-amounts.js');
const A=fs.existsSync(file)?require(file):{};
const line=(extra={})=>({id:'line-a',invoice_id:'invoice-a',name:'Synthetic item',barcode:'TEST-1',sales_type:'Paid',qty:3,price:40,created_at:'2026-01-01',...extra});
function client(execute=async()=>({data:{id:'request-a',status:'pending'}})){
 const calls=[],c={TextEncoder,crypto:require('node:crypto').webcrypto,prompt:()=> 'Synthetic correction'};
 vm.createContext(c);vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'../change-requests.js'),'utf8'),c);
 const api=c.ChangeRequests.createClient({sb:{rpc:async(name,args)=>{calls.push({name,args:JSON.parse(JSON.stringify(args))});return execute(name,args);}}});
 return {api,calls};
}
test('effective amount preserves zero, negatives and finite numeric strings without changing original fields',()=>{
 assert.equal(typeof A.amount,'function');
 for(const [override,expected] of [[0,0],['0.00',0],[-23.45,-23.45],['91.25',91.25],[null,120],[undefined,120],['',120],['  ',120],['NaN',120],[Infinity,120],['Infinity',120]]){
  const row=line({amount_override:override}),before={...row};assert.equal(A.amount(row),expected);assert.deepEqual(row,before);
 }
 assert.equal(A.amount({qty:'2',price:'3.5'}),7);assert.equal(A.amount({qty:'bad',price:8}),0);
});
test('dashboard summaries use proof across monthly/customer/manager and keep free quantities unchanged',()=>{
 const model=require('../dashboard-model.js');const rows=[line({amount_override:0}),line({id:'line-b',amount_override:-25}),line({id:'line-c',amount_override:91.25}),line({id:'line-d',sales_type:'FOC',qty:2,price:4})];
 const summary=model.summarize([{id:'invoice-a',customer:'Demo',mgr:'Tester',order_date:'2026-01-02'}],rows,{start:'2026-01-01',end:'2026-01-31'});
 assert.equal(summary.revenue,66.25);assert.equal(summary.byMonth['2026-01'],66.25);assert.equal(summary.byCustomer.Demo,66.25);assert.equal(summary.byManager.Tester,66.25);assert.equal(summary.foc,8);
});
test('unchanged replacement previews retain proof only with unique full item correspondence',()=>{
 assert.equal(typeof A.previewAmounts,'function');const old=line({amount_override:91.25,amount_reference:'Synthetic proof'});const same=line();
 assert.deepEqual(A.previewAmounts([same],[old]),[91.25]);
 for(const patch of [{name:'Changed'},{barcode:'TEST-2'},{sales_type:'FOC'},{qty:4},{price:41}])assert.deepEqual(A.previewAmounts([{...same,...patch}],[old]),[(patch.qty??3)*(patch.price??40)]);
 assert.deepEqual(A.previewAmounts([same,same],[old]),[120,120]);assert.deepEqual(A.previewAmounts([same],[old,old]),[120]);
});
test('proof updates submit full before snapshots through existing approval client only',async()=>{
 assert.equal(typeof A.createController,'function');const f=client(),controller=A.createController({client:f.api}),original=line({amount_override:null,amount_reference:null});controller.open([original]);
 controller.state.rows[0].override='0';controller.state.rows[0].reference=' Synthetic proof / page 2 ';
 await controller.submit();assert.equal(f.calls.length,1);assert.equal(f.calls[0].name,'submit_change_request');
 const op=f.calls[0].args.p_operations[0];assert.deepEqual(op,{table:'invoice_items',action:'update',key:{id:'line-a'},before:original,values:{amount_override:0,amount_reference:'Synthetic proof / page 2'}});assert.equal(original.amount_override,null);
});
test('existing proof may be changed or cleared and untouched rows emit no operations',async()=>{
 assert.equal(typeof A.createController,'function');const f=client(),c=A.createController({client:f.api});c.open([line({amount_override:'91.25',amount_reference:'Original'}),line({id:'free',sales_type:'FOC'})]);
 assert.equal(c.state.rows.length,1);await c.submit();assert.equal(f.calls.length,0);
 c.state.rows[0].reference='Replacement';await c.submit();assert.deepEqual(f.calls[0].args.p_operations[0].values,{amount_override:91.25,amount_reference:'Replacement'});
 c.open([line({amount_override:91.25,amount_reference:'Original'})]);c.state.rows[0].override='';await c.submit();assert.deepEqual(f.calls[1].args.p_operations[0].values,{amount_override:null,amount_reference:null});
});
test('invalid explicit amounts and missing sources retain typed inputs without submitting',async()=>{
 assert.equal(typeof A.createController,'function');for(const [value,reference] of [['0',' '],['NaN','Proof'],['Infinity','Proof'],['1oops','Proof'],['1.234','Proof']]){
  const f=client(),c=A.createController({client:f.api});c.open([line()]);c.state.rows[0].override=value;c.state.rows[0].reference=reference;await c.submit();
  assert.equal(f.calls.length,0);assert.ok(c.state.error);assert.equal(c.state.rows[0].override,value);assert.equal(c.state.rows[0].reference,reference);assert.equal(c.state.busy,false);
 }
});
test('duplicate clicks coalesce and request errors preserve inputs and retry identity',async()=>{
 assert.equal(typeof A.createController,'function');let finish;const f=client(()=>new Promise(r=>finish=r)),c=A.createController({client:f.api});c.open([line()]);c.state.rows[0].override='-20';c.state.rows[0].reference='Proof';
 const first=c.submit(),second=c.submit();await new Promise(setImmediate);assert.equal(f.calls.length,1);finish({error:{message:'offline'}});await Promise.all([first,second]);
 assert.equal(c.state.rows[0].override,'-20');assert.match(c.state.error,/offline/);assert.equal(c.state.busy,false);
 const retry=c.submit();await new Promise(setImmediate);assert.equal(f.calls[0].args.p_client_id,f.calls[1].args.p_client_id);finish({data:{id:'request-a',status:'pending'}});await retry;
});
test('logout reset invalidates late responses and clears proof data',async()=>{
 assert.equal(typeof A.createController,'function');let finish;const f=client(()=>new Promise(r=>finish=r)),c=A.createController({client:f.api});c.open([line()]);c.state.rows[0].override='80';c.state.rows[0].reference='Proof';
 const pending=c.submit();await new Promise(setImmediate);c.reset();finish({data:{id:'request-a',status:'pending'}});assert.equal(await pending,null);assert.equal(c.state.rows.length,0);assert.equal(c.state.message,'');assert.equal(c.state.error,'');
});
test('bounded wait preserves inputs and ignores a late response even after reopening',async()=>{
 assert.equal(typeof A.createController,'function');let finish;const f=client(()=>new Promise(r=>finish=r)),c=A.createController({client:f.api,timeoutMs:15});c.open([line()]);c.state.rows[0].override='80';c.state.rows[0].reference='Proof';
 assert.equal(await c.submit(),null);assert.equal(c.state.busy,false);assert.match(c.state.error,/확인|시간/);assert.equal(c.state.rows[0].override,'80');c.open([line({id:'new-line'})]);finish({data:{id:'request-a',status:'pending'}});await new Promise(setImmediate);assert.equal(c.state.rows[0].before.id,'new-line');assert.equal(c.state.message,'');
});
test('proof review fields have readable Korean labels',()=>{
 const UI=require('../admin-approvals.js');assert.equal(UI.valueText({amount_override:0,amount_reference:'Synthetic proof'}),'증빙 금액: 0\n증빙 근거: Synthetic proof');
});
test('retry after a timed-out request completes reuses its receipt instead of duplicating the request',async()=>{
 let finish;const f=client(()=>new Promise(r=>finish=r)),c=A.createController({client:f.api,timeoutMs:10});c.open([line()]);c.state.rows[0].override='80';c.state.rows[0].reference='Proof';
 await c.submit();finish({data:{id:'request-a',status:'pending'}});await new Promise(setImmediate);
 const result=await c.submit();assert.equal(f.calls.length,1);assert.equal(result.id,'request-a');
});
