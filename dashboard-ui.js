let _dashPeriod=null, _dashSnapshot=null;
function dashboardPeriod(){
  if(!_dashPeriod){const year=today().slice(0,4);_dashPeriod={start:year+'-01-01',end:year+'-12-31'};}
  if(_dashPeriod.allTime)_dashPeriod={..._dashPeriod,...DashboardModel.allTimePeriod(_invoices,today())};
  return _dashPeriod;
}
function dashboardControls(summary){
  const period=dashboardPeriod();
  const customers=[...new Set([..._customers.map(c=>c.name),..._invoices.map(v=>v.customer),period.customer].filter(Boolean))].sort((a,b)=>a.localeCompare(b,'ko'));
  const years=[...new Set([today().slice(0,4),period.start.slice(0,4),..._invoices.map(v=>(v.order_date||'').slice(0,4)).filter(v=>/^\d{4}$/.test(v))])].sort().reverse();
  return `<section class="card dash-filters" aria-label="대시보드 조회 기간">
    <form onsubmit="event.preventDefault();applyDashboardPeriod()">
      <label>연도<select id="dash-year" onchange="setDashboardYear(this.value)">${period.allTime?'<option value="" disabled selected>전체 기간</option>':''}${years.map(y=>`<option ${!period.allTime&&y===period.start.slice(0,4)?'selected':''}>${y}</option>`).join('')}</select></label>
      <label>시작일<input id="dash-start" type="date" required value="${period.start}"></label>
      <label>종료일<input id="dash-end" type="date" required value="${period.end}"></label>
      <label>거래처<select id="dash-customer" onchange="applyDashboardPeriod(true)"><option value="">전체 거래처</option>${customers.map(c=>`<option value="${esc(c)}" ${c===period.customer?'selected':''}>${esc(c)}</option>`).join('')}</select></label>
      <button class="btn btn-primary" type="submit">조회 적용</button>
      <button class="btn" type="button" onclick="setDashboardMonth()">이번 달</button>
      <button class="btn" type="button" onclick="setDashboardYear(today().slice(0,4))">올해 전체</button>
      <button class="btn ${period.allTime?'btn-primary':''}" type="button" onclick="setDashboardAllTime()" aria-pressed="${!!period.allTime}">전체 기간</button>
    </form>
    <p id="dash-period-error" role="alert"></p>
    <p class="dash-period-summary">${period.allTime?'전체 기간 · ':''}${period.start} ~ ${period.end} · ${esc(period.customer||'전체 거래처')} · 발주일 기준 · 취소 제외 주문 ${summary.rows.length}건</p>
    ${summary.missingDates?`<p class="dash-tax-warning">발주일 누락·형식 오류 ${summary.missingDates}건은 ${period.allTime?'전체 기간 조회에서도 ':''}집계에서 제외됩니다.</p>`:''}
  </section>`;
}
function dashboardBasis(summary){
  return `<div class="dash-basis-panel">
    <details><summary>매출 집계 기준 보기</summary>
      <p>총매출(등록금액)은 조회 기간의 취소 제외 Paid 품목 수량 × 저장 단가 합계입니다. 세금 기준 확인 필요 금액을 포함하며, 입금액이나 확정 공급가액을 뜻하지 않습니다. 공급가액 분석은 거래처 마스터의 영세·과세를 기본값으로 사용합니다.</p>
      <p>영세 거래는 세금 관련 예외 비고가 없으면 저장 금액을 공급가액 집계분에 반영합니다. 과세 거래의 단가 기준, 마스터 누락·중복, 세금 관련 비고가 있는 주문은 확인 필요 금액으로 분리합니다. 메모만으로 세금 구분을 변경하거나 1.1로 일괄 나누지 않습니다. 공급가액 집계분은 거래 증빙 검토 완료를 의미하지 않습니다.</p>
      <p>무료 제공 평가금액은 FOC·GWP·Sample 품목과 기존 인보이스 FOC 금액의 합계로 매출과 분리합니다. Lost는 Lost 품목의 저장 금액입니다. 두 평가금액은 세액 환산을 하지 않습니다.</p>
      <p>카드·그래프·거래처·담당자 집계에 같은 조회 기간과 거래처 조건을 적용합니다. 선택한 거래처 범위에서 발주일 누락·형식 오류 ${summary.missingDates}건은 기간 집계에서 제외됩니다. 담당자별 매출은 과거 거래 당시 기록이며 현재 업무 배분을 뜻하지 않습니다. 금액은 소수 단가로 계산하고 화면에서 원 단위로 반올림합니다.</p>
    </details>
    <p class="dash-basis">공급가액 집계분 + 세금 기준 확인 필요 금액${summary.displayAdjustment?` + 표시 반올림 차이 ${fmt(summary.displayAdjustment)}`:''} = 취소 제외 Paid 기록액 ${fmt(summary.recordedRevenue)} · 취소 제외 ${summary.cancelledCount}건</p>
    ${summary.pendingCount?`<p class="dash-tax-warning">세금 기준 확인 필요 ${summary.pendingCount}건은 공급가액 카드·그래프·달성률에서 제외된 상태입니다. 전체 매출 확정값이 아닙니다.</p>`:''}
  </div>`;
}
function applyDashboardPeriod(keepAllTime=false){
  const p={start:document.getElementById('dash-start').value,end:document.getElementById('dash-end').value,customer:document.getElementById('dash-customer').value};
  try{DashboardModel.summarize([],[],p);}catch(e){document.getElementById('dash-period-error').textContent=e.message;return;}
  p.allTime=!!(keepAllTime&&_dashPeriod?.allTime&&p.start===_dashPeriod.start&&p.end===_dashPeriod.end);
  _dashPeriod=p;renderDash();
}
function setDashboardYear(year){_dashPeriod={...dashboardPeriod(),start:year+'-01-01',end:year+'-12-31',allTime:false};renderDash();}
function setDashboardAllTime(){_dashPeriod={...dashboardPeriod(),...DashboardModel.allTimePeriod(_invoices,today()),allTime:true};renderDash();}
function setDashboardMonth(){
  const date=today(),year=Number(date.slice(0,4)),month=Number(date.slice(5,7));
  _dashPeriod={...dashboardPeriod(),start:date.slice(0,7)+'-01',end:date.slice(0,7)+'-'+new Date(year,month,0).getDate(),allTime:false};renderDash();
}
function dashboardMetricCard(metric,label,value,sub=''){
  return `<button type="button" class="kpi dash-metric ${metric==='recordedRevenue'?'dash-primary':''}" onclick="openDashboardEvidence('${metric}')"><span class="lbl">${label}</span><span class="val">${fmt(value)}</span><span class="sub">${sub||'근거 주문 보기 →'}</span></button>`;
}
function dashboardGoalCard(){
  const goal=5000000000,p=dashboardPeriod();
  const eligible=!p.allTime&&p.start==='2026-01-01'&&p.end==='2026-12-31'&&!p.customer;
  const progress=eligible?(_dashSnapshot.revenue/goal*100).toFixed(2):null;
  return `<div class="kpi"><div class="lbl">2026년 연간 목표 · 전체 거래처</div><div class="val">${fmt(goal)}</div><div class="sub">${eligible?`공급가액 집계분 기준 ${progress}%${_dashSnapshot.pendingCount?' (잠정)':''}<br>${_dashSnapshot.pendingCount?'세금 기준 확인 필요 금액 제외':'2026-01-01 ~ 2026-12-31'}`:'달성률은 2026년 전체·전체 거래처 조회에서 표시합니다.'}</div></div>`;
}
function openDashboardEvidence(metric){
  if(!_dashSnapshot)return;
  const labels={recordedRevenue:'총매출(등록금액)',revenue:'공급가액 집계분',pendingRevenue:'세금 기준 확인 필요 금액',foc:'무료 제공 평가금액',lost:'Lost 금액'};
  if(!labels[metric])return;
  const evidence=DashboardModel.evidence(_dashSnapshot,metric),rows=evidence.rows;
  document.getElementById('dash-evidence')?.remove();
  const dialog=document.createElement('dialog');dialog.id='dash-evidence';dialog.className='dash-evidence';
  dialog.innerHTML=`<div class="mhd"><h2>${labels[metric]} 근거 주문</h2><button class="btn" onclick="closeDashboardEvidence()" autofocus>닫기</button></div>
    <div class="dash-evidence-body"><p>${_dashPeriod.start} ~ ${_dashPeriod.end} · ${esc(_dashPeriod.customer||'전체 거래처')} · ${rows.length}건 · 합계 <strong>${fmt(_dashSnapshot[metric])}</strong></p>
    <p>${metric==='recordedRevenue'?'취소 제외 Paid 품목의 저장 금액 합계입니다. 세금 기준 확인 필요 금액을 포함하며 입금액이나 확정 공급가액이 아닙니다.':metric==='pendingRevenue'?'아래 금액은 저장된 Paid 기록액이며 공급가액으로 확정되지 않았습니다. 세금 구분·단가 기준을 확인할 증빙이 필요합니다.':'각 금액은 이 카드에 포함된 품목만 집계합니다.'} 주문 상세에서는 전체 품목을 확인할 수 있습니다.</p>
    <div class="dash-table-scroll"><table><thead><tr><th>주문번호</th><th>거래처</th><th>발주일</th><th>세금 구분</th><th>분류 근거·확인 사유</th><th>집계 금액</th></tr></thead><tbody>${rows.map(r=>`<tr><td><button class="alink" data-invoice="${esc(r.invoice.id)}">${esc(r.invoice.no||'번호 없음')}</button></td><td>${esc(r.invoice.customer)}</td><td>${esc(r.invoice.order_date)}</td><td>${esc(r.tax?.type||'미확인')}</td><td class="dash-tax-reason">${esc(r.tax?.reason||'')}</td><td>${fmt(r[metric])}</td></tr>`).join('')||'<tr><td colspan="6">이 기간에 해당하는 주문이 없습니다.</td></tr>'}</tbody><tfoot>${evidence.adjustment?`<tr><td colspan="5">원 단위 표시 반올림 차이 (거래 금액 보정 아님)</td><td>${fmt(evidence.adjustment)}</td></tr>`:''}<tr><th colspan="5">카드 집계 합계</th><td>${fmt(evidence.displayTotal)}</td></tr></tfoot></table></div></div>`;
  dialog.querySelectorAll('[data-invoice]').forEach(button=>button.addEventListener('click',()=>{const id=button.dataset.invoice;closeDashboardEvidence();viewInv(id);}));
  dialog.addEventListener('close',()=>{dialog.remove();document.querySelector(`[onclick="openDashboardEvidence('${metric}')"]`)?.focus();});
  document.body.appendChild(dialog);dialog.showModal();
}
function closeDashboardEvidence(){document.getElementById('dash-evidence')?.close();}
