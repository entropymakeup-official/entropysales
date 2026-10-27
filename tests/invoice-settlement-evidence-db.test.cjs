const {test, describe, before, after, beforeEach, afterEach} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createDatabase, harness, ADMIN, INVOICE} = require('./helpers/invoice-amount-db.cjs');

const MEMBER = '00000000-0000-0000-0000-000000000002';
const SECOND_ADMIN = '00000000-0000-0000-0000-000000000004';
const settlementPath = path.join(__dirname, '../sql/invoice-settlement-evidence.sql');
const revisionsPath = path.join(__dirname, '../sql/request-revisions.sql');

// The shared fixture keeps a minimal Drive table; give it the production columns and type check.
async function prepare({revisions = false} = {}) {
  const db = await createDatabase();
  await db.exec(`
    alter table public.invoice_drive_documents add column drive_file_id text, add column resource_key text,
      add column type text constraint invoice_drive_documents_type_check check (type in ('거래명세서','구매확인서','세금계산서','기타'));
    insert into auth.users values ('${SECOND_ADMIN}','second-admin@entropymakeup.com',now(),'{"dashboard_admin":true}','{}');`);
  if (revisions) await db.exec(fs.readFileSync(revisionsPath, 'utf8'));
  if (fs.existsSync(settlementPath)) await db.exec(fs.readFileSync(settlementPath, 'utf8'));
  return db;
}

function suite(label, options) {
  describe(label, () => {
    let db, h;
    before(async () => { db = await prepare(options); h = harness(db); });
    after(async () => { if (db) await db.close(); });
    beforeEach(async () => { await db.exec('begin'); await h.login(MEMBER); });
    afterEach(async () => { await db.exec('rollback; reset role'); });

    const evidence = (type, file = 'synthetic_file_0001') => ({table: 'invoice_drive_documents', action: 'insert', key: {}, before: null,
      values: {invoice_id: INVOICE, drive_file_id: file, name: `합성 ${type}`, type}});
    const statusOp = async values => ({table: 'invoices', action: 'update', key: {id: INVOICE}, before: await h.invoice(), values});
    const approve = async (id, who = ADMIN) => { await h.login(who); const r = await h.review(id); await h.login(MEMBER); return r; };

    test('adds settlement evidence types and empty verification columns', async () => {
      const inv = await h.invoice();
      assert.equal(inv.pay_verified_by, null); assert.equal(inv.ship_verified_at, null);
      const def = (await h.query("select pg_get_constraintdef(oid) d from pg_constraint where conname='invoice_drive_documents_type_check'")).rows[0].d;
      assert.match(def, /입금증빙/); assert.match(def, /선적서류/);
    });

    test('paid request without payment evidence is rejected at submission', async () => {
      await assert.rejects(async () => h.submit([await statusOp({status: 'Paid', pay_date: '2026-10-05'})]), /EVIDENCE_REQUIRED/);
      await assert.rejects(async () => h.submit([evidence('거래명세서'), await statusOp({status: 'Paid', pay_date: '2026-10-05'})]), /EVIDENCE_REQUIRED/);
    });

    test('payment evidence and status are approved together and record the approver', async () => {
      const pending = await h.submit([evidence('입금증빙'), await statusOp({status: 'Paid', pay_date: '2026-10-05'})]);
      assert.equal(pending.status, 'pending');
      assert.equal((await h.invoice()).status, 'Ordered');
      assert.equal((await approve(pending.id)).status, 'approved');
      const inv = await h.invoice();
      assert.equal(inv.status, 'Paid');
      assert.equal(inv.pay_verified_by, 'entropyadmin@entropy.internal');
      assert.ok(inv.pay_verified_at);
    });

    test('shipment needs shipping documents and records the approver', async () => {
      await assert.rejects(async () => h.submit([evidence('입금증빙'), await statusOp({ship_status: '출고완료', ship_date: '2026-10-06'})]), /EVIDENCE_REQUIRED/);
      const pending = await h.submit([evidence('선적서류'), await statusOp({ship_status: '출고완료', ship_date: '2026-10-06'})]);
      await approve(pending.id);
      const inv = await h.invoice();
      assert.equal(inv.ship_status, '출고완료');
      assert.equal(inv.ship_verified_by, 'entropyadmin@entropy.internal');
    });

    test('requester cannot approve their own settlement request; another admin can', async () => {
      await h.login(ADMIN);
      const pending = await h.submit([evidence('입금증빙'), await statusOp({status: 'Paid', pay_date: '2026-10-05'})]);
      await assert.rejects(() => h.review(pending.id), /SELF_APPROVAL_BLOCKED/);
      await h.login(SECOND_ADMIN);
      assert.equal((await h.review(pending.id)).status, 'approved');
      await h.login(ADMIN); // 합성 주문 RLS는 ADMIN·MEMBER에게만 조회를 허용한다.
      assert.equal((await h.invoice()).pay_verified_by, 'second-admin@entropymakeup.com');
    });

    test('self approval of other changes keeps working', async () => {
      await h.login(ADMIN);
      const pending = await h.submit([await statusOp({note: '합성 메모'})]);
      assert.equal((await h.review(pending.id)).status, 'approved');
    });

    test('verification fields cannot be written through a request', async () => {
      const pending = await h.submit([await statusOp({pay_verified_by: 'forged@example.com', pay_verified_at: '2026-01-01T00:00:00Z'})]);
      await approve(pending.id);
      const inv = await h.invoice();
      assert.equal(inv.pay_verified_by, null); assert.equal(inv.pay_verified_at, null);
    });

    test('cancelling paid clears the payment verification; existing evidence allows a later paid request', async () => {
      await approve((await h.submit([evidence('입금증빙'), await statusOp({status: 'Paid', pay_date: '2026-10-05'})])).id);
      await approve((await h.submit([await statusOp({status: 'Ordered', pay_date: null})])).id);
      assert.equal((await h.invoice()).pay_verified_by, null);
      await approve((await h.submit([await statusOp({status: 'Paid', pay_date: '2026-10-07'})])).id);
      assert.equal((await h.invoice()).pay_verified_by, 'entropyadmin@entropy.internal');
    });

    test('paid to closed keeps the original verification', async () => {
      await approve((await h.submit([evidence('입금증빙'), await statusOp({status: 'Paid', pay_date: '2026-10-05'})])).id);
      const at = (await h.invoice()).pay_verified_at;
      await approve((await h.submit([await statusOp({status: 'Closed'})])).id);
      assert.equal((await h.invoice()).pay_verified_at, at);
    });

    test('full invoice save cannot set paid without evidence, and new invoices cannot start as paid or shipped', async () => {
      await assert.rejects(async () => h.submit([await h.invoiceOp({status: 'Paid', pay_date: '2026-10-05'})]), /EVIDENCE_REQUIRED/);
      const lines = [{name: '합성 신규', barcode: null, sales_type: 'Paid', qty: 1, price: 1}];
      const header = {no: 'SYNTHETIC-NEW', customer: 'Synthetic customer', mgr: null, order_date: '2026-10-01', pay_date: null, ship_date: null, foc: false, note: null};
      await assert.rejects(() => h.submit([{action: 'invoice', id: null, before: null, invoice: {...header, status: 'Paid', ship_status: '준비중'}, items: lines}]), /EVIDENCE_REQUIRED/);
      await assert.rejects(() => h.submit([{action: 'invoice', id: null, before: null, invoice: {...header, status: 'Ordered', ship_status: '출고완료'}, items: lines}]), /EVIDENCE_REQUIRED/);
      const ok = await h.submit([{action: 'invoice', id: null, before: null, invoice: {...header, status: 'Ordered', ship_status: '준비중'}, items: lines}]);
      assert.equal(ok.status, 'pending');
    });
  });
}

suite('invoice settlement evidence SQL', {});
suite('invoice settlement evidence SQL with request revisions', {revisions: true});

test('installing twice is rejected instead of patching again', async () => {
  const db = await prepare();
  try { await assert.rejects(() => db.exec(fs.readFileSync(settlementPath, 'utf8')), /already installed/); }
  finally { await db.close(); }
});
