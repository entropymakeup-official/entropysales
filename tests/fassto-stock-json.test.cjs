const {test}=require('node:test');const assert=require('node:assert/strict');
const XLSX=require('xlsx');
const T=require('../tools/fassto-stock-json.cjs');

// 가짜 FMS 내보내기: 제목 줄, 빈 줄, 제목, 로트 행, 소계 행. 상품코드는 문자 셀(앞자리 0).
function fakeExport(){
 const ws=XLSX.utils.aoa_to_sheet([
  ['상품별재고현황'],[],
  ['상품코드','상품바코드','상품명','상품구분','LOT번호','유통기한','출고가능수량'],
  ['0012345','8800000000001','가짜 립','본품','L1','2028-01-31','1,200'],
  ['0012345','8800000000001','가짜 립','본품','L2','2028.06.30','30'],
  ['','','','','','소계','1230'],
  ['A-9','','가짜 쇼핑백','부자재','','','5'],
  ['0077','','가짜 크림','사은품','L9','언젠가','1']]);
 const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,ws,'Sheet1');
 return XLSX.read(XLSX.write(wb,{type:'buffer',bookType:'xlsx'}),{type:'buffer'});
}

test('FMS 엑셀: 제목·소계 행을 빼고 로트별 행을 문자 상품코드로 만든다',()=>{
 const {rows,skipped,badDates}=T.parseWorkbook(fakeExport());
 assert.deepEqual(rows.map(r=>[r.product_code,r.lot_text,r.expires_on,r.available_qty]),
  [['0012345','L1','2028-01-31',1200],['0012345','L2','2028-06-30',30],['A-9','','',5],['0077','L9','',1]]);
 assert.equal(rows[0].kind_text,'본품');assert.equal(rows[0].barcode,'8800000000001');
 assert.deepEqual(skipped,[6]);
 assert.deepEqual(badDates,[8]);
});

// 실제 FMS 모양(2026-11-19 확인): 21열 제목, 상품 제목 줄("… - N 건", 상품코드 비어 있음), 로트 행, 상품명 '소계' 행, 맨 끝 총계 행.
test('FMS 엑셀: 실제 모양(번호·고객사 열, 상품 제목 줄, 소계, 마지막 총계, 쉼표 수량, 앞자리 0 코드)',()=>{
 const head=['No.','고객사명','상품코드','상품바코드','상품명','상품구분','상품 취급온도','출고금지일','경과일','유통기한','제조일자','LOT번호','출고 가능 수량','출고 신청 수량','출고 지시 수량','작업중취소 수량','유통가공 수량','비가용재고','유통기한 경과재고','안전재고 수량','총재고'];
 const blank=()=>head.map(()=> '');
 const mk=o=>{const r=blank();for(const [k,v] of Object.entries(o))r[head.indexOf(k)]=v;return r;};
 const aoa=[head,
  mk({'상품명':'가짜 브로우 - 2 건'}),
  mk({'No.':'1','고객사명':'가짜사','상품코드':'02553620331724','상품바코드':'8800000000002','상품명':'가짜 브로우','상품구분':'본품','유통기한':'2028-03-31','LOT번호':'B1','출고 가능 수량':'1,501','총재고':'1,501'}),
  mk({'No.':'2','고객사명':'가짜사','상품코드':'02553620331724','상품바코드':'8800000000002','상품명':'가짜 브로우','상품구분':'본품','유통기한':'2029-01-15','LOT번호':'B2','출고 가능 수량':'20','비가용재고':'3'}),
  mk({'상품명':'소계','출고 가능 수량':'1,521'}),
  mk({'출고 가능 수량':'1,521','총재고':'1,524'})];
 const {rows,skipped,badDates}=T.parseStockRows(aoa);
 assert.deepEqual(rows.map(r=>[r.product_code,r.lot_text,r.expires_on,r.available_qty]),
  [['02553620331724','B1','2028-03-31',1501],['02553620331724','B2','2029-01-15',20]]);
 assert.equal(rows[0].product_name,'가짜 브로우');
 assert.deepEqual(skipped,[2,5,6]);
 assert.deepEqual(badDates,[]);
});

test('FMS 엑셀: 필수 열이 없으면 찾은 제목을 보여 주고 멈춘다',()=>{
 assert.throws(()=>T.parseStockRows([['상품코드','상품명','현재고']]),/열을 찾지 못했어요: 출고 가능 수량\. 찾은 제목: 상품코드, 상품명, 현재고/);
 assert.throws(()=>T.parseStockRows([['a','b']]),/상품코드 제목 줄을 찾지 못했어요/);
});

test('날짜 표기와 SQL 문',()=>{
 assert.deepEqual(['2028-1-5','20280105','2028/01/05','1/5/28','','x'].map(T.normalizeDate),['2028-01-05','2028-01-05','2028-01-05','2028-01-05','',null]);
 const sql=T.toSql([{product_code:"0'1",available_qty:1}]);
 assert.equal(sql,`select approval_private.logistics_replace_fassto_stock($fassto$[{"product_code":"0'1","available_qty":1}]$fassto$::jsonb, 'fms-browser');`);
 assert.throws(()=>T.toSql([{product_code:'$fassto$'}]),/\$fassto\$/);
 assert.throws(()=>T.toSql([],'manual'),/source/);
});

// ---- 검사 강화(Fix round 1) ----
const os=require('node:os'),path=require('node:path'),fs=require('node:fs'),{spawnSync}=require('node:child_process');
const HEAD=['상품코드','상품바코드','상품명','상품구분','LOT번호','유통기한','출고 가능 수량'];
function wbOf(rowsAfterHead){
 const ws=XLSX.utils.aoa_to_sheet([HEAD,...rowsAfterHead]);
 const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,ws,'S');
 return XLSX.read(XLSX.write(wb,{type:'buffer',bookType:'xlsx'}),{type:'buffer'});
}
const okRow=['0012345','8800000000001','가짜 립','본품','L1','2028-01-31','5'];

test('숫자 칸 상품코드·바코드는 멈춘다(과학 표기로 깨짐), 문자 칸 앞자리 0은 유지',()=>{
 assert.throws(()=>T.parseWorkbook(wbOf([[2553620331724,'','가짜','본품','L','2028-01-31','1']])),/상품코드.*2행.*문자/s);
 assert.throws(()=>T.parseWorkbook(wbOf([['0012345',8800000000001,'가짜','본품','L','2028-01-31','1']])),/바코드.*2행.*문자/s);
 assert.throws(()=>T.parseWorkbook(wbOf([['2.55362E+12','','가짜','본품','L','2028-01-31','1']])),/상품코드.*2행/s);
 const {rows}=T.parseWorkbook(wbOf([okRow]));
 assert.equal(rows[0].product_code,'0012345');
});

test('assertClean: 수량·유통기한이 잘못된 행이 있으면 던진다',()=>{
 const bad=r=>()=>T.assertClean(T.parseWorkbook(wbOf([r])));
 assert.doesNotThrow(bad(okRow));
 assert.throws(bad([...okRow.slice(0,6),'abc']),/수량.*행: 2/s);
 assert.throws(bad([...okRow.slice(0,6),'-5']),/수량.*행: 2/s);
 assert.throws(bad([...okRow.slice(0,6),'']),/수량.*행: 2/s);
 assert.throws(bad([...okRow.slice(0,5),'2028-13-45','5']),/유통기한.*행: 2/s);
 assert.throws(bad([...okRow.slice(0,5),'언젠가','5']),/유통기한.*행: 2/s);
});

test('달력에 없는 날짜는 null',()=>{
 assert.deepEqual(['2028-13-45','2027-02-29','2028-02-29','20281301','13/45/28'].map(T.normalizeDate),[null,null,'2028-02-29',null,null]);
});

test('CLI: 잘못된 파일은 SQL 없이 non-zero, --sql을 앞에 써도 파일로 읽지 않는다',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fassto-'));
 const cli=path.join(__dirname,'..','tools','fassto-stock-json.cjs');
 const write=(n,r)=>{const p=path.join(dir,n);fs.writeFileSync(p,XLSX.write(wbOf(r),{type:'buffer',bookType:'xlsx'}));return p;};
 const good=write('good.xlsx',[okRow]);
 const g=spawnSync(process.execPath,[cli,'--sql',good],{encoding:'utf8'});
 assert.equal(g.status,0);assert.match(g.stdout,/^select approval_private\.logistics_replace_fassto_stock/);
 for(const [n,r] of [['num.xlsx',[[2553620331724,'','가짜','본품','L','2028-01-31','1']]],['qty.xlsx',[[...okRow.slice(0,6),'abc']]],['neg.xlsx',[[...okRow.slice(0,6),'-5']]],['date.xlsx',[[...okRow.slice(0,5),'2028-13-45','5']]],['unread.xlsx',[[...okRow.slice(0,5),'언젠가','5']]]]){
  const x=spawnSync(process.execPath,[cli,'--sql',write(n,r)],{encoding:'utf8'});
  assert.notEqual(x.status,0,n);assert.equal(x.stdout,'',n);
 }
 fs.rmSync(dir,{recursive:true,force:true});
});
