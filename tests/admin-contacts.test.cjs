const {test}=require('node:test');const assert=require('node:assert/strict');const Admin=require('../admin-approvals.js');
test('admin contact batches show companies, people and communication details with escaped text',()=>{
 const operations=[{table:'contacts',action:'insert',values:{company:'<Company>',person:'Jane',person_en:'Jane Doe',title:'Director',duty:'Sales',department:'Export',mobile:'00123',fax:'00456',email:'jane@example.test',messenger:'@jane',website:'https://example.test',tags:'buyer'}},{table:'contacts',action:'update',before:{company:'Other',person:'John',phone:'000'},values:{phone:'123'}}];
 const html=Admin.render({isAdmin:true,requests:[{id:'request',status:'pending',created_at:'2026-09-17',operations}],filter:'all'});
 assert.match(html,/연락처 2건/);assert.match(html,/&lt;Company&gt; · Jane/);assert.match(html,/Other/);assert.match(html,/John/);assert.match(html,/jane@example.test/);assert.match(html,/영문 이름/);assert.match(html,/직책/);assert.match(html,/담당 업무/);assert.match(html,/메신저/);assert.doesNotMatch(html,/<Company>/);
 assert.match(Admin.renderDiff({table:'customers',action:'insert',values:{title:'Existing title'}}),/>제목(?: |<)/);
});
