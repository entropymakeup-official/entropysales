const {test}=require('node:test');const assert=require('node:assert/strict');
const C=require('../tools/fassto-sync-core.cjs');
const NOW=Date.UTC(2026,10,27,1); // KST 2026-11-27 10:00

test('날짜: KST 오늘 기준 범위, 여러 형식 정규화',()=>{
 assert.equal(C.kstDay(Date.UTC(2026,10,26,15)),'2026-11-27');
 assert.deepEqual(C.dateRange(NOW,14,14),{start:'2026-11-13',end:'2026-12-11'});
 assert.equal(C.normDate('2028-05-27'),'2028-05-27');
 assert.equal(C.normDate('20280527'),'2028-05-27');
 assert.equal(C.normDate('2028-05-26T15:00:00.000Z'),'2028-05-27'); // UTC 표기는 KST 날짜로
 assert.equal(C.normDate('2028-02-30'),'');assert.equal(C.normDate(''),'');assert.equal(C.normDate(null),'');
});

test('재고: 고객사상품코드·유통기한별로 합치고 주문가능수량을 쓴다',()=>{
 const rows=C.toStockRows([
  {cstGodCd:'11111111111111',godBarcd:'11111111111111',godNm:'가짜 상품',giftDiv:'01',distTermDt:'20290101',canStockQty:5,stockQty:9,whCd:'A'},
  {cstGodCd:'11111111111111',godBarcd:'11111111111111',godNm:'가짜 상품',giftDiv:'01',distTermDt:'2029-01-01',canStockQty:3,whCd:'B'},
  {cstGodCd:'22222222222222',godNm:'가짜 사은품',giftDiv:'02',distTermDt:'',canStockQty:0},
  {cstGodCd:'',godNm:'코드 없음',canStockQty:1}]);
 assert.deepEqual(rows,[
  {product_code:'11111111111111',barcode:'11111111111111',product_name:'가짜 상품',kind_text:'본품',lot_text:'',expires_on:'2029-01-01',available_qty:8},
  {product_code:'22222222222222',barcode:'',product_name:'가짜 사은품',kind_text:'사은품',lot_text:'',expires_on:'',available_qty:0}]);
});

test('출고: 상태 코드 변환, 쇼핑몰 택배 거르기, 바뀐 건 고르기',()=>{
 assert.equal(C.statusOf({wrkStat:'1'}),'ORDER');assert.equal(C.statusOf({wrkStat:'3'}),'DONE');
 assert.equal(C.statusOf({wrkStat:'8'}),'CANCEL');assert.equal(C.statusOf({wrkStat:'9'}),'SHORTAGE');assert.equal(C.statusOf({wrkStat:'7'}),null);
 assert.equal(C.keepDelivery({outDiv:'2',salChanel:'가짜몰'}),true);
 assert.equal(C.keepDelivery({outDiv:'1',salChanel:''}),true);
 assert.equal(C.keepDelivery({outDiv:'1',salChanel:'가짜몰'}),false);
 assert.equal(C.keepDelivery({outDiv:'1',salChanel:'가짜몰'},{parcelSalesChannelEmptyOnly:false}),true);
 const st={slips:{A:'2026-11-26 10:00'}};
 assert.equal(C.needsDetail({slipNo:'A',updTime:'2026-11-26 10:00'},st),false);
 assert.equal(C.needsDetail({slipNo:'A',updTime:'2026-11-26 11:00'},st),true);
 assert.equal(C.needsDetail({slipNo:'B',updTime:'x'},st),true);
});

test('출고: 목록 행과 상세 품목을 ingest 형식으로 바꾼다',()=>{
 const items=C.toItems([{goods:[{cstGodCd:'11111111111111',godNm:'가짜 상품',distTermDt:'2029-01-01',ordQty:30},{cstGodCd:'',ordQty:1},{cstGodCd:'3',ordQty:0}]}]);
 assert.deepEqual(items,[{product_code:'11111111111111',product_name:'가짜 상품',expires_on:'2029-01-01',qty:30}]);
 assert.deepEqual(C.toItems({goods:[{cstGodCd:'9',godNm:'x',distTermDt:'',ordQty:'2'}]}),[{product_code:'9',product_name:'x',expires_on:'',qty:2}]);
 const x={slipNo:'GG24OO261201000001',ordNo:'가짜 주문 1',ordDt:'2026-12-01',outDiv:'2',shopNm:'가짜 바이어',ordQty:30,wrkStat:'1',
  invoiceNo:'',parcelNm:'',remark:'가짜 비고',updUserNm:'가짜 요청자'};
 assert.deepEqual(C.toDelivery(x,items),{slip_no:'GG24OO261201000001',order_no:'가짜 주문 1',order_date:'2026-12-01',out_div:'car',shop_name:'가짜 바이어',
  status_code:'ORDER',remark:'가짜 비고',invoice_no:'',parcel_name:'',registered_by:'가짜 요청자',qty_total:30,items});
 assert.equal('items' in C.toDelivery({...x,outDiv:'1'},null),false);
 assert.equal(C.toDelivery({...x,outDiv:'1'},null).out_div,'parcel');
});

test('토큰: 만료 5분 전까지만 다시 쓴다(만료시각은 KST)',()=>{
 assert.equal(C.tokenValid({accessToken:'t',expreDatetime:'20261127103000'},NOW),true);  // 30분 남음
 assert.equal(C.tokenValid({accessToken:'t',expreDatetime:'20261127100400'},NOW),false); // 4분 남음
 assert.equal(C.tokenValid({accessToken:'',expreDatetime:'20261127103000'},NOW),false);
 assert.equal(C.tokenValid(null,NOW),false);
});

test('요약 한 줄',()=>{
 assert.equal(C.summary({stock_rows:120,stock_warning:'',created:2,updated:1,canceled:0,invoices:1,skipped:0},{mall:5}),
  '재고 120행 · 새 요청 2 · 수정 1 · 취소 0 · 송장 1 · 건너뜀 0 · 쇼핑몰 택배 제외 5');
 assert.equal(C.summary({stock_rows:null,stock_warning:'재고 4행(지난번 10행)이라 재고를 바꾸지 않았어요',created:0,updated:0,canceled:0,invoices:0,skipped:0},{mall:0}),
  '재고 경고: 재고 4행(지난번 10행)이라 재고를 바꾸지 않았어요 · 새 요청 0 · 수정 0 · 취소 0 · 송장 0 · 건너뜀 0 · 쇼핑몰 택배 제외 0');
});
