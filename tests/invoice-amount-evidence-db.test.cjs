const {test, describe, before, after, beforeEach, afterEach} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {createDatabase, harness, migrationPath, ADMIN, MEMBER, OUTSIDER, INVOICE, OTHER, ITEM, SECOND, FREE} = require('./helpers/invoice-amount-db.cjs');

const clearFirst = /증빙.*먼저.*해제|증빙.*해제.*먼저/;
const proof = {amount_override: 17.25, amount_reference: 'Synthetic evidence A'};

describe('invoice proof SQL', () => {
  let db, h;
  before(async () => { db = await createDatabase(); h = harness(db); });
  after(async () => { if (db) await db.close(); });
  beforeEach(async () => { await db.exec('begin'); await h.login(); });
  afterEach(async () => { await db.exec('rollback; reset role'); });

  test('migration adds nullable fixed precision proof columns without rewriting legacy rows', async () => {
    const columns = (await h.query("select column_name,data_type,numeric_precision,numeric_scale,is_nullable,column_default from information_schema.columns where table_schema='public' and table_name='invoice_items' and column_name in ('amount_override','amount_reference') order by column_name")).rows;
    assert.deepEqual(columns, [
      {column_name:'amount_override',data_type:'numeric',numeric_precision:18,numeric_scale:2,is_nullable:'YES',column_default:null},
      {column_name:'amount_reference',data_type:'text',numeric_precision:null,numeric_scale:null,is_nullable:'YES',column_default:null}
    ]);
    assert.deepEqual((await h.items()).map(i => [i.id,i.amount_override,i.amount_reference]), [[ITEM,null,null],[SECOND,null,null],[FREE,null,null]]);
  });

  for (const amount of [0, -12.34, 17.25]) {
    test(`generic approval keeps amount ${amount} pending until approval and preserves other fields`, async () => {
      const before = await h.items();
      const allBefore = await h.snapshot();
      const pending = await h.submit([await h.updateOp({...proof,amount_override:amount})]);
      assert.equal(pending.status,'pending');
      assert.deepEqual(await h.items(),before);
      assert.deepEqual((await h.snapshot())['invoice_sheet_private.queue'],allBefore['invoice_sheet_private.queue']);
      await h.login(MEMBER);
      await assert.rejects(() => h.review(pending.id), /ADMIN_REQUIRED/);
      await h.login(ADMIN);
      assert.equal((await h.review(pending.id)).status,'approved');
      assert.deepEqual(await h.items(), before.map(i => i.id === ITEM ? {...i,...proof,amount_override:amount} : i));
      assert.ok((await h.snapshot())['invoice_sheet_private.queue'][0].revision > allBefore['invoice_sheet_private.queue'][0].revision);
    });
  }

  test('legacy free and Paid lines accept an absent proof pair', async () => {
    await h.directContext();
    await h.query('update public.invoice_items set amount_override=null,amount_reference=null');
    assert.equal((await h.items()).length,3);
  });

  test('generic item insertion enforces the proof pair and keeps a valid new proof pending', async () => {
    const values = {invoice_id:INVOICE,invoice_no:'SYNTHETIC-1',name:'Synthetic inserted proof',barcode:null,sales_type:'Paid',qty:1,price:5,...proof};
    const insert = {table:'invoice_items',action:'insert',before:null,values};
    await assert.rejects(() => h.submit([{...insert,values:{...values,amount_reference:null}}]), error => error.code === '23514');
    const pending = await h.submit([insert]);
    assert.equal((await h.items()).length,3);
    await h.review(pending.id);
    const item = (await h.items()).find(i => i.name === 'Synthetic inserted proof');
    assert.equal(item.amount_override,17.25); assert.equal(item.amount_reference,proof.amount_reference);
  });

  const invalid = [
    ['amount without reference',17.25,null,'Paid'],
    ['reference without amount',null,'Synthetic evidence','Paid'],
    ['empty reference',1,'','Paid'],
    ['space reference',1,'   ','Paid'],
    ['whitespace reference',1,'\t\n\r','Paid'],
    ['overlong reference',1,'x'.repeat(1001),'Paid'],
    ['FOC proof',0,'Synthetic evidence','FOC'],
    ['other non-Paid proof',1,'Synthetic evidence','Sample'],
    ['null sales type proof',1,'Synthetic evidence',null],
    ['NaN proof','NaN','Synthetic evidence','Paid'],
    ['positive Infinity proof','Infinity','Synthetic evidence','Paid'],
    ['negative Infinity proof','-Infinity','Synthetic evidence','Paid']
  ];
  for (const [name,amount,reference,salesType] of invalid) {
    test(`database rejects ${name} without changing the row`, async () => {
      await h.directContext();
      const before = await h.items();
      await assert.rejects(() => h.query('update public.invoice_items set amount_override=$1::numeric,amount_reference=$2,sales_type=$3 where id=$4', [amount,reference,salesType,ITEM]), error => ['23514','22003'].includes(error.code));
      assert.deepEqual(await h.items(),before);
    });
  }

  test('reference boundaries accept one and 1000 Unicode characters', async () => {
    await h.approveUpdate({...proof,amount_reference:'가'});
    await h.approveUpdate({...proof,amount_reference:'증'.repeat(1000)});
    assert.equal((await h.items())[0].amount_reference,'증'.repeat(1000));
  });

  test('direct writes remain blocked and outsider RLS and approval checks stay enforced', async () => {
    await assert.rejects(() => h.query('update public.invoice_items set amount_override=17.25,amount_reference=$1 where id=$2', [proof.amount_reference,ITEM]), /APPROVAL_REQUIRED/);
    await assert.rejects(() => h.query('insert into approval_private.apply_context values(txid_current(),$1::uuid)', [ADMIN]), /permission denied/);
    const op = await h.updateOp(proof);
    await h.login(OUTSIDER);
    assert.deepEqual(await h.items(),[]);
    await assert.rejects(() => h.submit([op]), /UNAUTHORIZED/);
  });

  test('full before snapshot rejects stale proof approval', async () => {
    const op = await h.updateOp(proof);
    const stale = await h.submit([op]);
    await h.approveUpdate({...proof,amount_override:18});
    await assert.rejects(() => h.review(stale.id), /STALE_DATA/);
    assert.equal((await h.items())[0].amount_override,18);
    const requests = (await h.snapshot())['approval_private.requests'];
    assert.equal(requests.find(r => r.id === stale.id).status,'pending');
  });

  test('header-only full save keeps proof on replacement IDs, including zero, negative and NULL barcode', async () => {
    await h.approveUpdate({...proof,amount_override:0});
    await h.approveUpdate({amount_override:-8.75,amount_reference:'Synthetic evidence B'}, SECOND);
    const before = await h.items();
    const op = await h.invoiceOp({no:'SYNTHETIC-RENAMED',note:'Header changed'});
    op.items.reverse();
    const pending = await h.submit([op]);
    assert.deepEqual(await h.items(),before);
    await h.review(pending.id);
    const items = await h.items();
    assert.ok(items.every(i => !before.some(old => old.id === i.id)));
    assert.equal((await h.invoice()).note,'Header changed');
    assert.ok(items.every(i => i.invoice_no === 'SYNTHETIC-RENAMED'));
    assert.deepEqual(items.map(i => [i.name,i.amount_override,i.amount_reference,i.qty,i.price]).sort(), [
      ['Synthetic A',0,proof.amount_reference,2,10],
      ['Synthetic B',-8.75,'Synthetic evidence B',3,7],
      ['Synthetic free',null,null,1,0]
    ]);
  });

  test('NULL-safe numeric signature preserves a legacy proof when both numeric fields are NULL', async () => {
    await h.directContext();
    await h.query('update public.invoice_items set qty=null,price=null where id=$1', [ITEM]);
    await h.query('update public.invoice_items set amount_override=0,amount_reference=$1 where id=$2', [proof.amount_reference,ITEM]);
    const op = await h.invoiceOp({note:'Legacy NULL signature'});
    const saved = (await h.query('select public.save_invoice_atomic($1,$2::jsonb,$3::jsonb) r',[INVOICE,JSON.stringify(op.invoice),JSON.stringify(op.items)])).rows[0].r;
    const item = saved.items.find(i => i.name === 'Synthetic A');
    assert.equal(item.amount_override,0); assert.equal(item.qty,null); assert.equal(item.price,null);
  });

  for (const [field,value] of [['name','Different name'],['barcode','DIFFERENT'],['sales_type','FOC'],['qty',4],['price',11]]) {
    test(`full save rejects changed proof ${field} and rolls back header, rows and outbox`, async () => {
      await h.approveUpdate(proof);
      const op = await h.invoiceOp({note:'Must roll back'});
      op.items[0][field] = value;
      const before = await h.snapshot();
      await assert.rejects(() => h.submit([op]), clearFirst);
      assert.deepEqual(await h.snapshot(),before);
    });
  }

  for (const mode of ['removed','new duplicate','old duplicate']) {
    test(`full save rejects ${mode} proof signature atomically`, async () => {
      await h.approveUpdate(proof);
      if (mode === 'old duplicate') {
        await h.directContext();
        await h.query('insert into public.invoice_items(invoice_id,invoice_no,name,barcode,sales_type,qty,price) select invoice_id,invoice_no,name,barcode,sales_type,qty,price from public.invoice_items where id=$1', [ITEM]);
        await db.exec('reset role');
        await h.query('delete from approval_private.apply_context where transaction_id=txid_current()');
        await db.exec('set local role authenticated');
      }
      const op = await h.invoiceOp({note:'Must roll back'});
      if (mode === 'removed') op.items.shift();
      if (mode === 'new duplicate') op.items.push({...op.items[0]});
      if (mode === 'old duplicate') op.items = op.items.filter((i,index,all) => all.findIndex(j => j.name === i.name) === index);
      const before = await h.snapshot();
      await assert.rejects(() => h.submit([op]), clearFirst);
      assert.deepEqual(await h.snapshot(),before);
    });
  }

  test('direct full save also rejects proof removal and restores the complete transaction', async () => {
    await h.approveUpdate(proof);
    await h.directContext();
    const op = await h.invoiceOp({note:'Must roll back'});
    const before = await h.snapshot();
    await assert.rejects(() => h.query('select public.save_invoice_atomic($1,$2::jsonb,$3::jsonb)',[INVOICE,JSON.stringify(op.invoice),'[]']), clearFirst);
    assert.deepEqual(await h.snapshot(),before);
  });

  for (const [field,value] of [['invoice_id',OTHER],['name','Changed'],['barcode','Changed'],['sales_type','FOC'],['qty',5],['price',12]]) {
    test(`direct structural ${field} change requires clearing the entire proof pair`, async () => {
      await h.approveUpdate(proof);
      await h.directContext();
      const before = await h.items();
      await assert.rejects(() => h.query(`update public.invoice_items set ${field}=$1 where id=$2`,[value,ITEM]), clearFirst);
      assert.deepEqual(await h.items(),before);
      await h.query(`update public.invoice_items set ${field}=$1,amount_override=null,amount_reference=null where id=$2`,[value,ITEM]);
      const row = (await h.query('select to_jsonb(i) r from public.invoice_items i where id=$1',[ITEM])).rows[0].r;
      assert.equal(row[field],value); assert.equal(row.amount_override,null); assert.equal(row.amount_reference,null);
    });
  }

  test('generic approved structural edit is rejected; approved clear permits a later full edit', async () => {
    await h.approveUpdate(proof);
    const op = await h.updateOp({qty:5});
    await assert.rejects(() => h.submit([op]), clearFirst);
    await h.approveUpdate({amount_override:null,amount_reference:null});
    const invoice = await h.invoiceOp({note:'Proof cleared'});
    invoice.items[0].qty = 5;
    await h.review((await h.submit([invoice])).id);
    assert.equal((await h.items()).find(i => i.name === 'Synthetic A').qty,5);
  });

  test('unproved duplicate lines and extra distinct lines remain legal beside an unchanged proof', async () => {
    await h.approveUpdate(proof);
    const op = await h.invoiceOp();
    op.items.push({...op.items[1]}, {...op.items[1],name:'New synthetic item'});
    await h.review((await h.submit([op])).id);
    const items = await h.items();
    assert.equal(items.length,5);
    assert.equal(items.find(i => i.name === 'Synthetic A').amount_override,17.25);
    assert.ok(items.filter(i => i.name !== 'Synthetic A').every(i => i.amount_override === null));
  });

  test('new invoice creation keeps generated IDs and absent proofs under normal approval', async () => {
    const op = await h.invoiceOp({no:'SYNTHETIC-NEW'});
    op.id = null; op.before = null;
    const pending = await h.submit([op]);
    assert.equal((await h.query("select count(*)::int n from public.invoices where no='SYNTHETIC-NEW'")).rows[0].n,0);
    await h.review(pending.id);
    const saved = (await h.query("select to_jsonb(i) r from public.invoices i where no='SYNTHETIC-NEW'")).rows[0].r;
    assert.match(saved.id,/^[0-9a-f-]{36}$/);
    assert.notEqual(saved.id,INVOICE);
    const items = (await h.query('select id,amount_override,amount_reference from public.invoice_items where invoice_id=$1',[saved.id])).rows;
    assert.equal(items.length,3);
    assert.equal(new Set(items.map(i => i.id)).size,3);
    assert.ok(items.every(i => ![ITEM,SECOND,FREE].includes(i.id) && i.amount_override === null && i.amount_reference === null));
  });

  test('retained proof cannot be reassigned by changing both structure and evidence together', async () => {
    await h.approveUpdate(proof);
    const op = await h.updateOp({qty:7,amount_override:30,amount_reference:'Different synthetic proof'});
    await assert.rejects(() => h.submit([op]),clearFirst);
    assert.equal((await h.items())[0].qty,2);
    assert.equal((await h.items())[0].amount_override,17.25);
  });

  test('full invoice payload cannot inject proof through either the approval action or direct RPC', async () => {
    const op = await h.invoiceOp();
    op.items[0] = {...op.items[0],...proof};
    await assert.rejects(() => h.submit([op]), /INVALID_ITEM_FIELD/);
    await h.directContext();
    const before = await h.snapshot();
    await assert.rejects(() => h.query('select public.save_invoice_atomic($1,$2::jsonb,$3::jsonb)',[INVOICE,JSON.stringify(op.invoice),JSON.stringify(op.items)]), /증빙|INVALID_ITEM_FIELD/);
    assert.deepEqual(await h.snapshot(),before);
  });

  test('worker claim exposes explicit zero/negative/null amounts while preserving secret and leases', async () => {
    await h.approveUpdate({...proof,amount_override:0});
    await h.approveUpdate({...proof,amount_override:-8.75},SECOND);
    await db.exec('reset role; set local role anon');
    await assert.rejects(() => h.query("select public.claim_invoice_sheet_jobs('wrong')"), /Unauthorized worker/);
    const jobs = (await h.query("select public.claim_invoice_sheet_jobs('synthetic-worker-key',20) r")).rows[0].r;
    assert.equal(jobs.length,1);
    assert.equal(jobs[0].invoice_id,INVOICE);
    assert.equal(jobs[0].deleted,false);
    assert.equal(typeof jobs[0].revision,'string');
    assert.deepEqual(jobs[0].items.map(i => [i.id,i.amount_override,i.qty,i.price]), [[ITEM,0,2,10],[SECOND,-8.75,3,7],[FREE,null,1,0]]);
    assert.deepEqual((await h.query("select public.claim_invoice_sheet_jobs('synthetic-worker-key') r")).rows[0].r,[]);
    await db.exec('reset role');
    const lease = (await h.query("select lease_token,claimed_revision::text,attempts,lease_until=now()+interval '10 minutes' as duration_ok from invoice_sheet_private.queue where invoice_id=$1",[INVOICE])).rows[0];
    assert.deepEqual(lease,{lease_token:jobs[0].lease_token,claimed_revision:jobs[0].revision,attempts:1,duration_ok:true});
  });
});

test('migration preserves existing function ACL/security, approval guards, RLS and data on install/reinstall', async () => {
  const db = await createDatabase({migrate:false});
  try {
    const catalog = async () => ({
      functions:(await db.query("select p.oid,p.proname,p.proowner,p.proacl,p.prosecdef,p.proconfig,pg_get_function_arguments(p.oid) args from pg_proc p join pg_namespace n on n.oid=p.pronamespace where (n.nspname='public' and p.proname in ('save_invoice_atomic','claim_invoice_sheet_jobs')) or n.nspname='approval_private' order by p.oid")).rows,
      policies:(await db.query('select * from pg_policies order by schemaname,tablename,policyname')).rows,
      guards:(await db.query("select oid,tgrelid,tgname,tgfoid,tgtype,tgenabled from pg_trigger where tgname in ('require_change_approval','require_approval_truncate','synthetic_capture') order by oid")).rows,
      rls:(await db.query("select oid,relrowsecurity,relforcerowsecurity,relacl from pg_class where oid in ('public.invoices'::regclass,'public.invoice_items'::regclass) order by oid")).rows
    });
    const rows = async () => ({
      items:(await db.query("select to_jsonb(i)-'amount_override'-'amount_reference' r from public.invoice_items i order by id")).rows,
      invoices:(await db.query('select to_jsonb(i) r from public.invoices i order by id')).rows,
      queue:(await db.query('select to_jsonb(q) r from invoice_sheet_private.queue q order by invoice_id')).rows
    });
    const beforeCatalog = await catalog(), beforeRows = await rows();
    const sql = fs.readFileSync(migrationPath,'utf8');
    await db.exec(sql);
    assert.deepEqual(await catalog(),beforeCatalog);
    assert.deepEqual(await rows(),beforeRows);
    await db.exec(sql);
    assert.deepEqual(await catalog(),beforeCatalog);
    assert.deepEqual(await rows(),beforeRows);
  } finally { await db.close(); }
});

test('migration rolls back earlier columns and constraints when a later DDL statement fails', async () => {
  const db = await createDatabase({migrate:false});
  try {
    // Force a CREATE OR REPLACE return-type conflict after the column/constraint DDL.
    await db.exec("create function public.guard_invoice_amount_evidence() returns text language sql as $$select 'synthetic incompatible predecessor'::text$$;");
    const catalog = async () => (await db.query("select p.oid,pg_get_functiondef(p.oid) definition from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('save_invoice_atomic','claim_invoice_sheet_jobs','guard_invoice_amount_evidence') order by p.oid")).rows;
    const before = await catalog();
    await assert.rejects(() => db.exec(fs.readFileSync(migrationPath,'utf8')), /cannot change return type/);
    await db.exec('rollback');
    assert.deepEqual((await db.query("select attname from pg_attribute where attrelid='public.invoice_items'::regclass and attnum>0 and not attisdropped and attname in ('amount_override','amount_reference')")).rows,[]);
    assert.deepEqual((await db.query("select conname from pg_constraint where conrelid='public.invoice_items'::regclass and conname='invoice_items_amount_evidence_check'")).rows,[]);
    assert.deepEqual(await catalog(),before);
    assert.equal((await db.query('select count(*)::int n from public.invoice_items')).rows[0].n,3);
  } finally { await db.close(); }
});
