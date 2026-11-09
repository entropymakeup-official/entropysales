const {test, describe, before, after, beforeEach, afterEach} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createDatabase, harness, ADMIN, INVOICE, ITEM, SECOND} = require('./helpers/invoice-amount-db.cjs');

const MEMBER = '00000000-0000-0000-0000-000000000002';
const sql = name => fs.readFileSync(path.join(__dirname, '../sql', name), 'utf8');

// Production order: revisions → settlement evidence → self approval → free-order-closed.
async function prepare() {
  const db = await createDatabase();
  await db.exec(`
    alter table public.invoice_drive_documents add column drive_file_id text, add column resource_key text,
      add column type text constraint invoice_drive_documents_type_check check (type in ('거래명세서','구매확인서','세금계산서','기타'));`);
  await db.exec(sql('request-revisions.sql'));
  await db.exec(sql('invoice-settlement-evidence.sql'));
  await db.exec(sql('settlement-self-approval.sql'));
  await db.exec(sql('free-order-closed.sql'));
  return db;
}

describe('free order closed (무상 종결)', () => {
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
  // 합성 주문의 유상 2줄을 FOC로 바꾸고 선적서류와 함께 출고완료로 만든다.
  const makeFreeShipped = async () => {
    await approve([await itemOp(ITEM, {sales_type: 'FOC'}), await itemOp(SECOND, {sales_type: 'FOC'})]);
    await approve([doc('선적서류'), await statusOp({ship_status: '출고완료', ship_date: '2026-10-06'})]);
  };

  test('free shipped order closes without payment evidence and records the approver', async () => {
    await makeFreeShipped();
    assert.equal((await approve([await statusOp({status: 'Closed'})])).status, 'approved');
    const inv = await h.invoice();
    assert.equal(inv.status, 'Closed'); assert.equal(inv.pay_date, null);
    assert.equal(inv.pay_verified_by, 'entropyadmin@entropy.internal'); assert.ok(inv.pay_verified_at);
  });

  test('order with a paid amount cannot be closed', async () => {
    await approve([doc('선적서류'), await statusOp({ship_status: '출고완료', ship_date: '2026-10-06'})]);
    await assert.rejects(async () => h.submit([await statusOp({status: 'Closed'})]), /FREE_CLOSE_PAID_AMOUNT/);
  });

  test('a paid line overridden to zero leaves no amount to collect', async () => {
    await approve([await itemOp(SECOND, {sales_type: 'FOC'})]);
    await approve([await itemOp(ITEM, {amount_override: 0, amount_reference: '합성 근거 0원'})]);
    await approve([doc('선적서류'), await statusOp({ship_status: '출고완료', ship_date: '2026-10-06'})]);
    // 유상 줄이 남아 있어도 금액이 0이면 받을 돈이 없다.
    assert.equal((await approve([await statusOp({status: 'Closed'})])).status, 'approved');
  });

  test('free order needs shipped status and shipping documents to close', async () => {
    await approve([await itemOp(ITEM, {sales_type: 'FOC'}), await itemOp(SECOND, {sales_type: 'FOC'})]);
    await assert.rejects(async () => h.submit([await statusOp({status: 'Closed'})]), /FREE_CLOSE_SHIPPING_REQUIRED/);
    await assert.rejects(async () => h.submit([doc('거래명세서'), await statusOp({status: 'Closed'})]), /FREE_CLOSE_SHIPPING_REQUIRED/);
  });

  test('closed order cannot carry a pay date', async () => {
    await makeFreeShipped();
    await assert.rejects(async () => h.submit([await statusOp({status: 'Closed', pay_date: '2026-10-07'})]), /FREE_CLOSE_PAY_DATE/);
    await approve([await statusOp({status: 'Closed'})]);
    await assert.rejects(async () => h.submit([await statusOp({pay_date: '2026-10-07'})]), /FREE_CLOSE_PAY_DATE/);
  });

  test('closed order rejects a later paid amount and un-shipping', async () => {
    await makeFreeShipped();
    await approve([await statusOp({status: 'Closed'})]);
    await assert.rejects(async () => h.submit([await itemOp(ITEM, {sales_type: 'Paid'})]), /FREE_CLOSE_PAID_AMOUNT/);
    await assert.rejects(async () => h.submit([await statusOp({ship_status: '준비중', ship_date: null})]), /FREE_CLOSE_SHIPPING_REQUIRED/);
    // 전체 저장(품목 교체)으로 유상 줄을 넣는 것도 막힌다.
    const lines = (await h.items()).map(({name, barcode, qty, price}) => ({name, barcode, sales_type: 'Paid', qty, price}));
    await assert.rejects(async () => h.submit([await h.invoiceOp({}, lines)]), /FREE_CLOSE_PAID_AMOUNT/);
  });

  test('closed order reopens to ordered, then can become paid only with payment evidence', async () => {
    await makeFreeShipped();
    await approve([await statusOp({status: 'Closed'})]);
    await assert.rejects(async () => h.submit([await statusOp({status: 'Paid', pay_date: '2026-10-08'})]), /EVIDENCE_REQUIRED/);
    await approve([await statusOp({status: 'Ordered'})]);
    const inv = await h.invoice();
    assert.equal(inv.status, 'Ordered'); assert.equal(inv.pay_verified_by, null);
    await approve([await itemOp(ITEM, {sales_type: 'Paid'})]);
    await approve([doc('입금증빙', 'synthetic_pay_0001'), await statusOp({status: 'Paid', pay_date: '2026-10-08'})]);
    assert.equal((await h.invoice()).status, 'Paid');
  });

  test('paid free order moves to closed; paid order with an amount does not', async () => {
    await approve([await itemOp(ITEM, {sales_type: 'FOC'}), await itemOp(SECOND, {sales_type: 'FOC'})]);
    await approve([doc('입금증빙'), doc('선적서류', 'synthetic_ship_0001'), await statusOp({status: 'Paid', ship_status: '출고완료', ship_date: '2026-10-06'})]);
    assert.equal((await approve([await statusOp({status: 'Closed'})])).status, 'approved');
    assert.equal((await h.invoice()).status, 'Closed');
  });

  test('paid order with an amount cannot move to closed', async () => {
    await approve([doc('입금증빙'), doc('선적서류', 'synthetic_ship_0001'), await statusOp({status: 'Paid', pay_date: '2026-10-05', ship_status: '출고완료', ship_date: '2026-10-06'})]);
    await assert.rejects(async () => h.submit([await statusOp({status: 'Closed', pay_date: null})]), /FREE_CLOSE_PAID_AMOUNT/);
  });

  test('existing paid rules are unchanged', async () => {
    await assert.rejects(async () => h.submit([await statusOp({status: 'Paid', pay_date: '2026-10-05'})]), /EVIDENCE_REQUIRED/);
    await approve([doc('입금증빙'), await statusOp({status: 'Paid', pay_date: '2026-10-05'})]);
    const inv = await h.invoice();
    assert.equal(inv.status, 'Paid'); assert.equal(inv.pay_verified_by, 'entropyadmin@entropy.internal');
  });

  test('free-proof document can be retyped from payment evidence to other through a request', async () => {
    await approve([doc('입금증빙', 'synthetic_free_proof')]);
    await h.login(ADMIN);
    const d = (await h.query("select to_jsonb(d) r from public.invoice_drive_documents d where invoice_id=$1", [INVOICE])).rows[0].r;
    await h.login(MEMBER);
    await approve([{table: 'invoice_drive_documents', action: 'update', key: {id: d.id}, before: d, values: {type: '기타'}}]);
    await h.login(ADMIN);
    assert.equal((await h.query('select type from public.invoice_drive_documents where id=$1', [d.id])).rows[0].type, '기타');
  });

  test('migration refuses to install twice', async () => {
    await db.exec('reset role');
    await assert.rejects(() => db.exec(sql('free-order-closed.sql')), /already installed/);
    await db.exec('rollback; begin');
  });
});

// 롤백 SQL은 자체 begin/commit을 쓰므로 공유 트랜잭션 밖, 별도 DB에서 확인한다.
describe('free order closed rollback', () => {
  let db, h;
  before(async () => { db = await prepare(); h = harness(db); });
  after(async () => { if (db) await db.close(); });

  const doc = (type, file) => ({table: 'invoice_drive_documents', action: 'insert', key: {}, before: null,
    values: {invoice_id: INVOICE, drive_file_id: file, name: `합성 ${type}`, type}});
  const statusOp = async values => ({table: 'invoices', action: 'update', key: {id: INVOICE}, before: await h.invoice(), values});
  const itemOp = async (id, values) => ({table: 'invoice_items', action: 'update', key: {id}, before: (await h.items()).find(i => i.id === id), values});
  const approve = async ops => {
    const pending = await h.submit(ops);
    await h.login(ADMIN);
    await h.query("select public.review_change_request_versioned($1::uuid,true,'합성 검토',1)", [pending.id]);
    await h.login(MEMBER);
  };
  const inTx = async fn => { await db.exec('begin'); await h.login(MEMBER); await fn(); await db.exec('reset role; commit'); };

  test('rollback refuses while closed orders remain, then restores the previous guard', async () => {
    await inTx(async () => {
      await approve([await itemOp(ITEM, {sales_type: 'FOC'}), await itemOp(SECOND, {sales_type: 'FOC'})]);
      await approve([doc('선적서류', 'synthetic_ship_0001'), await statusOp({ship_status: '출고완료', ship_date: '2026-10-06'})]);
      await approve([await statusOp({status: 'Closed'})]);
    });
    await assert.rejects(() => db.exec(sql('free-order-closed-rollback.sql')), /Closed invoices remain/);
    await db.exec('rollback');
    await inTx(async () => { await approve([await statusOp({status: 'Ordered'})]); });
    await db.exec(sql('free-order-closed-rollback.sql'));
    const left = (await db.query(`select to_regprocedure('approval_private.invoice_paid_amount(uuid)') f,
      (select count(*)::int from pg_trigger where tgname='free_close_items_guard') t,
      position('FREE_CLOSE' in pg_get_functiondef('approval_private.settlement_guard()'::regprocedure)) p`)).rows[0];
    assert.deepEqual([left.f, left.t, left.p], [null, 0, 0]);
    // 옛 규칙: Closed도 입금완료로 보고 입금증빙을 요구한다.
    await db.exec('begin'); await h.login(MEMBER);
    await assert.rejects(async () => h.submit([await statusOp({status: 'Closed'})]), /EVIDENCE_REQUIRED/);
    await db.exec('rollback; reset role');
    // 되돌린 뒤 다시 설치할 수 있다.
    await db.exec(sql('free-order-closed.sql'));
  });
});
