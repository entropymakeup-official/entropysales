const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const file=require('node:path').join(__dirname,'../product-master.js');
const row=(name,code,type='완제품')=>{const a=Array(52).fill(null);a[0]=name;a[10]=code;a[11]=type;return a;};
function fixture(){const a=row('립 제품','FG-1');a[1]='판매중';a[4]='브랜드 A';a[5]='립';a[7]=0;a[30]='001234';const b=row('아이 제품','FG-2');b[1]='발주 전';b[4]='브랜드 B';const c=row('용기',null,'구성품');c[26]='공급사';c[28]='010-0012-3456';return {headers:Array.from({length:52},(_,i)=>'항목'+i),products:[{row:7,values:a,components:[{row:8,values:c}]},{row:9,values:b,components:[]}],source_date:'2026-09-28',source_name:'마스터.xlsx'};}
test('master searches component contacts and leading-zero barcodes, combines filters without dropping siblings',()=>{
 assert.ok(fs.existsSync(file),'read-only master module must exist');const m=require(file),s=fixture();
 assert.equal(m.filterProducts(s,{q:'001234'}).length,1);
 assert.equal(m.filterProducts(s,{q:'010-0012'}).length,1);
 assert.equal(m.filterProducts(s,{q:'공급사',brand:'브랜드 B'}).length,0);
 assert.equal(m.filterProducts(s,{status:'판매중',family:'립'}).length,1);
 assert.equal(m.filterProducts(s,{q:'없는상품'}).length,0);
 assert.equal(s.products.length,2);assert.equal(m.display(0),'0');assert.equal(m.display(null),'—');
});
test('detail displays every source column, escapes workbook text, and preserves blank values',()=>{
 assert.ok(fs.existsSync(file),'read-only master module must exist');const m=require(file),s=fixture();s.products[0].values[51]='<img src=x onerror=alert(1)>';
 const html=m.renderFields(s.headers,s.products[0].values);
 assert.match(html,/&lt;img/);assert.doesNotMatch(html,/<img/);assert.match(html,/항목51/);assert.match(html,/001234/);assert.match(html,/—/);
});
test('navigation or logout during load cancels stale master data and leaves no cached snapshot',async()=>{
 assert.ok(fs.existsSync(file),'read-only master module must exist');const m=require(file);let resolve;
 const c=m.createController(()=>new Promise(r=>{resolve=r;}));const pending=c.load();c.clear();resolve(fixture());await pending;
 assert.equal(c.state.snapshot,null);assert.equal(c.state.loading,false);
});
test('failed load clears previous data and can be retried',async()=>{
 assert.ok(fs.existsSync(file),'read-only master module must exist');const m=require(file);let fail=false;
 const c=m.createController(async()=>{if(fail)throw Error('denied');return fixture();});await c.load();assert.ok(c.state.snapshot);fail=true;await c.load();assert.equal(c.state.snapshot,null);assert.ok(c.state.error);fail=false;await c.load();assert.ok(c.state.snapshot);
});
