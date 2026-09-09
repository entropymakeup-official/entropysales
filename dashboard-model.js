(function(root){
  'use strict';
  function validDate(value){
    return typeof value==='string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0,10)===value;
  }
  function summarize(invoices,items,period){
    if(!validDate(period.start)||!validDate(period.end)||period.start>period.end)
      throw new Error('시작일과 종료일을 올바르게 입력해 주세요.');
    const months=[];
    let month=period.start.slice(0,7);
    while(month<=period.end.slice(0,7)){
      months.push(month);
      const [y,m]=month.split('-').map(Number);
      month=m===12?`${y+1}-01`:`${y}-${String(m+1).padStart(2,'0')}`;
    }
    const grouped=new Map();
    items.forEach(item=>{if(!grouped.has(item.invoice_id))grouped.set(item.invoice_id,[]);grouped.get(item.invoice_id).push(item);});
    const number=v=>Number.isFinite(Number(v))?Number(v):0;
    const selected=invoices.filter(v=>!period.customer||v.customer===period.customer);
    const rows=selected.filter(v=>validDate(v.order_date)&&v.order_date>=period.start&&v.order_date<=period.end).map(invoice=>{
      const lines=grouped.get(invoice.id)||[];
      const sum=types=>lines.filter(x=>types.includes(x.sales_type)).reduce((a,x)=>a+number(x.qty)*number(x.price),0);
      return {invoice,lines,revenue:sum(['Paid']),foc:number(invoice.foc)+sum(['FOC','GWP','Sample']),lost:sum(['Lost'])};
    });
    const result={rows,months,byMonth:Object.fromEntries(months.map(m=>[m,0])),byCustomer:Object.create(null),byManager:Object.create(null),revenue:0,foc:0,lost:0,missingDates:selected.filter(v=>!validDate(v.order_date)).length};
    rows.forEach(r=>{
      result.revenue+=r.revenue;result.foc+=r.foc;result.lost+=r.lost;
      result.byMonth[r.invoice.order_date.slice(0,7)]+=r.revenue;
      const c=r.invoice.customer||'거래처 미입력';result.byCustomer[c]=(result.byCustomer[c]||0)+r.revenue;
      const m=r.invoice.mgr||'담당자 미입력';result.byManager[m]=(result.byManager[m]||0)+r.revenue;
    });
    return result;
  }
  function evidence(summary,metric){
    const types={revenue:['Paid'],pendingRevenue:['Paid'],foc:['FOC','GWP','Sample'],lost:['Lost']};
    if(!types[metric])throw new Error('지원하지 않는 집계 항목입니다.');
    const rows=summary.rows.filter(r=>{
      if(metric==='pendingRevenue')return r.tax?.pending&&r.lines.some(i=>i.sales_type==='Paid');
      if(metric==='revenue'&&r.tax?.pending)return false;
      return r.lines.some(i=>types[metric].includes(i.sales_type))||(metric==='foc'&&Number(r.invoice.foc));
    });
    const roundedRows=rows.reduce((sum,r)=>sum+Math.round(r[metric]),0);
    const displayTotal=Math.round(summary[metric]);
    return {rows,roundedRows,displayTotal,adjustment:displayTotal-roundedRows};
  }
  function summarizeSupply(invoices,items,period,customers){
    const original=summarize(invoices,items,period);
    const result=summarize(invoices.filter(i=>i.status!=='Cancelled'),items,period);
    result.cancelledCount=original.rows.length-result.rows.length;
    result.recordedRevenue=result.revenue;result.revenue=0;result.pendingRevenue=0;
    result.byMonth=Object.fromEntries(result.months.map(m=>[m,0]));
    result.byCustomer=Object.create(null);result.byManager=Object.create(null);
    result.rows.forEach(r=>{
      const matches=customers.filter(c=>c.name===r.invoice.customer);
      const taxType=matches.length===1?matches[0].tax:'';
      const memo=[r.invoice.note,r.invoice.tracking_num].filter(Boolean).join(' ');
      let reason='';
      if(matches.length!==1)reason=matches.length?'거래처명이 중복되어 세금 구분 확인 필요':'거래처 마스터 연결 필요';
      else if(!['영세','과세'].includes(taxType))reason='거래처 세금 구분 미입력';
      else if(/v\s*a\s*t|부가\s*(?:가치\s*)?세|과세|영세|\btax\b/i.test(memo))reason='세금 관련 비고 확인 필요: '+memo;
      else if(taxType==='과세')reason='과세 거래: 단가의 VAT 포함·별도 여부 확인 필요';
      r.tax={type:taxType||'미확인',pending:!!reason,reason:reason||'거래처 영세 기본값 적용'};
      r.recordedRevenue=r.revenue;r.pendingRevenue=reason?r.revenue:0;
      if(reason)r.revenue=0;
      result.revenue+=r.revenue;result.pendingRevenue+=r.pendingRevenue;
      result.byMonth[r.invoice.order_date.slice(0,7)]+=r.revenue;
      const c=r.invoice.customer||'거래처 미입력',m=r.invoice.mgr||'담당자 미입력';
      result.byCustomer[c]=(result.byCustomer[c]||0)+r.revenue;
      result.byManager[m]=(result.byManager[m]||0)+r.revenue;
    });
    result.pendingCount=evidence(result,'pendingRevenue').rows.length;
    result.displayAdjustment=Math.round(result.recordedRevenue)-Math.round(result.revenue)-Math.round(result.pendingRevenue);
    return result;
  }
  const api={summarize,summarizeSupply,validDate,evidence};
  if(typeof module==='object'&&module.exports)module.exports=api;else root.DashboardModel=api;
})(typeof globalThis!=='undefined'?globalThis:this);
