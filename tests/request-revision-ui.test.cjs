const test=require('node:test'),assert=require('node:assert/strict'),UI=require('../admin-approvals.js');
test('only server-authorized pending requests display edit action',()=>{
 const requests=[{id:'own',can_edit:true,status:'pending',operations:[]},{id:'other',can_edit:false,status:'pending',operations:[]},{id:'done',can_edit:true,status:'approved',operations:[]}];
 const html=UI.render({requests});assert.match(html,/data-edit="own"/);assert.doesNotMatch(html,/data-edit="other"|data-edit="done"/);
});
test('review submits the exact displayed request revision',async()=>{
 let sent;const c=UI.createController({rpc:async(name,args)=>{if(name.startsWith('review')){sent={name,args};return {error:{message:'REQUEST_UPDATED'}};}return {data:{is_admin:true,requests:[{id:'r',status:'pending',revision:4}]}};}});
 await c.load();assert.equal(await c.review('r',true,''),false);
 assert.equal(sent.name,'review_change_request_versioned');assert.equal(sent.args.p_revision,4);assert.equal(c.state.requests[0].status,'pending');
 c.state.requests[0].revision=5;await c.review('r',true,'',4);assert.equal(sent.args.p_revision,4,'confirmation must keep the version visible before it opened');
});
