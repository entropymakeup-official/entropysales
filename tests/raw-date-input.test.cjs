const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
const row=(date,patch={})=>({'바코드':'00123','발주일':date,'수량':1,'단가':10,...patch});
function upload(rows,date1904=false){
 const errors={innerHTML:'',hidden:true};let previews=0;
 const c={window:{},_savingRawUpload:false,_customers:[{name:'Test'}],_products:[],
  document:{getElementById:id=>id==='raw-upload-cust'?{value:'Test'}:id==='raw-upload-errors'?errors:null},
  toast:()=>{},om:()=>{},esc:s=>String(s),
  FileReader:class{readAsBinaryString(){this.onload({target:{result:''}});}},
  XLSX:{read:()=>({Workbook:{WBProps:{date1904}},SheetNames:['S'],Sheets:{S:{}}}),utils:{sheet_to_json:()=>rows}}
 };
 vm.createContext(c);vm.runInContext(source.slice(source.indexOf('function handleRawUpload(input)'),source.indexOf('function discardRawUpload')),c);
 c._showRawPreviewModal=()=>previews++;c.handleRawUpload({files:[{}]});
 return {groups:c.window._rawUploadData,errors:errors.innerHTML,previews};
}

test('Excel numeric dates and explicit year-first text group into one canonical order',()=>{
 const r=upload([46276,'2026-9-11','2026/09/11','2026.9.11','20260911',20260911,'2026년 9월 11일'].map(d=>row(d)));
 assert.equal(r.previews,1);assert.equal(r.groups.length,1);
 assert.equal(r.groups[0].orderDate,'2026-09-11');assert.equal(r.groups[0].items.length,7);
});

test('Excel 1904 workbook epoch includes serial zero and preserves calendar date with time',()=>{
 const r=upload([row(0),row(44814.75)],true);
 assert.equal(r.previews,1);assert.deepEqual(Array.from(r.groups,g=>g.orderDate),['1904-01-01','2026-09-11']);
});

test('Excel 1900 epoch handles leap-year boundary and discards only time of day',()=>{
 const r=upload([row(1),row(59.5),row(61),row(46276.99999)]);
 assert.equal(r.previews,1);assert.deepEqual(Array.from(r.groups,g=>g.orderDate),['1900-01-01','1900-02-28','1900-03-01','2026-09-11']);
 for(const date of [0,60,60.75,-1,Infinity,2958466])assert.equal(upload([row(date)]).previews,0,String(date));
});

test('missing order date column or value blocks upload instead of defaulting to today',()=>{
 const missing=row('2026-09-11');delete missing['발주일'];
 for(const rows of [[missing],[row('')],[row(null)]]){
  const r=upload(rows);assert.equal(r.previews,0);assert.match(r.errors,/발주일/);
 }
});

test('invalid and ambiguous dates are rejected with the source row and field',()=>{
 for(const date of ['2026-02-29','2026-04-31','1900-02-29','09/11/2026','26-09-11','2026-13-01','2026-00-10','0000-01-01','2026-09-11T23:00:00Z','46276',true]){
  const bad=Object.defineProperty(row(date),'__rowNum__',{value:7});const r=upload([row('2026-09-11'),bad]);
  assert.equal(r.previews,0,String(date));assert.match(r.errors,/8행/);assert.match(r.errors,/발주일/);
 }
 const leap=upload([row('2024-02-29'),row('2000-02-29')]);assert.equal(leap.previews,1);
});

test('optional dates are normalized, and blanks can be filled by another row in the order',()=>{
 const r=upload([row('2026-9-11',{'입금일':'','출고일':46277}),row(46276,{'입금일':'2026/9/13','출고일':''}),row('20260911',{'입금일':46278,'출고일':'2026.09.12'})]);
 assert.equal(r.previews,1);assert.equal(r.groups.length,1);
 assert.equal(r.groups[0].payDate,'2026-09-13');assert.equal(r.groups[0].shipDate,'2026-09-12');
});

test('every optional date is validated even on later rows of an existing order',()=>{
 for(const field of ['입금일','출고일']){
  const r=upload([row('2026-09-11',{[field]:''}),row('2026-09-11',{[field]:'2026-02-30'})]);
  assert.equal(r.previews,0);assert.match(r.errors,/3행/);assert.match(r.errors,new RegExp(field));
 }
});

test('conflicting nonblank payment or shipment dates never silently use the first row',()=>{
 for(const field of ['입금일','출고일']){
  const r=upload([row('2026-09-11',{[field]:'2026-09-12'}),row('2026-9-11',{[field]:'2026-09-13'})]);
  assert.equal(r.previews,0);assert.match(r.errors,/3행/);assert.match(r.errors,new RegExp(field));assert.match(r.errors,/다릅니다/);
 }
});
