const {test, describe, before, after, beforeEach, afterEach} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createDatabase, harness, INVOICE} = require('./helpers/invoice-amount-db.cjs');

const MEMBER = '00000000-0000-0000-0000-000000000002';
const migration = path.join(__dirname, '../sql/invoice-note-append-only.sql');

describe('invoice memos are append-only', () => {
  let db, h;
  before(async () => {
    db = await createDatabase();
    await db.exec(fs.readFileSync(migration, 'utf8'));
    h = harness(db);
  });
  after(async () => { if (db) await db.close(); });
  beforeEach(async () => { await db.exec('begin'); await h.login(MEMBER); });
  afterEach(async () => { await db.exec('rollback; reset role'); });

  const rowOp = async note => ({table: 'invoices', action: 'update', key: {id: INVOICE}, before: await h.invoice(), values: {note}});

  test('appending to the existing memo is accepted and applied', async () => {
    const pending = await h.submit([await rowOp('Original header\n[2026-11-04] 증빙 확인')]);
    await h.login();
    assert.equal((await h.review(pending.id)).status, 'approved');
    assert.equal((await h.invoice()).note, 'Original header\n[2026-11-04] 증빙 확인');
  });

  test('replacing or clearing the memo is rejected at submit', async () => {
    for (const note of ['완전히 새 메모', '', null, 'Original'])
      await assert.rejects(async () => h.submit([await rowOp(note)]), /NOTE_APPEND_ONLY/);
  });

  test('invoice edits must keep the memo, including when the note key is missing', async () => {
    await assert.rejects(async () => h.submit([await h.invoiceOp({note: '덮어쓰기'})]), /NOTE_APPEND_ONLY/);
    const missing = await h.invoiceOp();
    delete missing.invoice.note;
    await assert.rejects(async () => h.submit([missing]), /NOTE_APPEND_ONLY/);
    assert.equal((await h.submit([await h.invoiceOp({note: 'Original header / 추가'})])).status, 'pending');
  });

  test('after another memo is approved, a request that drops it is rejected', async () => {
    const appended = await h.submit([await rowOp('Original header + A')]);
    await h.login();
    await h.review(appended.id);
    await h.login(MEMBER);
    // Built on the new row, but drops the first approved memo text.
    await assert.rejects(async () => h.submit([await rowOp('+ A only')]), /NOTE_APPEND_ONLY/);
  });

  test('an empty memo can be filled freely and the migration refuses to run twice', async () => {
    await h.login();
    await h.directContext();
    await h.query('update public.invoices set note=null where id=$1', [INVOICE]);
    await db.exec('reset role; delete from approval_private.apply_context where transaction_id=txid_current()');
    await h.login(MEMBER);
    assert.equal((await h.submit([await rowOp('첫 메모')])).status, 'pending');
    await db.exec('reset role');
    await assert.rejects(() => db.exec(fs.readFileSync(migration, 'utf8')), /already installed/);
  });
});
