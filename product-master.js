(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.ProductMaster=api;})(globalThis,function(){
 'use strict';
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const display=v=>v===null||v===undefined||v===''?'—':typeof v==='number'?v.toLocaleString('ko-KR',{maximumFractionDigits:10}):String(v);
 const norm=v=>String(v??'').normalize('NFKC').toLocaleLowerCase().replace(/\s+/g,' ').trim();
 function filterProducts(snapshot,filter={}){
  const words=norm(filter.q).split(' ').filter(Boolean);
  return snapshot.products.filter(p=>{
   if(filter.brand&&p.values[4]!==filter.brand)return false;
   if(filter.family&&p.values[5]!==filter.family)return false;
   if(filter.status&&p.values[1]!==filter.status)return false;
   const text=norm([p.values,...p.components.map(c=>c.values)].flat().join(' '));
   return words.every(word=>text.includes(word));
  });
 }
 function renderFields(headers,values){
  const groups=[['기본 정보',0,22],['품목·협력사',22,35],['발주·입고',35,51],['비고·자료',51,52]];
  return groups.map(([name,start,end])=>`<section class="pm-field-section"><h4>${name}</h4><dl class="pm-fields">${headers.slice(start,end).map((h,j)=>`<div${start+j===51?' class="pm-wide"':''}><dt>${esc(h)}</dt><dd>${esc(display(values[start+j]))}</dd></div>`).join('')}</dl></section>`).join('');
 }
 function createController(read){
  const state={snapshot:null,loading:false,error:''};let generation=0;
  return {state,clear(){generation++;state.snapshot=null;state.loading=false;state.error='';},async load(){
   const request=++generation;state.snapshot=null;state.loading=true;state.error='';
   try{const data=await read();if(request!==generation)return;
    if(!data)throw Error('조회 가능한 제품 마스터가 없습니다. 로그인 상태 또는 자료 등록 여부를 확인해 주세요.');
    if(!Array.isArray(data.headers)||data.headers.length!==52||!Array.isArray(data.products))throw Error('제품 마스터 자료 형식이 올바르지 않습니다.');
    state.snapshot=data;
   }catch(error){if(request===generation)state.error=error.message||'자료를 불러오지 못했습니다.';}
   finally{if(request===generation)state.loading=false;}
  }};
 }
 function mount({document,client}){
  const controller=createController(async()=>{
   const {data,error}=await client.from('product_master_snapshots').select('source_name,source_date,headers,products,loaded_at').eq('id',true).maybeSingle();
   if(error)throw Error('자료를 불러오지 못했습니다. 로그인 상태를 확인한 후 다시 시도해 주세요.');return data;
  });
  let active=false,view=0,root=null,filter={q:'',brand:'',family:'',status:''};
  function hide(){active=false;view++;controller.clear();if(root)root.remove();root=null;}
  function paint(){
   if(!active||!root)return;
   const s=controller.state;
   if(s.loading){root.innerHTML='<p class="pm-message" role="status">제품 마스터를 불러오는 중입니다…</p>';return;}
   if(s.error){root.innerHTML=`<div class="pm-message"><p role="alert">${esc(s.error)}</p><button class="btn" data-pm-retry>다시 불러오기</button></div>`;root.querySelector('[data-pm-retry]').onclick=load;return;}
   if(!s.snapshot)return;
   const data=s.snapshot,count=data.products.reduce((n,p)=>n+p.components.length,0);
   const select=(key,index,label)=>`<label>${label}<select data-pm-filter="${key}" aria-label="${label}"><option value="">전체</option>${[...new Set(data.products.map(p=>p.values[index]).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'ko')).map(v=>`<option value="${esc(v)}"${filter[key]===v?' selected':''}>${esc(v)}</option>`).join('')}</select></label>`;
   root.innerHTML=`<header class="pm-intro"><div><span class="pm-readonly">조회 전용</span><h2>제품 마스터</h2><p>자료 기준 ${esc(data.source_date)} · 제품 ${data.products.length.toLocaleString('ko-KR')}개 · 구성품 ${count.toLocaleString('ko-KR')}개</p><p class="pm-source">${esc(data.source_name)} · 제공된 파일 기준이며 실시간 재고가 아닙니다.</p></div><button class="btn" data-pm-retry>다시 불러오기</button></header>
   <div class="pm-toolbar"><label class="pm-search">제품·구성품 검색<input type="search" data-pm-filter="q" aria-label="제품·구성품 검색" placeholder="제품명, 코드, 바코드, 협력사 등" value="${esc(filter.q)}"></label>${select('brand',4,'브랜드')}${select('family',5,'제품군')}${select('status',1,'판매 상태')}<button class="btn" data-pm-reset>초기화</button></div>
   <div class="pm-results-heading"><p data-pm-count role="status" aria-live="polite"></p><span>제품을 펼치면 상세정보와 구성품을 볼 수 있습니다.</span></div><div data-pm-list></div>`;
   root.querySelector('[data-pm-retry]').onclick=load;
   root.querySelector('[data-pm-reset]').onclick=()=>{filter={q:'',brand:'',family:'',status:''};paint();};
   root.querySelectorAll('[data-pm-filter]').forEach(input=>{input.addEventListener(input.tagName==='INPUT'?'input':'change',()=>{filter[input.dataset.pmFilter]=input.value;paintList();});});
   paintList();
  }
  function paintList(){
   const data=controller.state.snapshot;if(!root||!data)return;
   const rows=filterProducts(data,filter),list=root.querySelector('[data-pm-list]');
   root.querySelector('[data-pm-count]').textContent=`조회 결과 ${rows.length} / ${data.products.length}개`;
   if(!rows.length){list.innerHTML='<p class="pm-message">검색 조건에 맞는 제품이 없습니다. 검색어 또는 필터를 변경해 주세요.</p>';return;}
   list.innerHTML=rows.map(p=>`<details class="pm-product" data-row="${p.row}"><summary><div class="pm-product-main"><strong>${esc(p.values[0])}</strong><span>${esc(display(p.values[10]))} · ${esc(display(p.values[3]))}</span></div><span class="pm-state">${esc(display(p.values[1]))}</span><span class="pm-product-meta">${esc(display(p.values[4]))}<small>${esc(display(p.values[5]))}</small></span><span class="pm-cost"><span><small>표준원가 · 부가세 별도</small>${esc(display(p.values[7]))}</span><span><small>표준원가 · 부가세 포함</small>${esc(display(p.values[8]))}</span></span><span class="pm-component-count">구성품 ${p.components.length}</span></summary><div class="pm-product-body"></div></details>`).join('');
   list.querySelectorAll('.pm-product').forEach(el=>{el.addEventListener('toggle',()=>{
    if(!el.open||el.dataset.loaded)return;el.dataset.loaded='true';
    const p=rows.find(p=>String(p.row)===el.dataset.row);
    el.querySelector('.pm-product-body').innerHTML=`${renderFields(data.headers,p.values)}<section class="pm-components"><h3>구성품 ${p.components.length}개</h3>${p.components.length?p.components.map(c=>`<details class="pm-component"><summary><strong>${esc(c.values[0])}</strong><span>${esc(display(c.values[23]))}</span><span>${esc(display(c.values[26]))}</span></summary><div>${renderFields(data.headers,c.values)}</div></details>`).join(''):'<p>등록된 구성품이 없습니다.</p>'}</section>`;
   });});
  }
  async function load(){const current=++view;const pending=controller.load();paint();await pending;if(active&&current===view)paint();}
  async function show(){hide();active=true;document.getElementById('topbar-actions').replaceChildren();const content=document.getElementById('content');content.replaceChildren();root=document.createElement('section');root.className='product-master';root.setAttribute('aria-label','제품 마스터 조회');content.append(root);await load();}
  client.auth.onAuthStateChange(event=>{if(event==='SIGNED_OUT')hide();});
  return {show,hide};
 }
 return {display,filterProducts,renderFields,createController,mount};
});
