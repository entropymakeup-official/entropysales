# Annual History Implementation Plan

> For agentic workers: use superpowers:subagent-driven-development task by task.

**Goal:** Durable Supabase daily archive and yearly monthly statistics.
**Architecture:** Backward-compatible daily window trigger archives observed days. New year RPC aggregates archived rows. Monthly UI uses existing validated browser importer and exact original readback.
**Tech Stack:** Vanilla JS, Supabase PostgreSQL, Node test, PGlite.
**Spec:** docs/superpowers/specs/2026-09-11-annual-history-design.md

## Global Constraints
No Wekeep API, no tokens, no deletion of historical data. Company-only existing authorization helper. Do not modify existing history SQL/tests unnecessarily. Preserve source signed quantities, blank codes and distinct SKU. Incomplete coverage is not zero. All changes inside current isolated worktree.

### Task 1: Archive database and annual RPC
Files: create sql/wekeep-history-archive.sql, tests/wekeep-history-archive-db.test.cjs. Read sql/wekeep-history.sql and existing DB test setup.
Interface: exact annual RPC response described in spec. Existing save/get untouched. Trigger from product_window records all dates in accepted window; has_record false markers represent missing records. Archive metadata independent from cascading live catalog. Per-date collection monotonicity; equal-time differing data rejected, identical idempotent. Trigger archive backfill on installation no timestamp fabrication; reinstallation cannot overwrite newer archive. Preserve original company authorization guard and restrict EXECUTE; private tables RLS and no direct client privileges. Validate p_year before querying, no future years, KST today. Monthly quantities summed as bigint; null on zero record days. Upper record date capped today; timestamp counts exactly corresponding archive dates.
- [ ] Write failing PGlite tests for new function absent, then archive Jan+Feb windows and ensure Jan survives; same day update no duplicates; empty marker not numeric0; seed preserves collection timestamp; repeated install no regression; live catalog deletion retains archive; unauthorized read/direct table denied; invalidyear; exactmonthend vs lastrecord; negative and large sum.
- [ ] Run node --test tests/wekeep-history-archive-db.test.cjs and record RED.
- [ ] Implement idempotent standalone SQL extension (not CLI migrations folder; repo convention standalone SQL install script) with transaction, tables, trigger function, seed and RPC.
- [ ] Run targeted archive tests and original history DB tests, record results.
- [ ] Commit only assigned files, write report .local/annual/task-1-report.md with schema, tested cases, install checks. No external DB writes, no browser operations, no child reviewers.

### Task 2: Monthly UI and integration
Files: inventory-monthly.js, tests/inventory-monthly.test.cjs, app.js, index.html, styles.css/package.json as required by existing names.
Interface: annual read RPC above; write uses existing save_wekeep_history then read exact get_wekeep_history to call InventoryHistory.confirmsBatch. Existing current inventory openProduct works through new mount. Keep InventoryHistory globals loaded as parser utilities.
- [ ] Write failing monthly tests covering 12rows, years/leapyear, subtotal/incomplete coverage, knownzero/missing, monthly balance semantics, negative flow, chart escaping, filters, stale async responses and write/readback mismatch.
- [ ] Implement pure validateAnnual/summarizeMonthly/render and bounded mount read/write lifecycle. year changes issue new read; late response must not paint another year. Product identity match uses existing matcher.
- [ ] Integrate app.js read(year), write(batch), verify(batch) contracts and index script order. Add syntax check entry. No external deployment.
- [ ] Run relevant tests and fullsuite/check, commit assigned files, write report .local/annual/task-2-report.md.

### Task 3: Operational collection and release
- [ ] Confirm source January window through visible UI; collect full roster with observed SKU DOM attributes.
- [ ] Review SQL and UI with independent reviewer, fix confirmed findings, run full tests and actual browser UI.
- [ ] Install validated archive SQL on existing company Supabase, verify seeded counts/permissions/idempotency read-only postcheck.
- [ ] Publish repository feature via reviewed PR, verify deployed files and company annual UI.
- [ ] Collect annual source month windows using UI, retain date/page/SKU validation. Save verified batches and mark exact coverage only after ack+freshread.
- [ ] Update existing collector guide/state/heartbeat for currentmonth and historical backfill; retain notification policy, no duplicate scheduler. Record full/partial actual coverage and handoff.
