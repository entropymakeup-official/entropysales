const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');

test('index cache key changes whenever app.js content changes',()=>{
  const root=path.join(__dirname,'..');
  const app=fs.readFileSync(path.join(root,'app.js'));
  const index=fs.readFileSync(path.join(root,'index.html'),'utf8');
  const expected=crypto.createHash('sha256').update(app).digest('hex').slice(0,12);
  const actual=index.match(/<script src="app\.js\?v=([a-f0-9]{12})"><\/script>/)?.[1];
  assert.equal(actual,expected,'app.js 변경 시 index.html의 콘텐츠 해시도 갱신해야 합니다.');
});
