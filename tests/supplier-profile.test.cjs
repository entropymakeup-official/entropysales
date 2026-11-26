const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {harness}=require('./helpers/approvals.cjs');const A=require('../invoice-amounts.js');
const root=path.join(__dirname,'..');
// Synthetic values only. Real company details live in app_settings.supplier_profile, never in this public repository.
const PROFILE={name:'Demo Supplier',addr:'Demo address',ceo:'Demo CEO',default_contact:'Desk',default_phone:'000-0000-0001',biz_type:'Demo biz',manager_phones:{tester:'000-0000-0002'},stamp_png_base64:'QUJD'};

function fixture(profile){
 const h=harness();Object.assign(h.ctx,{InvoiceAmounts:A,SALES_TYPES:['Paid','FOC'],MGRS:['Tester']});
 h.ctx._invoices[0]={...h.ctx._invoices[0],order_date:'2026-01-02',mgr:'Tester'};
 h.ctx._items=[{id:'item-a',invoice_id:'inv-a',barcode:'SYNTHETIC',name:'Synthetic item',sales_type:'Paid',qty:1,price:10}];
 const printed=[],opened=[];h.ctx.window.open=()=>({document:{write:html=>printed.push(html),close(){}},focus(){},print(){}});
 h.ctx.om=id=>opened.push(id);h.ctx._supplierProfile=profile;
 h.load('fmt','fmtExact','fmtN','parseSupplierProfile','supplierFor','openSupplierProfile','renderSupplierStamp','parseManagerPhones','downloadMeongse');
 return {...h,printed,opened};
}

test('statement prints supplier details, manager phone and stamp from the stored profile',()=>{
 const h=fixture(PROFILE);h.ctx.downloadMeongse(h.ctx._invoices[0]);
 const html=h.printed[0];
 for(const text of ['Demo Supplier','Demo address','Demo CEO','000-0000-0002','Demo biz','data:image/png;base64,QUJD'])assert.ok(html.includes(text),text);
});

test('statement falls back to the default phone for an unknown manager',()=>{
 const h=fixture(PROFILE);h.ctx._invoices[0].mgr='Someone';h.ctx.downloadMeongse(h.ctx._invoices[0]);
 assert.ok(h.printed[0].includes('000-0000-0001'));
});

test('statement is blocked and the profile form opens when no profile is stored',()=>{
 const h=fixture(null);h.ctx.downloadMeongse(h.ctx._invoices[0]);
 assert.equal(h.printed.length,0);assert.deepEqual(h.opened,['m-supplier']);assert.match(h.notices.at(-1),/공급자 정보/);
});

test('profile parser rejects missing name, missing stamp and non-base64 stamp',()=>{
 const h=fixture(null);const parse=h.ctx.parseSupplierProfile;
 assert.equal(parse(JSON.stringify(PROFILE)).name,'Demo Supplier');
 assert.equal(parse(JSON.stringify({...PROFILE,name:''})),null);
 assert.equal(parse(JSON.stringify({...PROFILE,stamp_png_base64:''})),null);
 assert.equal(parse(JSON.stringify({...PROFILE,stamp_png_base64:'"><script>'})),null);
 assert.equal(parse('not json'),null);assert.equal(parse(null),null);
});

test('manager phone lines are parsed case-insensitively and bad lines are rejected',()=>{
 const h=fixture(null);
 assert.deepEqual({...h.ctx.parseManagerPhones('Grace=000-1\n\n raye = 000-2 ')},{grace:'000-1',raye:'000-2'});
 assert.throws(()=>h.ctx.parseManagerPhones('no-equals-sign'),/담당자=번호/);
});

test('public files carry no personal phone numbers or embedded stamp image',()=>{
 for(const file of ['app.js','index.html']){
  const text=fs.readFileSync(path.join(root,file),'utf8');
  assert.doesNotMatch(text,/01[016789]-\d{3,4}-\d{4}/,file+' has a mobile number');
  assert.doesNotMatch(text,/iVBORw0KGgo[A-Za-z0-9+/=]{200,}/,file+' embeds a PNG image');
 }
});

test('approval summary shows the supplier profile as readable text instead of the raw stamp',()=>{
 const Summary=require('../change-summary.js');
 const html=Summary.render([{table:'app_settings',action:'insert',key:{key:'supplier_profile'},values:{key:'supplier_profile',value:JSON.stringify({...PROFILE,stamp_png_base64:'A'.repeat(4096)})}}]);
 assert.match(html,/공급자 정보: Demo Supplier/);assert.match(html,/담당자 연락처 1명\(tester 000-0000-0002\)/);assert.match(html,/직인 이미지 3KB/);
 assert.doesNotMatch(html,/A{100}/);
});
