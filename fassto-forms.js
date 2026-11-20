(function(root,factory){const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;else root.FasstoForms=api;})(typeof globalThis!=='undefined'?globalThis:this,function(root){
'use strict';
// 파스토 FMS 업로드 양식 3종(해외택배신청·택배신청·차량배송신청(상품))을 만든다. DOM과 네트워크 없음.
// HEAD는 tests/fixtures/fassto/ 원본 1~4행을 그대로 옮긴 값이다. 원본이 바뀌면 tests/fassto-forms.test.cjs가 알려 준다.
const HEAD={
 overseas:[
  ["배송국가","운송사","주문번호","발송인명","발송인우편번호","발송인전화번호","발송인주소","수취인명","수취인전화번호","수취인우편번호","수취인주소(성)","수취인주소(시)","수취인주소(구)","수취인주소","수취인신분번호","출고 신청 수량","화폐단위코드","상품코드 또는 상품명","해외배송용 상품명","HS CODE","상품무게","상품단위금액","브랜드명","상품판매처","택배기사 요청사항","Incoterms","발송인이메일","수취인이메일"],
  ["조건부 필수","조건부 필수","필수","필수","선택","필수","필수","필수","필수","필수","조건부 필수","조건부 필수","선택","필수","조건부 필수","필수","필수","필수","선택","선택","필수","필수","필수","선택","선택","선택","조건부 필수","조건부 필수"],
  ["▶1~4행을 삭제하지 말고 올려주세요.\r\n▶ 배송하실 국가를 다운로드 받으 신 후 엑셀과 동일한 텍스트로 입력해주세요.\r\n▶ 해외 특송의 경우 필수로 입력해주세요.","▶ 배송하실 운송사를 선택해주세요.\r\n▶ 해외 특송의 경우 필수로 입력해주세요.","▶ 고객님께서 관리하시는 주문 번호 입니다.\r\n동일한 주문에 대해서는 같은 주문번호를, 서로 다른 주문건은 별개의 주문번호를 기재해주세요.\r\n특수문자는 '-', '_' 외 입력이 불가합니다.","▶ 발송인 이름을 입력 해주세요.","▶ 발송인 우편번호를 입력 해주세요.","▶ 발송인 전화번호를 입력 해주세요.","▶ 발송인 주소를 영어로 입력 해주세요","▶ 배송 받게 될 구매 고객명을 기재해주세요.\r\n▶ 영문입력 \r\n(FEDEX 는 영문 입력 필수 / 이코노미 는 일본,중국 자국어 입력)","▶ 배송 받게 될 구매고객 전화번호를 개재해주세요.","▶ 배송 가게 될 배송지의 우편번호를 기재해주세요.","▶ 배송 가게 될 배송지의 (성)을 영문으로 정확하게 기재해주세요.\r\n▶ 중국 외 국가는 반드시 (성)을 입력해주세요.\r\n▶ 영문입력 \r\n(FEDEX 는 영문 입력 필수 / 이코노미 는 일본,중국 자국어 입력)","▶ 배송 가게 될 배송지의 (성)을 영문으로 정확하게 기재해주세요.\r\n▶ 중국 외 국가는 반드시 (시)을 입력해주세요.\r\n▶ 영문입력 \r\n(FEDEX 는 영문 입력 필수 / 이코노미 는 일본,중국 자국어 입력)","▶ 배송 가게 될 배송지 주소를 영문으로 정확하게 기재해주세요.\r\n▶ 중국 외 국가는 반드시 성,시,구를 입력해주세요.\r\n▶ 영문입력 \r\n(FEDEX 는 영문 입력 필수 / 이코노미 는 일본,중국 자국어 입력)","▶ 배송 가게 될 배송지 주소를 영문으로 정확하게 기재해주세요.\r\n▶ [성/시/구] 중 입력하신 정보를 제외한 세부주소만 기재해주시고, 중국 주소 중 [성/시/구]를 입력하지 않으셨다면 [성/시/구]를 포함한 전체 주소를 기재해주세요.\r\n▶ 영문입력 \r\n(FEDEX 는 영문 입력 필수 / 이코노미 는 일본,중국 자국어 입력)","▶ 수취인 신분번호를 기재해주세요.\r\n▶ 배송지가 중국인 경우 필수 입력입니다. (신분증 번호)\r\n▶ 배송지가 브라질/멕시코/칠레인 경우 세금식별번호(Tax ID) 필수 입력입니다.\r\n   멕시코 RFC 또는 CURP / 브라질 CPF 또는 CNPJ / 칠레 RUT (브라질·칠레는 구분자 포함 가능, 멕시코는 구분자 없이 입력)","▶ 배송할 상품의 수량입니다.\r\n입력한 수량 만큼의 재고가 파스토 센터에 보관되어 있어야 합니다.","▶ 화폐 단위를 입력해주세요. \r\n(USD/JPY/EUR 외 입력 불가)","▶ 파스토 센터에 입고 되어 있는 상품코드를 입력해주세요.","▶ 해외 송장에 출력될 상품명을 영문으로 입력해주세요.\r\n▶ 미입력시, 상품 정보에 입력해주신 해외송장용 상품명이 입력됩니다.","▶ 상품의 HSCODE를 입력해주세요.\r\n▶ 미입력시, 상품 정보에 입력해주신 HSCODE가 입력됩니다.","▶ 상품의 중량을 입력해주세요. 모르실 경우 1로 입력하셔도 무방합니다.","▶ 상품의 금액을 입력해주세요\r\n(Q 열에 있는 화폐 단위에 맞는 금액 입력)","▶ 판매상품의 브랜드명을 영문/숫자/특수문자(.,/:[]{}<>()!@#$%^&*-_) 만 입력할 수 있습니다.","▶ 판매 상품의 URL 정보를 입력해 주세요.","▶ 배송기사에게 전달할 메모를 입력해주세요.","▶ 무역거래조건으로 DAP,DDU(수취인이 세금납부)와 DDP(발송인이 세금납부) 중에서만 입력가능합니다. \r\n\r\n▶일본 및 미국의 경우 DDP 조건만 가능하며, 그외의 국가는 DAP 발송이 가능합니다.\r\nDDP 조건의 경우 국가 와 운송사 별로 수수료가(관부가세 대납 수수료) 발생될 수 있습니다","▶ 발송인 이메일 주소를 입력해주세요.\r\n▶ 운송사 FEDEX는 필수 입력입니다. (2026-11-21 접수분부터, 미입력 시 FedEx 발송 접수 제한)\r\n▶ 그 외 운송사는 선택 입력입니다.","▶ 수취인(구매고객) 이메일 주소를 입력해주세요.\r\n▶ 운송사 FEDEX는 필수 입력입니다. (2026-11-21 접수분부터, 미입력 시 FedEx 발송 접수 제한)\r\n▶ 그 외 운송사는 선택 입력입니다."],
  ["JP","FEDEX","A1234","FASSTO","8770213","+81-347-4411-9297","36, Guryong-gil, Mapo-gu, Seoul, Republic of Korea","Wilfred Daniel PhD","+81-779-3965-1910","8770212","大分県","日田市","前津江町","大分県日田市前津江町大野 2-1-7-309","A0102345","2","JPY","F1","A001","3926102000","0.1","0.1","FASSTO","http://www.smartstore.com/fassto","Please be careful","DDP","sender@example.com","customer@example.com"]],
 parcel:[
  ["판매채널","주문번호","주문자","우편번호","기본주소","상세주소","주문자 전화번호","주문자 전화번호(기타)","상품코드 또는 상품명","출고 신청 수량","보내는 분","보내는 분 연락처","택배기사 요청사항","송장번호","구분","상세 일련번호","클레임 번호","유통기한","현관문비밀번호"],
  ["선택","필수","필수","선택","필수","조건부 필수","필수","선택","필수","필수","선택","선택","선택","선택","선택","선택","선택","조건부 필수","조건부 필수"],
  ["▶1~4행을 삭제하지 말고 올려주세요.\n▶상품을 판매하고 있는 쇼핑몰을 입력해 주세요.","▶쇼핑몰 주문번호입니다.\n▶주문번호, 고객명, 고객주소가 같은 행은 1개의 주문으로 \n합쳐져 등록되며, 합포장 배송됩니다.\n▶주문번호는 재사용할 수 없습니다.","▶상품을 받는 분 이름입니다.\n▶( ) , - _ 이외의 특수문자는 이용할 수 없습니다.","▶배송지의 우편번호 입니다.","▶상품을 받는 분 주소입니다.\n▶도로명 주소로 입력해 주세요. 구 주소(지번 주소)도 등록할 수 있지만,\n간혹 송장이 출력되지 않을 수 있어 권장하지 않습니다.\n▶( ) , - _ 이외의 특수문자는 이용할 수 없습니다.","▶상품을 받는 분의 상세주소 입니다.\n▶상세주소를 입력해주세요. 동/호수와 같은 정보를 추가입력해주세요.\n▶( ) , - _ 이외의 특수문자는 이용할 수 없습니다.\n▶정확한 배송을 위해 새벽배송 시 필수 항목입니다.\n▶상세주소를 정확히 입력해주세요.","▶상품을 받는 분 전화번호입니다.","▶상품을 받는 분 전화번호입니다.","▶받는 분 주소로 배송할 상품입니다. \n▶상품코드 또는 상품명 중 1가지만 입력해 주세요.\n▶파스토 센터에 입고되어 있는 상품이어야 합니다.\n▶상품코드로 입력하시는 것을 권장합니다. \n상품명으로 입력하실 경우, 띄어쓰기에 유의해 주세요. \nFMS에 등록한 상품명과 완벽하게 일치해야 합니다.","▶배송할 상품의 수량입니다.\n▶입력한 수량만큼의 재고가 \n파스토 센터에 보관되어 있어야 합니다.","▶상품을 보내는 분 이름입니다.\n▶보내는 분 미입력 시 \n송장에 고객님의 상호명이 표시되어 배송됩니다.","▶상품을 보내는 분 전화번호입니다.","▶요청 메시지는 택배기사에게 전달됩니다. \n▶받는 분의 개인정보 보호를 위해 송장에는 표시되지 않습니다.","▶외부 시스템과 연동하신 경우 입력하는 항목입니다.","▶외부 시스템과 연동하신 경우 입력하는 항목입니다.","▶외부 시스템과 연동하신 경우 입력하는 항목입니다.","▶외부 시스템과 연동하신 경우 입력하는 항목입니다.","▶'유통기한 지정'하여 출고하시는 경우, \n상품의 유통기한을 입력해 주세요.","▶새벽배송시 필수 항목 입니. 현관문 비밀번호를 입력해주세요. 최대 50자"],
  ["예시) 스마트스토어, 11번가, 인터파크, \nGS shop, 롯데닷컴, 하프클럽, ESM지마켓, \n롯데홈쇼핑, 현대홈쇼핑, 신세계몰, \nCJ Oshopping, SSG.com, 쿠팡","20200421","홍길동","56874","서울특별시 관악구 국회단지12길 23 (봉천동) ","단독주택 1층","010-1234-5678, \n01012345678","02-912-1234","북유럽 침구 세트(퀸size),\nA00001","1","홍길동, \n주식회사 지지스튜디오","010-1234-5678, \n01012345678","문 앞에 놓아 주세요.","","","","","2020-04-21,\n20200421","현관문 비밀번호"]],
 vehicle:[
  ["상품코드 또는 상품명","출고 신청 수량","주문번호","유통기한","공급가","판매가","배송구분"],
  ["필수","필수","필수","조건부 필수","선택","선택","필수"],
  ["▶1~4행을 삭제하지 말고 올려주세요.\n▶받는 분 주소로 배송할 상품입니다. \n▶상품코드 또는 상품명 중 1가지만 입력해 주세요.\n▶파스토 센터에 입고되어 있는 상품이어야 합니다.\n▶상품코드로 입력하시는 것을 권장합니다. \n상품명으로 입력하실 경우, 띄어쓰기에 유의해 주세요. \nFMS에 등록한 상품명과 완벽하게 일치해야 합니다.","▶배송할 상품의 수량입니다.\n▶입력한 수량만큼의 재고가 \n파스토 센터에 보관되어 있어야 합니다.","▶고객님께서 관리하시는 주문번호입니다.","▶'유통기한 지정'하여 출고하시는 경우, \n상품의 유통기한을 입력해 주세요.","공급가격을 입력해주세요.","판매가격을 입력해주세요.","▶배송구분을 입력해주세요. (기업, 차량)"],
  ["북유럽 침구 세트(퀸size),\nA00001","500","20200421","2020-04-21,\n20200421","","","차량"]]
};
const FORMS={
 overseas:{label:'해외택배신청',sheet:'파스토제공-해외택배신청',head:HEAD.overseas,text:[2,4,5,8,9,14,17,19]},
 parcel:{label:'택배신청',sheet:'파스토제공-택배신청',head:HEAD.parcel,text:[1,3,6,7,8,11]},
 vehicle:{label:'차량배송신청(상품)',sheet:'파스토제공-차량배송신청(상품)',head:HEAD.vehicle,text:[0,2]}
};
// 발송인 기본값(해외). 사용자 확인 전까지 Seoul Alpes 건에 쓴 전화·이메일. 담당자가 요청별로 덮어쓸 수 있다.
const SENDER={name_text:'ENTROPY (Brand Genome Co., Ltd.)',address_text:'4F, 94 Dokseodang-ro, Yongsan-gu, Seoul, Republic of Korea',phone_text:'+82-10-4089-9090',email_text:'sylee@entropymakeup.com'};
const BRAND='ENTROPY';
const MODE_FORM={parcel:'parcel',express:'overseas',direct:'vehicle',air:'vehicle',ocean:'vehicle'};
const TAX_ID_COUNTRIES=['CN','BR','MX','CL'];
const CURRENCIES=['USD','JPY','EUR'];
const INCOTERMS=['DAP','DDU','DDP'];
const MAX_ITEMS=50;
const DAY=86400000,KST=9*3600000,STALE_MS=2*DAY;
const RECIPIENT_KEYS=['name_text','phone_text','postal_text','country_code','state_text','city_text','district_text','address1_text','address2_text','email_text','tax_id_text','currency_code'];
const HANDLER_KEYS=['courier_text','incoterms_code','sender_name_text','sender_phone_text','sender_address_text','sender_email_text'];
// 받는 곳 입력 칸 [열 이름, 라벨 HTML, 최대 길이]. 화폐(currency_code)와 Incoterms는 고르는 칸이라 화면에서 따로 그린다.
const RECIPIENT_FIELDS={
 parcel:[['name_text','받는 분',100],['phone_text','전화',40],['postal_text','우편번호 <small>선택</small>',20],['address1_text','기본주소 <small>도로명</small>',300],['address2_text','상세주소',300]],
 overseas:[['name_text','받는 분 <small>영문</small>',100],['phone_text','전화',40],['email_text','이메일 <small>FEDEX면 필수</small>',200],['country_code','국가코드 <small>예 CH</small>',2],
  ['state_text','주(성) <small>영문</small>',100],['city_text','시 <small>영문</small>',100],['district_text','구 <small>선택</small>',100],['address1_text','상세주소 <small>영문</small>',300],
  ['postal_text','우편번호',20],['tax_id_text','신분번호 <small>중국·브라질·멕시코·칠레만</small>',60]],
 vehicle:[]
};
const HANDLER_FIELDS=[['courier_text','운송사 <small>예 FEDEX</small>',60],['sender_name_text','발송인 이름 <small>비우면 기본값</small>',100],['sender_phone_text','발송인 전화 <small>비우면 기본값</small>',40],
 ['sender_address_text','발송인 주소 <small>영문 · 비우면 기본값</small>',300],['sender_email_text','발송인 이메일 <small>비우면 기본값</small>',200]];
const BAD_PARCEL=/[^\p{L}\p{N}\s(),\-_]/u;

const s=v=>String(v??'').trim();
const blank=v=>v==null||String(v).trim()==='';
const formFor=mode=>MODE_FORM[mode]||null;
const formHint=form=>FORMS[form]?`파스토 ${FORMS[form].label} 양식으로 만들어요.`:'이 운송 방식은 파스토 양식 없이 처리해요.';
const senderOf=(r,d=SENDER)=>({name_text:s(r?.sender_name_text)||d.name_text,phone_text:s(r?.sender_phone_text)||d.phone_text,address_text:s(r?.sender_address_text)||d.address_text,email_text:s(r?.sender_email_text)||d.email_text});

// 내려받기 전 필수 칸 검사. 빠진 칸을 한국어 문장 배열로 돌려준다(빈 배열이면 통과).
function validate(form,request,recipient,items,defaults=SENDER){
 if(!FORMS[form])return ['이 운송 방식은 파스토 양식이 없어요.'];
 const e=[],r=recipient||{},list=items||[];
 const no=s(request?.fassto_order_no);
 if(!no)e.push('주문번호가 아직 없어요. 새로고침한 뒤 다시 해 주세요.');
 else if(!/^[A-Za-z0-9_-]+$/.test(no))e.push('주문번호에는 영문·숫자와 - _만 쓸 수 있어요.');
 if(!list.length)e.push('품목을 1줄 이상 넣어 주세요.');
 if(list.length>MAX_ITEMS)e.push('품목은 50줄까지 넣을 수 있어요.');
 list.forEach((it,i)=>{
  const n=i+1;
  if(!s(it.product_code))e.push(`${n}번째 품목의 상품코드가 없어요.`);
  if(!(Number.isInteger(Number(it.qty))&&Number(it.qty)>=1))e.push(`${n}번째 품목의 수량을 1 이상으로 적어 주세요.`);
  if(form==='overseas'){
   if(blank(it.unit_price)||!(Number(it.unit_price)>0))e.push(`${n}번째 품목의 단가를 적어 주세요.`);
   if(!blank(it.weight_kg)&&!(Number(it.weight_kg)>0))e.push(`${n}번째 품목의 무게는 0보다 커야 해요.`);
  }
 });
 const need=(key,label)=>{if(!s(r[key]))e.push(`받는 곳: ${label} 칸이 비어 있어요.`);};
 if(form==='parcel'){
  need('name_text','받는 분');need('address1_text','기본주소');need('phone_text','전화');
  for(const [key,label] of [['name_text','받는 분'],['address1_text','기본주소'],['address2_text','상세주소']])
   if(BAD_PARCEL.test(s(r[key])))e.push(`받는 곳: ${label}에는 ( ) , - _ 말고 다른 특수문자를 쓸 수 없어요.`);
 }
 if(form==='overseas'){
  const country=s(r.country_code).toUpperCase();
  if(!/^[A-Z]{2}$/.test(country))e.push('받는 곳: 국가코드를 영문 두 글자로 적어 주세요(예 CH).');
  need('name_text','받는 분');need('phone_text','전화');need('postal_text','우편번호');need('address1_text','상세주소');
  if(country!=='CN'){need('state_text','주(성)');need('city_text','시');}
  if(TAX_ID_COUNTRIES.includes(country))need('tax_id_text','신분번호');
  if(!CURRENCIES.includes(s(r.currency_code)))e.push('받는 곳: 화폐를 USD·JPY·EUR 중에서 골라 주세요.');
  if(!s(r.courier_text))e.push('운송사가 비어 있어요. 물류 담당자가 요약 수정에서 정해 주세요.');
  if(s(r.incoterms_code)&&!INCOTERMS.includes(s(r.incoterms_code)))e.push('Incoterms는 DAP·DDU·DDP 중 하나여야 해요.');
  const snd=senderOf(r,defaults);
  if(!snd.name_text||!snd.phone_text||!snd.address_text)e.push('발송인 이름·전화·주소가 비어 있어요.');
  if(/fedex/i.test(s(r.courier_text))){
   if(!snd.email_text)e.push('FEDEX는 발송인 이메일이 필요해요.');
   if(!s(r.email_text))e.push('FEDEX는 받는 분 이메일이 필요해요.');
  }
 }
 return e;
}

// 5행부터 넣을 2차원 배열. 빈 칸은 ''(셀을 만들지 않음), 수량·무게·단가는 숫자.
function buildRows(form,request,recipient,items,defaults=SENDER){
 if(!FORMS[form])throw new Error('이 운송 방식은 파스토 양식이 없어요.');
 const r=recipient||{},no=s(request?.fassto_order_no),snd=senderOf(r,defaults);
 return (items||[]).map(it=>{
  const code=s(it.product_code),qty=Number(it.qty),exp=s(it.lot_text)&&it.expires_on?String(it.expires_on).slice(0,10):'';
  if(form==='overseas')return [s(r.country_code).toUpperCase(),s(r.courier_text),no,snd.name_text,'',snd.phone_text,snd.address_text,
   s(r.name_text),s(r.phone_text),s(r.postal_text),s(r.state_text),s(r.city_text),s(r.district_text),s(r.address1_text),s(r.tax_id_text),
   qty,s(r.currency_code),code,s(it.en_name_text),s(it.hs_code_text),blank(it.weight_kg)?1:Number(it.weight_kg),blank(it.unit_price)?'':Number(it.unit_price),
   BRAND,'','',s(r.incoterms_code),snd.email_text,s(r.email_text)];
  if(form==='parcel')return ['',no,s(r.name_text),s(r.postal_text),s(r.address1_text),s(r.address2_text),s(r.phone_text),'',code,qty,
   s(r.sender_name_text),s(r.sender_phone_text),'','','','','',exp,''];
  return [code,qty,no,exp,'','','차량'];
 });
}

// SheetJS 워크북. 1~4행은 원본 그대로, 시트 이름도 원본과 같게. 상품코드·주문번호·우편번호·전화 칸은 문자 셀(@).
function toWorkbook(form,rows,lib){
 const X=lib||root.XLSX,f=FORMS[form];
 if(!X)throw new Error('엑셀 도구를 불러오지 못했어요. 새로고침한 뒤 다시 해 주세요.');
 if(!f)throw new Error('이 운송 방식은 파스토 양식이 없어요.');
 const ws={},all=[...f.head,...(rows||[])],width=f.head[0].length;
 all.forEach((row,r)=>row.forEach((v,c)=>{
  if(v==null||v==='')return;
  const ref=X.utils.encode_cell({r,c});
  if(typeof v==='number'&&r>=4)ws[ref]={t:'n',v};
  else{ws[ref]={t:'s',v:String(v)};if(r>=4&&f.text.includes(c))ws[ref].z='@';}
 }));
 ws['!ref']=X.utils.encode_range({s:{r:0,c:0},e:{r:all.length-1,c:width-1}});
 ws['!cols']=Array.from({length:width},()=>({wch:18}));
 const wb=X.utils.book_new();X.utils.book_append_sheet(wb,ws,f.sheet);
 return wb;
}
const fileName=(form,request)=>`파스토_${FORMS[form]?.label||'양식'}_${s(request?.fassto_order_no)||'주문번호없음'}.xlsx`;

// ── 파스토 상품 목록(로트별 행) ──
function groupStock(rows){
 const map=new Map();
 for(const x of rows||[]){
  const code=s(x.product_code);if(!code)continue;
  let g=map.get(code);
  if(!g){g={product_code:code,product_name:s(x.product_name),barcode:s(x.barcode),kind_text:s(x.kind_text),total_qty:0,lots:[]};map.set(code,g);}
  const q=Number(x.available_qty)||0;g.total_qty+=q;
  if(s(x.lot_text))g.lots.push({lot_text:s(x.lot_text),expires_on:x.expires_on?String(x.expires_on).slice(0,10):null,available_qty:q});
 }
 return [...map.values()].sort((a,b)=>a.product_name.localeCompare(b.product_name,'ko')||a.product_code.localeCompare(b.product_code));
}
function searchStock(groups,q,limit=20){
 const t=s(q).toLowerCase();if(!t)return [];
 return (groups||[]).filter(g=>[g.product_name,g.barcode,g.product_code].some(v=>v.toLowerCase().includes(t))).slice(0,limit);
}
function availableFor(item,groups){
 const g=(groups||[]).find(x=>x.product_code===s(item?.product_code));if(!g)return null;
 if(s(item.lot_text)){const l=g.lots.find(x=>x.lot_text===s(item.lot_text));return l?l.available_qty:0;}
 return g.total_qty;
}
function qtyWarning(item,groups){
 const a=availableFor(item,groups),q=Number(item?.qty);
 return a!=null&&Number.isFinite(q)&&q>a?`출고 가능 ${a.toLocaleString('ko-KR')}개보다 많아요.`:'';
}
function stockWarnings(items,groups){
 return (items||[]).map((it,i)=>(groups||[]).some(g=>g.product_code===s(it.product_code))?'':`${i+1}번째 품목(${s(it.product_code)})은 파스토 목록에 없는 상품이에요.`).filter(Boolean);
}
function stockAge(sync,groups,nowMs){
 const t=Date.parse(sync?.synced_at||'');
 if(!Number.isFinite(t))return {text:'파스토 목록이 아직 없어요. 품목은 상품코드를 직접 확인해 주세요.',stale:true};
 const k=new Date(t+KST).toISOString(),stale=nowMs-t>STALE_MS;
 return {text:`파스토 목록: ${k.slice(5,7)}/${k.slice(8,10)} ${k.slice(11,16)} 기준 (상품 ${(groups||[]).length}종)${stale?' · 재고 정보가 오래됐어요':''}`,stale};
}

// ── 저장용 변환 ──
// 폼 값({name_text,...})에서 받는 곳 행을 만든다. 담당자 칸은 담당자일 때만 넣는다(요청자 저장이 담당자 값을 덮지 않게).
function toRecipientRow(values,{isHandler=false}={}){
 const v=values||{},row={};
 for(const k of [...RECIPIENT_KEYS,...(isHandler?HANDLER_KEYS:[])])if(k in v)row[k]=k==='country_code'?s(v[k]).toUpperCase():s(v[k]);
 return row;
}
function toItemRows(items){
 return (items||[]).map(it=>({product_code:s(it.product_code),product_name_text:s(it.product_name_text),qty:Number(it.qty),
  lot_text:s(it.lot_text),expires_on:s(it.lot_text)&&it.expires_on?String(it.expires_on).slice(0,10):null,en_name_text:s(it.en_name_text),
  weight_kg:blank(it.weight_kg)?null:Number(it.weight_kg),unit_price:blank(it.unit_price)?null:Number(it.unit_price),hs_code_text:s(it.hs_code_text)}));
}
// 저장 전 형식 검사(필수 칸은 내려받을 때 본다)
function checkInput(form,recipient,items){
 const e=[],r=recipient||{},list=items||[];
 if(list.length>MAX_ITEMS)e.push('품목은 50줄까지 넣을 수 있어요.');
 list.forEach((it,i)=>{
  const n=i+1;
  if(!(Number.isInteger(Number(it.qty))&&Number(it.qty)>=1))e.push(`${n}번째 품목의 수량을 1 이상의 정수로 적어 주세요.`);
  if(!blank(it.unit_price)&&!(Number(it.unit_price)>=0))e.push(`${n}번째 품목의 단가는 숫자로 적어 주세요.`);
  if(!blank(it.weight_kg)&&!(Number(it.weight_kg)>0))e.push(`${n}번째 품목의 무게는 0보다 큰 숫자로 적어 주세요.`);
 });
 if(form==='overseas'){
  if(s(r.country_code)&&!/^[A-Za-z]{2}$/.test(s(r.country_code)))e.push('국가코드는 영문 두 글자로 적어 주세요(예 CH).');
  if(s(r.currency_code)&&!CURRENCIES.includes(s(r.currency_code)))e.push('화폐는 USD·JPY·EUR 중에서 골라 주세요.');
 }
 return e;
}

return {FORMS,SENDER,BRAND,CURRENCIES,INCOTERMS,TAX_ID_COUNTRIES,MAX_ITEMS,RECIPIENT_KEYS,HANDLER_KEYS,RECIPIENT_FIELDS,HANDLER_FIELDS,
 formFor,formHint,senderOf,validate,buildRows,toWorkbook,fileName,groupStock,searchStock,availableFor,qtyWarning,stockWarnings,stockAge,
 toRecipientRow,toItemRows,checkInput};
});
