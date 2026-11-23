(function(root){
  'use strict';
  // 거래처별 기준 소비자가(계약의 "수정 국내 소비자가").
  // 표에 행이 있으면 그 값 × 공급률, 없으면 제품 RSP(products.price) × 공급률.
  const TABLE='customer_retail_prices';
  const barcodeOf=value=>value==null?'':String(value).trim();
  const positive=value=>{const n=typeof value==='number'?value:Number(String(value??'').replace(/[₩,\s]/g,''));return String(value??'').trim()!==''&&Number.isFinite(n)&&n>0?n:null;};

  function lookup(rows,customerId,barcode){
    const code=barcodeOf(barcode);
    if(!customerId||!code)return null;
    return (Array.isArray(rows)?rows:[]).find(r=>r&&r.customer_id===customerId&&barcodeOf(r.barcode)===code)||null;
  }

  // customer: customers 행, product: products 행(없으면 null), rows: customer_retail_prices 전체
  function supplyPrice({customer,product,barcode,rows}={}){
    const rate=parseFloat(customer?.supply_rate)||null;
    const override=lookup(rows,customer?.id,barcode??product?.barcode);
    const overridePrice=override?positive(override.retail_price):null;
    const retail=overridePrice!==null?overridePrice:(Number(product?.price)||0);
    const source=overridePrice!==null?'customer':'rsp';
    const price=rate&&retail?Math.round(retail*rate/100):null;
    return {price,retail,rate,source,note:override?.note||'',rsp:Number(product?.price)||0};
  }

  function basisLabel(result){
    if(!result)return '';
    return result.source==='customer'?`거래처 기준가${result.note?' ('+result.note+')':''}`:'RSP 판매가';
  }

  // 엑셀에서 복사한 "바코드<TAB>기준 소비자가<TAB>메모" 줄을 읽습니다.
  function parsePaste(text){
    const rows=[],errors=[];
    String(text||'').split(/\r?\n/).forEach((line,index)=>{
      if(!line.trim())return;
      const cells=line.includes('\t')?line.split('\t'):line.trim().split(/\s+/);
      const barcode=barcodeOf(cells[0]);
      if(/^(barcode|바코드)$/i.test(barcode))return;
      const retail=positive(cells[1]);
      if(!barcode||retail===null){errors.push(`${index+1}번째 줄: 바코드와 기준 소비자가(0보다 큰 숫자)를 확인해 주세요.`);return;}
      rows.push({barcode,retail_price:retail,note:String(cells.slice(2).join(' ')||'').trim()});
    });
    return {rows,errors};
  }

  // 편집 화면의 행(draft)과 현재 DB 행(before)을 비교해 변경요청 작업을 만듭니다.
  function planChanges({customerId,before,draft}={}){
    const errors=[],changes=[];
    const current=(Array.isArray(before)?before:[]).filter(r=>r&&r.customer_id===customerId);
    const seen=new Set();
    const kept=new Set();
    (Array.isArray(draft)?draft:[]).forEach((row,index)=>{
      const barcode=barcodeOf(row?.barcode);
      const retail=positive(row?.retail_price);
      const note=String(row?.note??'').trim();
      if(!barcode&&String(row?.retail_price??'').trim()===''&&!note)return;
      const label=`기준 소비자가 ${index+1}번째 행`;
      if(!barcode){errors.push(`${label}: 바코드를 입력해 주세요.`);return;}
      if(barcode.length>64){errors.push(`${label}: 바코드가 너무 깁니다.`);return;}
      if(retail===null){errors.push(`${label}: 기준 소비자가는 0보다 큰 숫자로 입력해 주세요.`);return;}
      if(note.length>500){errors.push(`${label}: 메모는 500자 이하로 입력해 주세요.`);return;}
      if(seen.has(barcode)){errors.push(`${label}: 바코드 ${barcode}가 중복됩니다.`);return;}
      seen.add(barcode);
      const old=row?.id?current.find(r=>r.id===row.id):current.find(r=>barcodeOf(r.barcode)===barcode&&!kept.has(r.id));
      if(old){
        kept.add(old.id);
        const values={};
        if(barcodeOf(old.barcode)!==barcode)values.barcode=barcode;
        if(Number(old.retail_price)!==retail)values.retail_price=retail;
        if(String(old.note||'')!==note)values.note=note;
        if(Object.keys(values).length)changes.push([TABLE,'update',{id:old.id},values,old]);
      }else{
        changes.push([TABLE,'insert',{},{customer_id:customerId,barcode,retail_price:retail,note},null]);
      }
    });
    current.forEach(old=>{if(!kept.has(old.id))changes.push([TABLE,'delete',{id:old.id},{},old]);});
    // 바코드를 다른 행으로 옮기는 경우 unique 충돌을 피하도록 삭제를 먼저 적용합니다.
    changes.sort((a,b)=>(a[1]==='delete'?0:1)-(b[1]==='delete'?0:1));
    return {errors,changes:errors.length?[]:changes};
  }

  const api={TABLE,lookup,supplyPrice,basisLabel,parsePaste,planChanges};
  if(typeof module==='object'&&module.exports)module.exports=api;else root.CustomerPrices=api;
})(typeof globalThis!=='undefined'?globalThis:this);
