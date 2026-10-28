const {test, describe, before, after, beforeEach, afterEach} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createDatabase, harness, INVOICE, OTHER, SECOND} = require('./helpers/invoice-amount-db.cjs');

const read = name => fs.readFileSync(path.join(__dirname, '../sql', name), 'utf8');
// Production order: ship_mode is already installed when this migration runs.
const shipMode = db => db.exec(read('invoice-item-ship-mode.sql'));
const migrate = db => db.exec(read('invoice-reference-link.sql'));

function linkHelpers(h) {
  const row = async id => (await h.query('select to_jsonb(i) r from public.invoices i where id=$1', [id])).rows[0].r;
  const linkOp = async (values, id = INVOICE) => ({table: 'invoices', action: 'update', key: {id}, before: await row(id), values});
  return {row, linkOp};
}

describe('invoice reference link SQL', () => {
  let db, h, l;
  before(async () => { db = await createDatabase(); await shipMode(db); await migrate(db); h = harness(db); l = linkHelpers(h); });
  after(async () => { if (db) await db.close(); });
  beforeEach(async () => { await db.exec('begin'); await h.login(); });
  afterEach(async () => { await db.exec('rollback; reset role'); });

  test('adds two nullable columns without defaults and leaves existing invoices unlinked', async () => {
    const columns = (await h.query("select column_name,data_type,is_nullable,column_default from information_schema.columns where table_schema='public' and table_name='invoices' and column_name like 'ref_%' order by column_name")).rows;
    assert.deepEqual(columns, [
      {column_name: 'ref_invoice_id', data_type: 'uuid', is_nullable: 'YES', column_default: null},
      {column_name: 'ref_kind', data_type: 'text', is_nullable: 'YES', column_default: null}
    ]);
    for (const id of [INVOICE, OTHER]) {
      const r = await l.row(id);
      assert.equal(r.ref_invoice_id, null);
      assert.equal(r.ref_kind, null);
    }
  });

  test('a link is stored only after approval through the generic update operation', async () => {
    const pending = await h.submit([await l.linkOp({ref_invoice_id: OTHER, ref_kind: '재출고'})]);
    assert.equal(pending.status, 'pending');
    assert.equal((await l.row(INVOICE)).ref_invoice_id, null);
    assert.equal((await h.review(pending.id)).status, 'approved');
    const r = await l.row(INVOICE);
    assert.equal(r.ref_invoice_id, OTHER);
    assert.equal(r.ref_kind, '재출고');
  });

  test('a link can be cleared again', async () => {
    await h.review((await h.submit([await l.linkOp({ref_invoice_id: OTHER, ref_kind: '정정'})])).id);
    await h.review((await h.submit([await l.linkOp({ref_invoice_id: null, ref_kind: null})])).id);
    assert.equal((await l.row(INVOICE)).ref_invoice_id, null);
  });

  test('self links, unknown invoices and unknown kinds are rejected at submission', async () => {
    await assert.rejects(async () => h.submit([await l.linkOp({ref_invoice_id: INVOICE})]), /invoices_ref_invoice_not_self/);
    await assert.rejects(async () => h.submit([await l.linkOp({ref_invoice_id: '10000000-0000-0000-0000-0000000000ff'})]), /invoices_ref_invoice_id_fkey/);
    await assert.rejects(async () => h.submit([await l.linkOp({ref_invoice_id: OTHER, ref_kind: '반품'})]), /invoices_ref_kind_check/);
  });

  test('a full invoice save keeps an existing link', async () => {
    await h.review((await h.submit([await l.linkOp({ref_invoice_id: OTHER, ref_kind: '상계'})])).id);
    await h.review((await h.submit([await h.invoiceOp({note: 'header edit after link'})])).id);
    const r = await l.row(INVOICE);
    assert.equal(r.note, 'header edit after link');
    assert.equal(r.ref_invoice_id, OTHER);
    assert.equal(r.ref_kind, '상계');
  });

  test('a full invoice save cannot set the link (header keys stay restricted)', async () => {
    await assert.rejects(async () => h.submit([await h.invoiceOp({ref_invoice_id: OTHER})]), /INVALID_INVOICE_FIELD/);
  });

  test('approving the delete of the referenced invoice clears the link instead of failing', async () => {
    await h.review((await h.submit([await l.linkOp({ref_invoice_id: INVOICE, ref_kind: '정정'}, OTHER)])).id);
    const items = (await h.query('select to_jsonb(i) r from public.invoice_items i where invoice_id=$1 order by id', [INVOICE])).rows.map(x => x.r);
    const del = {table: 'invoices', action: 'delete', key: {id: INVOICE}, before: await l.row(INVOICE), before_items: items, before_drive_documents: []};
    assert.equal((await h.review((await h.submit([del])).id)).status, 'approved');
    assert.equal((await l.row(OTHER)).ref_invoice_id, null);
  });

  test('sheet worker snapshot keeps its existing invoice fields', async () => {
    await h.review((await h.submit([await l.linkOp({ref_invoice_id: OTHER, ref_kind: '재출고'})])).id);
    await db.exec('reset role');
    const jobs = (await h.query("select public.claim_invoice_sheet_jobs('synthetic-worker-key',50) r")).rows[0].r;
    const job = jobs.find(j => j.invoice_id === INVOICE);
    assert.deepEqual(Object.keys(job.invoice).sort(), ['customer','id','mgr','no','note','order_date','pay_date','ship_date','ship_status','status']);
  });
});

// Requests queued before the migration carry `before` snapshots without the new
// columns. They must stay approvable (no STALE_DATA) after the migration.
for (const kind of ['generic invoice update', 'generic item update', 'full invoice save', 'invoice delete']) {
  test(`a pending ${kind} created before the migration remains approvable`, async () => {
    const db = await createDatabase();
    try {
      await shipMode(db);
      const h = harness(db), l = linkHelpers(h);
      await db.exec('begin'); await h.login();
      let op;
      if (kind === 'generic invoice update') op = await l.linkOp({note: 'queued before ref link'});
      else if (kind === 'generic item update') op = await h.updateOp({qty: 9}, SECOND);
      else if (kind === 'full invoice save') op = await h.invoiceOp({note: 'queued before ref link'});
      else {
        const items = (await h.query('select to_jsonb(i) r from public.invoice_items i where invoice_id=$1 order by id', [OTHER])).rows.map(x => x.r);
        op = {table: 'invoices', action: 'delete', key: {id: OTHER}, before: await l.row(OTHER), before_items: items, before_drive_documents: []};
      }
      assert.equal(Object.hasOwn(op.before.invoice || op.before, 'ref_invoice_id'), false);
      const pending = await h.submit([op]);
      await db.exec('commit; reset role');
      await migrate(db);
      await db.exec('begin'); await h.login();
      assert.equal((await h.review(pending.id)).status, 'approved');
      await db.exec('rollback; reset role');
    } finally { await db.close(); }
  });
}

test('migration is idempotent', async () => {
  const db = await createDatabase();
  try {
    await shipMode(db); await migrate(db); await migrate(db);
    const n = (await db.query("select count(*)::int n from pg_constraint where conrelid='public.invoices'::regclass and conname like 'invoices_ref_%'")).rows[0].n;
    assert.equal(n, 3);
  } finally { await db.close(); }
});

test('migration refuses to run before the approval workflow', async () => {
  const {PGlite} = require('@electric-sql/pglite');
  const db = new PGlite();
  try {
    await db.exec('create table public.invoices(id uuid primary key)');
    await assert.rejects(() => migrate(db), /change-approvals/);
  } finally { await db.close(); }
});
