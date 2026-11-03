const {test, describe, before, after, beforeEach, afterEach} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createDatabase, harness, ADMIN, INVOICE} = require('./helpers/invoice-amount-db.cjs');

const MEMBER = '00000000-0000-0000-0000-000000000002';
const migrationPath = path.join(__dirname, '../sql/invoice-create-documents.sql');
const settlementPath = path.join(__dirname, '../sql/invoice-settlement-evidence.sql');

describe('new invoice requests can carry Drive evidence', () => {
  let db, h;
  before(async () => {
    db = await createDatabase();
    // The shared fixture keeps a minimal Drive table; give it the production columns and checks.
    await db.exec(`
      alter table public.invoice_drive_documents add column drive_file_id text not null check (drive_file_id ~ '^[A-Za-z0-9_-]{10,200}$'),
        add column resource_key text, add column type text constraint invoice_drive_documents_type_check check (type in ('거래명세서','구매확인서','세금계산서','기타')),
        add constraint invoice_drive_documents_unique unique (invoice_id,drive_file_id);`);
    await db.exec(fs.readFileSync(settlementPath, 'utf8'));
    if (fs.existsSync(migrationPath)) await db.exec(fs.readFileSync(migrationPath, 'utf8'));
    h = harness(db);
  });
  after(async () => { if (db) await db.close(); });
  beforeEach(async () => { await db.exec('begin'); await h.login(MEMBER); });
  afterEach(async () => { await db.exec('rollback; reset role'); });

  const newInvoice = (documents, header = {}) => ({action: 'invoice', id: null, before: null,
    invoice: {no: 'NEW_20261103', customer: 'Demo', mgr: 'M', order_date: '2026-11-03', pay_date: null, ship_date: null, status: 'Ordered', ship_status: '준비중', foc: 0, note: '', ...header},
    items: [{name: '합성 품목', barcode: '8800000000001', sales_type: 'Paid', qty: 10, price: 1000}],
    ...(documents ? {documents} : {})});
  const doc = (type, file = 'synthetic_order_0001') => ({drive_file_id: file, resource_key: null, name: `합성 ${type}`, type});
  const created = async () => (await h.query("select to_jsonb(i) r from public.invoices i where no='NEW_20261103'")).rows[0]?.r;
  const docsOf = async id => (await h.query('select type,drive_file_id from public.invoice_drive_documents where invoice_id=$1 order by type', [id])).rows;
  const approve = async id => { await h.login(ADMIN); const r = await h.review(id); await h.login(MEMBER); return r; };

  test('order and its evidence are created together only on approval', async () => {
    const pending = await h.submit([newInvoice([doc('거래명세서'), doc('입금증빙', 'synthetic_pay_00001')])]);
    assert.equal(pending.status, 'pending');
    assert.equal(await created(), undefined);
    assert.equal((await h.query('select count(*)::int n from public.invoice_drive_documents')).rows[0].n, 0);
    assert.equal((await approve(pending.id)).status, 'approved');
    const inv = await created();
    assert.equal(inv.status, 'Ordered');
    assert.deepEqual(await docsOf(inv.id), [{type: '거래명세서', drive_file_id: 'synthetic_order_0001'}, {type: '입금증빙', drive_file_id: 'synthetic_pay_00001'}]);
  });

  test('payment evidence attached at creation satisfies the later paid request', async () => {
    await approve((await h.submit([newInvoice([doc('입금증빙', 'synthetic_pay_00001')])])).id);
    const inv = await created();
    const pending = await h.submit([{table: 'invoices', action: 'update', key: {id: inv.id}, before: inv, values: {status: 'Paid', pay_date: '2026-11-04'}}]);
    await approve(pending.id);
    assert.equal((await created()).status, 'Paid');
  });

  test('order without documents behaves as before', async () => {
    await approve((await h.submit([newInvoice()])).id);
    assert.deepEqual(await docsOf((await created()).id), []);
  });

  test('rejects documents on existing orders, empty lists and unknown fields', async () => {
    const existing = await h.invoiceOp();
    await assert.rejects(() => h.submit([{...existing, documents: [doc('거래명세서')]}]), /INVALID_DOCUMENTS/);
    await assert.rejects(() => h.submit([newInvoice([])]), /INVALID_DOCUMENTS/);
    await assert.rejects(() => h.submit([newInvoice([{...doc('거래명세서'), invoice_id: INVOICE}])]), /INVALID_DOCUMENT_FIELD/);
    await assert.rejects(() => h.submit([newInvoice([{...doc('거래명세서'), name: ' '}])]), /INVALID_REQUIRED/);
    await assert.rejects(() => h.submit([newInvoice([doc('거래명세서', 'bad/link')])]), e => e.code === '23514');
    await assert.rejects(() => h.submit([newInvoice([doc('거래명세서'), doc('기타')])]), e => e.code === '23505');
    assert.equal(await created(), undefined);
  });

  test('settlement status still cannot be set at creation', async () => {
    await assert.rejects(() => h.submit([newInvoice([doc('입금증빙')], {status: 'Paid', pay_date: '2026-11-03'})]), /EVIDENCE_REQUIRED/);
  });

  test('installation refuses to run twice', async () => {
    await db.exec('reset role');
    const guard = fs.readFileSync(migrationPath, 'utf8').match(/do \$\$[\s\S]*?end \$\$;/)[0];
    await db.exec('savepoint reinstall');
    await assert.rejects(() => db.exec(guard), /already installed/);
    await db.exec('rollback to savepoint reinstall');
  });
});
