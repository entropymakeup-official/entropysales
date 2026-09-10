const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
const row=(patch={},index=1)=>Object.defineProperty({'바코드':'00123','발주일':'2026-09-10','수량':2,'단가':12.5,'유형':'Paid',...patch},'__rowNum__',{value:index});
function setup(rows,{customer={name:'Test'},products=[]}={}){
 const messages=[],opened=[];let previews=0;
 const nodes={'raw-upload-cust':{value:'Test'},'raw-upload-errors':{innerHTML:'',hidden:true}};
 const c={window:{},_savingRawUpload:false,_customers:[customer],_products:products,
  document:{getElementById:id=>nodes[id]||null},toast:m=>messages.push(m),om:m=>opened.push(m),
  esc:s=>String(s??'').replace(/[&<>"']/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x])),
  FileReader:class{readAsBinaryString(){this.onload({target:{result:'fake workbook bytes'}});}},
  XLSX:{read:()=>({SheetNames:['Sheet1'],Sheets:{Sheet1:{}}}),utils:{sheet_to_json:()=>rows}}
 };
 vm.createContext(c);vm.runInContext(source.slice(source.indexOf('function handleRawUpload(input)'),source.indexOf('function discardRawUpload')),c);
 c._showRawPreviewModal=()=>{previews++;};
 return {c,nodes,messages,opened,run:()=>c.handleRawUpload({files:[{}],value:'file'}),previews:()=>previews};
}
test('Excel quantities and prices preserve grouped thousands, decimals, zero and signed numbers',()=>{
 const s=setup([row({'수량':'1,000.5','단가':'₩1,234.50'}),row({'수량':0,'단가':0}),row({'수량':'-2.5','단가':'12.5'})]);s.run();
 const items=s.c.window._rawUploadData.flatMap(g=>g.items);
 assert.deepEqual(Array.from(items,i=>[i.qty,i.price]),[[1000.5,1234.5],[0,0],[-2.5,12.5]]);
 assert.equal(items[0].barcode,'00123');assert.equal(s.previews(),1);
});
test('a populated row without a barcode blocks the whole file and reports its actual worksheet row',()=>{
 const s=setup([row(),row({'바코드':''},7)]);s.run();
 assert.ok(!s.c.window._rawUploadData);assert.equal(s.previews(),0);
 assert.match(s.nodes['raw-upload-errors'].innerHTML,/8행/);assert.match(s.nodes['raw-upload-errors'].innerHTML,/바코드/);
});
test('invalid or blank quantity never becomes zero or a truncated number',()=>{
 for(const value of ['oops','12개','1,00','',true,Infinity]){
  const s=setup([row({'수량':value})]);s.run();
  assert.ok(!s.c.window._rawUploadData,`quantity ${value} must block`);
  assert.match(s.nodes['raw-upload-errors'].innerHTML,/수량/);
 }
});
test('invalid prices and missing prices without a calculated supply price block preview',()=>{
 for(const value of ['12oops','1,00','',false,NaN]){
  const s=setup([row({'단가':value})]);s.run();
  assert.ok(!s.c.window._rawUploadData,`price ${value} must block`);
  assert.match(s.nodes['raw-upload-errors'].innerHTML,/단가/);
 }
});
test('missing and ambiguous required columns cannot silently become empty imports',()=>{
 for(const missing of ['바코드','수량']){const r=row();delete r[missing];const s=setup([r]);s.run();assert.equal(s.previews(),0);assert.match(s.nodes['raw-upload-errors'].innerHTML,new RegExp(missing));}
 const s=setup([row({'수량':100,'Qty':1})]);s.run();assert.equal(s.previews(),0);assert.match(s.nodes['raw-upload-errors'].innerHTML,/중복/);
});
test('blank worksheet rows are ignored but unsafe numeric barcodes are rejected',()=>{
 const blank=row({'바코드':'','발주일':'','수량':'','단가':'','유형':''},3);
 const s=setup([row(),blank]);s.run();assert.equal(s.c.window._rawUploadData[0].items.length,1);
 const bad=setup([row({'바코드':9007199254740992})]);bad.run();assert.equal(bad.previews(),0);assert.match(bad.nodes['raw-upload-errors'].innerHTML,/바코드/);
});
test('supply rate calculation stays in effect and permits a blank source price',()=>{
 const s=setup([row({'단가':''})],{customer:{name:'Test',supply_rate:30},products:[{barcode:'00123',name:'Product',price:100}]});s.run();
 assert.equal(s.c.window._rawUploadData[0].items[0].price,30);
 const bad=setup([row({'단가':'12oops'})],{customer:{name:'Test',supply_rate:30},products:[{barcode:'00123',name:'Product',price:100}]});bad.run();assert.equal(bad.previews(),0);
});
test('multiple errors remain visible and a corrected file clears them before preview',()=>{
 const rows=[row({'바코드':''},5),row({'수량':'x'},10)];const s=setup(rows);s.run();
 assert.match(s.nodes['raw-upload-errors'].innerHTML,/6행/);assert.match(s.nodes['raw-upload-errors'].innerHTML,/11행/);
 rows.splice(0,rows.length,row());s.run();assert.equal(s.previews(),1);assert.equal(s.nodes['raw-upload-errors'].hidden,true);
});

test('CSV automatic numeric inference cannot bypass validation or remove barcode zeros',()=>{
 const s=setup([]);let converted;
 s.c.XLSX.read=(_bytes,options)=>{converted=options.raw?[row({'수량':'1,00','바코드':'00123'})]:[row({'수량':100,'바코드':123})];return {SheetNames:['Sheet1'],Sheets:{Sheet1:{}}};};
 s.c.XLSX.utils.sheet_to_json=()=>converted;s.run();
 assert.equal(s.previews(),0);assert.match(s.nodes['raw-upload-errors'].innerHTML,/수량/);
});
test('Excel formula errors cannot become optional blank prices or disappear as empty rows',()=>{
 for(const rows of [[row({'단가':''})],[]]){
  const s=setup(rows,{customer:{name:'Test',supply_rate:30},products:[{barcode:'00123',price:100}]});
  s.c.XLSX.read=()=>({SheetNames:['Sheet1'],Sheets:{Sheet1:{C3:{t:'e',v:7},'!ref':'A1:C3'}}});s.run();
  assert.equal(s.previews(),0);assert.match(s.nodes['raw-upload-errors'].innerHTML,/3행/);assert.match(s.nodes['raw-upload-errors'].innerHTML,/C3/);
 }
});
