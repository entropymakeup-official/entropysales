(function(root){
 'use strict';
 const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
 const fileIdPattern=/^[A-Za-z0-9_-]{10,200}$/;
 const resourcePattern=/^[A-Za-z0-9_-]{1,200}$/;
 const types=['거래명세서','구매확인서','세금계산서','기타'];
 const fields='id,invoice_id,drive_file_id,resource_key,name,type,created_at';
 const uncertain='저장 결과를 확인하지 못했습니다. 증빙 목록을 새로 확인한 뒤 다시 시도해 주세요.';
 function canonical(fileId,key){return 'https://drive.google.com/file/d/'+fileId+'/view'+(key?'?resourcekey='+key:'');}
 function parseLink(value){
  const raw=String(value||'').trim();
  const invalid=()=>new Error('Google Drive 파일의 공유 링크를 입력해 주세요.');
  if(!raw||/[\\\x00-\x20]/.test(raw)||/\/\.\.?\//.test(raw))throw invalid();
  let u;try{u=new URL(raw);}catch(_){throw invalid();}
  if(u.protocol!=='https:'||u.username||u.password||u.port||!['drive.google.com','docs.google.com'].includes(u.hostname))throw invalid();
  let id;
  if(u.hostname==='drive.google.com'){
   const match=u.pathname.match(/^\/file\/d\/([A-Za-z0-9_-]{10,200})(?:\/(?:view|preview|edit))?\/?$/);
   if(match)id=match[1];
   else if(['/open','/uc'].includes(u.pathname)&&u.searchParams.getAll('id').length===1)id=u.searchParams.get('id');
  }else id=u.pathname.match(/^\/(?:document|spreadsheets|presentation)\/d\/([A-Za-z0-9_-]{10,200})(?:\/(?:edit|view|preview))?\/?$/)?.[1];
  const keys=u.searchParams.getAll('resourcekey'),key=keys[0]||null;
  if(!fileIdPattern.test(id||'')||keys.length>1||(keys.length&&(!key||!resourcePattern.test(key))))throw invalid();
  return {fileId:id,resourceKey:key,url:canonical(id,key)};
 }
 function prepare(form,invoices){
  const name=String(form.name||'').trim(),invoiceId=String(form.invoice_id||'');
  if(!name||name.length>250)throw new Error('서류명을 1~250자로 입력해 주세요.');
  if(!uuid.test(invoiceId)||!invoices.some(i=>i.id===invoiceId))throw new Error('연결할 주문을 선택해 주세요.');
  if(!types.includes(form.type))throw new Error('서류 종류를 선택해 주세요.');
  const link=parseLink(form.url);
  return {invoice_id:invoiceId,drive_file_id:link.fileId,resource_key:link.resourceKey,name,type:form.type};
 }
 function validRow(r){return !!r&&uuid.test(r.id||'')&&uuid.test(r.invoice_id||'')&&fileIdPattern.test(r.drive_file_id||'')&&
  (r.resource_key===null||resourcePattern.test(r.resource_key||''))&&typeof r.name==='string'&&r.name.trim().length>0&&r.name.length<=250&&types.includes(r.type);}
 function urlFor(row){return validRow(row)?canonical(row.drive_file_id,row.resource_key):'';}
 async function bounded(request){
  let timer;try{return await Promise.race([Promise.resolve(request),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(uncertain)),20000);})]);}
  finally{clearTimeout(timer);}
 }
 async function list(sb){
  const rows=[];
  for(let offset=0;offset<10000;offset+=250){
   const {data,error}=await bounded(sb.from('invoice_drive_documents').select(fields).order('id').range(offset,offset+249));
   if(error||!Array.isArray(data)||data.some(r=>!validRow(r)))throw new Error('Drive 증빙을 불러오지 못했습니다. 다시 조회해 주세요.');
   rows.push(...data);if(data.length<250)return rows;
  }
  throw new Error('증빙이 많아 전체 조회를 완료하지 못했습니다. 관리자에게 문의해 주세요.');
 }
 async function save(sb,form,invoices){
  const payload=prepare(form,invoices);
  const {data,error}=await bounded(sb.from('invoice_drive_documents').insert(payload).select(fields).single());
  if(error?.code==='23505')throw new Error('이 주문에 이미 연결된 Drive 파일입니다. 증빙 목록을 새로 확인해 주세요.');
  if(error||!validRow(data)||Object.keys(payload).some(k=>data[k]!==payload[k]))throw new Error(uncertain);
  return data;
 }
 async function remove(sb,id){
  if(!uuid.test(id||''))throw new Error('삭제할 연결을 다시 확인해 주세요.');
  const {data,error}=await bounded(sb.from('invoice_drive_documents').delete().eq('id',id).select('id'));
  if(error||!Array.isArray(data)||data.length!==1||data[0].id!==id)throw new Error('연결 삭제 결과를 확인하지 못했습니다. 목록을 새로 조회해 주세요.');
 }
 root.DriveDocuments={types,parseLink,prepare,urlFor,list,save,remove};
})(typeof globalThis!=='undefined'?globalThis:window);
