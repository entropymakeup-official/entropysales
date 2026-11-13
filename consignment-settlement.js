(function(root){
  'use strict';
  // 면세점처럼 입고분은 매출(계산서)로 잡고, 대금은 팔린 만큼 다음 달에 정산받는 거래처의 월별 정산 현황과 검증.
  // select('*'): 검증 칸 설치 전후 모두 읽을 수 있게 한다.
  const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money=value=>'₩'+Math.round(value).toLocaleString('ko-KR');
  const qty=value=>Number(value).toLocaleString('ko-KR');
  function validDate(value){
    return typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&!Number.isNaN(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
  }
  function amount(value,{nonNegative=false}={}){
    if(!['number','string'].includes(typeof value)||String(value).trim()==='')throw new Error('정산 금액을 확인해야 합니다.');
    const n=Number(value);
    if(!Number.isFinite(n)||Math.abs(n)>Number.MAX_SAFE_INTEGER||(nonNegative&&n<0))throw new Error('정산 금액 범위를 확인해야 합니다.');
    return n;
  }
  function optionalCount(value,{nonNegative=true}={}){
    if(value===null||value===undefined)return null;
    const n=Number(value);
    if(!Number.isSafeInteger(n)||(nonNegative&&n<0))throw new Error('정산 수량을 확인해야 합니다.');
    return n;
  }
  function validate(rows){
    if(!Array.isArray(rows))throw new Error('정산 자료를 확인해야 합니다.');
    const seen=new Set();
    return rows.map(row=>{
      if(!row||typeof row.customer_id!=='string'||!row.customer_id||!validDate(row.month)||!row.month.endsWith('-01'))throw new Error('정산 월·거래처를 확인해야 합니다.');
      const line=typeof row.line==='string'&&row.line.trim()?row.line.trim():'기본';
      const key=row.customer_id+'|'+row.month+'|'+line;
      if(seen.has(key))throw new Error('같은 거래처·월·라인의 정산 자료가 중복되었습니다.');
      seen.add(key);
      const hasDeposit=row.deposited_amount!==null&&row.deposited_amount!==undefined;
      if(hasDeposit!==(row.deposited_date!==null&&row.deposited_date!==undefined)||(hasDeposit&&!validDate(row.deposited_date)))throw new Error('실입금 금액과 날짜를 확인해야 합니다.');
      if(!Number.isSafeInteger(Number(row.ending_stock_qty))||Number(row.ending_stock_qty)<0)throw new Error('월말 재고 수량을 확인해야 합니다.');
      const verifiedBy=row.verified_by??null,verifiedAt=row.verified_at??null;
      if((verifiedBy===null)!==(verifiedAt===null))throw new Error('검증자와 검증일을 확인해야 합니다.');
      return {...row,line,stocked:amount(row.stocked_supply),sold:amount(row.sold_supply),deposited:hasDeposit?amount(row.deposited_amount):null,
        stockQty:Number(row.ending_stock_qty),stock:amount(row.ending_stock_supply,{nonNegative:true}),
        openingQty:optionalCount(row.opening_stock_qty),inQty:optionalCount(row.in_qty),returnQty:optionalCount(row.return_qty),
        soldQty:optionalCount(row.sold_qty,{nonNegative:false}),verifiedBy,verifiedAt};
    });
  }
  // 점검 상태: ok(맞음) / explained(차이 있으나 메모로 설명) / pending(아직 확인 전) / missing(근거 미등록) / fail(불일치) / na(해당 없음)
  function checkRows(checked){
    const prev=new Map(),byStore=new Map();
    [...checked].sort((a,b)=>a.month.localeCompare(b.month)).forEach(r=>{
      const k=r.customer_id+'|'+r.line,list=byStore.get(k)||[];
      prev.set(r,list[list.length-1]||null);list.push(r);byStore.set(k,list);
    });
    return checked.map(r=>{
      const hasNote=typeof r.note==='string'&&r.note.trim()!=='';
      const checks=[];
      // 1. 재고: 기초+입고−반품−판매=기말, 기초=지난달 기말
      if([r.openingQty,r.inQty,r.returnQty,r.soldQty].some(v=>v===null))checks.push({key:'stock',status:'missing',label:'재고 수량 미입력'});
      else{
        const flow=r.openingQty+r.inQty-r.returnQty-r.soldQty;
        const p=prev.get(r);
        if(flow!==r.stockQty)checks.push({key:'stock',status:'fail',label:`재고 흐름 불일치 (계산 ${qty(flow)}개, 기말 ${qty(r.stockQty)}개)`});
        else if(p&&p.stockQty!==r.openingQty)checks.push({key:'stock',status:'fail',label:`기초 ${qty(r.openingQty)}개 ≠ 지난달 기말 ${qty(p.stockQty)}개`});
        else checks.push({key:'stock',status:'ok',label:'재고 흐름 일치'});
      }
      // 2. 판매 정산액 ↔ 실입금: VAT 별도(=판매액) 또는 VAT 포함(판매액×1.1, 단수 차이 0.01% 이내)
      if(r.deposited===null)checks.push({key:'deposit',status:'pending',label:'실입금 미확인'});
      else{
        const plain=r.deposited-r.sold,withVat=r.deposited-Math.round(r.sold*1.1),tol=Math.max(10,Math.abs(r.sold)*0.0001);
        if(Math.abs(plain)<=1)checks.push({key:'deposit',status:'ok',label:'입금 = 판매 정산액'});
        else if(Math.abs(withVat)<=tol)checks.push({key:'deposit',status:'ok',label:withVat?`입금 = 판매액+VAT (단수 ${withVat>0?'+':''}${withVat.toLocaleString('ko-KR')}원)`:'입금 = 판매액+VAT'});
        else checks.push({key:'deposit',status:hasNote?'explained':'fail',label:`입금 차이 ${plain>0?'+':''}${plain.toLocaleString('ko-KR')}원${hasNote?' (메모 참고)':''}`});
      }
      // 3. 근거 등록: 입고가 있으면 세금계산서 근거, 마감자료는 항상
      if(r.stocked===0)checks.push({key:'invoice',status:'na',label:'입고 없음 (계산서 없음)'});
      else{
        const aps=approvals(r.evidence?.hometax_approval);
        const label=r.evidence?.tax_invoice_url?'계산서 근거 있음':aps.length?`홈택스 승인번호 ${aps.length}건`:'계산서 근거 미등록';
        checks.push({key:'invoice',status:r.evidence?.tax_invoice_url||aps.length?'ok':'missing',label});
      }
      checks.push({key:'closing',status:r.evidence?.closing_url?'ok':'missing',label:r.evidence?.closing_url?'마감자료 있음':'마감자료 미등록'});
      // 4. 검증 기록
      checks.push({key:'verified',status:r.verifiedBy?'ok':'missing',label:r.verifiedBy?`검증 ${r.verifiedBy}`:'검증 기록 없음'});
      const worst=checks.some(c=>c.status==='fail')?'fail':checks.some(c=>['missing','pending'].includes(c.status))?'needs':'ok';
      return {...r,checks,status:worst};
    });
  }
  function summarize(rows,period,customers){
    if(!validDate(period.start)||!validDate(period.end)||period.start>period.end)throw new Error('조회 기간이 올바르지 않습니다.');
    const checked=checkRows(validate(rows)),byId=new Map(customers.map(c=>[c.id,c]));
    const first=period.start.slice(0,7)+'-01',last=period.end.slice(0,7)+'-01';
    const selected=checked.filter(r=>r.month>=first&&r.month<=last&&(!period.customer||byId.get(r.customer_id)?.name===period.customer))
      .map(r=>{const customer_name=byId.get(r.customer_id)?.name||'거래처 연결 확인 필요';return {...r,customer_name,label:customer_name+(r.line!=='기본'?' '+r.line:'')};})
      .sort((a,b)=>b.month.localeCompare(a.month)||a.customer_name.localeCompare(b.customer_name,'ko')||(a.line==='기본'?-1:b.line==='기본'?1:a.line.localeCompare(b.line,'ko')));
    const result={rows:selected,totalRegistered:checked.length,stocked:0,sold:0,deposited:0,missingDeposits:0,stock:0,stockQty:0,stockMonths:[],issues:0,failures:0,lines:[]};
    const latest=new Map();
    for(const r of selected){
      result.stocked+=r.stocked;result.sold+=r.sold;
      if(r.deposited===null)result.missingDeposits++;else result.deposited+=r.deposited;
      if(r.status!=='ok')result.issues++;
      if(r.status==='fail')result.failures++;
      const lk=r.customer_id+'|'+r.line;
      if(!latest.has(lk))latest.set(lk,r); // rows are newest first
    }
    for(const r of latest.values()){result.stock+=r.stock;result.stockQty+=r.stockQty;result.stockMonths.push(r.label+' '+r.month.slice(0,7));}
    // 라인별 누적: 시작 기초 + 누적 입고 − 반품 − 판매 = 마지막 기말 (수량), 누적 입고·판매·입금 (금액)
    for(const [lk,last] of latest){
      const list=selected.filter(r=>r.customer_id+'|'+r.line===lk).sort((a,b)=>a.month.localeCompare(b.month));
      const first=list[0],complete=list.every(r=>[r.openingQty,r.inQty,r.returnQty,r.soldQty].every(v=>v!==null));
      const c={label:last.label,from:first.month.slice(0,7),to:last.month.slice(0,7),months:list.length,stocked:0,sold:0,deposited:0,pending:0,inQty:0,returnQty:0,soldQty:0,
        startQty:complete?first.openingQty:null,endQty:last.stockQty,endAmt:last.stock};
      for(const r of list){c.stocked+=r.stocked;c.sold+=r.sold;if(r.deposited===null)c.pending++;else c.deposited+=r.deposited;if(complete){c.inQty+=r.inQty;c.returnQty+=r.returnQty;c.soldQty+=r.soldQty;}}
      c.flowOk=complete?c.startQty+c.inQty-c.returnQty-c.soldQty===c.endQty:null;
      result.lines.push(c);
    }
    for(const key of ['stocked','sold','deposited','stock'])amount(result[key]);
    return result;
  }
  // 대시보드 주문(발주월 기준) 합계: 참고용. 주문 금액은 VAT 포함·별도가 섞여 있어 자동 판정하지 않는다.
  function orderTotals(invoices,items,amountOf){
    const byInvoice=new Map();
    for(const i of items||[])if(i.sales_type==='Paid')byInvoice.set(i.invoice_id,(byInvoice.get(i.invoice_id)||0)+amountOf(i));
    const totals=new Map();
    for(const v of invoices||[]){
      if(v.status==='Cancelled'||!validDate(v.order_date))continue;
      const key=v.customer+'|'+v.order_date.slice(0,7)+'-01';
      totals.set(key,(totals.get(key)||0)+(byInvoice.get(v.id)||0));
    }
    return totals;
  }
  async function load(client,options={}){
    let timer,active=true;
    async function scan(){
      const rows=[];let expected=null,pages=0;
      do{
        const response=await client.from('consignment_settlements').select('*',{count:'exact'})
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
  // 홈택스 전자세금계산서 승인번호(작성일자 8자리-8자리-8자리), 쉼표로 여러 건. 형식이 하나라도 틀리면 근거로 보지 않는다.
  function approvals(value){
    if(typeof value!=='string'||!value.trim())return [];
    const list=value.split(',').map(v=>v.trim());
    return list.every(v=>/^\d{8}-\d{8}-[0-9a-z]{8}$/i.test(v))?list:[];
  }
  function evidenceLink(value,label){
    if(typeof value!=='string')return '';
    try{
      const url=new URL(value);
      const allowed=url.protocol==='https:'&&!url.username&&!url.password&&(!url.port||url.port==='443')&&
        ((url.hostname==='docs.google.com'&&url.pathname.startsWith('/spreadsheets/d/'))||(url.hostname==='drive.google.com'&&url.pathname.startsWith('/file/d/'))||
         (url.hostname==='flex.team'&&url.pathname.startsWith('/workflow/')));
      return allowed?`<a href="${escape(url.href)}" target="_blank" rel="noopener noreferrer">${label}</a>`:'';
    }catch{return '';}
  }
  const ICON={ok:'✓',explained:'ⓘ',pending:'…',missing:'－',fail:'!',na:'·'};
  const chip=c=>`<span class="consign-chip consign-${c.status}" title="${escape(c.label)}">${ICON[c.status]} ${escape(c.label)}</span>`;
  const basisNote='<p class="consign-note">입고 공급가는 계산서 발행 기준으로 대시보드 매출과 같은 기준입니다. 면세점은 팔린 만큼만 다음 달에 정산하므로 실입금은 판매 정산액을 따르고, 월말 매장 재고(납품가)만큼은 아직 정산받지 않은 금액입니다. 금액은 VAT 별도, 실입금은 통장 기준입니다. 주문 매출·입금 상태는 바꾸지 않습니다.</p>';
  const errorBody=(retry,msg)=>`<p role="alert">${msg}</p>${retry}`;
  // 메인 대시보드: 요약 카드. 상세 검증은 '면세점 정산' 메뉴.
  function render(state,period,customers){
    const header='<div class="card-hd"><h3>면세점 월별 정산</h3><button type="button" class="btn" onclick="go(\'consign\')">검증 화면 열기 →</button></div>';
    const retry='<button type="button" class="btn" onclick="refreshDashboardConsignment()">정산 다시 불러오기</button>';
    const wrap=body=>`<section id="dash-consignment" class="card consign-panel" aria-label="면세점 월별 정산">${header}<div class="consign-body">${body}</div></section>`;
    if(!state||state.status==='idle'||state.status==='loading')return wrap('<p role="status">정산 자료를 불러오는 중입니다.</p>');
    if(state.status!=='ready')return wrap(errorBody(retry,'정산 자료를 불러오지 못했습니다. 연결·로그인·접근 권한을 확인해 주세요.'));
    let s;
    try{s=summarize(state.rows,period,customers);}catch{return wrap(errorBody(retry,'정산 자료가 일치하지 않아 금액을 표시하지 않았습니다. 자료를 다시 확인해 주세요.'));}
    const scope=`<p class="consign-scope">${escape(period.start.slice(0,7))} ~ ${escape(period.end.slice(0,7))} · ${escape(period.customer||'전체 거래처')} · <strong>마감 월 기준</strong> · ${s.rows.length}건</p>`;
    if(!s.rows.length)return wrap(`${scope}<p>이 범위에 등록된 정산 자료가 없습니다.</p>`);
    const depositNote=s.missingDeposits?`<em>실입금 미확인 ${s.missingDeposits}건 제외</em>`:'';
    const metrics=[
      ['입고 공급가 (매출 기준)',money(s.stocked),''],
      ['실입금',money(s.deposited),depositNote],
      ['미정산 잔액 (최근 월말 재고)',money(s.stock),`<em>${qty(s.stockQty)}개 · ${escape(s.stockMonths.join(', '))}</em>`],
      ['검증',s.issues?`확인 필요 ${s.issues}건`:'모두 확인',s.failures?`<em class="consign-fail-text">불일치 ${s.failures}건</em>`:'']
    ].map(([label,value,extra])=>`<div><span>${label}</span><strong>${value}</strong>${extra}</div>`).join('');
    return wrap(`${scope}<div class="consign-totals">${metrics}</div>`);
  }
  // '면세점 정산' 메뉴: 월별 표 + 줄별 점검 + 근거 + 검증 기록
  function renderPage(state,filter,customers,orders){
    const retry='<button type="button" class="btn" onclick="refreshConsignPage()">다시 불러오기</button>';
    const wrap=body=>`<section id="consign-page" class="card consign-panel consign-compact" aria-label="면세점 정산 검증"><div class="consign-body">${body}<details class="consign-basis"><summary>금액 기준·점검 표시 설명</summary>${basisNote}<p class="consign-note">줄을 누르면 재고 흐름·입금 계좌·메모 등 상세가 펼쳐집니다. 점검 ✓ 맞음 · ⓘ 메모로 설명 · … 확인 전 · － 미등록 · ! 불일치 · · 해당 없음. 대시보드 주문 금액은 VAT 포함·별도가 섞여 있어 상세에 참고로만 보여 줍니다.</p></details></div></section>`;
    if(!state||state.status==='idle'||state.status==='loading')return wrap('<p role="status">정산 자료를 불러오는 중입니다.</p>');
    if(state.status!=='ready')return wrap(errorBody(retry,'정산 자료를 불러오지 못했습니다. 연결·로그인·접근 권한을 확인해 주세요.'));
    const year=filter.year,period=year==='all'?{start:'2000-01-01',end:'2099-12-31',customer:filter.customer||''}:{start:year+'-01-01',end:year+'-12-31',customer:filter.customer||''};
    let s;
    try{s=summarize(state.rows,period,customers);}catch{return wrap(errorBody(retry,'정산 자료가 일치하지 않아 표시하지 않았습니다. 자료를 다시 확인해 주세요.'));}
    const years=[...new Set([...(year==='all'?[]:[year]),...state.rows.map(r=>String(r.month).slice(0,4))])].sort().reverse();
    const allStores=[...new Set(state.rows.map(r=>customers.find(c=>c.id===r.customer_id)?.name).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'ko'));
    const controls=`<form class="consign-filters" onsubmit="event.preventDefault()">
      <label>연도<select onchange="setConsignFilter({year:this.value})"><option value="all" ${year==='all'?'selected':''}>전체 기간</option>${years.map(y=>`<option ${y===year?'selected':''}>${escape(y)}</option>`).join('')}</select></label>
      <label>매장<select onchange="setConsignFilter({customer:this.value})"><option value="">전체</option>${allStores.map(n=>`<option value="${escape(n)}" ${n===filter.customer?'selected':''}>${escape(n)}</option>`).join('')}</select></label>
      <label class="consign-check"><input type="checkbox" ${filter.issuesOnly?'checked':''} onchange="setConsignFilter({issuesOnly:this.checked})"> 확인 필요만</label>
      ${retry}</form>`;
    const metrics=[['입고 공급가',money(s.stocked)],['판매 정산액',money(s.sold)],['실입금',money(s.deposited)+(s.missingDeposits?` <em>(미확인 ${s.missingDeposits}건 제외)</em>`:'')],
      ['미정산 잔액',money(s.stock)+` <em>${qty(s.stockQty)}개</em>`],['검증',s.issues?`확인 필요 ${s.issues}건`:'모두 확인']]
      .map(([l,v])=>`<div><span>${l}</span><strong>${v}</strong></div>`).join('');
    const rows=s.rows.filter(r=>!filter.issuesOnly||r.status!=='ok');
    const SHORT={stock:'재고',deposit:'입금',invoice:'계산서',closing:'마감',verified:'검증'};
    const tableRows=rows.map((r,i)=>{
      const aps=approvals(r.evidence?.hometax_approval);
      const links=[evidenceLink(r.evidence?.closing_url,'마감'),evidenceLink(r.evidence?.tax_invoice_url,'계산서'),
        !r.evidence?.tax_invoice_url&&aps.length?`<span class="consign-memo" title="홈택스 승인번호: ${escape(aps.join(', '))}">승인번호</span>`:'',
        evidenceLink(r.evidence?.reconciliation_url,'대조')].filter(Boolean).join(' ');
      const deposit=r.deposited===null?'<span class="consign-muted">미확인</span>':`${money(r.deposited)} <span class="consign-muted">${escape(String(r.deposited_date).slice(5).replace('-','/'))}</span>`;
      const badges=r.checks.filter(c=>c.key!=='closing'||c.status!=='ok').map(c=>`<span class="consign-chip consign-${c.status}" title="${escape(c.label)}">${SHORT[c.key]}${ICON[c.status]}</span>`).join('');
      const ord=r.line==='기본'?orders?.get(r.customer_name+'|'+r.month):undefined;
      const detail=[
        r.openingQty===null?'':`재고 흐름: 기초 ${qty(r.openingQty)} + 입고 ${qty(r.inQty)} − 반품 ${qty(r.returnQty)} − 판매 ${qty(r.soldQty)} = 기말 ${qty(r.stockQty)}개`,
        r.deposited===null?'':`입금: ${escape(r.deposited_date)}${r.evidence?.deposit_account?' · '+escape(r.evidence.deposit_account):''}`,
        ord===undefined?'':`대시보드 주문(발주월, 참고): ${money(ord)}`,
        aps.length?`홈택스 승인번호: ${escape(aps.join(', '))}`:'',
        r.checks.map(c=>`${SHORT[c.key]} ${escape(c.label)}`).join(' · '),
        r.note?`메모: ${escape(r.note)}`:''
      ].filter(Boolean).map(t=>`<div>${t}</div>`).join('');
      const verified=r.verifiedBy?`<span title="${escape(String(r.verifiedAt))}">${escape(r.verifiedBy)} ${escape(String(r.verifiedAt).slice(5,10).replace('-','/'))}</span>`:'<span class="consign-muted">—</span>';
      return `<tr class="consign-row consign-row-${r.status}" onclick="const d=this.nextElementSibling;d.hidden=!d.hidden" title="눌러서 상세 보기">
        <td>${escape(r.month.slice(2,7).replace('-','.'))}</td><td>${escape(r.label.replace(/^PLMK\s*/,''))}</td>
        <td class="consign-money">${money(r.stocked)}</td><td class="consign-money">${money(r.sold)}</td><td class="consign-money">${deposit}</td>
        <td class="consign-money">${money(r.stock)} <span class="consign-muted">${qty(r.stockQty)}개</span></td>
        <td class="consign-checks">${badges}</td>
        <td class="consign-links" onclick="event.stopPropagation()">${links||'<span class="consign-muted">없음</span>'}${r.note?` <span class="consign-memo" title="${escape(r.note)}">메모</span>`:''}</td><td>${verified}</td></tr>
        <tr class="consign-detail" hidden><td colspan="9">${detail}</td></tr>`;
    }).join('');
    const empty=rows.length?'':`<p>${filter.issuesOnly?'확인이 필요한 줄이 없습니다.':'이 조건에 등록된 정산 자료가 없습니다.'}</p>`;
    const cumulative=s.lines.length?`<table class="consign-table consign-cumulative"><thead><tr><th>누적 (${escape(year==='all'?'전체 기간':year+'년')})</th><th>기간</th><th>입고 공급가</th><th>판매 정산액</th><th>실입금</th><th>재고 수량 흐름</th><th>현재 재고</th></tr></thead><tbody>${s.lines.map(c=>{
      const flow=c.flowOk===null?'<span class="consign-muted">수량 미입력 달 있음</span>':`<span class="consign-chip consign-${c.flowOk?'ok':'fail'}">${c.flowOk?'✓':'!'} ${qty(c.startQty)} +${qty(c.inQty)} −${qty(c.returnQty)} −${qty(c.soldQty)} = ${qty(c.startQty+c.inQty-c.returnQty-c.soldQty)}</span>`;
      return `<tr><td>${escape(c.label.replace(/^PLMK\s*/,''))}</td><td>${escape(c.from)}~${escape(c.to)} <span class="consign-muted">${c.months}개월</span></td><td class="consign-money">${money(c.stocked)}</td><td class="consign-money">${money(c.sold)}</td><td class="consign-money">${money(c.deposited)}${c.pending?` <span class="consign-muted">미확인 ${c.pending}</span>`:''}</td><td>${flow}</td><td class="consign-money">${money(c.endAmt)} <span class="consign-muted">${qty(c.endQty)}개</span></td></tr>`;}).join('')}</tbody></table>`:'';
    return wrap(`<div class="consign-head">${controls}<div class="consign-totals consign-totals-5">${metrics}</div></div>${cumulative}${empty}<table class="consign-table"><thead><tr><th>월</th><th>매장</th><th>입고 공급가</th><th>판매 정산액</th><th>실입금</th><th>월말 재고</th><th>점검</th><th>근거</th><th>검증</th></tr></thead><tbody>${tableRows}</tbody></table>`);
  }
  const api={load,summarize,checkRows:rows=>checkRows(validate(rows)),orderTotals,render,renderPage};
  if(typeof module==='object'&&module.exports)module.exports=api;else root.ConsignmentSettlement=api;
})(typeof globalThis!=='undefined'?globalThis:this);
