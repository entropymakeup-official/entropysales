(function(root){
  'use strict';
  const clone=value=>JSON.parse(JSON.stringify(value));
  const number=value=>Number.isFinite(Number(value))?Number(value):0;
  function hasOverride(item){
    const value=item?.amount_override;
    return (typeof value==='number'||typeof value==='string'&&value.trim()!=='')&&Number.isFinite(Number(value));
  }
  function amount(item){return hasOverride(item)?Number(item.amount_override):number(item?.qty)*number(item?.price);}
  function correspondences(items,before,normalizeBarcode=false){
    const key=item=>JSON.stringify([item.name??null,normalizeBarcode?item.barcode??'':item.barcode??null,item.sales_type??null,item.qty==null?null:number(item.qty),item.price==null?null:number(item.price)]);
    const old=new Map(),counts=new Map();
    before.forEach(item=>{const k=key(item);if(!old.has(k))old.set(k,[]);old.get(k).push(item);});
    items.forEach(item=>{const k=key(item);counts.set(k,(counts.get(k)||0)+1);});
    return items.map(item=>{const k=key(item),matches=old.get(k);return counts.get(k)===1&&matches?.length===1?matches[0]:null;});
  }
  // A blank HTML input loses NULL. Restore it only with a unique full match on
  // both sides; ambiguous NULL/empty source rows must still fail the SQL guard.
  function preserveBlankBarcodes(items,before=[]){
    const matches=correspondences(items,before,true);
    return items.map((item,index)=>item.barcode===''&&matches[index]?.barcode===null?{...item,barcode:null}:item);
  }
  function previewAmounts(items,before=[]){
    const replacements=preserveBlankBarcodes(items,before),matches=correspondences(replacements,before);
    return replacements.map((item,index)=>matches[index]?amount(matches[index]):number(item.qty)*number(item.price));
  }
  function values(row){
    const text=String(row.override??'').trim();
    if(!text)return {amount_override:null,amount_reference:null};
    if(!/^[+-]?(?:\d+(?:\.\d{0,2})?|\.\d{1,2})$/.test(text)||!Number.isFinite(Number(text))||Math.abs(Number(text))>=1e16)
      throw Error('증빙 금액은 소수 둘째 자리까지의 숫자로 입력해 주세요.');
    const reference=String(row.reference??'').trim();
    if(!reference)throw Error('증빙 금액을 입력한 품목에는 증빙 근거가 필요합니다.');
    return {amount_override:Number(text),amount_reference:reference};
  }
  function createController({client,timeoutMs=20000,onChange=()=>{}}){
    const state={rows:[],busy:false,error:'',message:''};let epoch=0,pending=null,attempt=null;
    function reset(){epoch++;pending=null;attempt=null;Object.assign(state,{rows:[],busy:false,error:'',message:''});onChange();}
    function open(items){reset();state.rows=items.filter(item=>item.sales_type==='Paid').map(item=>({before:clone(item),override:hasOverride(item)?String(item.amount_override):'',reference:item.amount_reference??''}));onChange();}
    function submit(options={}){
      if(pending)return pending;
      const started=epoch,rows=clone(state.rows);state.busy=true;state.error='';state.message='';onChange();
      pending=Promise.resolve().then(async()=>{
        let timer;
        try{
          const changes=rows.map(row=>({row,patch:values(row)})).filter(({row,patch})=>
            patch.amount_override!==(hasOverride(row.before)?Number(row.before.amount_override):null)||patch.amount_reference!==(row.before.amount_reference??null));
          if(!changes.length){state.message='변경한 증빙 금액이나 근거가 없습니다.';return null;}
          const request=async()=>{
            const operations=await Promise.all(changes.map(({row,patch})=>client.row('invoice_items','update',{id:row.before.id},patch,row.before)));
            if(started!==epoch)return null;
            const key=JSON.stringify(operations);
            if(!attempt||attempt.key!==key){
              const current={key};attempt=current;
              current.promise=Promise.resolve().then(()=>started===epoch?client.submit(operations,options):null).catch(error=>{if(attempt===current)attempt=null;throw error;});
            }
            return attempt.promise;
          };
          const result=await Promise.race([request(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('응답 대기 시간이 지났습니다. 접수 여부는 변경 요청 목록에서 확인해 주세요.')),timeoutMs);})]);
          if(started!==epoch)return null;
          attempt=null;
          if(result)state.message=result.status==='pending'?'변경 요청이 접수됐습니다. 관리자 승인 대기 중입니다.':'접수된 요청 상태를 변경 요청 목록에서 확인해 주세요. 확정 자료는 새로고침 후 확인할 수 있습니다.';
          return result;
        }catch(error){if(started===epoch)state.error='요청 실패 또는 접수 확인 필요: '+(error?.message||String(error))+' 입력을 유지했습니다.';return null;}
        finally{clearTimeout(timer);if(started===epoch){pending=null;state.busy=false;onChange();}}
      });
      return pending;
    }
    return {state,open,submit,reset};
  }
  function editorWarning(items){return items.some(hasOverride)?'증빙 금액이 있는 주문입니다. 이름·바코드·유형·수량·단가가 그대로인 유일 품목은 증빙을 유지합니다. 품목 변경·삭제·중복 추가 전에는 상세의 증빙 금액에서 해제를 요청하고 승인을 받아 주세요. 아래 금액은 편집 미리보기이며 확정 자료는 승인 후 변경됩니다.':'';}
  function mount({document,client,auth,onMessage=()=>{},timeoutMs}){
    const el=id=>document.getElementById(id);
    const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const money=value=>'₩'+number(value).toLocaleString('ko-KR',{maximumFractionDigits:2});
    let generation=0,actor,controller;
    function update(){
      const s=controller.state;
      el('invoice-amount-error').textContent=s.error;
      el('invoice-amount-message').textContent=s.message;
      el('invoice-amount-submit').disabled=s.busy||!s.rows.length;
      el('invoice-amount-submit').textContent=s.busy?'요청 중...':'변경 요청 제출';
      el('invoice-amount-reason').disabled=s.busy;
      el('invoice-amount-rows').querySelectorAll('input,textarea').forEach(input=>{input.disabled=s.busy;});
    }
    controller=createController({client,timeoutMs,onChange:update});
    function close(){
      generation++;controller.reset();
      el('m-invoice-amount').classList.remove('open');
      el('invoice-amount-rows').innerHTML='';el('invoice-amount-title').textContent='';
      el('invoice-amount-reason').value='';
    }
    function open(invoice,items){
      generation++;controller.open(items);
      el('invoice-amount-reason').value='';
      el('invoice-amount-title').textContent=invoice.no+' · 증빙 금액';
      el('invoice-amount-rows').innerHTML=controller.state.rows.map((row,index)=>{
        const item=row.before;
        return `<tr data-amount-row="${index}"><td><strong>${escape(item.name)}</strong><small>${escape(item.barcode||'바코드 없음')}</small></td><td class="amount-number">${escape(item.qty)}</td><td class="amount-number">${money(item.price)}</td><td class="amount-number">${money(number(item.qty)*number(item.price))}</td><td class="amount-number">${money(amount(item))}</td><td><input id="invoice-amount-value-${index}" type="text" inputmode="decimal" aria-label="${index+1}행 증빙 금액" placeholder="빈칸: 해제" value="${escape(row.override)}"/></td><td><textarea id="invoice-amount-reference-${index}" aria-label="${index+1}행 증빙 근거" placeholder="문서명·페이지·원본 링크 등"${row.override!==''?' required':''}>${escape(row.reference)}</textarea></td></tr>`;
      }).join('')||'<tr><td colspan="7">증빙 금액을 요청할 Paid 품목이 없습니다.</td></tr>';
      controller.state.rows.forEach((row,index)=>{
        const input=el('invoice-amount-value-'+index),reference=el('invoice-amount-reference-'+index);
        input.addEventListener('input',()=>{reference.required=input.value.trim()!=='';});
      });
      update();el('m-invoice-amount').classList.add('open');
    }
    async function submit(){
      if(controller.state.busy)return null;
      const reason=el('invoice-amount-reason').value.trim();
      if(!reason||reason.length>2000){controller.state.error='변경 사유를 1~2000자로 입력해 주세요.';update();return null;}
      const started=generation;
      controller.state.rows.forEach((row,index)=>{row.override=el('invoice-amount-value-'+index).value;row.reference=el('invoice-amount-reference-'+index).value;});
      const result=await controller.submit({reason});
      if(result&&started===generation){const message=controller.state.message;close();onMessage(message);}
      return result;
    }
    auth?.onAuthStateChange?.((event,session)=>{const next=session?.user?.id||null;if(event==='SIGNED_OUT'||actor!==undefined&&next!==actor)close();actor=next;});
    return {open,submit,close,reset:close};
  }
  const api={amount,hasOverride,preserveBlankBarcodes,previewAmounts,createController,editorWarning,mount};
  if(typeof module==='object'&&module.exports)module.exports=api;else root.InvoiceAmounts=api;
})(typeof globalThis!=='undefined'?globalThis:this);
