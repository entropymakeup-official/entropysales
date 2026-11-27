#!/usr/bin/env node
'use strict';
// 파스토가 준 api_cd·api_key를 사무실 PC 설정 파일(저장소 밖)에 넣는다. 키는 화면에 보이지 않게 입력받는다.
// 쓰는 법(저장소 폴더에서): node tools/fassto-set-keys.cjs
const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline');
const S=require('./fassto-sync.cjs');

function ask(q,{hidden=false}={}){
 return new Promise(res=>{
  const rl=readline.createInterface({input:process.stdin,output:process.stdout,terminal:true});
  if(hidden){const w=rl._writeToOutput.bind(rl);rl._writeToOutput=s=>{if(s.startsWith(q))w(q);else if(/\r|\n/.test(s))w(s);};}
  rl.question(q,a=>{rl.close();if(hidden)process.stdout.write('\n');res(String(a||'').trim());});
 });
}

(async()=>{
 const dir=S.defaultDir(),p=path.join(dir,'config.json');
 if(!fs.existsSync(p))S.loadConfig(dir);
 const c=JSON.parse(fs.readFileSync(p,'utf8').replace(/^﻿/,''));
 c.fassto=c.fassto||{};
 const cd=await ask('api_cd 입력 후 Enter: ');
 const key=await ask('api_key 입력 후 Enter (화면에 안 보여요): ',{hidden:true});
 const url=await ask(`호출 서버 URL (지금 ${c.fassto.baseUrl||'https://fmsapi.fassto.ai'} · 그대로면 Enter): `);
 if(!cd||!key){console.log('api_cd나 api_key가 비어 있어 저장하지 않았어요.');process.exitCode=1;return;}
 c.fassto.apiCd=cd;c.fassto.apiKey=key;if(url)c.fassto.baseUrl=url;
 fs.writeFileSync(p+'.tmp',JSON.stringify(c,null,1));fs.renameSync(p+'.tmp',p);
 const left=S.loadConfig(dir).missing;
 console.log('저장했어요. '+(left.length?'아직 빈 값: '+left.join(', '):'빈 값 없음 — Claude에게 "넣었어"라고 알려 주세요.'));
})().catch(e=>{console.error('실패: '+e.message);process.exitCode=1;});
