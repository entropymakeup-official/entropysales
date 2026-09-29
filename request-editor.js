(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.RequestEditor=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
'use strict';
const clone=v=>JSON.parse(JSON.stringify(v));
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels={status:'주문 상태',pay_date:'입금일',ship_status:'출고 상태',ship_date:'출고일',no:'주문번호',customer:'거래처',mgr:'담당자',order_date:'발주일',foc:'FOC 금액',note:'메모',name:'제품명 / 이름',barcode:'바코드',qty:'수량',price:'단가',sales_type:'판매 유형',tracking_num:'운송장번호'};
const statusKeys=['status','pay_date','ship_status','ship_date'];
const numeric=new Set(['qty','quantity','price','unit_price','amount','foc','amount_override','deposit_pct','balance_pct']);
let activeDialog=null;
function prepareInvoice(inv,requests,items){
 if(requests.length>1)throw Error('이 주문의 내 대기 요청이 여러 건입니다. 변경 요청 목록에서 수정할 요청을 선택해 주세요.');
 if(requests.length){
  const draft=clone(requests[0]);
  const targets=draft.operations.filter(op=>(op.action==='invoice'&&op.id===inv.id)||(op.table==='invoices'&&op.key?.id===inv.id));
  if(targets.length!==1||targets[0].action==='delete')throw Error('기존 요청 내용을 변경 요청 목록에서 확인해 주세요.');
  if(items&&targets[0].action==='update'){
   const old=targets[0],values={...old.before,...old.values};
   const invoice=Object.fromEntries(['no','customer','mgr','order_date','pay_date','ship_date','status','ship_status','foc','note','tracking_num'].filter(k=>k in values).map(k=>[k,values[k]]));
   // Keep fields accepted by the full-invoice endpoint; tracking is preserved by it.
   delete invoice.tracking_num;
   if(Object.keys(old.values).some(k=>!Object.keys(invoice).includes(k)))throw Error('이 요청의 변경 항목은 내 변경 요청에서 먼저 확인해 주세요.');
   const clean=items.map(it=>Object.fromEntries(['name','barcode','qty','price','sales_type'].filter(k=>k in it).map(k=>[k,it[k]])));
   draft.operations[draft.operations.indexOf(old)]={action:'invoice',id:inv.id,before:{invoice:clone(old.before),items:clone(items)},invoice,items:clean};
  }
  return draft;
 }
 return {reason:'',operations:[{table:'invoices',action:'update',key:{id:inv.id},before:clone(inv),values:Object.fromEntries(statusKeys.map(k=>[k,inv[k]??(k==='ship_status'?'준비중':null)]))}]};
}
function fields(draft){
 const result=[];
 function walk(value,path,group){
  for(const [key,v] of Object.entries(value||{})){
   if(['id','created_at','updated_at','invoice_id'].includes(key))continue;
   if(v!==null&&typeof v==='object'){walk(v,[...path,key],group+' · '+(labels[key]||key));continue;}
   result.push({key,path:[...path,key],value:v,group,type:typeof v==='boolean'?'boolean':(typeof v==='number'||numeric.has(key))?'number':/(_date|^date$)/.test(key)?'date':'text'});
  }
 }
 draft.operations.forEach((op,i)=>{
  if(op.action==='delete')return;
  const kind=op.action==='invoice'?'invoice':'values',values=op[kind]||{};
  if(op.action==='invoice'||op.table==='invoices'){
   const before=op.action==='invoice'?op.before?.invoice:op.before;
   for(const key of statusKeys)if(!(key in values))values[key]=before?.[key]??(key==='ship_status'?'준비중':key==='status'?'Ordered':null);
  }
  const start=result.length;
  walk(values,['operations',i,kind],`${i+1}. ${values.no||op.before?.no||op.before?.invoice?.no||values.name||(op.table==='invoices'?'주문':op.table)||'주문'}`);
  for(const f of result.slice(start))f.isInvoice=op.action==='invoice'||op.table==='invoices';
  if(op.action==='invoice')op.items.forEach((item,j)=>walk(item,['operations',i,'items',j],`${i+1}. 품목 ${j+1}`));
 });return result;
}
function assign(draft,field,raw){
 let value=raw;
 if(field.type==='number'){value=raw===''?null:Number(raw);if(value!==null&&!Number.isFinite(value))throw Error('숫자를 확인해 주세요.');}
 if(field.type==='boolean')value=raw==='true';
 if(field.type==='date'&&raw==='')value=null;
 if(raw===''&&field.value===null)value=null;
 let target=draft;for(const key of field.path.slice(0,-1))target=target[key];target[field.path.at(-1)]=value;
}
function input(field,index,label){
 const value=field.value??'',name=`data-field="${index}" aria-label="${esc(label||labels[field.key]||field.key)}"`,isInvoice=field.isInvoice;
 let options=field.key==='ship_status'?['준비중','출고완료']:field.key==='sales_type'?['Paid','FOC','GWP','Sample','Replacement','Lost']:field.key==='status'&&isInvoice?['Ordered','Paid','Closed','Cancelled']:field.type==='boolean'?['true','false']:null;
 if(options&&!options.includes(String(value)))options=[String(value),...options];
 const control=options?`<select ${name}>${options.map(v=>`<option value="${esc(v)}"${String(value)===v?' selected':''}>${esc(v==='true'?'예':v==='false'?'아니요':v)}</option>`).join('')}</select>`:
 field.type==='text'?`<textarea ${name} rows="2">${esc(value)}</textarea>`:`<input ${name} type="${field.type}" step="any" value="${esc(value)}">`;
 return `<label>${esc(label||labels[field.key]||field.key)}${control}</label>`;
}
async function open({document,request,client,submit,onSaved=()=>{},label}){
 if(activeDialog){activeDialog.focus?.();return activeDialog;}
 const session=await client.auth?.getSession?.();if(session?.error)throw session.error;
 if(activeDialog){activeDialog.focus?.();return activeDialog;}
 let actor=session?.data?.session?.user?.id||request.requester_id||null;
 const draft=clone(request),dialog=document.createElement('dialog'),previous=document.activeElement;let busy=false,closed=false,sessionChanged=false;
 dialog.className='request-editor';dialog.setAttribute('aria-label',draft.id?'내 요청 수정':'주문·출고 상태 변경');
 const subscription=client.auth?.onAuthStateChange?.((event,nextSession)=>{const next=nextSession?.user?.id||null;if(event==='SIGNED_OUT'||(actor&&next&&actor!==next)){sessionChanged=true;finish(false);}else if(next)actor=next;})?.data?.subscription;
 function finish(result){if(closed)return;closed=true;subscription?.unsubscribe?.();activeDialog=null;dialog.close();dialog.remove();previous?.focus?.();return result;}
 function draw(){
  const schema=fields(draft);
  dialog.innerHTML=`<form><h2>${draft.id?'내 요청 수정':'주문·출고 상태 변경'}</h2><p>${draft.id?'기존 대기 요청을 보완합니다.':'주문 상태와 출고 상태를 함께 선택할 수 있습니다.'} 관리자 승인 후 확정 자료에 반영됩니다.</p><div class="request-editor-fields">${schema.map((f,i)=>`${i===0||schema[i-1].group!==f.group?`<h3>${esc(f.group)}</h3>`:''}${input(f,i,label?.(f.key))}`).join('')}</div>${draft.operations.map((op,i)=>op.action==='invoice'?`<div class="request-item-actions"><button type="button" data-add="${i}">품목 추가</button>${op.items.map((_,j)=>`<button type="button" data-remove="${i},${j}">품목 ${j+1} 삭제</button>`).join('')}</div>`:op.action==='delete'?'<p>삭제 대상은 유지됩니다. 변경 사유를 수정할 수 있습니다.</p>':'').join('')}<label>변경 사유<textarea data-reason required maxlength="2000" rows="3">${esc(draft.reason||'')}</textarea></label><p data-error role="alert"></p><footer><button type="button" data-cancel>취소</button><button type="submit">${draft.id?'수정 요청 저장':'변경 요청 제출'}</button></footer></form>`;
  const sync=()=>{for(const el of dialog.querySelectorAll('[data-field]'))assign(draft,schema[Number(el.dataset.field)],el.value);draft.reason=dialog.querySelector('[data-reason]').value.trim();};
  dialog.querySelector('[data-cancel]').onclick=()=>{if(!busy)finish(false);};
  for(const button of dialog.querySelectorAll('[data-add],[data-remove]'))button.onclick=()=>{sync();if(button.dataset.add!==undefined)draft.operations[Number(button.dataset.add)].items.push({name:'',barcode:'',sales_type:'Paid',qty:1,price:0});else{const [i,j]=button.dataset.remove.split(',').map(Number);draft.operations[i].items.splice(j,1);}draw();};
  dialog.querySelector('form').onsubmit=async event=>{
   event.preventDefault();if(busy||closed||sessionChanged)return;
   const error=dialog.querySelector('[data-error]');error.textContent='';
   try{
    sync();if(!draft.reason)throw Error('변경 사유를 입력해 주세요.');
    busy=true;for(const el of dialog.querySelectorAll('input,textarea,select,button'))el.disabled=true;
    let result;
    if(draft.id){const {data,error:rpcError}=await client.rpc('revise_change_request',{p_id:draft.id,p_revision:draft.revision,p_operations:draft.operations,p_reason:draft.reason});if(rpcError)throw rpcError;result=data;if(result?.revision!==draft.revision+1)throw Error('수정 결과를 확인하지 못했습니다. 요청 목록을 새로고침해 주세요.');}
    else result=await submit(draft.operations,{reason:draft.reason});
    if(!result?.id||result.status!=='pending')throw Error('요청 결과를 목록에서 확인해 주세요.');
    if(!sessionChanged){finish(true);await onSaved(result);}
   }catch(e){error.textContent='저장하지 못했거나 결과 확인이 필요합니다. '+(e.message||String(e));}
   finally{busy=false;for(const el of dialog.querySelectorAll('input,textarea,select,button'))el.disabled=false;}
  };
 }
 dialog.addEventListener('cancel',event=>{event.preventDefault();if(!busy)finish(false);});
 for(const type of ['keydown','paste'])dialog.addEventListener(type,event=>event.stopPropagation());
 draw();document.body.appendChild(dialog);dialog.showModal();activeDialog=dialog;dialog.querySelector('input,select,textarea')?.focus();return dialog;
}
return {prepareInvoice,fields,assign,open};
});
