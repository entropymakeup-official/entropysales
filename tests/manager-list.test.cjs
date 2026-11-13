const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {code,source}=require('./helpers/approvals.cjs');
const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');

test('이상윤 is a selectable manager with their own phone on 거래명세서',()=>{
 assert.match(source,/const MGRS = \[[^\]]*'이상윤'[^\]]*\];/);
 assert.match(source,/'이상윤':'010-4089-9090'/);
 const select=html.match(/<select id="c-mgr">([\s\S]*?)<\/select>/)[1];
 assert.match(select,/<option>이상윤<\/option>/);
});

function selectCtx(values){
 const options=values.map(v=>({value:v,textContent:v}));
 const el={value:values[0],options,appendChild(o){o.value=o.textContent;options.push(o);}};
 const ctx={document:{getElementById:id=>id==='c-mgr'?el:null,createElement:()=>({})}};
 vm.createContext(ctx);vm.runInContext(code('setMgrSelect'),ctx);
 return {ctx,el,options};
}

test('customer edit keeps a manager missing from the select instead of dropping it',()=>{
 const {ctx,el,options}=selectCtx(['liah','Grace']);
 ctx.setMgrSelect('Grace');assert.equal(el.value,'Grace');assert.equal(options.length,2);
 ctx.setMgrSelect('New Person');assert.equal(el.value,'New Person');assert.equal(options.length,3);
 ctx.setMgrSelect('New Person');assert.equal(options.length,3);
 ctx.setMgrSelect('');assert.equal(el.value,'liah');
});
