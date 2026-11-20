const {test}=require('node:test');const assert=require('node:assert/strict');const path=require('node:path');
const XLSX=require('xlsx');
const F=require('../fassto-forms.js');
const FIX={overseas:'파스토제공-해외택배신청_양식.xlsx',parcel:'파스토제공-택배신청_양식.xlsx',vehicle:'파스토제공-차량배송신청(상품)_양식.xlsx'};
const fixture=form=>XLSX.readFile(path.join(__dirname,'fixtures/fassto',FIX[form]));
const grid=wb=>XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{header:1,defval:'',raw:true});
const roundTrip=wb=>XLSX.read(XLSX.write(wb,{type:'buffer',bookType:'xlsx'}),{type:'buffer'});
const req={fassto_order_no:'LG20261120_003'};
const items=[{product_code:'0012345',product_name_text:'가짜 립',qty:3,lot_text:'',expires_on:null,unit_price:12.5,weight_kg:null,en_name_text:'Fake Lip'},
 {product_code:'0099',product_name_text:'가짜 크림',qty:2,lot_text:'L2',expires_on:'2028-06-30',unit_price:7,weight_kg:0.2,en_name_text:''}];
const parcelTo={name_text:'홍길동',phone_text:'010-0000-0000',postal_text:'01234',address1_text:'가짜시 가짜로 1',address2_text:'101동 1호'};
const overseasTo={name_text:'Fake Buyer',phone_text:'+41-00-000-0000',postal_text:'08001',country_code:'CH',state_text:'ZH',city_text:'Zurich',district_text:'',
 address1_text:'Fakestrasse 1',email_text:'buyer@example.com',tax_id_text:'',currency_code:'USD',courier_text:'FEDEX',incoterms_code:'DAP'};

test('운송 방식으로 양식을 정한다',()=>{
 assert.deepEqual(['parcel','express','direct','air','ocean','quick','etc'].map(F.formFor),['parcel','overseas','vehicle','vehicle','vehicle',null,null]);
 assert.equal(F.formHint('parcel'),'파스토 택배신청 양식으로 만들어요.');
 assert.equal(F.formHint(null),'이 운송 방식은 파스토 양식 없이 처리해요.');
});

for(const form of ['overseas','parcel','vehicle']){
 test(`${form}: 1~4행·열 수·시트 이름이 파스토 원본과 같다`,()=>{
  const orig=fixture(form),want=grid(orig).slice(0,4);
  const to=form==='overseas'?overseasTo:form==='parcel'?parcelTo:null;
  const wb=roundTrip(F.toWorkbook(form,F.buildRows(form,req,to,items),XLSX));
  assert.deepEqual(wb.SheetNames,orig.SheetNames);
  assert.equal(F.FORMS[form].sheet,orig.SheetNames[0]);
  const got=grid(wb);
  assert.deepEqual(got.slice(0,4).map(r=>r.map(String)),want.map(r=>r.map(String)));
  assert.equal(F.FORMS[form].head[0].length,want[0].length);
  assert.equal(got[4].length,want[0].length);
  assert.equal(got.length,6); // 1~4행 + 품목 2줄
 });
}

test('5행부터: 상품코드는 앞자리 0을 지킨 문자 셀, 모든 줄이 같은 주문번호',()=>{
 const cell=(wb,ref)=>wb.Sheets[wb.SheetNames[0]][ref];
 const p=roundTrip(F.toWorkbook('parcel',F.buildRows('parcel',req,parcelTo,items),XLSX));
 assert.deepEqual([cell(p,'I5').t,cell(p,'I5').v],['s','0012345']);
 assert.deepEqual([cell(p,'B5').v,cell(p,'B6').v],['LG20261120_003','LG20261120_003']);
 assert.deepEqual([cell(p,'D5').t,cell(p,'D5').v],['s','01234']);
 assert.deepEqual([cell(p,'J5').t,cell(p,'J5').v],['n',3]);
 assert.equal(cell(p,'R5'),undefined); // 로트를 안 고르면 유통기한 비움
 assert.equal(cell(p,'R6').v,'2028-06-30');
 const v=roundTrip(F.toWorkbook('vehicle',F.buildRows('vehicle',req,null,items),XLSX));
 assert.deepEqual([cell(v,'A5').t,cell(v,'A5').v,cell(v,'C5').v,cell(v,'G5').v,cell(v,'G6').v],['s','0012345','LG20261120_003','차량','차량']);
});

test('해외: 열 위치, 무게 기본 1, 브랜드 ENTROPY, 발송인 기본값과 담당자 덮어쓰기',()=>{
 const rows=F.buildRows('overseas',req,overseasTo,items);
 assert.equal(rows[0].length,28);
 const [a]=rows;
 assert.deepEqual([a[0],a[1],a[2],a[3],a[5],a[6]],['CH','FEDEX','LG20261120_003',F.SENDER.name_text,F.SENDER.phone_text,F.SENDER.address_text]);
 assert.deepEqual([a[7],a[9],a[10],a[11],a[13],a[15],a[16],a[17]],['Fake Buyer','08001','ZH','Zurich','Fakestrasse 1',3,'USD','0012345']);
 assert.deepEqual([a[18],a[20],a[21],a[22],a[25],a[26],a[27]],['Fake Lip',1,12.5,'ENTROPY','DAP','sylee@entropymakeup.com','buyer@example.com']);
 assert.equal(rows[1][20],0.2);
 const own=F.buildRows('overseas',req,{...overseasTo,sender_name_text:'Other Sender',sender_email_text:'x@entropymakeup.com'},items)[0];
 assert.deepEqual([own[3],own[26],own[5]],['Other Sender','x@entropymakeup.com',F.SENDER.phone_text]);
 assert.equal(F.fileName('overseas',req),'파스토_해외택배신청_LG20261120_003.xlsx');
 assert.equal(F.fileName('vehicle',req),'파스토_차량배송신청(상품)_LG20261120_003.xlsx');
});

test('검사: 양식별 필수 칸, 금지 문자, 주문번호, FEDEX 이메일',()=>{
 assert.deepEqual(F.validate('parcel',req,parcelTo,items),[]);
 assert.deepEqual(F.validate('vehicle',req,null,items),[]);
 assert.deepEqual(F.validate('overseas',req,overseasTo,items),[]);
 assert.deepEqual(F.validate(null,req,null,items),['이 운송 방식은 파스토 양식이 없어요.']);
 const p=F.validate('parcel',{fassto_order_no:'LG 1'},{...parcelTo,name_text:'홍길동#',phone_text:''},[]);
 assert.ok(p.includes('주문번호에는 영문·숫자와 - _만 쓸 수 있어요.'));
 assert.ok(p.includes('품목을 1줄 이상 넣어 주세요.'));
 assert.ok(p.includes('받는 곳: 전화 칸이 비어 있어요.'));
 assert.ok(p.includes('받는 곳: 받는 분에는 ( ) , - _ 말고 다른 특수문자를 쓸 수 없어요.'));
 assert.deepEqual(F.validate('parcel',req,{...parcelTo,name_text:'홍길동(본사)_1, 2-3'},items),[]);
 assert.ok(F.validate('vehicle',{},null,[{product_code:'',qty:0}]).includes('주문번호가 아직 없어요. 새로고침한 뒤 다시 해 주세요.'));
 assert.ok(F.validate('vehicle',req,null,[{product_code:'',qty:0}]).includes('1번째 품목의 상품코드가 없어요.'));
 assert.ok(F.validate('vehicle',req,null,[{product_code:'A',qty:1.5}]).includes('1번째 품목의 수량을 1 이상으로 적어 주세요.'));
 const o=F.validate('overseas',req,{...overseasTo,email_text:'',courier_text:'FEDEX',country_code:'BR',state_text:''},[{...items[0],unit_price:''}]);
 assert.ok(o.includes('FEDEX는 받는 분 이메일이 필요해요.'));
 assert.ok(o.includes('받는 곳: 신분번호 칸이 비어 있어요.'));
 assert.ok(o.includes('받는 곳: 주(성) 칸이 비어 있어요.'));
 assert.ok(o.includes('1번째 품목의 단가를 적어 주세요.'));
 assert.ok(!F.validate('overseas',req,{...overseasTo,country_code:'CN',state_text:'',city_text:'',tax_id_text:'110000'},items).some(x=>x.includes('주(성)')));
 assert.ok(F.validate('overseas',req,{...overseasTo,courier_text:''},items).includes('운송사가 비어 있어요. 물류 담당자가 요약 수정에서 정해 주세요.'));
 assert.ok(F.validate('overseas',req,{...overseasTo,courier_text:'FEDEX'},items,{...F.SENDER,email_text:''}).includes('FEDEX는 발송인 이메일이 필요해요.'));
 assert.ok(!F.validate('overseas',req,{...overseasTo,courier_text:'DHL',email_text:''},items).some(x=>x.includes('FEDEX')));
});

test('파스토 목록: 상품별로 묶고, 검색·수량 경고·목록에 없는 상품·갱신 시각',()=>{
 const stock=[{product_code:'0012345',barcode:'8800000000001',product_name:'가짜 립',kind_text:'본품',lot_text:'L1',expires_on:'2028-01-31',available_qty:120},
  {product_code:'0012345',barcode:'8800000000001',product_name:'가짜 립',kind_text:'본품',lot_text:'L2',expires_on:'2028-06-30',available_qty:30},
  {product_code:'A-9',barcode:'',product_name:'가짜 쇼핑백',kind_text:'부자재',lot_text:'',expires_on:null,available_qty:5}];
 const g=F.groupStock(stock);
 assert.deepEqual(g.map(x=>[x.product_code,x.total_qty,x.lots.length]),[['0012345',150,2],['A-9',5,0]]);
 assert.deepEqual(F.searchStock(g,'8800').map(x=>x.product_code),['0012345']);
 assert.deepEqual(F.searchStock(g,'쇼핑').map(x=>x.product_code),['A-9']);
 assert.deepEqual(F.searchStock(g,' '),[]);
 assert.equal(F.qtyWarning({product_code:'0012345',qty:151},g),'출고 가능 150개보다 많아요.');
 assert.equal(F.qtyWarning({product_code:'0012345',qty:150},g),'');
 assert.equal(F.qtyWarning({product_code:'0012345',lot_text:'L2',qty:31},g),'출고 가능 30개보다 많아요.');
 assert.equal(F.qtyWarning({product_code:'ZZ',qty:999},g),'');
 assert.deepEqual(F.stockWarnings([{product_code:'0012345'},{product_code:'ZZ'}],g),['2번째 품목(ZZ)은 파스토 목록에 없는 상품이에요.']);
 const now=Date.UTC(2026,10,21,3); // 11/21 12:00 KST
 assert.deepEqual(F.stockAge({synced_at:'2026-11-21T00:05:00Z'},g,now),{text:'파스토 목록: 11/21 09:05 기준 (상품 2종)',stale:false});
 assert.deepEqual(F.stockAge({synced_at:'2026-11-18T00:05:00Z'},g,now),{text:'파스토 목록: 11/18 09:05 기준 (상품 2종) · 재고 정보가 오래됐어요',stale:true});
 assert.equal(F.stockAge(null,[],now).stale,true);
});

test('저장 변환: 받는 곳 담당자 칸은 담당자만, 품목은 숫자·로트 규칙, 저장 전 형식 검사',()=>{
 const vals={name_text:' A ',country_code:'ch',courier_text:'FEDEX',incoterms_code:'DAP'};
 assert.deepEqual(F.toRecipientRow(vals),{name_text:'A',country_code:'CH'});
 assert.deepEqual(F.toRecipientRow(vals,{isHandler:true}),{name_text:'A',country_code:'CH',courier_text:'FEDEX',incoterms_code:'DAP'});
 assert.deepEqual(F.toItemRows([{product_code:'007',product_name_text:'x',qty:'2',lot_text:'',expires_on:'2028-01-01',unit_price:'',weight_kg:'0.5'}]),
  [{product_code:'007',product_name_text:'x',qty:2,lot_text:'',expires_on:null,en_name_text:'',weight_kg:0.5,unit_price:null,hs_code_text:''}]);
 assert.deepEqual(F.checkInput('parcel',{},[{qty:'1'}]),[]);
 assert.deepEqual(F.checkInput('overseas',{country_code:'CHE',currency_code:'KRW'},[{qty:'0',unit_price:'abc',weight_kg:'0'}]),
  ['1번째 품목의 수량을 1 이상의 정수로 적어 주세요.','1번째 품목의 단가는 숫자로 적어 주세요.','1번째 품목의 무게는 0보다 큰 숫자로 적어 주세요.','국가코드는 영문 두 글자로 적어 주세요(예 CH).','화폐는 USD·JPY·EUR 중에서 골라 주세요.']);
 assert.deepEqual(F.checkInput('vehicle',{},Array.from({length:51},()=>({qty:1}))),['품목은 50줄까지 넣을 수 있어요.']);
});
