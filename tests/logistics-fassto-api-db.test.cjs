const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const {PGlite}=require('@electric-sql/pglite');
const read=f=>fs.readFileSync(path.join(__dirname,'../sql',f),'utf8');
const id=n=>'00000000-0000-0000-0000-'+String(n).padStart(12,'0');
const KEY='test-sync-key-'+'0'.repeat(40);
// KST 날짜(오늘 기준 n일)
const kday=n=>new Date(Date.now()+9*3600000+n*86400000).toISOString().slice(0,10);

async function setup(){
 const db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create schema auth;create schema approval_private;
 create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz);
 create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz);
 create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create function auth.jwt() returns jsonb language sql security definer as $$select jsonb_build_object('session_id',current_setting('request.jwt.claim.session_id',true),'email',(select email from auth.users where id=nullif(current_setting('request.jwt.claim.sub',true),'')::uuid))$$;
 grant usage on schema public,auth,approval_private to anon,authenticated;
 insert into auth.users values ('${id(1)}','req@entropymakeup.com',now(),null),('${id(3)}','handler@entropymakeup.com',now(),null),('${id(4)}','other@entropymakeup.com',now(),null);
 insert into auth.sessions select id,id,null from auth.users;
 create table public.invoices(id uuid primary key default gen_random_uuid(),no text);grant select on public.invoices to authenticated;`);
 await db.exec(read('team-tasks.sql'));
 await db.exec(read('logistics.sql'));
 await db.exec(`insert into logistics_handlers(email,display_name) values ('handler@entropymakeup.com','가짜 담당');
  insert into logistics_people(email,display_name) values ('req@entropymakeup.com','가짜 요청자');`);
 await db.exec(read('logistics-fassto.sql'));
 const sql=read('logistics-fassto-api.sql');await db.exec(sql);await db.exec(sql); // 다시 실행해도 안전
 await db.exec(`insert into approval_private.logistics_fassto_keys(key_hash,label_text) values (encode(sha256(convert_to('${KEY}','UTF8')),'hex'),'테스트');
  insert into approval_private.logistics_fassto_settings(id,default_requester_email) values (1,'handler@entropymakeup.com');`);
 const login=async n=>{await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.session_id',$1,false)",[id(n)]);await db.exec('set role authenticated');};
 const asSystem=async()=>{await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub','',false)");};
 const asAnon=async()=>{await asSystem();await db.exec('set role anon');};
 const ingest=async(deliveries,stock=null,key=KEY)=>{await asAnon();try{return (await db.query('select public.logistics_fassto_ingest($1,$2::jsonb,$3::jsonb) r',[key,stock==null?null:JSON.stringify(stock),deliveries==null?null:JSON.stringify(deliveries)])).rows[0].r;}finally{await asSystem();}};
 const create=async(o={})=>{await login(1);try{return (await db.query(`insert into logistics_requests(type_code,title_text,team_code,counterparty_text,ship_mode_code) values ('b2b',$1,'global','가짜 바이어',$2) returning *`,[o.title||'수동 요청',o.mode||'direct'])).rows[0];}finally{await asSystem();}};
 const req=async slip=>(await db.query('select * from logistics_requests where fassto_slip_no=$1',[slip])).rows[0];
 return {db,login,asSystem,asAnon,ingest,create,req};
}
const dlv=(o={})=>({slip_no:'GG24OO261201000001',order_no:'가짜 주문 1',order_date:'2026-12-01',out_div:'car',shop_name:'가짜 바이어',status_code:'ORDER',
 remark:'가짜 비고',invoice_no:'',parcel_name:'',registered_by:'가짜 요청자',qty_total:30,
 items:[{product_code:'11111111111111',product_name:'가짜 상품',expires_on:'2029-01-01',qty:30}],...o});

test('연결 칸: 회사 구성원은 파스토 칸을 넣거나 바꿀 수 없고, 시스템은 바꿀 수 있다',async()=>{
 const {db,login,asSystem}=await setup();
 try{
  await login(1);
  const r=(await db.query(`insert into logistics_requests(type_code,title_text,team_code,counterparty_text,ship_mode_code,fassto_slip_no,fassto_status_code)
   values ('b2b','t','global','c','direct','HACK1','DONE') returning *`)).rows[0];
  assert.equal(r.fassto_slip_no,null);assert.equal(r.fassto_status_code,null);
  await asSystem();
  await db.query(`update logistics_requests set fassto_slip_no='GG24OO261201000009',fassto_status_code='ORDER' where id=$1`,[r.id]);
  await login(3);
  await db.query(`update logistics_requests set fassto_slip_no='HACK2',fassto_status_code='DONE',title_text='고침' where id=$1`,[r.id]);
  await asSystem();
  const after=(await db.query('select * from logistics_requests where id=$1',[r.id])).rows[0];
  assert.equal(after.fassto_slip_no,'GG24OO261201000009');assert.equal(after.fassto_status_code,'ORDER');assert.equal(after.title_text,'고침');
  await assert.rejects(()=>db.query(`update logistics_requests set fassto_status_code='PARTDONE' where id=$1`,[r.id]),/check/i);
 }finally{await db.close();}
});

test('기사 정보: 담당자만 쓰고, 요청자·담당자만 읽고, 취소된 요청에는 못 쓴다',async()=>{
 const {db,login,asSystem,create}=await setup();
 try{
  const r=await create();
  await login(1);
  await assert.rejects(()=>db.query(`insert into logistics_request_drivers(request_id,driver_name_text) values ($1,'가짜 기사')`,[r.id]));
  await login(3);
  await db.query(`insert into logistics_request_drivers(request_id,driver_name_text,driver_phone_text,vehicle_no_text) values ($1,' 가짜 기사 ','010-0000-0000','00가0000')`,[r.id]);
  const row=(await db.query('select * from logistics_request_drivers where request_id=$1',[r.id])).rows[0];
  assert.equal(row.driver_name_text,'가짜 기사');assert.equal(row.updated_by_text,'handler@entropymakeup.com');
  await login(1);
  assert.equal((await db.query('select * from logistics_request_drivers where request_id=$1',[r.id])).rows.length,1);
  await login(4);
  assert.equal((await db.query('select * from logistics_request_drivers where request_id=$1',[r.id])).rows.length,0);
  await asSystem();
  await db.query(`update logistics_requests set status_code='canceled' where id=$1`,[r.id]);
  await login(3);
  await assert.rejects(()=>db.query(`update logistics_request_drivers set vehicle_no_text='11나1111' where request_id=$1`,[r.id]),/LOGISTICS_CLOSED/);
 }finally{await db.close();}
});

test('동기화 표: 기존 재고 갱신 행은 kind_code=stock, 오류 칸 기본값은 빈 문자열',async()=>{
 const {db}=await setup();
 try{
  await db.query(`select approval_private.logistics_replace_fassto_stock('[{"product_code":"11111111111111","available_qty":5}]'::jsonb,'fms-browser')`);
  const s=(await db.query('select kind_code,error_text from logistics_fassto_sync')).rows[0];
  assert.deepEqual(s,{kind_code:'stock',error_text:''});
  await assert.rejects(()=>db.query(`insert into logistics_fassto_sync(source_text,row_count,kind_code) values ('fassto-api',0,'etc')`),/check/i);
 }finally{await db.close();}
});

test('열쇠·설정 표: anon·authenticated는 읽을 수 없다',async()=>{
 const {db,login,asAnon,asSystem}=await setup();
 try{
  await login(3);
  await assert.rejects(()=>db.query('select * from approval_private.logistics_fassto_keys'),/permission denied/);
  await asAnon();
  await assert.rejects(()=>db.query('select * from approval_private.logistics_fassto_settings'),/permission denied/);
  await asSystem();
 }finally{await db.close();}
});

test('ingest: 열쇠가 틀리거나 꺼졌으면 거부하고, 로그인한 구성원은 실행할 수 없다',async()=>{
 const {db,login,ingest,asSystem}=await setup();
 try{
  await assert.rejects(()=>ingest([dlv()],null,'wrong-key-'+'1'.repeat(40)),/LOGISTICS_FASSTO_KEY/);
  await db.exec(`update approval_private.logistics_fassto_keys set is_active=false`);
  await assert.rejects(()=>ingest([dlv()]),/LOGISTICS_FASSTO_KEY/);
  await db.exec(`update approval_private.logistics_fassto_keys set is_active=true`);
  await login(3);
  await assert.rejects(()=>db.query('select public.logistics_fassto_ingest($1,null,null)',[KEY]),/permission denied/);
  await asSystem();
  assert.equal((await db.query('select count(*)::int n from logistics_requests')).rows[0].n,0);
 }finally{await db.close();}
});

test('ingest: 새 출고는 요청 한 건을 만들고(요청자 매핑·품목·슬랙 알림), 다시 보내도 늘지 않는다',async()=>{
 const {db,ingest,req}=await setup();
 try{
  const res=await ingest([dlv()]);
  assert.equal(res.created,1);
  const r=await req('GG24OO261201000001');
  assert.equal(r.type_code,'b2b');assert.equal(r.ship_mode_code,'direct');assert.equal(r.title_text,'가짜 바이어 · 가짜 주문 1');
  assert.equal(r.counterparty_text,'가짜 바이어');assert.equal(r.requester_email,'req@entropymakeup.com');
  assert.equal((await db.query('select want_date::text d from logistics_requests where id=$1',[r.id])).rows[0].d,'2026-12-01');
  assert.equal(r.qty_summary_text,'품목 1종 · 총 30개');assert.equal(r.note_text,'[파스토 GG24OO261201000001] 가짜 비고');
  assert.equal(r.fassto_status_code,'ORDER');assert.match(r.fassto_order_no,/^LG\d{8}_\d{3}$/);assert.equal(r.status_code,'requested');
  const it=(await db.query('select product_code,qty,lot_text,expires_on::text exp from logistics_request_items where request_id=$1',[r.id])).rows;
  assert.equal(it.length,1);assert.equal(it[0].lot_text,'2029-01-01');assert.equal(it[0].exp,'2029-01-01');
  assert.equal((await db.query(`select count(*)::int n from logistics_slack_outbox where request_id=$1 and event_code='created'`,[r.id])).rows[0].n,1);
  const again=await ingest([dlv()]);
  assert.deepEqual([again.created,again.updated],[0,0]);
  assert.equal((await db.query('select count(*)::int n from logistics_requests')).rows[0].n,1);
  const unknown=await ingest([dlv({slip_no:'GG24OO261201000002',registered_by:'모르는 사람',out_div:'parcel',order_no:'LG20261201_901',items:undefined})]);
  assert.equal(unknown.created,1);
  const u=await req('GG24OO261201000002');
  assert.equal(u.requester_email,'handler@entropymakeup.com');assert.equal(u.ship_mode_code,'parcel');assert.equal(u.qty_summary_text,'총 30개');
  const sync=(await db.query(`select row_count,note_text from logistics_fassto_sync where kind_code='delivery' order by id desc limit 1`)).rows[0];
  assert.equal(sync.row_count,1);assert.match(sync.note_text,/새 1/);
 }finally{await db.close();}
});

test('ingest: 대시보드에서 만든 요청은 LG 주문번호로 연결하고 새로 만들지 않는다',async()=>{
 const {db,ingest,create,req}=await setup();
 try{
  const mine=await create();
  const res=await ingest([dlv({order_no:mine.fassto_order_no})]);
  assert.deepEqual([res.created,res.updated],[0,1]);
  assert.equal((await req('GG24OO261201000001')).id,mine.id);
 }finally{await db.close();}
});

test('ingest: 품목 변경은 요청·접수 상태에서만 반영하고, 준비중 이후는 댓글을 한 번만 남긴다',async()=>{
 const {db,ingest,req,login,asSystem}=await setup();
 try{
  await ingest([dlv()]);
  const r=await req('GG24OO261201000001');
  const changed=dlv({items:[{product_code:'11111111111111',product_name:'가짜 상품',expires_on:'2029-01-01',qty:40}]});
  assert.equal((await ingest([changed])).updated,1);
  assert.equal((await db.query('select qty from logistics_request_items where request_id=$1',[r.id])).rows[0].qty,40);
  assert.equal((await req('GG24OO261201000001')).qty_summary_text,'품목 1종 · 총 40개');
  await login(3);await db.query(`update logistics_requests set status_code='preparing' where id=$1`,[r.id]);await asSystem();
  const again=dlv({items:[{product_code:'11111111111111',product_name:'가짜 상품',expires_on:'2029-01-01',qty:50}]});
  await ingest([again]);await ingest([again]);
  assert.equal((await db.query('select qty from logistics_request_items where request_id=$1',[r.id])).rows[0].qty,40);
  const c=(await db.query('select body_text,author_email from logistics_request_comments where request_id=$1',[r.id])).rows;
  assert.equal(c.length,1);assert.equal(c[0].author_email,'fassto-sync');assert.match(c[0].body_text,/품목이 바뀌었어요/);
 }finally{await db.close();}
});

test('ingest: 파스토 취소는 출고완료 전이면 요청을 취소하고, 출고완료면 댓글만, 없는 건은 건너뛴다',async()=>{
 const {db,ingest,req,login,asSystem}=await setup();
 try{
  await ingest([dlv(),dlv({slip_no:'GG24OO261201000003'})]);
  const res=await ingest([dlv({status_code:'CANCEL'}),dlv({slip_no:'GG24OO261201000099',status_code:'CANCEL'})]);
  assert.deepEqual([res.canceled,res.skipped],[1,1]);
  const a=await req('GG24OO261201000001');
  assert.equal(a.status_code,'canceled');assert.equal(a.status_note_text,'파스토에서 출고요청 취소');assert.equal(a.fassto_status_code,'CANCEL');
  const b=await req('GG24OO261201000003');
  await login(3);await db.query(`update logistics_requests set status_code='shipped',result_text='차량 00가0000',shipped_on='2026-12-01' where id=$1`,[b.id]);await asSystem();
  await ingest([dlv({slip_no:'GG24OO261201000003',status_code:'CANCEL'})]);
  assert.equal((await req('GG24OO261201000003')).status_code,'shipped');
  assert.equal((await db.query(`select count(*)::int n from logistics_request_comments where request_id=$1`,[b.id])).rows[0].n,1);
 }finally{await db.close();}
});

test('ingest: 택배 송장은 결과 칸이 비어 있을 때만 채우고 상태는 바꾸지 않는다',async()=>{
 const {db,ingest,req,login,asSystem}=await setup();
 try{
  // 출고완료라 주문일이 오늘(KST) 전이면 새로 만들지 않으므로(F1) 오늘 날짜로 보낸다
  await ingest([dlv({out_div:'parcel',order_no:'LG20261201_902',status_code:'DONE',order_date:kday(0),invoice_no:'000011112222',parcel_name:'가짜택배'})]);
  const r=await req('GG24OO261201000001');
  assert.equal(r.result_text,'가짜택배 000011112222');assert.equal(r.status_code,'requested');
  await login(3);await db.query(`update logistics_requests set result_text='직접 적음' where id=$1`,[r.id]);await asSystem();
  const res=await ingest([dlv({out_div:'parcel',order_no:'LG20261201_902',status_code:'DONE',order_date:kday(0),invoice_no:'999',parcel_name:'가짜택배'})]);
  assert.equal(res.invoices,0);assert.equal((await req('GG24OO261201000001')).result_text,'직접 적음');
 }finally{await db.close();}
});

test('ingest: 재고는 fassto-api로 바꾸고, 지난번 절반 미만이면 바꾸지 않고 경고한다',async()=>{
 const {db,ingest}=await setup();
 try{
  const rows=n=>Array.from({length:n},(_,i)=>({product_code:String(11111111111110+i),barcode:'',product_name:'가짜 상품',kind_text:'본품',lot_text:'',expires_on:'2029-01-01',available_qty:5}));
  const a=await ingest(null,rows(10));
  assert.equal(a.stock_rows,10);
  assert.equal((await db.query(`select source_text from logistics_fassto_sync where kind_code='stock' order by id desc limit 1`)).rows[0].source_text,'fassto-api');
  const b=await ingest(null,rows(4));
  assert.equal(b.stock_rows,null);assert.match(b.stock_warning,/재고 4행\(지난번 10행\)/);
  assert.equal((await db.query('select count(*)::int n from logistics_fassto_stock')).rows[0].n,10);
 }finally{await db.close();}
});

test('report_error: 열쇠 검사 후 delivery 실패 행을 남긴다',async()=>{
 const {db,asAnon,asSystem}=await setup();
 try{
  await asAnon();
  await assert.rejects(()=>db.query('select public.logistics_fassto_report_error($1,$2)',['x'.repeat(40),'e']),/LOGISTICS_FASSTO_KEY/);
  await db.query('select public.logistics_fassto_report_error($1,$2)',[KEY,'파스토 응답 없음']);
  await asSystem();
  const s=(await db.query(`select kind_code,row_count,error_text from logistics_fassto_sync order by id desc limit 1`)).rows[0];
  assert.deepEqual(s,{kind_code:'delivery',row_count:0,error_text:'파스토 응답 없음'});
 }finally{await db.close();}
});


test('F1 ingest: 연결된 요청이 없는 출고완료 건은 오늘(KST) 전 주문이면 새로 만들지 않는다',async()=>{
 const {db,ingest,create,req}=await setup();
 try{
  const res=await ingest([dlv({status_code:'DONE',order_date:kday(-1)}),dlv({slip_no:'GG24OO261201000002',status_code:'DONE',order_date:kday(0)}),
   dlv({slip_no:'GG24OO261201000003',status_code:'DONE',order_date:''}),dlv({slip_no:'GG24OO261201000004',status_code:'ORDER',order_date:kday(-3)})]);
  assert.deepEqual([res.created,res.skipped],[3,1]);
  assert.equal(await req('GG24OO261201000001'),undefined);
  // 이미 있는 요청은 출고완료·지난 주문이어도 계속 연결·갱신한다
  const mine=await create();
  const linked=await ingest([dlv({slip_no:'GG24OO261201000005',order_no:mine.fassto_order_no,status_code:'DONE',order_date:kday(-2)}),
   dlv({slip_no:'GG24OO261201000004',status_code:'DONE',order_date:kday(-3)})]);
  assert.deepEqual([linked.created,linked.skipped],[0,0]);
  assert.equal((await req('GG24OO261201000005')).id,mine.id);
  assert.equal((await req('GG24OO261201000004')).fassto_status_code,'DONE');
 }finally{await db.close();}
});

test('F2 fassto_created: 구성원은 넣거나 바꿀 수 없고, 동기화가 만든 요청만 true',async()=>{
 const {db,login,asSystem,ingest,req}=await setup();
 try{
  await login(1);
  const r=(await db.query(`insert into logistics_requests(type_code,title_text,team_code,counterparty_text,ship_mode_code,fassto_created)
   values ('b2b','t','global','c','direct',true) returning *`)).rows[0];
  assert.equal(r.fassto_created,false);
  await login(3);
  await db.query(`update logistics_requests set fassto_created=true where id=$1`,[r.id]);
  await asSystem();
  assert.equal((await db.query('select fassto_created from logistics_requests where id=$1',[r.id])).rows[0].fassto_created,false);
  await ingest([dlv()]);
  assert.equal((await req('GG24OO261201000001')).fassto_created,true);
 }finally{await db.close();}
});

test('F2 ingest: 사람이 만든 요청의 품목은 바꾸지 않고 댓글을 한 번만 남긴다',async()=>{
 const {db,ingest,create,login,asSystem}=await setup();
 try{
  const mine=await create();
  await login(1);
  await db.query(`select public.logistics_replace_items($1,$2::jsonb)`,[mine.id,JSON.stringify([{product_code:'22222222222222',product_name_text:'직접 넣은 상품',qty:7,lot_text:'L1',expires_on:''}])]);
  await asSystem();
  const d=dlv({order_no:mine.fassto_order_no});
  await ingest([d]);await ingest([d]);
  const it=(await db.query('select product_code,qty,lot_text from logistics_request_items where request_id=$1',[mine.id])).rows;
  assert.deepEqual(it,[{product_code:'22222222222222',qty:7,lot_text:'L1'}]);
  const c=(await db.query('select body_text from logistics_request_comments where request_id=$1',[mine.id])).rows;
  assert.equal(c.length,1);assert.match(c[0].body_text,/품목이 바뀌었어요/);
 }finally{await db.close();}
});

test('F2 ingest: 품목 비교는 줄 순서와 상관없다',async()=>{
 const {db,ingest}=await setup();
 try{
  const a={product_code:'11111111111111',product_name:'가짜 상품',expires_on:'2029-01-01',qty:30},b={product_code:'11111111111112',product_name:'가짜 상품 2',expires_on:'',qty:5};
  await ingest([dlv({items:[a,b],qty_total:35})]);
  const res=await ingest([dlv({items:[b,a],qty_total:35})]);
  assert.equal(res.updated,0);
 }finally{await db.close();}
});

test('F3 ingest: 정리하면 빈 품목 목록은 "품목 없음"으로 보고, 수량 100만 초과 줄은 버린다',async()=>{
 const {db,ingest,req}=await setup();
 try{
  await ingest([dlv()]);
  const r=await req('GG24OO261201000001');
  const res=await ingest([dlv({items:[{product_code:'',qty:'x'},{product_code:'11111111111111',qty:0}]})]);
  assert.equal(res.updated,0);
  assert.equal((await db.query('select qty from logistics_request_items where request_id=$1',[r.id])).rows[0].qty,30);
  await ingest([dlv({slip_no:'GG24OO261201000002',items:[{product_code:'11111111111111',qty:'abc'}]})]);
  const n=await req('GG24OO261201000002');
  assert.equal(n.qty_summary_text,'총 30개');
  assert.equal((await db.query('select count(*)::int n from logistics_request_items where request_id=$1',[n.id])).rows[0].n,0);
  await ingest([dlv({slip_no:'GG24OO261201000003',items:[{product_code:'11111111111111',qty:5},{product_code:'11111111111112',qty:2000000}]})]);
  const m=await req('GG24OO261201000003');
  assert.deepEqual((await db.query('select product_code,qty from logistics_request_items where request_id=$1',[m.id])).rows,[{product_code:'11111111111111',qty:5}]);
 }finally{await db.close();}
});

test('ingest: 파스토 주문번호가 대시보드 주문번호와 같으면 주문에 연결하고, 출고완료·취소된 요청은 건드리지 않는다',async()=>{
 const {db,ingest,req,login,asSystem}=await setup();
 try{
  const inv=(await db.query(`insert into public.invoices(no) values ('RE_20261126') returning id`)).rows[0].id;
  await ingest([dlv({order_no:'RE_20261126'})]);
  const r=await req('GG24OO261201000001');
  assert.equal(r.invoice_id,inv);
  assert.equal((await db.query(`select count(*)::int n from logistics_request_history where request_id=$1 and field_code='invoice'`,[r.id])).rows[0].n,1);
  // 주문이 나중에 생겨도 다음 동기화에서 잇는다
  await ingest([dlv({slip_no:'GG24OO261201000002',order_no:'CR_20261123'})]);
  assert.equal((await req('GG24OO261201000002')).invoice_id,null);
  const inv2=(await db.query(`insert into public.invoices(no) values ('CR_20261123') returning id`)).rows[0].id;
  await ingest([dlv({slip_no:'GG24OO261201000002',order_no:'CR_20261123'})]);
  assert.equal((await req('GG24OO261201000002')).invoice_id,inv2);
  // 출고완료된 요청은 주문 칸을 바꾸지 않는다(요약이 닫혀 있음)
  await ingest([dlv({slip_no:'GG24OO261201000003',order_no:'HC_20261124'})]);
  const c=await req('GG24OO261201000003');
  await login(3);await db.query(`update logistics_requests set status_code='shipped',result_text='차량 00가0000',shipped_on='2026-12-01' where id=$1`,[c.id]);await asSystem();
  await db.query(`insert into public.invoices(no) values ('HC_20261124')`);
  await ingest([dlv({slip_no:'GG24OO261201000003',order_no:'HC_20261124'})]);
  assert.equal((await req('GG24OO261201000003')).invoice_id,null);
  // 주문번호가 비어 있으면 연결하지 않는다
  await db.query(`insert into public.invoices(no) values ('')`);
  await ingest([dlv({slip_no:'GG24OO261201000004',order_no:''})]);
  assert.equal((await req('GG24OO261201000004')).invoice_id,null);
 }finally{await db.close();}
});

test('ingest 새 요청 범위: 시작일 전 주문은 만들지 않고, 택배는 대시보드 주문번호·LG 주문번호일 때만 만든다',async()=>{
 const {db,ingest,req}=await setup();
 try{
  await db.exec(`update approval_private.logistics_fassto_settings set create_from_date='2026-12-01' where id=1`);
  const a=await ingest([dlv({slip_no:'GG24OO261201000011',order_date:'2026-11-30'}),dlv({slip_no:'GG24OO261201000012',order_date:'2026-12-01'})]);
  assert.equal(await req('GG24OO261201000011'),undefined);
  assert.ok(await req('GG24OO261201000012'));
  assert.deepEqual([a.created,a.skipped],[1,1]);
  await db.exec(`update approval_private.logistics_fassto_settings set create_from_date=null where id=1`);
  await db.query(`insert into public.invoices(no) values ('HC_20261124')`);
  const b=await ingest([
   dlv({slip_no:'GG24OO261201000021',out_div:'parcel',order_no:'20261126-0001'}),
   dlv({slip_no:'GG24OO261201000022',out_div:'parcel',order_no:'HC_20261124'}),
   dlv({slip_no:'GG24OO261201000023',out_div:'parcel',order_no:''})]);
  assert.equal(await req('GG24OO261201000021'),undefined);
  assert.ok(await req('GG24OO261201000022'));
  assert.equal(await req('GG24OO261201000023'),undefined);
  assert.deepEqual([b.created,b.skipped],[1,2]);
 }finally{await db.close();}
});
