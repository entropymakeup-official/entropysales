// This repository is public (GitHub Pages). Business data belongs in Supabase or internal documents, never here.
// The checks below run in CI so a commit that adds a report, a real phone number, a business number,
// an outside contact email or an embedded image fails before it is merged.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const root=path.join(__dirname,'..');

function trackedFiles(){
 return execFileSync('git',['ls-files','-z'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean);
}

// Synthetic values used in tests and placeholders.
const SYNTHETIC_BIZ=/^(000-00-00000|100-00-0000\d)$/;
const isSyntheticPhone=(mid,last)=>mid.startsWith('0')||(mid==='1234'&&last==='5678');
const ALLOWED_EMAIL_DOMAINS=/(^|\.)(entropymakeup\.com|entropy\.internal|anthropic\.com|example\.(com|org|test)|test|x\.com)$/i;
const ALLOWED_EMAILS=new Set(['someone@gmail.com','user@drive.google.com']);

function findings(file,text){
 const out=[];
 const line=i=>text.slice(0,i).split('\n').length;
 for(const m of text.matchAll(/(?<!\d)01[016789]-?(\d{3,4})-?(\d{4})(?!\d)/g))
  if(!isSyntheticPhone(m[1],m[2]))out.push(`${file}:${line(m.index)} 휴대폰 번호 ${m[0]}`);
 for(const m of text.matchAll(/(?<![\d-])\d{3}-\d{2}-\d{5}(?![\d-])/g))
  if(!SYNTHETIC_BIZ.test(m[0]))out.push(`${file}:${line(m.index)} 사업자번호 형식 ${m[0]}`);
 for(const m of text.matchAll(/iVBORw0KGgo[A-Za-z0-9+/=]{200,}/g))out.push(`${file}:${line(m.index)} PNG 이미지 내장`);
 for(const m of text.matchAll(/[A-Za-z0-9._%+-]+@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})(?![\w.])/g))
  if(!ALLOWED_EMAIL_DOMAINS.test(m[1])&&!ALLOWED_EMAILS.has(m[0].toLowerCase()))out.push(`${file}:${line(m.index)} 외부 이메일 ${m[0]}`);
 return out;
}

test('no business documents or dated reports are tracked',()=>{
 const bad=trackedFiles().filter(f=>{
  if(/\.(docx?|hwp|pdf|xls|csv)$/i.test(f))return true;
  if(/\.xlsx$/i.test(f))return !f.startsWith('tests/fixtures/');
  return /_20\d\d-\d\d-\d\d[^/]*\.md$/.test(f)||/-report\.html$/.test(f);
 });
 assert.deepEqual(bad,[],'업무 자료는 공개 레포 대신 Drive·인수인계 폴더에 두세요');
});

test('tracked text files carry no real phone numbers, business numbers, outside emails or embedded images',()=>{
 const out=[];
 for(const file of trackedFiles()){
  if(file==='package-lock.json')continue;
  const buf=fs.readFileSync(path.join(root,file));
  if(buf.includes(0))continue; // binary (images, xlsx fixtures)
  out.push(...findings(file,buf.toString('utf8')));
 }
 assert.deepEqual(out,[],'실제 연락처·사업자번호·직인 이미지는 DB(app_settings 등)나 내부 문서에 두세요');
});

test('guard catches real-looking values and lets synthetic ones through',()=>{
 assert.equal(findings('x','010-0000-0000 010-1234-5678 01001234567 000-00-00000 100-00-00002 a@example.test sylee@entropymakeup.com').length,0);
 const hit=findings('x','010-2345-6789 01023456789 123-45-67890 dean@partner.kr iVBORw0KGgo'+'A'.repeat(200));
 assert.deepEqual(hit.map(h=>h.split(' ')[1]),['휴대폰','휴대폰','사업자번호','PNG','외부']);
});
