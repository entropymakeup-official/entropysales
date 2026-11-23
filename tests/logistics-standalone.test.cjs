'use strict';
// 전사용 물류 요청 단독 페이지(logistics.html)와 그 부팅 스크립트(logistics-standalone.js).
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const S=require('../logistics-standalone.js');
const P=require('../logistics.js');

const read=f=>fs.readFileSync(path.join(__dirname,'..',f),'utf8');

function fakeDom(){
 const els={};
 const mk=id=>els[id]||(els[id]={id,hidden:false,innerHTML:'',textContent:'',onclick:null,disabled:false});
 return {document:{getElementById:mk,title:''},els};
}
function fakeEnv({email='me@entropymakeup.com',search='',getSessionError=null}={}){
 const d=fakeDom(),log=[],messages=[];let authCb=null;
 let session=email?{user:{email}}:null;
 const client={auth:{
  getSession:async()=>({data:{session},error:getSessionError}),
  signInWithOAuth:async a=>{log.push(['oauth',a]);return {error:null};},
  signOut:async()=>{log.push(['signOut']);session=null;authCb?.('SIGNED_OUT',null);return {error:null};},
  onAuthStateChange:cb=>{authCb=cb;}}};
 const page={shows:0,opened:[],show(){this.shows++;log.push(['show']);return Promise.resolve();},hide(){log.push(['hide']);},openRequest(id){this.opened.push(id);log.push(['open',id]);return Promise.resolve();}};
 const mounts=[];
 const mountTab=o=>{mounts.push(o);return page;};
 const location={href:'https://x.github.io/entropysales/logistics.html'+search,pathname:'/entropysales/logistics.html',search,hash:''};
 const history={state:null,replaced:[],replaceState(s,t,u){this.replaced.push(u);}};
 return {d,log,messages,client,page,mounts,mountTab,location,history,
  auth:(ev,s)=>{session=s;return authCb(ev,s);},
  boot:()=>S.boot({document:d.document,client,mountTab,location,history,onMessage:m=>messages.push(m)})};
}

test('logistics.html: 대시보드 앱 없이 물류 화면만 불러오고, 순서대로 부팅한다',()=>{
 const html=read('logistics.html');
 assert.ok(!html.includes('location.replace'),'더 이상 대시보드로 넘기지 않는다');
 assert.ok(!html.includes('app.js'),'영업 대시보드 앱은 불러오지 않는다');
 const order=['https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2','https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
  'style.css?v=','logistics.css?v=','logistics-model.js?v=','fassto-forms.js?v=','logistics.js?v=','logistics-standalone.js?v=','LogisticsStandalone.boot('];
 let at=-1;for(const s of order){const i=html.indexOf(s);assert.ok(i>at,`${s} 순서`);at=i;}
 for(const id of ['lg-login','lg-login-btn','lg-login-error','lg-shell','lg-user','lg-logout','page-title','topbar-actions','content','toast'])
  assert.ok(html.includes(`id="${id}"`),id);
 assert.ok(html.includes('https://qqmhxnwmasamkqsbnrvw.supabase.co'));
 assert.ok(html.includes('href="index.html"'),'해외영업 대시보드로 가는 링크');
 const v=[...html.matchAll(/(logistics(?:-model|-standalone)?\.(?:js|css)|fassto-forms\.js)\?v=([^"]+)"/g)];
 assert.equal(v.length,5);assert.equal(new Set(v.map(m=>m[2])).size,1,'물류 파일은 같은 버전 꼬리표');
 const pkg=JSON.parse(read('package.json'));
 assert.match(pkg.scripts.check,/node --check logistics-standalone\.js/);
});

test('boot: 로그인 안 했으면 로그인 화면만 보이고, 버튼을 누르면 회사 구글 계정으로 지금 주소로 돌아오게 로그인한다',async()=>{
 const t=fakeEnv({email:'',search:'?id=r1'});
 await t.boot();
 assert.equal(t.d.els['lg-login'].hidden,false);
 assert.equal(t.d.els['lg-shell'].hidden,true);
 assert.equal(t.mounts.length,0);
 await t.d.els['lg-login-btn'].onclick();
 assert.deepEqual(t.log.at(-1),['oauth',{provider:'google',options:{redirectTo:'https://x.github.io/entropysales/logistics.html?id=r1',queryParams:{hd:'entropymakeup.com'}}}]);
});

test('boot: 회사 계정이면 물류 화면을 열고, 주소의 id 요청을 열고 주소에서 지운다',async()=>{
 const t=fakeEnv({email:'Kim@EntropyMakeup.com',search:'?id=r1'});
 await t.boot();
 assert.equal(t.d.els['lg-login'].hidden,true);
 assert.equal(t.d.els['lg-shell'].hidden,false);
 assert.equal(t.mounts.length,1);
 assert.equal(t.mounts[0].client,t.client);
 assert.equal(t.mounts[0].document,t.d.document);
 assert.equal(t.page.shows,1);
 assert.deepEqual(t.page.opened,['r1']);
 assert.deepEqual(t.history.replaced,['/entropysales/logistics.html']);
 assert.equal(t.d.els['lg-user'].textContent,'kim@entropymakeup.com');
 assert.equal(t.d.els['page-title'].textContent,'물류 요청');
});

test('boot: id 없이 오면 목록만 연다',async()=>{
 const t=fakeEnv();
 await t.boot();
 assert.equal(t.page.shows,1);
 assert.deepEqual(t.page.opened,[]);
 assert.deepEqual(t.history.replaced,[]);
});

test('boot: 회사 밖 계정은 로그아웃시키고 안내한다',async()=>{
 const t=fakeEnv({email:'someone@gmail.com'});
 await t.boot();
 assert.ok(t.log.some(x=>x[0]==='signOut'));
 assert.equal(t.mounts.length,0);
 assert.equal(t.d.els['lg-login'].hidden,false);
 assert.match(t.d.els['lg-login-error'].textContent,/entropymakeup\.com 계정만/);
 assert.equal(t.d.els['lg-login-error'].hidden,false);
});

test('boot: 로그아웃하면 화면을 닫고 로그인 화면으로, 다시 로그인하면 같은 화면을 한 번만 붙여 다시 연다',async()=>{
 const t=fakeEnv();
 await t.boot();
 await t.d.els['lg-logout'].onclick();
 assert.ok(t.log.some(x=>x[0]==='hide'));
 assert.equal(t.d.els['lg-login'].hidden,false);
 assert.equal(t.d.els['lg-shell'].hidden,true);
 await t.auth('SIGNED_IN',{user:{email:'me@entropymakeup.com'}});
 assert.equal(t.mounts.length,1,'mountTab은 한 번만');
 assert.equal(t.page.shows,2);
 assert.equal(t.d.els['lg-shell'].hidden,false);
 // 이미 열려 있을 때 들어오는 SIGNED_IN(토큰 갱신 등)은 다시 그리지 않는다
 await t.auth('SIGNED_IN',{user:{email:'me@entropymakeup.com'}});
 assert.equal(t.page.shows,2);
});

test('boot: 구글 로그인에서 돌아온 직후(세션이 늦게 생김)에도 SIGNED_IN으로 열린다',async()=>{
 const t=fakeEnv({email:''});
 await t.boot();
 await t.auth('SIGNED_IN',{user:{email:'me@entropymakeup.com'}});
 assert.equal(t.page.shows,1);
 assert.equal(t.d.els['lg-login'].hidden,true);
});

test('boot: 세션 확인이 실패하면 로그인 화면에 오류를 보여 준다',async()=>{
 const t=fakeEnv({email:'',getSessionError:{message:'network down'}});
 await t.boot();
 assert.equal(t.d.els['lg-login'].hidden,false);
 assert.match(t.d.els['lg-login-error'].textContent,/network down/);
});

// ── 대시보드 탭의 '별도 페이지로 열기' ──
function tabDom(){
 const els={};
 const mk=id=>els[id]||(els[id]={id,hidden:false,innerHTML:'',value:'',textContent:'',open:false,
  showModal(){this.open=true;},close(){this.open=false;},querySelector:()=>null,querySelectorAll:()=>[]});
 return {document:{getElementById:mk},els};
}
function tabClient(){
 const q={select(){return q;},eq(){return q;},in(){return q;},order(){return q;},limit(){return q;},range(){return q;},gte(){return q;},
  maybeSingle(){return q;},single(){return q;},then(res){return Promise.resolve({data:[],error:null}).then(res);}};
 return {from:()=>q,rpc:async()=>({data:null,error:null}),
  auth:{getSession:async()=>({data:{session:{user:{email:'me@entropymakeup.com'}}},error:null}),onAuthStateChange(){}}};
}

test('mountTab: pageUrl을 주면 상단에 별도 페이지로 여는 링크를 둔다 (대시보드 탭용)',async()=>{
 const d=tabDom();
 const page=P.mountTab({document:d.document,client:tabClient(),pageUrl:'logistics.html'});
 await page.show();
 assert.ok(d.els['topbar-actions'].innerHTML.includes('<a class="btn" id="lg-standalone" href="logistics.html" target="_blank" rel="noopener"><i class="ti ti-external-link"></i> 별도 페이지로 열기</a>'));
 page.hide();
 assert.equal(d.els['topbar-actions'].innerHTML,'','숨기면 물류 버튼을 비운다');
});

test('mountTab: pageUrl이 없으면 (단독 페이지) 링크를 두지 않는다',async()=>{
 const d=tabDom();
 const page=P.mountTab({document:d.document,client:tabClient()});
 await page.show();
 assert.ok(!d.els['topbar-actions'].innerHTML.includes('lg-standalone'));
});

test('대시보드: 물류 탭을 pageUrl과 함께 붙인다',()=>{
 const index=read('index.html');
 assert.ok(index.includes("globalThis.logistics=LogisticsPage.mountTab({document,client:sb,onMessage:m=>toast(m),pageUrl:'logistics.html'});"));
});
