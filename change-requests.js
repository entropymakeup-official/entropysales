(function(root){
'use strict';
const clone=value=>JSON.parse(JSON.stringify(value));
const sorted=rows=>clone(rows).sort((a,b)=>String(a.id).localeCompare(String(b.id)));
function createClient({sb,promptReason=()=>root.prompt('변경 사유를 입력하세요. 관리자 승인 후 반영됩니다.'),notify=()=>{}}){
 const attempts=new Map();let actor=null,epoch=0;
 const reset=()=>{attempts.clear();epoch++;};
 sb.auth?.onAuthStateChange?.((_event,session)=>{const next=session?.user?.id||null;if(next!==actor){actor=next;reset();}});
 async function read(table,key){let query=sb.from(table).select('*');for(const [k,v] of Object.entries(key))query=query.eq(k,v);const {data,error}=await query.maybeSingle();if(error)throw error;return data;}
 async function row(table,action,key,values,before){
  if(action==='insert')return {table,action,key:key||{},before:null,values:clone(values)};
  if(before===undefined)before=await read(table,key);
  if(!before)throw Error('변경 전 자료를 찾지 못했습니다. 목록을 다시 확인해 주세요.');
  const patch=action==='delete'?null:clone(values);
  if(patch)for(const [k,v]of Object.entries(key)){if(Object.prototype.hasOwnProperty.call(patch,k)){if(patch[k]!==v)throw Error('기본 키는 변경할 수 없습니다.');delete patch[k];}}
  return {table,action,key:clone(key),before:clone(before),...(action==='delete'?{}:{values:patch})};
 }
 async function invoice(id,invoice,items,before){
  if(id!==null&&before===undefined){const old=await read('invoices',{id});const result=await sb.from('invoice_items').select('*').eq('invoice_id',id);if(result.error)throw result.error;before={invoice:old,items:result.data};}
  if(id!==null&&(!before?.invoice||!Array.isArray(before.items)))throw Error('변경 전 주문을 다시 확인해 주세요.');
  return {action:'invoice',id,before:id===null?null:{invoice:clone(before.invoice),items:sorted(before.items)},invoice:clone(invoice),items:clone(items)};
 }
 async function submit(operations,options={}){
  const serialized=JSON.stringify(operations);
  if(!Array.isArray(operations)||!operations.length||operations.length>1000||new TextEncoder().encode(serialized).length>5*1024*1024)throw Error('요청은 1~1000개 작업, 5MB 이하로 나누어 제출해 주세요.');
  let attempt=attempts.get(serialized);
  if(attempt?.promise)return attempt.promise;
  if(!attempt){attempt={id:options.clientId||root.crypto.randomUUID()};attempts.set(serialized,attempt);}
  const started=epoch;
  // Register before awaiting a synchronous or asynchronous reason dialog.
  attempt.promise=Promise.resolve().then(async()=>{
    const reason=options.reason===undefined?(attempt.reason??await promptReason()):options.reason;
    if(reason===null||!String(reason).trim()){attempts.delete(serialized);return null;}
    attempt.reason=String(reason).trim();
    if(started!==epoch)throw Error('로그인 계정이 변경됐습니다. 새 계정에서 요청을 다시 확인해 주세요.');
    const {data,error}=await sb.rpc('submit_change_request',{p_operations:JSON.parse(serialized),p_reason:attempt.reason,p_client_id:attempt.id});
    if(started!==epoch)throw Error('로그인 계정이 변경됐습니다. 이전 계정의 요청 목록을 확인해 주세요.');
    if(error)throw error;
    if(!data?.id||!['pending','approved','rejected'].includes(data.status))throw Error('요청 접수 결과를 확인하지 못했습니다. 변경 요청 목록을 확인해 주세요.');
    attempts.delete(serialized);notify(message(data));return data;
  });
  try{return await attempt.promise;}finally{attempt.promise=null;}
 }
 async function list(limit=100,offset=0){const {data,error}=await sb.rpc('list_change_requests',{p_limit:limit,p_offset:offset});if(error)throw error;return data;}
 async function review(id,approve,note=''){const {data,error}=await sb.rpc('review_change_request',{p_id:id,p_approve:approve,p_note:note});if(error)throw error;return data;}
 return {row,invoice,submit,list,review,read,reset};
}
function message(result){return result?.status==='approved'?'이 요청은 이미 승인됐습니다. 목록을 새로고침해 확정 자료를 확인해 주세요.':result?.status==='rejected'?'이 요청은 이미 반려됐습니다. 변경 요청 목록의 사유를 확인해 주세요.':'변경 요청이 접수됐습니다. 관리자 승인 대기 중입니다.';}
root.ChangeRequests={createClient,message};
})(typeof globalThis!=='undefined'?globalThis:window);
