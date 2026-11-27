(function(root,factory){const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;else root.LogisticsStandalone=api;})(typeof globalThis!=='undefined'?globalThis:this,function(root){
'use strict';
// 전사용 단독 페이지(logistics.html, support.html)의 로그인과 화면 연결. 화면 자체는 대시보드 탭과 같은 mountTab을 쓴다(title로 제목만 바꾼다).
const DOMAIN='entropymakeup.com';

function boot({document,client,mountTab,location=root.location,history=root.history,onMessage=()=>{},domain=DOMAIN,title='물류 요청'}){
 const $=id=>document.getElementById(id);
 let page=null,open=false;
 const setError=msg=>{const e=$('lg-login-error');if(!e)return;e.textContent=msg||'';e.hidden=!msg;};
 function showLogin(msg){
  open=false;
  $('lg-shell').hidden=true;$('lg-login').hidden=false;
  setError(msg);
 }
 // 슬랙 링크로 온 ?id=<요청>을 읽고 주소에서 지운다.
 function takeId(){
  let p;try{p=new URLSearchParams(location?.search||'');}catch(_){return '';}
  const id=p.get('id')||'';if(!p.has('id'))return '';
  p.delete('id');
  try{const qs=p.toString();history?.replaceState?.(history.state??null,'',(location.pathname||'')+(qs?'?'+qs:'')+(location.hash||''));}catch(_){}
  return id;
 }
 async function enter(session){
  const email=String(session?.user?.email||'').toLowerCase();
  if(!email.endsWith('@'+domain)){
   await client.auth.signOut();
   showLogin(`${domain} 계정만 들어올 수 있어요. (${email})`);
   return;
  }
  if(open)return;
  open=true;
  $('lg-login').hidden=true;$('lg-shell').hidden=false;setError('');
  $('lg-user').textContent=email;
  $('page-title').textContent=title;
  if(!page)page=mountTab({document,client,onMessage});
  const id=takeId();
  await page.show();
  if(id)await page.openRequest(id);
 }
 const btn=$('lg-login-btn');
 if(btn)btn.onclick=async()=>{
  btn.disabled=true;setError('');
  const {error}=await client.auth.signInWithOAuth({provider:'google',options:{redirectTo:location.href,queryParams:{hd:domain}}});
  if(error){btn.disabled=false;setError(error.message);}
 };
 const out=$('lg-logout');
 if(out)out.onclick=async()=>{await client.auth.signOut();};
 client.auth.onAuthStateChange((ev,session)=>{
  if(ev==='SIGNED_OUT'){page?.hide();showLogin('');}
  else if(ev==='SIGNED_IN'&&session&&!open)return enter(session);
 });
 return (async()=>{
  const {data,error}=await client.auth.getSession();
  if(error){showLogin(error.message);return;}
  if(!data?.session){showLogin('');return;}
  await enter(data.session);
 })();
}

return {boot,DOMAIN};
});
