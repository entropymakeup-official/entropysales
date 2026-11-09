(function(root){
  'use strict';
  // 면세점처럼 입고분은 매출(계산서)로 잡고, 대금은 팔린 만큼 다음 달에 정산받는 거래처의 월별 정산 현황.
  const fields='customer_id,month,stocked_supply,sold_supply,deposited_amount,deposited_date,ending_stock_qty,ending_stock_supply,evidence,note';
  const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money=value=>'₩'+Math.round(value).toLocaleString('ko-KR');
  function validDate(value){
    return typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&!Number.isNaN(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
  }
  function amount(value,{nonNegative=false}={}){
    if(!['number','string'].includes(typeof value)||String(value).trim()==='')throw new Error('정산 금액을 확인해야 합니다.');
    const n=Number(value);
    if(!Number.isFinite(n)||Math.abs(n)>Number.MAX_SAFE_INTEGER||(nonNegative&&n<0))throw new Error('정산 금액 범위를 확인해야 합니다.');
    return n;
  }
  function validate(rows){
    if(!Array.isArray(rows))throw new Error('정산 자료를 확인해야 합니다.');
    const seen=new Set();
    return rows.map(row=>{
      if(!row||typeof row.customer_id!=='string'||!row.customer_id||!validDate(row.month)||!row.month.endsWith('-01'))throw new Error('정산 월·거래처를 확인해야 합니다.');
      const key=row.customer_id+'|'+row.month;
      if(seen.has(key))throw new Error('같은 거래처·월의 정산 자료가 중복되었습니다.');
      seen.add(key);
      const hasDeposit=row.deposited_amount!==null&&row.deposited_amount!==undefined;
      if(hasDeposit!==(row.deposited_date!==null&&row.deposited_date!==undefined)||(hasDeposit&&!validDate(row.deposited_date)))throw new Error('실입금 금액과 날짜를 확인해야 합니다.');
      if(!Number.isSafeInteger(Number(row.ending_stock_qty))||Number(row.ending_stock_qty)<0)throw new Error('월말 재고 수량을 확인해야 합니다.');
      return {...row,stocked:amount(row.stocked_supply),sold:amount(row.sold_supply),deposited:hasDeposit?amount(row.deposited_amount):null,
        stockQty:Number(row.ending_stock_qty),stock:amount(row.ending_stock_supply,{nonNegative:true})};
    });
  }
  function summarize(rows,period,customers){
    if(!validDate(period.start)||!validDate(period.end)||period.start>period.end)throw new Error('조회 기간이 올바르지 않습니다.');
    const checked=validate(rows),byId=new Map(customers.map(c=>[c.id,c]));
    const first=period.start.slice(0,7)+'-01',last=period.end.slice(0,7)+'-01';
    const selected=checked.filter(r=>r.month>=first&&r.month<=last&&(!period.customer||byId.get(r.customer_id)?.name===period.customer))
      .map(r=>({...r,customer_name:byId.get(r.customer_id)?.name||'거래처 연결 확인 필요'}))
      .sort((a,b)=>b.month.localeCompare(a.month)||a.customer_name.localeCompare(b.customer_name,'ko'));
    const result={rows:selected,totalRegistered:checked.length,stocked:0,sold:0,deposited:0,missingDeposits:0,stock:0,stockQty:0,stockMonths:[]};
    const latest=new Map();
    for(const r of selected){
      result.stocked+=r.stocked;result.sold+=r.sold;
      if(r.deposited===null)result.missingDeposits++;else result.deposited+=r.deposited;
      if(!latest.has(r.customer_id))latest.set(r.customer_id,r); // rows are newest first
    }
    for(const r of latest.values()){result.stock+=r.stock;result.stockQty+=r.stockQty;result.stockMonths.push(r.customer_name+' '+r.month.slice(0,7));}
    for(const key of ['stocked','sold','deposited','stock'])amount(result[key]);
    return result;
  }
  async function load(client,options={}){
    let timer,active=true;
    async function scan(){
      const rows=[];let expected=null,pages=0;
      do{
        const response=await client.from('consignment_settlements').select(fields,{count:'exact'})
          .order('month').order('customer_id').range(rows.length,rows.length+499);
        if(!active)throw new Error('Read expired');
        if(!response||response.error||!Array.isArray(response.data)||!Number.isSafeInteger(response.count)||response.count<0)throw new Error('Read failed');
        if(expected===null)expected=response.count;
        if(expected!==response.count||rows.length+response.data.length>expected||(!response.data.length&&rows.length<expected))throw new Error('Incomplete read');
        rows.push(...response.data);
        pages++;
      }while(rows.length<expected);
      validate(rows);
      return {rows,pages};
    }
    const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?
      Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
    const work=(async()=>{
      const first=await scan();
      if(first.pages>1){
        const second=await scan();
        if(JSON.stringify(canonical(first.rows))!==JSON.stringify(canonical(second.rows)))throw new Error('Read changed');
      }
      return {status:'ready',rows:first.rows};
    })();
    const deadline=new Promise((resolve,reject)=>{timer=setTimeout(()=>{active=false;reject(new Error('Read expired'));},options.timeoutMs??20000);});
    try{return await Promise.race([work,deadline]);}
    catch{return {status:'error',rows:[]};}
    finally{active=false;clearTimeout(timer);}
  }
  function evidenceLink(value,label){
    if(typeof value!=='string')return '';
    try{
      const url=new URL(value);
      const allowed=url.protocol==='https:'&&!url.username&&!url.password&&(!url.port||url.port==='443')&&
        ((url.hostname==='docs.google.com'&&url.pathname.startsWith('/spreadsheets/d/'))||(url.hostname==='drive.google.com'&&url.pathname.startsWith('/file/d/')));
      return allowed?`<a href="${escape(url.href)}" target="_blank" rel="noopener noreferrer">${label}</a>`:'';
    }catch{return '';}
  }
  function render(state,period,customers){
    const header='<div class="card-hd"><h3>면세점 월별 정산</h3><span class="badge bg-amber">판매분 정산 거래처</span></div>';
    const basis='<p class="consign-note">입고 공급가는 계산서 발행 기준으로 대시보드 매출과 같은 기준입니다. 면세점은 팔린 만큼만 다음 달에 정산하므로 실입금은 판매 정산액을 따르고, 월말 매장 재고(납품가)만큼은 아직 정산받지 않은 금액입니다. 금액은 VAT 별도, 실입금은 통장 기준입니다. 이 패널은 주문 매출·입금 상태를 바꾸지 않습니다.</p>';
    const retry='<button type="button" class="btn" onclick="refreshDashboardConsignment()">정산 다시 불러오기</button>';
    const wrap=body=>`<section id="dash-consignment" class="card consign-panel" aria-label="면세점 월별 정산">${header}<div class="consign-body">${body}${basis}</div></section>`;
    if(!state||state.status==='idle'||state.status==='loading')return wrap('<p role="status">정산 자료를 불러오는 중입니다.</p>');
    if(state.status!=='ready')return wrap(`<p role="alert">정산 자료를 불러오지 못했습니다. 연결·로그인·접근 권한을 확인해 주세요.</p>${retry}`);
    let s;
    try{s=summarize(state.rows,period,customers);}catch{return wrap(`<p role="alert">정산 자료가 일치하지 않아 금액을 표시하지 않았습니다. 자료를 다시 확인해 주세요.</p>${retry}`);}
    const scope=`<p class="consign-scope">${escape(period.start.slice(0,7))} ~ ${escape(period.end.slice(0,7))} · ${escape(period.customer||'전체 거래처')} · <strong>마감 월 기준</strong> · 조회 ${s.rows.length}건 / 전체 등록 ${s.totalRegistered}건</p>`;
    if(!s.rows.length)return wrap(`${scope}<p>이 범위에 등록된 정산 자료가 없습니다.</p>${retry}`);
    const depositNote=s.missingDeposits?`<em>실입금 미확인 ${s.missingDeposits}건 제외</em>`:'';
    const metrics=[
      ['입고 공급가 (매출 기준)',money(s.stocked),''],
      ['판매 정산액',money(s.sold),''],
      ['실입금',money(s.deposited),depositNote],
      ['미정산 잔액 (최근 월말 재고)',money(s.stock),`<em>${s.stockQty.toLocaleString('ko-KR')}개 · ${escape(s.stockMonths.join(', '))}</em>`]
    ].map(([label,value,extra])=>`<div><span>${label}</span><strong>${value}</strong>${extra}</div>`).join('');
    const tableRows=s.rows.map(r=>{
      const links=[evidenceLink(r.evidence?.closing_url,'마감자료'),evidenceLink(r.evidence?.reconciliation_url,'입금 대조')].filter(Boolean).join(' · ');
      const deposit=r.deposited===null?'미확인':`${money(r.deposited)}<br><span>${escape(r.deposited_date)}</span>`;
      return `<tr><td>${escape(r.month.slice(0,7))}</td><td>${escape(r.customer_name)}</td><td class="consign-money">${money(r.stocked)}</td><td class="consign-money">${money(r.sold)}</td><td class="consign-money">${deposit}</td><td class="consign-money">${money(r.stock)}<br><span>${r.stockQty.toLocaleString('ko-KR')}개</span></td><td>${links||'근거 링크 미등록'}${r.note?`<br><span>${escape(r.note)}</span>`:''}</td></tr>`;
    }).join('');
    return wrap(`${scope}<div class="consign-totals">${metrics}</div><details><summary>월별 정산 내역과 근거 보기</summary><div class="dash-table-scroll"><table><thead><tr><th>마감 월</th><th>거래처</th><th>입고 공급가</th><th>판매 정산액</th><th>실입금</th><th>월말 재고</th><th>근거</th></tr></thead><tbody>${tableRows}</tbody></table></div></details><div class="consign-refresh">${retry}</div>`);
  }
  const api={load,summarize,render};
  if(typeof module==='object'&&module.exports)module.exports=api;else root.ConsignmentSettlement=api;
})(typeof globalThis!=='undefined'?globalThis:this);
