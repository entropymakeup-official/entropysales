'use strict';
// 파스토 OpenAPI 응답 → 대시보드 동기화 형식. 순수 함수만 둔다(네트워크·파일은 fassto-sync.cjs).
// 설계: docs/superpowers/specs/2026-11-27-fassto-api-sync-design.md
const KST=9*3600000;
// 응답 wrkStat는 숫자(1 출고요청, 2 작업중, 3 출고완료·부분출고완료, 8 취소, 9 결품). 조회 경로 코드도 받아 둔다.
const STATUS={'1':'ORDER','2':'WORKING','3':'DONE','8':'CANCEL','9':'SHORTAGE',
 ORDER:'ORDER',WORKING:'WORKING',DONE:'DONE',PARTDONE:'DONE',CANCEL:'CANCEL',SHORTAGE:'SHORTAGE'};
const GIFT={'01':'본품','02':'사은품','03':'부자재'};
const s=v=>String(v??'').trim();

const kstDay=ms=>new Date(ms+KST).toISOString().slice(0,10);
function addDays(day,n){const [y,m,d]=day.split('-').map(Number);return new Date(Date.UTC(y,m-1,d+n)).toISOString().slice(0,10);}
function dateRange(nowMs,back=14,ahead=14){const t=kstDay(nowMs);return {start:addDays(t,-back),end:addDays(t,ahead)};}

function normDate(v){
 const t=s(v);if(!t)return '';
 if(/T\d{2}:\d{2}/.test(t)&&/(Z|[+-]\d{2}:?\d{2})$/.test(t)){const ms=Date.parse(t);return Number.isFinite(ms)?kstDay(ms):'';}
 const m=/^(\d{4})-?(\d{2})-?(\d{2})/.exec(t);if(!m)return '';
 const iso=`${m[1]}-${m[2]}-${m[3]}`,dt=new Date(iso+'T00:00:00Z');
 return Number.isNaN(dt.getTime())||dt.toISOString().slice(0,10)!==iso?'':iso;
}

function toStockRows(list){
 const map=new Map();
 for(const x of list||[]){
  const code=s(x.cstGodCd);if(!code)continue;
  const exp=normDate(x.distTermDt),key=code+'|'+exp,qty=Number(x.canStockQty)||0;
  const prev=map.get(key);
  if(prev){prev.available_qty+=qty;continue;}
  map.set(key,{product_code:code,barcode:s(x.godBarcd),product_name:s(x.godNm),kind_text:GIFT[s(x.giftDiv)]||s(x.giftDiv),lot_text:'',expires_on:exp,available_qty:qty});
 }
 return [...map.values()];
}

const statusOf=x=>STATUS[s(x?.wrkStat)]||null;
function keepDelivery(x,{parcelSalesChannelEmptyOnly=true}={}){
 const div=s(x?.outDiv);
 if(div==='2')return true;
 if(div==='1')return !parcelSalesChannelEmptyOnly||!s(x.salChanel);
 return false;
}
const needsDetail=(x,state)=>(state?.slips||{})[s(x?.slipNo)]!==s(x?.updTime);

function toItems(detail){
 const d=Array.isArray(detail)?detail[0]:detail;
 return (d?.goods||[]).map(g=>({product_code:s(g.cstGodCd),product_name:s(g.godNm),expires_on:normDate(g.distTermDt),qty:Number(g.ordQty)||0}))
  .filter(g=>g.product_code&&g.qty>0);
}

function toDelivery(x,items){
 const o={slip_no:s(x.slipNo),order_no:s(x.ordNo),order_date:normDate(x.ordDt),out_div:s(x.outDiv)==='2'?'car':'parcel',shop_name:s(x.shopNm),
  status_code:statusOf(x),remark:s(x.remark),invoice_no:s(x.invoiceNo),parcel_name:s(x.parcelNm),registered_by:s(x.updUserNm),qty_total:Number(x.ordQty)||0};
 if(items)o.items=items;
 return o;
}

function tokenValid(tok,nowMs){
 const m=/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(s(tok?.expreDatetime));
 if(!s(tok?.accessToken)||!m)return false;
 const exp=Date.UTC(+m[1],+m[2]-1,+m[3],+m[4],+m[5],+m[6])-KST;
 return exp-nowMs>5*60000;
}

function summary(res,{mall=0}={}){
 const r=res||{};
 const stock=r.stock_warning?`재고 경고: ${r.stock_warning}`:r.stock_rows!=null?`재고 ${r.stock_rows}행`:'재고 없음';
 return `${stock} · 새 요청 ${r.created||0} · 수정 ${r.updated||0} · 취소 ${r.canceled||0} · 송장 ${r.invoices||0} · 건너뜀 ${r.skipped||0} · 쇼핑몰 택배 제외 ${mall}`;
}

module.exports={kstDay,addDays,dateRange,normDate,toStockRows,statusOf,keepDelivery,needsDetail,toItems,toDelivery,tokenValid,summary};
