const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const {PGlite}=require('@electric-sql/pglite');
const A='00000000-0000-0000-0000-000000000001',U='00000000-0000-0000-0000-000000000002',O='00000000-0000-0000-0000-000000000003',C='10000000-0000-0000-0000-000000000001',D='20000000-0000-0000-0000-000000000001';
test('contracts enforce approval isolation, permissions, terms, document ownership and stale edits',async()=>{
 const file=path.join(__dirname,'../sql/contracts.sql');assert.ok(fs.existsSync(file),'contracts schema must exist');const db=new PGlite();
 try{
 await db.exec(`create role anon;create role authenticated;create schema auth;create schema storage;
 create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,raw_app_meta_data jsonb default '{}');
 insert into auth.users values('${A}','entropyadmin@entropy.internal',now(),'{}'),('${U}','member@entropymakeup.com',now(),'{}'),('${O}','outside@example.com',now(),'{}');
 create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create table storage.objects(id uuid primary key,bucket_id text,name text);alter table storage.objects enable row level security;
 create table customers(id uuid primary key default gen_random_uuid(),name text not null);
 create table documents(id uuid primary key default gen_random_uuid(),name text,customer text,type text);
 insert into customers values('${C}','거래처 A');insert into documents values('${D}','서명본','거래처 A','계약서');
 grant usage on schema public,auth to authenticated,anon;`);
 for(const table of ['invoices','invoice_items','products','stocks','schedules','tax_records','app_settings','product_details','invoice_drive_documents','tax_invoice_amounts'])await db.exec(`create table ${table}(id uuid primary key default gen_random_uuid(),name text)`);
 await db.exec(fs.readFileSync(path.join(__dirname,'../sql/change-approvals.sql'),'utf8'));await db.exec(fs.readFileSync(file,'utf8'));
 await db.exec(fs.readFileSync(path.join(__dirname,'../sql/contract-clauses.sql'),'utf8'));
 await db.exec(fs.readFileSync(path.join(__dirname,'../sql/contract-returns.sql'),'utf8'));
 const login=async id=>{await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);await db.exec('set role authenticated');};
 const rows=async()=> (await db.query('select * from contracts')).rows;
 const submit=async op=>(await db.query('select submit_change_request($1::jsonb,$2,$3::uuid) r',[JSON.stringify([op]),'계약 확인',crypto.randomUUID()])).rows[0].r;
 const review=async(id,approve=true)=>(await db.query('select review_change_request($1::uuid,$2,$3) r',[id,approve,'검토 완료'])).rows[0].r;
 const values={customer_id:C,name:'2026 공급 계약',status:'유효',start_date:'2026-01-01',end_date:'2026-12-31',payment_type:'분할',deposit_pct:30,balance_pct:70,deposit_due:'발주 시',balance_due:'선적 전',foc_status:'없음',document_id:D};
 const insert=patch=>({table:'contracts',action:'insert',before:null,values:{...values,...patch}});
 await db.exec('set role anon');await assert.rejects(rows,/permission denied/);await login(U);
 await assert.rejects(()=>db.exec(`insert into contracts(customer_id,name) values('${C}','우회')`),/permission denied|APPROVAL_REQUIRED/);
 for(const patch of [{balance_pct:60},{deposit_due:''},{foc_status:'있음',foc_terms:''},{end_date:'2025-12-31'},{start_date:null},{payment_type:'후불',balance_due:''},{document_id:'22222222-2222-2222-2222-222222222222'}])await assert.rejects(()=>submit(insert(patch)));
 const request=await submit(insert({}));assert.equal(request.status,'pending');assert.equal((await rows()).length,0);
 await db.exec('reset role');await assert.rejects(()=>db.exec(fs.readFileSync(path.join(__dirname,'../sql/contract-clauses.sql'),'utf8')),/Pending contract requests/);await db.exec('rollback');await assert.rejects(()=>db.exec(fs.readFileSync(path.join(__dirname,'../sql/contract-returns.sql'),'utf8')),/Pending contract requests/);await db.exec('rollback');await login(U);
 await assert.rejects(()=>review(request.id),/FORBIDDEN|ADMIN/);await login(A);assert.equal((await review(request.id)).status,'approved');let row=(await rows())[0];assert.equal(row.deposit_pct,'30.00');
 assert.equal(row.kol_support_status,'미확인');
 for(const topic of ['returns','defect_liability','unclear_cause']){assert.equal(row[topic+'_status'],'미확인');await assert.rejects(()=>submit(insert({[topic+'_status']:'명시',[topic+'_terms']:''})));}

 for(const patch of [{kol_support_status:'있음'},{kol_support_status:'명시',kol_support_terms:''},{sns_handover_status:'일부명시',sns_handover_terms:' '},{vmd_support_terms:'x'.repeat(4001)}])await assert.rejects(()=>submit(insert(patch)));
 const reviewed={returns_status:'일부명시',returns_terms:'제10조 반품 예외',defect_liability_status:'미기재',defect_liability_terms:'본문 검토 미발견',unclear_cause_status:'명시',unclear_cause_terms:'제11조 공동검사',kol_support_status:'일부명시',kol_support_terms:'제7조 사전 협의',sns_handover_status:'미기재',sns_handover_terms:'검토 원문 1~5쪽에서 계정 이관 조항 미발견'};
 const clauseRequest=await submit({table:'contracts',action:'update',key:{id:row.id},before:row,values:reviewed});
 assert.equal((await rows())[0].kol_support_status,'미확인');await review(clauseRequest.id);row=(await rows())[0];assert.equal(row.kol_support_terms,reviewed.kol_support_terms);assert.equal(row.sns_handover_status,'미기재');for(const k of ['returns','defect_liability','unclear_cause'])assert.equal(row[k+'_terms'],reviewed[k+'_terms']);
 await login(O);await assert.rejects(rows,/UNAUTHORIZED/);await assert.rejects(()=>submit(insert({})),/UNAUTHORIZED/);await login(U);
 const update={table:'contracts',action:'update',key:{id:row.id},before:row,values:{name:'변경 계약'}};
 const pending=await submit(update);assert.equal((await rows())[0].name,'2026 공급 계약');
 const second=await submit({...update,values:{name:'다른 변경'}});await login(A);await review(pending.id);await assert.rejects(()=>review(second.id),/STALE_DATA/);
 const before=(await rows())[0];await assert.rejects(()=>submit({table:'contracts',action:'update',key:{id:before.id},before,values:{previous_contract_id:before.id}}),/cycle|previous|이전|순환/i);
 const rename=await submit({table:'customers',action:'update',key:{id:C},before:{id:C,name:'거래처 A'},values:{name:'거래처 A 변경'}});await review(rename.id);
 const manager=await submit({table:'contracts',action:'update',key:{id:before.id},before,values:{manager:'새 담당자'}});await review(manager.id);assert.equal((await rows())[0].manager,'새 담당자');
 await assert.rejects(()=>submit({table:'documents',action:'update',key:{id:D},before:{id:D,name:'서명본',customer:'거래처 A',type:'계약서'},values:{customer:'다른 거래처'}}),/연결|linked/);
 const renameDoc=await submit({table:'documents',action:'update',key:{id:D},before:{id:D,name:'서명본',customer:'거래처 A',type:'계약서'},values:{customer:'거래처 A 변경'}});await review(renameDoc.id);
 const rejected=await submit(insert({name:'반려될 계약'}));await review(rejected.id,false);assert.equal((await rows()).length,1);
 await assert.rejects(()=>submit({table:'documents',action:'delete',key:{id:D},before:{id:D,name:'서명본',customer:'거래처 A 변경',type:'계약서'}}),/foreign key/);
 await db.exec('reset role');await db.exec(`insert into approval_private.apply_context values(txid_current(),'${A}')`); // no context survives into another transaction
 await db.query("select set_config('request.jwt.claim.sub',$1,false)",[A]);
 await assert.rejects(()=>db.exec(`update contracts set name='직접 수정'`),/APPROVAL_REQUIRED/);
 }finally{await db.close();}
});
