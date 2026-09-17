const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const file=require('node:path').join(__dirname,'../contacts-import.js');
const I=fs.existsSync(file)?require(file):{};
test('maps BOM Korean headers and keeps international phones and leading zeroes',()=>{
 assert.equal(typeof I.parseTable,'function');
 const p=I.parseTable([['\ufeff업체명','담당자','휴대폰','이메일'],['Sample','담당자','01001234567','a@example.test']]);
 assert.equal(p.error,'');assert.equal(p.contacts[0].mobile,'01001234567');
 assert.equal(p.contacts[0].company,'Sample');
});
test('Google and Outlook split names and organisation headers map without inventing company',()=>{
 assert.equal(typeof I.parseTable,'function');
 const p=I.parseTable([['Organization 1 - Name','Given Name','Family Name','E-mail 1 - Value','Phone 1 - Value'],['Sample','Jane','Doe','j@example.test','+44 20 1234']]);
 assert.equal(p.contacts[0].person,'Jane Doe');assert.equal(p.contacts[0].company,'Sample');assert.equal(p.contacts[0].mobile,'+44 20 1234');
 const m=I.parseTable([['Email'],['a@sample.test']]);assert.equal(m.contacts[0].company,'');assert.equal(m.contacts[0].person,'');
});
test('CSV preserves quoted newlines commas escaped quotes and phone strings',()=>{
 assert.equal(typeof I.parseCSV,'function');
 assert.deepEqual(I.parseCSV('회사,이름,전화,메모\r\nSample,Jane,00123,"line1, detail\nline2 ""quote"""\r\n'),[['회사','이름','전화','메모'],['Sample','Jane','00123','line1, detail\nline2 "quote"']]);
 assert.throws(()=>I.parseCSV('a,b\n"unfinished'),/따옴표/);
 assert.deepEqual(I.parseCSV('Company;Name;Phone\nSample;Jane;0123'),[['Company','Name','Phone'],['Sample','Jane','0123']]);
});
test('classifies committed, pending, file duplicates and invalid rows before selection',()=>{
 assert.equal(typeof I.classify,'function');
 const row={company:'Sample',person:'Jane',email:'j@example.test',status:'활성'};
 const result=I.classify([row,{...row,person:'Other',email:'J@example.test'},{...row,person:'Bad',email:'bad'},{...row,person:'No',email:''},{...row,person:'Existing',email:'old@example.test'},{...row,person:'Pending',email:'pending@example.test'}],[{...row,person:'Existing',email:'old@example.test'},{...row,person:'Pending',email:'pending@example.test',_pending:true}]);
 assert.deepEqual(result.map(r=>r._state),['new','dup','invalid','invalid','exists','pending']);
 assert.equal(I.classify([{...row,status:'unknown'}],[])[0]._state,'invalid');
 assert.equal(I.classify([{...row,email:'a@b..test'}],[])[0]._state,'invalid');
});
test('CSV decoder accepts UTF-8 BOM, UTF-16 and Korean legacy bytes',()=>{
 assert.equal(I.decodeCSV(new TextEncoder().encode('\ufeff회사,담당자').buffer),'회사,담당자');
 assert.equal(I.decodeCSV(Uint8Array.from([0xff,0xfe,0x41,0,0x2c,0,0x42,0]).buffer),'A,B');
 assert.equal(I.decodeCSV(Uint8Array.from([0xc8,0xb8,0xbb,0xe7]).buffer),'회사');
});
test('review escapes imported text and only valid new rows get checkboxes',()=>{
 assert.equal(typeof I.renderReview,'function');
 const html=I.renderReview([{company:'<img src=x onerror=alert(1)>',person:'A',_state:'new',_line:2},{company:'B',person:'C',_state:'invalid',_reason:'bad',_line:3}]);
 assert.ok(!html.includes('<img'));assert.ok(html.includes('&lt;img'));assert.equal((html.match(/class="ci-pick"/g)||[]).length,1);
});
test('rejects unknown headers and reports physical row numbers across blank rows',()=>{
 assert.equal(typeof I.parseTable,'function');
 assert.match(I.parseTable([['unknown'],['x']]).error,/머리글/);
 const p=I.parseTable([[],['회사','이름','이메일'],[],['A','B','b@example.test']]);assert.equal(p.contacts[0]._line,4);
});
test('file validation enforces limits and extension before workbook reading',()=>{
 assert.equal(typeof I.validateFile,'function');
 assert.throws(()=>I.validateFile({name:'a.xlsx',size:16*1024*1024}),/15MB/);
 assert.throws(()=>I.validateFile({name:'a.html',size:1}),/지원/);
 assert.doesNotThrow(()=>I.validateFile({name:'A.CSV',size:10}));
});
