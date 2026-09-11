// Pure functions shared by Apps Script and Node regression tests.
var HEADERS={
  orders:['_주문ID','_반영버전','Invoice','Customer','담당자','발주일','입금일','출고일','주문상태','출고상태','메모'],
  items:['_주문ID','_반영버전','_품목ID','Invoice','Product','Barcode','Sales_Type','Qty','Unit Price','Amount'],
  state:['_주문ID','_반영버전','삭제됨','반영시각']
};
function revisionNumber(value){
  var text=String(value);
  if(!/^[1-9][0-9]*$/.test(text))throw new Error('Invalid revision');
  return BigInt(text);
}
function finiteNumber(value){
  if(value===null||value===''||typeof value==='boolean'||!Number.isFinite(Number(value)))throw new Error('Invalid number');
  return Number(value);
}
function textValue(value){return value==null?'':String(value);}
function applyJobs(current,jobs,now){
  var orders=current.orders.map(r=>r.slice()),items=current.items.map(r=>r.slice());
  var states=new Map();
  current.state.forEach(r=>{
    if(states.has(r[0]))throw new Error('Duplicate checkpoint');
    revisionNumber(r[1]);states.set(r[0],r.slice());
  });
  jobs.forEach(job=>{
    var id=textValue(job.invoice_id),revision=String(job.revision),previous=states.get(id);
    if(!id)throw new Error('Missing invoice ID');
    if(previous&&revisionNumber(previous[1])>=revisionNumber(revision))return;
    revisionNumber(revision);
    var nextItems=[],nextOrder=null;
    if(job.deleted!==true){
      var inv=job.invoice;
      if(!inv||String(inv.id)!==id||!inv.no||!Array.isArray(job.items))throw new Error('Invalid invoice snapshot');
      var seen=new Set();
      nextItems=job.items.map(item=>{
        var itemId=textValue(item.id);
        if(!itemId||seen.has(itemId))throw new Error('Invalid/duplicate item ID');
        seen.add(itemId);
        var qty=finiteNumber(item.qty),price=finiteNumber(item.price),amount=item.amount_override==null?qty*price:finiteNumber(item.amount_override);
        if(!Number.isFinite(amount))throw new Error('Invalid number');
        return [id,revision,itemId,textValue(inv.no),textValue(item.name),textValue(item.barcode),textValue(item.sales_type),qty,price,amount];
      });
      nextOrder=[id,revision,inv.no,inv.customer,inv.mgr,inv.order_date,inv.pay_date,inv.ship_date,inv.status,inv.ship_status,inv.note].map(textValue);
    }
    orders=orders.filter(r=>r[0]!==id);items=items.filter(r=>r[0]!==id);
    if(nextOrder)orders.push(nextOrder);
    items.push(...nextItems);states.set(id,[id,revision,job.deleted===true,textValue(now)]);
  });
  orders.sort((a,b)=>a[0].localeCompare(b[0]));
  items.sort((a,b)=>a[0].localeCompare(b[0])||a[2].localeCompare(b[2]));
  return {orders:orders,items:items,state:Array.from(states.values()).sort((a,b)=>a[0].localeCompare(b[0]))};
}
function typedCell(value){
  if(value===null||value===undefined||value==='')return {};
  if(typeof value==='number')return {userEnteredValue:{numberValue:finiteNumber(value)}};
  if(typeof value==='boolean')return {userEnteredValue:{boolValue:value}};
  return {userEnteredValue:{stringValue:String(value)}};
}
if(typeof module!=='undefined')module.exports={applyJobs,HEADERS,typedCell};
