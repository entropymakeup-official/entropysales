const {test, describe, before, after, beforeEach, afterEach} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createDatabase, harness, ADMIN, INVOICE, ITEM, SECOND} = require('./helpers/invoice-amount-db.cjs');

const MEMBER = '00000000-0000-0000-0000-000000000002';
const sql = name => fs.readFileSync(path.join(__dirname, '../sql', name), 'utf8');

// Production order: revisions → settlement evidence → self approval → free-order-closed → ship-no-evidence.
async function prepare() {
  const db = await createDatabase();
  await db.exec(`
    alter table public.invoice_drive_documents add column drive_file_id text, add column resource_key text,
      add column type text constraint invoice_drive_documents_type_check check (type in ('거래명세서','구매확인서','세금계산서','기타'));`);
  await db.exec(sql('request-revisions.sql'));
  await db.exec(sql('invoice-settlement-evidence.sql'));
  await db.exec(sql('settlement-self-approval.sql'));
  await db.exec(sql('free-order-closed.sql'));
  await db.exec(sql('ship-no-evidence.sql'));
  return db;
}

describe('ship status 출고완료(증빙없음)', () => {
  let db, h;
  before(async () => { db = await prepare(); h = harness(db); });
  after(async () => { if (db) await db.close(); });
  beforeEach(async () => { await db.exec('begin'); await h.login(MEMBER); });
  afterEach(async () => { await db.exec('rollback; reset role'); });

  const doc = (type, file = 'synthetic_file_0001') => ({table: 'invoice_drive_documents', action: 'insert', key: {}, before: null,
    values: {invoice_id: INVOICE, drive_file_id: file, name: `합성 ${type}`, type}});
  const statusOp = async values => ({table: 'invoices', action: 'update', key: {id: INVOICE}, before: await h.invoice(), values});
  const itemOp = async (id, values) => ({table: 'invoice_items', action: 'update', key: {id}, before: (await h.items()).find(i => i.id === id), values});
  const approve = async ops => {
    const pending = await h.submit(ops);
    await h.login(ADMIN);
    const r = (await h.query("select public.review_change_request_versioned($1::uuid,true,'합성 검토',1) r", [pending.id])).rows[0].r;
    await h.login(MEMBER);
    return r;
  };
  const header = {customer: 'Synthetic', mgr: 'M', order_date: '2026-11-13', pay_date: null, ship_date: null, foc: 0, note: ''};
  const lines = [{name: 'Synthetic A', barcode: '', sales_type: 'Paid', qty: 1, price: 10}];

  test('an existing order can move to 출고완료(증빙없음) without shipping documents', async () => {
    const result = await approve([await statusOp({ship_status: '출고완료(증빙없음)'})]);
    assert.equal(result.status, 'approved');
    const inv = await h.invoice();
    assert.equal(inv.ship_status, '출고완료(증빙없음)');
    assert.equal(inv.ship_verified_by, null);
  });

  test('출고완료 still requires shipping documents', async () => {
    await assert.rejects(async () => h.submit([await statusOp({ship_status: '출고완료', ship_date: '2026-10-06'})]), /EVIDENCE_REQUIRED/);
  });

  test('a no-evidence order becomes 출고완료 once shipping documents are attached', async () => {
    await approve([await statusOp({ship_status: '출고완료(증빙없음)'})]);
    await approve([doc('선적서류'), await statusOp({ship_status: '출고완료', ship_date: '2026-10-06'})]);
    const inv = await h.invoice();
    assert.equal(inv.ship_status, '출고완료');
    assert.ok(inv.ship_verified_by);
  });

  test('new orders cannot start as 출고완료(증빙없음)', async () => {
    await assert.rejects(() => h.submit([{action: 'invoice', id: null, before: null, invoice: {no: 'NEW_SHIP_1', ...header, status: 'Ordered', ship_status: '출고완료(증빙없음)'}, items: lines}]), /EVIDENCE_REQUIRED/);
  });

  test('free close (Closed) still needs 출고완료 with shipping documents', async () => {
    await approve([await itemOp(ITEM, {sales_type: 'FOC'}), await itemOp(SECOND, {sales_type: 'FOC'})]);
    await approve([await statusOp({ship_status: '출고완료(증빙없음)'})]);
    await assert.rejects(async () => h.submit([await statusOp({status: 'Closed'})]), /FREE_CLOSE_SHIPPING_REQUIRED/);
  });

  test('unknown ship status values are rejected by the table constraint', async () => {
    await assert.rejects(async () => approve([await statusOp({ship_status: '배송중'})]), /invoices_ship_status_check/);
  });

  test('migration refuses to install twice', async () => {
    await db.exec('reset role');
    await assert.rejects(() => db.exec(sql('ship-no-evidence.sql')), /already installed/);
  });
});
