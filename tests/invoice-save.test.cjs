const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Execute the actual production saveInv function. Only the DOM and remote DB
// boundary are replaced; no live customer data or credentials are used.
const target = process.env.APP_UNDER_TEST || path.join(__dirname, '../app.js');
const source = fs.readFileSync(target, 'utf8');
const saveCode = source.slice(source.indexOf('async function saveInv(){'), source.indexOf('async function delInv('));

function harness({ response, throws, deferred, isNew = false } = {}) {
  const original = { id: 'inv-1', no: 'OLD', customer: 'Test Customer', note: 'original' };
  const oldItem = { id: 'item-1', invoice_id: 'inv-1', name: 'Original item', qty: 1, price: 10 };
  const values = { 'inv-no': 'NEW', 'inv-cust-ro': 'Test Customer', 'inv-odate': '2026-09-05', 'inv-pdate': '', 'inv-sdate': '', 'inv-status': 'Ordered', 'inv-ship': '준비중', 'inv-foc': '0', 'inv-note': 'edited' };
  const elements = Object.fromEntries(Object.entries(values).map(([id, value]) => [id, { value }]));
  elements['inv-save-btn'] = { disabled: false, textContent: '저장' };
  const notices = [], closed = [], downloads = [], calls = [];
  let legacyDeletes = 0;
  const row = {
    querySelectorAll: () => ['Replacement item', '12345678', '2', '10'].map(value => ({ value })),
    querySelector: () => ({ value: 'Paid' })
  };
  const sb = {
    rpc: async (name, args) => { calls.push({ name, args }); if (deferred) await deferred; if (throws) throw throws; return response; },
    from: table => ({
      update: () => ({ eq: async () => ({ error: null }) }),
      delete: () => ({ eq: async () => { legacyDeletes++; return { error: null }; } }),
      insert: () => ({ error: { message: 'simulated item insertion failure' }, select: () => ({ single: async () => ({ data: { id: 'inv-3', no: 'NEW' } }) }) })
    })
  };
  const ctx = vm.createContext({
    sb, _savingInv: false, _editInv: isNew ? null : original,
    _invoices: [original], _items: [oldItem],
    document: { getElementById: id => elements[id], querySelectorAll: () => [row] },
    custByName: () => ({ mgr: 'test' }),
    alert: msg => notices.push(msg), toast: msg => notices.push(msg),
    cm: id => closed.push(id), renderInvoices: () => {},
    downloadMeongse: inv => downloads.push(inv), setTimeout: fn => fn(), console
  });
  vm.runInContext(saveCode, ctx);
  return { ctx, elements, notices, closed, downloads, calls, legacyDeletes: () => legacyDeletes, run: () => ctx.saveInv() };
}

test('server failure preserves cache and open form without success message', async () => {
  const h = harness({ response: { data: null, error: { message: 'item rejected' } } });
  await h.run();
  assert.equal(h.ctx._items[0]?.name, 'Original item');
  assert.equal(h.ctx._invoices[0].note, 'original');
  assert.equal(h.closed.length, 0);
  assert.equal(h.legacyDeletes(), 0);
  assert.ok(h.notices.some(s => /실패|확인/.test(s)));
  assert.equal(h.elements['inv-save-btn'].disabled, false);
});

test('network exception preserves input and permits later user action', async () => {
  const h = harness({ throws: new Error('network unavailable') });
  await h.run();
  assert.equal(h.ctx._items[0]?.id, 'item-1');
  assert.equal(h.elements['inv-note'].value, 'edited');
  assert.equal(h.closed.length, 0);
  assert.equal(h.elements['inv-save-btn'].disabled, false);
  assert.equal(h.ctx._savingInv, false);
});

test('successful edit uses server IDs and replaces only the edited invoice items', async () => {
  const h = harness({ response: { error: null, data: { invoice: { id: 'inv-1', no: 'NEW', note: 'edited' }, items: [{ id: 'server-item-2', invoice_id: 'inv-1', qty: 2, price: 10 }] } } });
  h.ctx._items.push({ id: 'other-item', invoice_id: 'inv-2' });
  await h.run();
  assert.equal(h.ctx._items.length, 2);
  assert.ok(h.ctx._items.some(i => i.id === 'server-item-2'));
  assert.ok(h.ctx._items.some(i => i.id === 'other-item'));
  assert.equal(h.ctx._invoices[0].note, 'edited');
  assert.equal(h.closed.length, 1);
});

test('duplicate clicks during a pending save issue one request', async () => {
  let resolve;
  const deferred = new Promise(r => { resolve = r; });
  const h = harness({ deferred, response: { error: { message: 'failed' } } });
  const first = h.run();
  await h.run();
  assert.equal(h.calls.length, 1);
  assert.equal(h.elements['inv-save-btn'].disabled, true);
  resolve(); await first;
  assert.equal(h.elements['inv-save-btn'].disabled, false);
});

test('new invoice downloads only the confirmed server result', async () => {
  const h = harness({ isNew: true, response: { error: null, data: { invoice: { id: 'inv-3', no: 'NEW' }, items: [{ id: 'item-3', invoice_id: 'inv-3', qty: 2, price: 10 }] } } });
  await h.run();
  assert.equal(h.downloads.length, 1);
  assert.equal(h.downloads[0].id, 'inv-3');
  assert.equal(h.downloads[0].items[0].id, 'item-3');
  assert.equal(h.ctx._invoices.length, 2);
});

test('malformed response never produces a success message or cache replacement', async () => {
  const h = harness({ response: { error: null, data: {} } });
  await h.run();
  assert.equal(h.closed.length, 0);
  assert.equal(h.ctx._invoices[0].note, 'original');
  assert.ok(h.notices.some(s => /확인/.test(s)));
});
