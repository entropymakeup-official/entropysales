(function(root){
  'use strict';
  const fields='approval_number,customer_id,written_date,issued_date,record_kind,currency,supply_amount,vat_amount,gross_amount,evidence';
  const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money=value=>'₩'+Math.round(value).toLocaleString('ko-KR');
  function validDate(value){
    return typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&!Number.isNaN(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
  }
  function amount(value){
    if(!['number','string'].includes(typeof value)||String(value).trim()==='')throw new Error('계산서 금액을 확인해야 합니다.');
    const n=Number(value);
    if(!Number.isFinite(n)||Math.abs(n)>Number.MAX_SAFE_INTEGER)throw new Error('계산서 금액 범위를 확인해야 합니다.');
    return n;
  }
  function validate(rows){
    if(!Array.isArray(rows))throw new Error('계산서 자료를 확인해야 합니다.');
    const seen=new Set();
    return rows.map(row=>{
      if(!row||typeof row.approval_number!=='string'||!row.approval_number.trim()||typeof row.customer_id!=='string'||!row.customer_id)throw new Error('계산서 연결 정보를 확인해야 합니다.');
      if(seen.has(row.approval_number))throw new Error('중복된 계산서 승인번호가 있습니다.');
      seen.add(row.approval_number);
      if(!validDate(row.written_date)||!validDate(row.issued_date)||row.currency!=='KRW'||!['original','correction'].includes(row.record_kind))throw new Error('계산서 날짜·통화·구분을 확인해야 합니다.');
      const supply=amount(row.supply_amount),vat=amount(row.vat_amount),gross=amount(row.gross_amount);
      if(Math.abs(supply+vat-gross)>Math.max(1,Math.abs(gross))*Number.EPSILON*8)throw new Error('공급가액과 VAT 합계가 맞지 않습니다.');
      return {...row,supply,vat,gross};
    });
  }
  function summarize(rows,period,customers){
    if(!validDate(period.start)||!validDate(period.end)||period.start>period.end)throw new Error('조회 기간이 올바르지 않습니다.');
    const checked=validate(rows),byId=new Map(customers.map(c=>[c.id,c]));
    const selected=checked.filter(r=>r.written_date>=period.start&&r.written_date<=period.end&&(!period.customer||byId.get(r.customer_id)?.name===period.customer))
      .map(r=>({...r,customer_name:byId.get(r.customer_id)?.name||'거래처 연결 확인 필요'}))
      .sort((a,b)=>b.written_date.localeCompare(a.written_date)||a.approval_number.localeCompare(b.approval_number));
    const result={rows:selected,totalRegistered:checked.length,supply:0,vat:0,gross:0};
    for(const r of selected){result.supply+=r.supply;result.vat+=r.vat;result.gross+=r.gross;}
    for(const key of ['supply','vat','gross'])amount(result[key]);
    return result;
  }
  async function load(client,options={}){
    let timer,active=true;
    async function scan(){
      const rows=[];let expected=null,pages=0;
      do{
        const response=await client.from('tax_invoice_amounts').select(fields,{count:'exact'})
          .order('written_date').order('approval_number').range(rows.length,rows.length+499);
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
    // JSONB evidence key order has no meaning; compare every selected value in a stable order.
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
        ((url.hostname==='docs.google.com'&&url.pathname.startsWith('/spreadsheets/d/'))||(url.hostname==='flex.team'&&url.pathname.startsWith('/workflow/')));
      return allowed?`<a href="${escape(url.href)}" target="_blank" rel="noopener noreferrer">${label}</a>`:'';
    }catch{return '';}
  }
  function render(state,period,customers){
    const header='<div class="card-hd"><h3>세금계산서 확인금액</h3><span class="badge bg-amber">일부 자료</span></div>';
    const basis='<p class="tax-ledger-note">확인되어 등록된 계산서만 집계합니다. 전체 매출·목표 달성률에는 합산하지 않습니다. 입금·실제 출고 완료를 뜻하지 않습니다.</p>';
    const retry='<button type="button" class="btn" onclick="refreshDashboardTaxLedger()">계산서 다시 불러오기</button>';
    const wrap=body=>`<section id="dash-tax-ledger" class="card tax-ledger-panel" aria-label="세금계산서 확인금액">${header}<div class="tax-ledger-body">${body}${basis}</div></section>`;
    if(!state||state.status==='idle'||state.status==='loading')return wrap('<p role="status">확인된 계산서 자료를 불러오는 중입니다.</p>');
    if(state.status!=='ready')return wrap(`<p role="alert">계산서 자료를 불러오지 못했습니다. 연결·로그인·접근 권한을 확인해 주세요.</p>${retry}`);
    let summary;
    try{summary=summarize(state.rows,period,customers);}catch{return wrap(`<p role="alert">계산서 자료가 일치하지 않아 금액을 표시하지 않았습니다. 자료를 다시 확인해 주세요.</p>${retry}`);}
    const scope=`<p class="tax-ledger-scope">${escape(period.start)} ~ ${escape(period.end)} · ${escape(period.customer||'전체 거래처')} · <strong>계산서 작성일 기준</strong> · 조회 ${summary.rows.length}건 / 전체 등록 ${summary.totalRegistered}건</p>`;
    if(!summary.rows.length)return wrap(`${scope}<p>현재 계정으로 조회되는 등록 계산서가 이 범위에 없습니다. 매출이 0원임을 뜻하지 않습니다.</p>${retry}`);
    const tableRows=summary.rows.map(r=>{
      const links=[evidenceLink(r.evidence?.tax_sheet_url,'세금계산서'),evidenceLink(r.evidence?.flex_url,'발급 승인')].filter(Boolean).join(' · ');
      return `<tr><td>${escape(r.customer_name)}</td><td>${escape(r.written_date)}</td><td>${escape(r.approval_number)}${r.record_kind==='correction'?'<br><span>수정계산서</span>':''}</td><td class="tax-ledger-money">${money(r.supply)}</td><td class="tax-ledger-money">${money(r.vat)}</td><td class="tax-ledger-money">${money(r.gross)}</td><td>${links||'근거 링크 미등록'}</td></tr>`;
    }).join('');
    const metrics=[['공급가액',summary.supply],['VAT',summary.vat],['합계금액',summary.gross]].map(([label,value])=>`<div><span>${label}</span><strong>${money(value)}</strong></div>`).join('');
    const rounded=summary.rows.reduce((n,r)=>n+Math.round(r.supply),0);
    const note=rounded!==Math.round(summary.supply)?'<p>행별 표시와 합계에 원 단위 반올림 차이가 있을 수 있습니다.</p>':'';
    return wrap(`${scope}<div class="tax-ledger-totals">${metrics}</div><details><summary>계산서별 금액과 근거 보기</summary><div class="dash-table-scroll"><table><thead><tr><th>거래처</th><th>작성일</th><th>승인번호</th><th>공급가액</th><th>VAT</th><th>합계금액</th><th>근거</th></tr></thead><tbody>${tableRows}</tbody></table></div>${note}</details><div class="tax-ledger-refresh">${retry}</div>`);
  }
  const api={load,summarize,render};
  if(typeof module==='object'&&module.exports)module.exports=api;else root.TaxLedger=api;
})(typeof globalThis!=='undefined'?globalThis:this);
