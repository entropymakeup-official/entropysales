const {test}=require('node:test');
const assert=require('node:assert/strict');
const Summary=require('../change-summary.js');
const Admin=require('../admin-approvals.js');

const text=html=>html.replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/\s+/g,' ').trim();
const header={no:'INV-1',customer:'Synthetic',mgr:'M',order_date:'2026-10-01',pay_date:null,ship_date:null,status:'Ordered',ship_status:'준비중',foc:0,note:''};
const line=(over={})=>({id:'i1',invoice_id:'inv',name:'Lip',barcode:'880',sales_type:'Paid',qty:'2',price:'10',ship_mode:null,amount_override:null,...over});

test('update shows only the fields whose value changes, with before and after',()=>{
  const html=Summary.render([{table:'invoices',action:'update',key:{id:'inv'},before:{id:'inv',...header,note:'old'},values:{note:'new memo',status:'Ordered'}}]);
  const t=text(html);
  assert.match(t,/인보이스 수정 · INV-1/);
  assert.match(t,/비고\(메모\) old → new memo/);
  assert.doesNotMatch(t,/상태/);
});

test('update with no effective change says so',()=>{
  assert.match(text(Summary.render([{table:'invoice_items',action:'update',key:{id:'i1'},before:line(),values:{qty:2}}])),/실제로 바뀌는 값이 없습니다/);
});

test('new invoice lists the header and every item line',()=>{
  const t=text(Summary.render([{action:'invoice',id:null,before:null,auto_number:true,invoice:{...header,note:'샘플 교체'},items:[{name:'Lip',barcode:'880',sales_type:'Paid',qty:2,price:10,ship_mode:'Air'},{name:'Gift',barcode:'',sales_type:'FOC',qty:1,price:0,ship_mode:null}]}]));
  assert.match(t,/신규 인보이스 · INV-1/);
  assert.match(t,/승인 시 확정/);
  assert.match(t,/비고\(메모\) 샘플 교체/);
  assert.match(t,/품목 2개/);
  assert.match(t,/1 Lip 880 Paid Air 2 10/);
  assert.match(t,/2 Gift \(빈칸\) FOC \(빈칸\) 1 0/);
});

test('invoice edit shows header changes and pairs item lines into 수정/추가/삭제',()=>{
  const before={invoice:{id:'inv',...header},items:[line(),line({id:'i2',name:'Brow',barcode:'881',qty:'1'}),line({id:'i3',name:'Old',barcode:'882'})]};
  const items=[{name:'Lip',barcode:'880',sales_type:'Paid',qty:5,price:10,ship_mode:null},{name:'Brow',barcode:'881',sales_type:'Paid',qty:1,price:10,ship_mode:null},{name:'New',barcode:'883',sales_type:'FOC',qty:3,price:0,ship_mode:'Sea'}];
  const t=text(Summary.render([{action:'invoice',id:'inv',before,invoice:{...header,ship_date:'2026-10-05'},items}]));
  assert.match(t,/출고일 \(빈칸\) → 2026-10-05/);
  assert.match(t,/변경 전 3개 → 변경 후 3개/);
  assert.match(t,/수정 Lip · 880 수량 2 → 5/);
  assert.match(t,/추가 New · 883/);
  assert.match(t,/삭제 Old · 882/);
  assert.doesNotMatch(t,/Brow · 881/,'unchanged line (numeric string vs number) is not listed');
});

test('delete names the target and the children removed with it',()=>{
  const t=text(Summary.render([{table:'invoices',action:'delete',key:{id:'inv'},before:{id:'inv',...header},before_items:[line(),line()],before_drive_documents:[]}]));
  assert.match(t,/인보이스 삭제 · INV-1 · Synthetic · 2026-10-01/);
  assert.match(t,/품목 2개 · Drive 증빙 연결 0개/);
});

test('reference links render the invoice number, values are escaped',()=>{
  const html=Summary.render([{table:'invoices',action:'update',key:{id:'inv'},before:{id:'inv',...header,ref_invoice_id:null,ref_kind:null},values:{ref_invoice_id:'other',ref_kind:'재출고',note:'<img src=x>'}}],{invoiceNo:id=>id==='other'?'INV-0':undefined});
  assert.match(text(html),/참고 인보이스 \(빈칸\) → INV-0/);
  assert.match(text(html),/참고 유형 \(빈칸\) → 재출고/);
  assert.doesNotMatch(html,/<img/);
});

test('admin request card shows the change summary above the full diff',()=>{
  const html=Admin.render({isAdmin:true,invoiceNos:{other:'INV-0'},requests:[{id:'r1',status:'pending',reason:'링크',operations:[{table:'invoices',action:'update',key:{id:'inv'},before:{id:'inv',...header},values:{ref_invoice_id:'other',ref_kind:'정정'}}]}]});
  assert.ok(html.indexOf('변경 내역')<html.indexOf('변경 전후 상세 확인'));
  assert.match(text(html),/참고 인보이스 \(빈칸\) → INV-0/);
});
