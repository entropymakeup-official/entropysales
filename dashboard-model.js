(function(root){
  'use strict';
  const amounts=typeof module==='object'&&module.exports?require('./invoice-amounts.js'):root.InvoiceAmounts;
  const displayCents=value=>Math.round(Number(Number(value).toLocaleString('en-US',{useGrouping:false,maximumFractionDigits:2}))*100);
  function validDate(value){
    return typeof value==='string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0,10)===value;
  }
  function allTimePeriod(invoices,today){
    const dates=invoices.map(v=>v.order_date).filter(validDate).sort();
    const year=today.slice(0,4);
    return {start:dates[0]||year+'-01-01',end:dates[dates.length-1]||year+'-12-31'};
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
      const sum=types=>lines.filter(x=>types.includes(x.sales_type)).reduce((a,x)=>a+amounts.amount(x),0);
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
    const types={recordedRevenue:['Paid'],revenue:['Paid'],pendingRevenue:['Paid'],foc:['FOC','GWP','Sample'],lost:['Lost']};
    if(!types[metric])throw new Error('지원하지 않는 집계 항목입니다.');
    const rows=summary.rows.filter(r=>{
      if(metric==='pendingRevenue')return r.tax?.pending&&r.lines.some(i=>i.sales_type==='Paid');
      if(metric==='revenue'&&r.tax?.pending)return false;
      return r.lines.some(i=>types[metric].includes(i.sales_type))||(metric==='foc'&&Number(r.invoice.foc));
    });
    const rowCents=rows.reduce((sum,r)=>sum+displayCents(r[metric]),0),totalCents=displayCents(summary[metric]);
    return {rows,roundedRows:rowCents/100,displayTotal:totalCents/100,adjustment:(totalCents-rowCents)/100};
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
    result.displayAdjustment=(displayCents(result.recordedRevenue)-displayCents(result.revenue)-displayCents(result.pendingRevenue))/100;
    return result;
  }
  function summarizeTax(invoices,items,period,customers,records){
    const summary=summarizeSupply(invoices,items,period,customers);
    const groups=new Map();
    summary.rows.forEach(row=>{
      if(!row.lines.some(i=>i.sales_type==='Paid'))return;
      const inv=row.invoice,month=inv.order_date.slice(0,7),key=JSON.stringify([month,inv.customer]);
      if(!groups.has(key)){
        const matches=customers.filter(c=>c.name===inv.customer),c=matches.length===1?matches[0]:null;
        groups.set(key,{month,customer:inv.customer||'거래처 미입력',custId:c?.id||null,mgr:c?.mgr||inv.mgr||'-',
          taxType:['영세','과세'].includes(c?.tax)?c.tax:'미확인',taxStatus:c?.id?(records.find(r=>r.customer_id===c.id&&r.month===month)?.status||'발행예정'):'연결 확인 필요',
          amt:0,supplyAmt:0,pendingAmt:0,pendingCount:0,invoices:[],reasons:[]});
      }
      const group=groups.get(key);
      group.amt+=row.recordedRevenue;group.supplyAmt+=row.revenue;group.pendingAmt+=row.pendingRevenue;
      group.invoices.push(inv.no||String(inv.id));
      if(row.tax.pending){group.pendingCount++;if(!group.reasons.includes(row.tax.reason))group.reasons.push(row.tax.reason);}
    });
    return {...summary,taxRows:[...groups.values()]};
  }
  const api={summarize,summarizeSupply,summarizeTax,validDate,allTimePeriod,evidence};
  if(typeof module==='object'&&module.exports)module.exports=api;else root.DashboardModel=api;
})(typeof globalThis!=='undefined'?globalThis:this);
