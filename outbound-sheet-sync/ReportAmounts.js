function reportExpected(current,salesMap){
  var out={orders:current.orders.length,items:current.items.length,quantity:0,amount:0,Revenue:0,Cost:0,Opportunity:0,byOrder:{}};
  var orders=new Map(),seen=new Set();
  current.orders.forEach(r=>{if(!r[0]||orders.has(r[0]))throw new Error('Duplicate order or missing ID');orders.set(r[0],r);out.byOrder[r[0]]={Revenue:0,Cost:0,Opportunity:0};});
  current.items.forEach(r=>{
    var inv=orders.get(r[0]);if(!inv)throw new Error('Missing order');
    if(String(inv[1])!==String(r[1]))throw new Error('Revision mismatch');
    if(!r[2]||seen.has(r[2]))throw new Error('Duplicate item or missing ID');seen.add(r[2]);
    var category=salesMap[r[6]];if(!['Revenue','Cost','Opportunity'].includes(category))throw new Error('Unknown sales type');
    var qty=Number(r[7]),price=Number(r[8]),amount=Number(r[9]);
    if(r[7]===''||r[8]===''||r[9]===''||![qty,price,amount].every(Number.isFinite))throw new Error('Amount mismatch');
    out.quantity+=qty;out.amount+=amount;out[category]+=amount;out.byOrder[r[0]][category]+=amount;
  });return out;
}
