const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {harness}=require('./helpers/approvals.cjs');

function select(values){
 const options=values.map(v=>({value:v,textContent:v}));
 const el={options,_value:values[0]||'',appendChild(o){options.push(o);},
  get value(){return this._value;},set value(v){this._value=options.some(o=>o.value===v)?v:'';}};
 return el;
}

test('editing a customer keeps a manager that is not in the dropdown and multi-line notes',async()=>{
 const h=harness();h.ctx.CustomerPrices=require('../customer-prices.js');h.ctx._customerRetailPrices=[];
 h.ctx.document.createElement=()=>({});
 h.elements['c-mgr']=select(['liah','Grace']);
 h.load('setCustMgr','editCust','saveCust','renderCustRetailEditor','custRetailChanges');
 const note='첫 줄\n둘째 줄';
 const cust={id:'cr',name:'코마렉스',code:'CR',mgr:'정담당',country:'Myanmar',tax:'영세',biz:'',addr:'',ceo:'',contact:'',phone:'',email:'',biz_type:'',note,status:'거래중',supply_rate:35};
 h.ctx._customers=[cust];
 h.ctx.editCust('cr');
 assert.equal(h.elements['c-mgr'].value,'정담당');
 h.elements['c-supply-rate'].value='40';
 await h.ctx.saveCust();
 const op=h.calls[0].args.p_operations[0];
 assert.equal(op.values.mgr,'정담당');assert.equal(op.values.note,note);assert.equal(op.values.supply_rate,40);
});

test('customer form offers 이상윤 and uses a textarea for notes',()=>{
 const html=fs.readFileSync(require('node:path').join(__dirname,'../index.html'),'utf8');
 assert.match(html,/<select id="c-mgr"><option>이상윤<\/option>/);
 assert.match(html,/<textarea id="c-note"/);
});
