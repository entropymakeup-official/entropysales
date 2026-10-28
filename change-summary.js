(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.ChangeSummary=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  // Readable "what changes" summary of change-request operations, compared from each
  // operation's `before` snapshot and its `values`/`invoice`/`items`. Shown when a
  // request is confirmed (approval dialog, request list, submit reason dialog).
  const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const labels={no:'인보이스 번호',customer:'거래처',mgr:'담당자',order_date:'발주일',pay_date:'입금일',ship_date:'출고일',status:'상태',ship_status:'출고 상태',foc:'FOC',note:'비고(메모)',
    tracking_num:'운송장번호',ref_invoice_id:'참고 인보이스',ref_kind:'참고 유형',name:'제품명',barcode:'바코드',sales_type:'판매 유형',ship_mode:'운송',qty:'수량',price:'단가',
    amount_override:'증빙 금액',amount_reference:'증빙 근거',invoice_id:'주문',invoice_no:'주문번호',title:'제목',date:'날짜',month:'월',value:'설정값',key:'설정 항목'};
  const tables={invoices:'인보이스',invoice_items:'인보이스 품목',customers:'거래처',products:'제품',stocks:'재고',documents:'서류',schedules:'일정',app_settings:'설정',tax_records:'세금계산서',product_details:'제품 상세',invoice_drive_documents:'Drive 증빙',contacts:'연락처',contracts:'계약서'};
  const HEADER=['no','customer','mgr','order_date','pay_date','ship_date','status','ship_status','foc','note'];
  const ITEM=['name','barcode','sales_type','ship_mode','qty','price','amount_override','amount_reference'];
  const HIDDEN=new Set(['id','created_at','updated_at']);
  const label=(key,ctx)=>ctx?.label?.(key)||labels[key]||key;
  const numeric=value=>(typeof value==='number'&&Number.isFinite(value))||(typeof value==='string'&&value.trim()!==''&&Number.isFinite(Number(value)));
  // DB rows may hold numeric columns as strings; '' and null both mean "empty".
  function same(a,b){
    const empty=v=>v===null||v===undefined||v==='';
    if(empty(a)&&empty(b))return true;
    if(numeric(a)&&numeric(b))return Number(a)===Number(b);
    return JSON.stringify(a??null)===JSON.stringify(b??null);
  }
  function show(key,value,ctx){
    if(value===null||value===undefined||value==='')return '(빈칸)';
    if(key==='ref_invoice_id'){const no=ctx?.invoiceNo?.(value);return no?no:`목록에 없는 인보이스 (${String(value).slice(0,8)}…)`;}
    if(typeof value==='boolean')return value?'예':'아니요';
    if(typeof value==='object')return JSON.stringify(value);
    return String(value);
  }
  const changeRow=(key,from,to,ctx)=>`<tr><th scope="row">${escape(label(key,ctx))}</th><td class="from">${escape(show(key,from,ctx))}</td><td class="arrow" aria-hidden="true">→</td><td class="to">${escape(show(key,to,ctx))}</td></tr>`;
  const changeTable=rows=>rows.length?`<table class="cs-table"><thead><tr><th scope="col">항목</th><th scope="col">변경 전</th><th aria-hidden="true"></th><th scope="col">변경 후</th></tr></thead><tbody>${rows.join('')}</tbody></table>`:'<p class="cs-none">실제로 바뀌는 값이 없습니다.</p>';
  const valueTable=(entries,ctx)=>entries.length?`<table class="cs-table"><tbody>${entries.map(([k,v])=>`<tr><th scope="row">${escape(label(k,ctx))}</th><td>${escape(show(k,v,ctx))}</td></tr>`).join('')}</tbody></table>`:'<p class="cs-none">값 없음</p>';
  const itemName=item=>`${item?.name||'(이름 없음)'}${item?.barcode?` · ${item.barcode}`:''}`;
  const itemFacts=(item,fields)=>fields.filter(k=>k!=='name'&&k!=='barcode'&&item?.[k]!==null&&item?.[k]!==undefined&&item?.[k]!=='').map(k=>`${labels[k]||k} ${show(k,item[k])}`).join(' · ');
  function identify(table,row){
    if(!row)return '';
    if(table==='invoices')return [row.no,row.customer,row.order_date].filter(Boolean).join(' · ');
    if(table==='invoice_items')return itemName(row);
    return String(row.name||row.title||row.no||row.company||row.key||row.barcode||row.month||'');
  }
  function itemRows(items){
    const fields=['name','barcode','sales_type','ship_mode','qty','price'].filter(k=>items.some(i=>i&&i[k]!==undefined&&i[k]!==null&&i[k]!==''));
    return `<table class="cs-table cs-items"><thead><tr><th scope="col">#</th>${fields.map(k=>`<th scope="col">${escape(labels[k])}</th>`).join('')}</tr></thead><tbody>${items.map((item,i)=>`<tr><td>${i+1}</td>${fields.map(k=>`<td>${escape(show(k,item?.[k]))}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  }
  // Items in a full invoice save replace the old list. Pair unchanged lines first,
  // then lines with the same barcode/name, so a quantity edit reads as one change.
  function diffItems(beforeItems,afterItems){
    const fields=ITEM.filter(k=>afterItems.some(i=>i&&Object.prototype.hasOwnProperty.call(i,k)));
    const restBefore=beforeItems.map((item,index)=>({item,index})),changes=[];
    const take=predicate=>{const at=restBefore.findIndex(predicate);return at<0?null:restBefore.splice(at,1)[0].item;};
    const pending=[];
    for(const after of afterItems){
      if(!take(({item})=>fields.every(k=>same(item?.[k],after?.[k]))))pending.push(after);
    }
    for(const after of pending){
      const key=String(after?.barcode||'')+'|'+String(after?.name||'');
      const before=take(({item})=>String(item?.barcode||'')+'|'+String(item?.name||'')===key);
      if(before)changes.push({kind:'수정',item:after,detail:fields.filter(k=>!same(before[k],after[k])).map(k=>`${labels[k]||k} ${show(k,before[k])} → ${show(k,after[k])}`).join(' · ')});
      else changes.push({kind:'추가',item:after,detail:itemFacts(after,fields)});
    }
    for(const {item} of restBefore)changes.push({kind:'삭제',item,detail:itemFacts(item,fields)});
    return changes;
  }
  function invoiceSection(op,ctx){
    const items=Array.isArray(op.items)?op.items:[];
    if(op.id===null||op.id===undefined||op.id===''){
      const header=HEADER.filter(k=>op.invoice&&Object.prototype.hasOwnProperty.call(op.invoice,k)&&!same(op.invoice[k],null)).map(k=>[k,op.invoice[k]]);
      const no=op.invoice?.no||'';
      return `<section class="cs-op"><h4>신규 인보이스${no?' · '+escape(no):''}</h4>${op.auto_number?'<p class="cs-note">인보이스 번호는 승인 시 확정됩니다.</p>':''}${valueTable(header,ctx)}<h5>품목 ${items.length}개</h5>${itemRows(items)}</section>`;
    }
    const before=op.before?.invoice||{},beforeItems=Array.isArray(op.before?.items)?op.before.items:[];
    const header=Object.keys(op.invoice||{}).filter(k=>!same(before[k],op.invoice[k])).map(k=>changeRow(k,before[k],op.invoice[k],ctx));
    const changes=diffItems(beforeItems,items);
    const itemHtml=changes.length?`<table class="cs-table cs-items"><thead><tr><th scope="col">구분</th><th scope="col">품목</th><th scope="col">내용</th></tr></thead><tbody>${changes.map(c=>`<tr class="cs-${c.kind==='추가'?'added':c.kind==='삭제'?'removed':'changed'}"><td>${escape(c.kind)}</td><td>${escape(itemName(c.item))}</td><td>${escape(c.detail||'—')}</td></tr>`).join('')}</tbody></table>`:'<p class="cs-none">품목 변경 없음</p>';
    return `<section class="cs-op"><h4>인보이스 수정 · ${escape(identify('invoices',before)||op.invoice?.no||'')}</h4><h5>헤더</h5>${header.length?changeTable(header):'<p class="cs-none">헤더 변경 없음</p>'}<h5>품목 (변경 전 ${beforeItems.length}개 → 변경 후 ${items.length}개)</h5>${itemHtml}</section>`;
  }
  function rowSection(op,ctx){
    const name=tables[op.table]||op.table||'자료',before=op.before||{},values=op.values||{};
    if(op.action==='update'){
      const rows=Object.keys(values).filter(k=>!same(before[k],values[k])).map(k=>changeRow(k,before[k],values[k],ctx));
      return `<section class="cs-op"><h4>${escape(name)} 수정 · ${escape(identify(op.table,before)||'대상')}</h4>${changeTable(rows)}</section>`;
    }
    if(op.action==='delete'){
      const children=op.table==='invoices'?`<p class="cs-note">함께 삭제: 품목 ${Array.isArray(op.before_items)?op.before_items.length:0}개 · Drive 증빙 연결 ${Array.isArray(op.before_drive_documents)?op.before_drive_documents.length:0}개</p>`:'';
      const keys=op.table==='invoices'?HEADER:op.table==='invoice_items'?ITEM:Object.keys(before).filter(k=>!HIDDEN.has(k));
      return `<section class="cs-op cs-delete"><h4>${escape(name)} 삭제 · ${escape(identify(op.table,before)||'대상')}</h4>${valueTable(keys.filter(k=>!same(before[k],null)).map(k=>[k,before[k]]),ctx)}${children}</section>`;
    }
    if(op.action==='insert'){
      return `<section class="cs-op"><h4>${escape(name)} 추가 · ${escape(identify(op.table,values)||'새 자료')}</h4>${valueTable(Object.entries(values).filter(([k,v])=>!HIDDEN.has(k)&&!same(v,null)),ctx)}</section>`;
    }
    return `<section class="cs-op"><h4>${escape(name)} 변경</h4></section>`;
  }
  function render(operations,ctx={}){
    const ops=Array.isArray(operations)?operations:[];
    if(!ops.length)return '';
    return `<div class="change-summary">${ops.map(op=>op?.action==='invoice'?invoiceSection(op,ctx):rowSection(op||{},ctx)).join('')}</div>`;
  }
  const css='.change-summary{font-size:12px;color:#17233d}.change-summary .cs-op{margin:0 0 14px}.change-summary h4{font-size:13px;margin:0 0 6px}.change-summary h5{font-size:12px;margin:10px 0 4px;color:#4a5875}.change-summary .cs-table{width:100%;border-collapse:collapse;table-layout:auto}.change-summary .cs-table th,.change-summary .cs-table td{border:1px solid #e1e6ef;padding:5px 8px;text-align:left;vertical-align:top;overflow-wrap:anywhere;font-weight:400}.change-summary .cs-table thead th{background:#f3f5f9;font-weight:600}.change-summary tbody th{width:28%;color:#4a5875}.change-summary .from{color:#8a3b3b;text-decoration:line-through;text-decoration-color:#d9a3a3}.change-summary .to{color:#1f6741;font-weight:600}.change-summary .arrow{width:18px;color:#7a89a5;text-align:center}.change-summary .cs-added td{background:#edf7f1}.change-summary .cs-removed td{background:#fdeeee}.change-summary .cs-changed td{background:#fff8e6}.change-summary .cs-none,.change-summary .cs-note{color:#65718a;margin:4px 0}';
  return {render,diffItems,same,css,labels};
});
