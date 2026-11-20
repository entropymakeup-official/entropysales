#!/usr/bin/env node
'use strict';
// FMS '상품별재고현황' 엑셀을 logistics_replace_fassto_stock(rows, source)에 넘길 로트별 JSON으로 바꾼다.
// 쓰는 법: node tools/fassto-stock-json.cjs <내려받은.xlsx> [--sql]
//  --sql 이면 SQL 편집기·Supabase MCP에 그대로 넣을 select 문을 출력한다. 요약은 stderr로 보낸다.
// 열 이름은 2026-11-19 FMS 상품별재고현황으로 확인했다. 파스토가 바꾸면 ALIASES에 더한다(필수 열을 못 찾으면 찾은 제목을 보여 주고 멈춘다).
const XLSX=require('xlsx');

const ALIASES={
 product_code:['상품코드'],
 barcode:['상품바코드','바코드'],
 product_name:['상품명'],
 kind_text:['상품구분','구분'],
 lot_text:['LOT번호','LOT','로트번호','로트'],
 expires_on:['유통기한'],
 available_qty:['출고가능수량','출고가능','가용재고','가용수량']
};
const REQUIRED={product_code:'상품코드',product_name:'상품명',available_qty:'출고 가능 수량'};
const TOTAL=/^(소계|합계|총계|총합계)$/;
const norm=v=>String(v??'').replace(/\s+/g,'').trim();

function normalizeDate(v){
 const t=String(v??'').trim();if(!t)return '';
 let m=/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})/.exec(t)||/^(\d{4})(\d{2})(\d{2})$/.exec(t);
 if(m)return `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
 m=/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/.exec(t); // 엑셀 기본 날짜 표시(m/d/yy)
 if(m)return `20${m[3]}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`;
 return null;
}

// aoa: sheet_to_json(header:1, raw:false) 결과(문자 2차원 배열)
function parseStockRows(aoa){
 const rows=aoa||[];
 const h=rows.findIndex(r=>(r||[]).some(c=>norm(c)==='상품코드'));
 if(h<0)throw new Error('FMS 엑셀에서 상품코드 제목 줄을 찾지 못했어요.');
 const head=rows[h].map(norm),col={};
 for(const [key,names] of Object.entries(ALIASES)){const i=head.findIndex(x=>names.includes(x));if(i>=0)col[key]=i;}
 const missing=Object.entries(REQUIRED).filter(([k])=>col[k]==null).map(([,label])=>label);
 if(missing.length)throw new Error(`FMS 엑셀 열을 찾지 못했어요: ${missing.join(', ')}. 찾은 제목: ${head.filter(Boolean).join(', ')}`);
 const out=[],skipped=[],badDates=[];
 rows.slice(h+1).forEach((r,k)=>{
  const at=key=>col[key]==null?'':String((r||[])[col[key]]??'').trim();
  const code=at('product_code');
  if(!code||norm(code)==='상품코드'||(r||[]).some(c=>TOTAL.test(norm(c)))){if((r||[]).some(c=>norm(c)))skipped.push(h+2+k);return;}
  const exp=normalizeDate(at('expires_on'));
  if(exp===null)badDates.push(h+2+k);
  const qty=Number(at('available_qty').replace(/,/g,''));
  out.push({product_code:code,barcode:at('barcode'),product_name:at('product_name'),kind_text:at('kind_text'),lot_text:at('lot_text'),
   expires_on:exp||'',available_qty:Number.isFinite(qty)?Math.trunc(qty):0});
 });
 return {rows:out,skipped,badDates};
}
function parseWorkbook(wb){
 const ws=wb.Sheets[wb.SheetNames[0]];
 return parseStockRows(XLSX.utils.sheet_to_json(ws,{header:1,raw:false,defval:''}));
}
function toSql(rows,source='fms-browser'){
 const json=JSON.stringify(rows);
 if(json.includes('$fassto$'))throw new Error('상품 정보에 $fassto$ 글자가 있어 SQL로 만들 수 없어요.');
 if(!['fms-browser','fassto-api'].includes(source))throw new Error('source는 fms-browser 또는 fassto-api예요.');
 return `select approval_private.logistics_replace_fassto_stock($fassto$${json}$fassto$::jsonb, '${source}');`;
}

if(require.main===module){
 const file=process.argv[2];
 if(!file){console.error('쓰는 법: node tools/fassto-stock-json.cjs <상품별재고현황.xlsx> [--sql]');process.exit(2);}
 const {rows,skipped,badDates}=parseWorkbook(XLSX.readFile(file));
 if(!rows.length){console.error('로트 행이 0개예요. 파일을 확인해 주세요.');process.exit(1);}
 const codes=new Set(rows.map(r=>r.product_code)).size;
 console.error(`로트 행 ${rows.length}개, 상품 ${codes}종, 건너뛴 행 ${skipped.length}개${badDates.length?`, 유통기한을 못 읽은 행 ${badDates.join(',')}`:''}`);
 process.stdout.write(process.argv.includes('--sql')?toSql(rows)+'\n':JSON.stringify(rows,null,1)+'\n');
}
module.exports={ALIASES,normalizeDate,parseStockRows,parseWorkbook,toSql};
