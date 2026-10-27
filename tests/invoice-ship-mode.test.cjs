const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const A=require('../invoice-amounts.js'),E=require('../request-editor.js'),UI=require('../admin-approvals.js');
const {harness,code,source}=require('./helpers/approvals.cjs');
// Values built inside a vm context come from another realm.
const plain=value=>JSON.parse(JSON.stringify(value));

test('ship mode normalizes Air/Sea spellings, keeps blanks empty and flags anything else',()=>{
 for(const v of ['Air','air',' AIR ','항공','Air Freight','by-air'])assert.equal(A.shipMode(v),'Air',v);
 for(const v of ['Sea','sea','해상','Ocean','sea_freight','선박'])assert.equal(A.shipMode(v),'Sea',v);
 for(const v of ['',' ',null,undefined])assert.equal(A.shipMode(v),null);
 for(const v of ['Truck','택배','Air/Sea',0])assert.equal(A.shipMode(v),undefined,String(v));
 assert.deepEqual(A.SHIP_MODES,['Air','Sea']);assert.equal(A.shipModeLabel('Sea'),'해상');assert.equal(A.shipModeLabel(null),'');
});

test('evidence preview tells apart identical lines by ship mode, mirroring the SQL signature',()=>{
 const base={name:'Twin',barcode:'T',sales_type:'Paid',qty:5,price:4};
 const before=[{...base,id:'a',ship_mode:'Air',amount_override:19.5},{...base,id:'s',ship_mode:'Sea',amount_override:null}];
 assert.deepEqual(A.previewAmounts([{...base,ship_mode:'Air'},{...base,ship_mode:'Sea'}],before),[19.5,20]);
 // Changing the mode of the evidence line no longer matches it, like the SQL guard.
 assert.deepEqual(A.previewAmounts([{...base,ship_mode:'Sea'},{...base,ship_mode:'Sea'}],before),[20,20]);
 assert.match(A.editorWarning(before),/운송 방식/);
});

test('ship mode headers are recognized before the type and ship-date columns, tracking numbers are not',()=>{
 const c={};vm.createContext(c);vm.runInContext(code('isShipModeHeader'),c);
 const kl=k=>k.toLowerCase().replace(/[\s_\-*\n()]/g,'');
 for(const h of ['운송방식','운송 유형','운송','Ship Mode','SHIP_MODE','Shipping Method','항공/해상','Air/Sea'])assert.equal(c.isShipModeHeader(kl(h)),true,h);
 for(const h of ['운송장번호','Tracking No','출고일','Ship Date','Sales Type','유형'])assert.equal(c.isShipModeHeader(kl(h)),false,h);
});

function rawUpload(rows){
 const errors={innerHTML:'',hidden:true};let previews=0;
 const c={window:{},_savingRawUpload:false,_customers:[{name:'Test'}],_products:[],InvoiceAmounts:A,
  document:{getElementById:id=>id==='raw-upload-cust'?{value:'Test'}:id==='raw-upload-errors'?errors:null},
  toast:()=>{},om:()=>{},esc:s=>String(s),
  FileReader:class{readAsBinaryString(){this.onload({target:{result:''}});}},
  XLSX:{read:()=>({Workbook:{WBProps:{date1904:false}},SheetNames:['S'],Sheets:{S:{}}}),utils:{sheet_to_json:()=>rows}}};
 vm.createContext(c);vm.runInContext(source.slice(source.indexOf('function handleRawUpload(input)'),source.indexOf('function discardRawUpload')),c);vm.runInContext(code('isShipModeHeader'),c);
 c._showRawPreviewModal=()=>previews++;c.handleRawUpload({files:[{}]});
 return {groups:c.window._rawUploadData,errors:errors.innerHTML,previews};
}
const rawRow=patch=>({'바코드':'00123','발주일':'2026-10-01','수량':1,'단가':10,...patch});

test('RAW Excel upload reads an optional ship mode column per line',()=>{
 const r=rawUpload([rawRow({'Sales Type':'Paid','운송방식':'Air'}),rawRow({'Sales Type':'Paid','운송방식':'해상'}),rawRow({'Sales Type':'FOC','운송방식':''})]);
 assert.equal(r.previews,1);assert.deepEqual(plain(r.groups[0].items.map(i=>[i.salesType,i.shipMode])),[['Paid','Air'],['Paid','Sea'],['FOC',null]]);
 const without=rawUpload([rawRow()]);assert.equal(without.previews,1);assert.equal(without.groups[0].items[0].shipMode,null);
 // '운송유형' must not be taken as the sales type column.
 const typed=rawUpload([rawRow({'유형':'FOC','운송유형':'Sea'})]);assert.deepEqual([typed.groups[0].items[0].salesType,typed.groups[0].items[0].shipMode],['FOC','Sea']);
});

test('RAW Excel upload blocks the file on an unknown ship mode and names the row',()=>{
 const r=rawUpload([rawRow({'운송방식':'Air'}),rawRow({'운송방식':'Truck'})]);
 assert.equal(r.previews,0);assert.equal(r.groups,undefined);assert.match(r.errors,/3행[^<]*운송방식/);
});

function invoiceUpload(rows){
 let error='',previewed=null;
 const c={InvoiceAmounts:A,today:()=>'2026-10-27',_uploadData:null,
  showUploadError:m=>{error=m;},showPreview:d=>{previewed=d;},
  FileReader:class{readAsBinaryString(){this.onload({target:{result:''}});}},
  XLSX:{read:()=>({SheetNames:['업로드'],Sheets:{'업로드':{}}}),utils:{sheet_to_json:()=>rows}}};
 vm.createContext(c);vm.runInContext(code('processFile')+'\n'+code('isShipModeHeader'),c);c.processFile({});
 return {error,previewed};
}

test('invoice Excel upload reads Ship Mode, leaves it blank when absent and rejects unknown values',()=>{
 const row=patch=>({Customer:'A',Invoice:'INV-1','제품명':'Twin',Qty:5,Price:4,...patch});
 const r=invoiceUpload([row({'Ship Mode':'air'}),row({'Ship Mode':'Sea'})]);
 assert.equal(r.error,'');assert.deepEqual(plain(r.previewed[0].items.map(i=>i.shipMode)),['Air','Sea']);
 assert.equal(invoiceUpload([row()]).previewed[0].items[0].shipMode,null);
 const bad=invoiceUpload([row({'Ship Mode':'Air'}),row({'Ship Mode':'Rail'})]);
 assert.equal(bad.previewed,null);assert.match(bad.error,/3행/);
});

test('invoice upload, RAW upload and the invoice form all submit ship_mode on every line',async()=>{
 const h=harness();h.load('confirmUpload','genInvNo','confirmRawUpload','renderRawUploadStatus');
 Object.assign(h.ctx,{go(){},cancelUpload(){},_showRawPreviewModal(){}});
 h.ctx._uploadData=[{customer:'Demo',invNo:'UP-1',orderDate:'2026-10-01',items:[{name:'Twin',barcode:'T',st:'Paid',qty:1,price:2,shipMode:'Air'},{name:'Twin',barcode:'T',st:'Paid',qty:1,price:2,shipMode:null}]}];
 await h.ctx.confirmUpload();
 assert.deepEqual(h.calls[0].args.p_operations[0].items.map(i=>i.ship_mode),['Air',null]);
 h.ctx.window._rawUploadData=[{customer:'Demo',orderDate:'2026-10-01',items:[{name:'N',barcode:'1',qty:1,price:3,salesType:'Paid',shipMode:'Sea'}]}];
 await h.ctx.confirmRawUpload();
 assert.deepEqual(h.calls[1].args.p_operations[0].items.map(i=>i.ship_mode),['Sea']);

 const f=harness();f.load('saveInv');
 for(const [id,value]of Object.entries({'inv-no':'NEW-1','inv-cust-ro':'Demo','inv-status':'Ordered','inv-ship':'준비중'}))f.element(id).value=value;
 const row=(mode)=>{const inputs=['Twin','T','5','4'].map(value=>({value}));return {querySelectorAll:()=>inputs,querySelector:s=>s==='select'?{value:'Paid'}:s==='.inv-ship-mode'?{value:mode}:null};};
 f.ctx.document.querySelectorAll=s=>s==='#inv-items tr'?[row('Air'),row('')]:[];
 await f.ctx.saveInv();
 assert.deepEqual(f.calls[0].args.p_operations[0].items.map(i=>i.ship_mode),['Air',null]);
});

test('invoice detail, list and RAW table show the line ship mode',()=>{
 const h=harness();h.load('viewInv','filterInv','renderRaw','filterRaw','fmt','fmtN','stBadge','itemsByType','statusBadge','shipBadge');
 Object.assign(h.ctx,{loadInvDocs(){},renderDriveDocs(){},loadDriveDocs(){},_invFileCache:{},_invoiceStatusPending:new Set(),invoicePaymentMarkup:()=>'',MGRS:[],SALES_TYPES:['Paid'],invoiceAmounts:{open(){}},updateInvFileIcon(){},loadInvFileIcons(){}});h.ctx.invoiceSheetStatus={refresh(){}};h.ctx._rawPage=1;
 h.ctx._items=[{id:'1',invoice_id:'inv-a',name:'Twin',qty:1,price:2,sales_type:'Paid',ship_mode:'Air'},{id:'2',invoice_id:'inv-a',name:'Twin',qty:1,price:2,sales_type:'Paid',ship_mode:'Sea'},{id:'3',invoice_id:'inv-a',name:'Other',qty:1,price:2,sales_type:'Paid',ship_mode:null}];
 h.ctx.viewInv('inv-a');
 const detail=h.element('view-inv-items').innerHTML;assert.match(detail,/항공/);assert.match(detail,/해상/);assert.equal((detail.match(/<tr>/g)||[]).length,3);
 h.ctx.window._inv_filtered=null;h.element('inv-tbody');h.ctx.filterInv();
 assert.match(h.element('inv-tbody').innerHTML,/OLD<\/span> <span class="badge bg-blue">항공<\/span><span class="badge bg-teal">해상<\/span>/);
 h.ctx.renderRaw();assert.deepEqual(plain(h.ctx.window._rr.map(r=>r.shipMode)),['Air','Sea',null]);
 h.ctx.filterRaw();assert.match(h.element('raw-tbody').innerHTML,/항공[\s\S]*해상/);
});

test('request editor offers a blank/Air/Sea choice per line and stores blank as null',()=>{
 const draft={id:'r',revision:1,reason:'x',operations:[{action:'invoice',id:'i',before:{invoice:{no:'I'},items:[]},invoice:{no:'I'},items:[{name:'Twin',qty:1,price:2,sales_type:'Paid',ship_mode:'Air'}]}]};
 const field=E.fields(draft).find(f=>f.key==='ship_mode');
 assert.ok(field);assert.deepEqual(field.path,['operations',0,'items',0,'ship_mode']);
 E.assign(draft,field,'');assert.equal(draft.operations[0].items[0].ship_mode,null);
 E.assign(draft,field,'Sea');assert.equal(draft.operations[0].items[0].ship_mode,'Sea');
 const inv={id:'i',no:'I',status:'Ordered',ship_status:'준비중'};
 const req={id:'r',revision:1,reason:'x',operations:[{table:'invoices',action:'update',key:{id:'i'},before:inv,values:{status:'Paid'}}]};
 const items=[{id:'line',name:'Twin',barcode:'T',qty:1,price:2,sales_type:'Paid',ship_mode:'Sea',invoice_id:'i'}];
 assert.deepEqual(E.prepareInvoice(inv,[req],items).operations[0].items,[{name:'Twin',barcode:'T',qty:1,price:2,sales_type:'Paid',ship_mode:'Sea'}]);
});

test('request editor renders ship mode as a labelled select, including for requests saved before the field',async()=>{
 const html=[];const dialog={className:'',innerHTML:'',setAttribute(){},addEventListener(){},showModal(){},close(){},remove(){},querySelector:()=>({focus(){},onclick:null,onsubmit:null,value:''}),querySelectorAll:()=>[]};
 Object.defineProperty(dialog,'innerHTML',{set:v=>html.push(v),get:()=>html.at(-1)||''});
 const document={createElement:()=>dialog,body:{appendChild(){}},activeElement:null};
 const request={id:'r',revision:1,reason:'x',operations:[{action:'invoice',id:'i',before:{invoice:{no:'I'},items:[]},invoice:{no:'I'},items:[{name:'Twin',qty:1,price:2,sales_type:'Paid'}]}]};
 await E.open({document,request,client:{},submit:async()=>null});
 assert.match(html.at(-1),/운송 방식<select[^>]*><option value=""[^>]* selected>미지정<\/option><option value="Air">항공 \(Air\)<\/option><option value="Sea">해상 \(Sea\)<\/option>/);
 assert.equal('ship_mode' in request.operations[0].items[0],false);
});

test('approval diff labels ship mode and marks a changed line',()=>{
 const op={action:'invoice',id:'i',before:{invoice:{no:'I'},items:[{id:'1',name:'Twin',qty:1,price:2,sales_type:'Paid',ship_mode:null}]},invoice:{no:'I'},items:[{name:'Twin',qty:1,price:2,sales_type:'Paid',ship_mode:'Air'}]};
 const html=UI.renderDiff(op);
 assert.match(html,/운송 방식: —/);assert.match(html,/운송 방식: Air/);assert.match(html,/class="changed"[^>]*><th scope="row">품목/);
 assert.doesNotMatch(html,/기타 항목 \(ship_mode\)/);
});
