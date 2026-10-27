const {test, describe, before, after, beforeEach, afterEach} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {createDatabase, harness, ADMIN, INVOICE, ITEM, SECOND} = require('./helpers/invoice-amount-db.cjs');

const shipModePath = path.join(__dirname, '../sql/invoice-item-ship-mode.sql');
const migrate = db => db.exec(fs.readFileSync(shipModePath, 'utf8'));
const pair = [
  {name:'Synthetic twin',barcode:'TWIN',sales_type:'Paid',qty:5,price:4,ship_mode:'Air'},
  {name:'Synthetic twin',barcode:'TWIN',sales_type:'Paid',qty:5,price:4,ship_mode:'Sea'}
];

describe('invoice item ship_mode SQL', () => {
  let db, h;
  before(async () => { db = await createDatabase(); await migrate(db); h = harness(db); });
  after(async () => { if (db) await db.close(); });
  beforeEach(async () => { await db.exec('begin'); await h.login(); });
  afterEach(async () => { await db.exec('rollback; reset role'); });

  test('adds a nullable column restricted to Air/Sea without touching existing lines', async () => {
    const column = (await h.query("select data_type,is_nullable,column_default from information_schema.columns where table_schema='public' and table_name='invoice_items' and column_name='ship_mode'")).rows;
    assert.deepEqual(column, [{data_type:'text',is_nullable:'YES',column_default:null}]);
    assert.ok((await h.items()).every(i => i.ship_mode === null));
    await h.directContext();
    await assert.rejects(() => h.query("update public.invoice_items set ship_mode='Truck' where id=$1", [ITEM]), /invoice_items_ship_mode_check/);
  });

  test('full invoice save stores Air and Sea on otherwise identical lines only after approval', async () => {
    const before = await h.items();
    const pending = await h.submit([await h.invoiceOp({}, pair)]);
    assert.equal(pending.status, 'pending');
    assert.deepEqual(await h.items(), before);
    assert.equal((await h.review(pending.id)).status, 'approved');
    assert.deepEqual((await h.items()).map(i => i.ship_mode).sort(), ['Air', 'Sea']);
  });

  test('lines without ship_mode keep saving as NULL', async () => {
    await h.review((await h.submit([await h.invoiceOp({note:'header only'})])).id);
    assert.ok((await h.items()).every(i => i.ship_mode === null));
  });

  test('generic approved item update can set and clear ship_mode', async () => {
    await h.approveUpdate({ship_mode:'Sea'});
    assert.equal((await h.items()).find(i => i.id === ITEM).ship_mode, 'Sea');
    await h.approveUpdate({ship_mode:null});
    assert.equal((await h.items()).find(i => i.id === ITEM).ship_mode, null);
  });

  test('invalid modes are rejected at submission with a readable code', async () => {
    for (const mode of ['air', 'Truck', '', 1]) {
      await assert.rejects(async () => h.submit([await h.invoiceOp({}, [{...pair[0], ship_mode:mode}])]), /INVALID_SHIP_MODE/);
      await assert.rejects(async () => h.submit([await h.updateOp({ship_mode:mode})]), /INVALID_SHIP_MODE/);
    }
  });

  test('other item keys in a full save stay rejected', async () => {
    await assert.rejects(async () => h.submit([await h.invoiceOp({}, [{...pair[0], invoice_no:'X'}])]), /INVALID_ITEM_FIELD/);
  });

  test('an old browser payload without ship_mode cannot erase a stored mode', async () => {
    await h.review((await h.submit([await h.invoiceOp({}, pair)])).id);
    const stale = pair.map(({ship_mode, ...rest}) => rest);
    await assert.rejects(async () => h.submit([await h.invoiceOp({note:'stale tab'}, stale)]), /STALE_CLIENT/);
    assert.deepEqual((await h.items()).map(i => i.ship_mode).sort(), ['Air', 'Sea']);
  });

  test('evidence amount survives a full save on one of two lines told apart only by ship_mode', async () => {
    await h.review((await h.submit([await h.invoiceOp({}, pair)])).id);
    const air = (await h.items()).find(i => i.ship_mode === 'Air');
    await h.approveUpdate({amount_override:19.5, amount_reference:'Synthetic air proof'}, air.id);
    await h.review((await h.submit([await h.invoiceOp({note:'header edit'}, pair)])).id);
    const after = await h.items();
    assert.deepEqual(after.map(i => [i.ship_mode, i.amount_override === null ? null : Number(i.amount_override)]).sort(), [['Air', 19.5], ['Sea', null]]);
  });

  test('sheet worker snapshot keeps its existing item fields', async () => {
    await h.review((await h.submit([await h.invoiceOp({}, pair)])).id);
    await db.exec('reset role');
    const jobs = (await h.query("select public.claim_invoice_sheet_jobs('synthetic-worker-key',50) r")).rows[0].r;
    const job = jobs.find(j => j.invoice_id === INVOICE);
    assert.ok(job.items.length === 2);
    for (const item of job.items) assert.deepEqual(Object.keys(item).sort(), ['amount_override','barcode','id','name','price','qty','sales_type']);
  });
});

for (const kind of ['generic item update', 'full invoice save']) {
  test(`a pending ${kind} created before the migration remains approvable`, async () => {
    const db = await createDatabase();
    try {
      const h = harness(db);
      await db.exec('begin'); await h.login();
      const op = kind === 'full invoice save' ? await h.invoiceOp({note:'queued before ship_mode'}) : await h.updateOp({qty:9}, SECOND);
      const pending = await h.submit([op]);
      await db.exec('commit; reset role');
      await migrate(db);
      await db.exec('begin'); await h.login();
      assert.equal((await h.review(pending.id)).status, 'approved');
      assert.ok((await h.items()).every(i => i.ship_mode === null));
      await db.exec('rollback; reset role');
    } finally { await db.close(); }
  });
}

test('migration fails closed when the installed definitions no longer match', async () => {
  const db = await createDatabase();
  try {
    await migrate(db);
    await assert.rejects(() => migrate(db), /changed .*review before applying ship_mode/);
    await db.exec('rollback');
    const columns = (await db.query("select count(*)::int n from information_schema.columns where table_name='invoice_items' and column_name='ship_mode'")).rows[0].n;
    assert.equal(columns, 1);
  } finally { await db.close(); }
});

test('migration refuses to run before the evidence migration', async () => {
  const db = await createDatabase({migrate:false});
  try {
    await assert.rejects(() => migrate(db), /invoice-amount-evidence/);
  } finally { await db.close(); }
});
