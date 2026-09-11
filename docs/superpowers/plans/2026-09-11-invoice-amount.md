# Invoice evidence amount implementation plan

> For agentic workers: implement each task with test-driven development and verify before completion.

**Goal:** Preserve approved evidence totals throughout existing sales views and outbound Sheets synchronization.

**Architecture:** Optional line amount and evidence reference remain under the current approval workflow. Common amount calculation prioritizes that value; database validation and invoice replacement preserve it. The existing outbound worker carries the explicit amount without changing quantity or unit price.

**Tech Stack:** Plain JavaScript, Supabase Postgres 17, PGlite, existing Apps Script.

**Spec:** ../specs/2026-09-11-invoice-amount-design.md

## Constraints

- Existing approval/RLS, latest inventory and Excel date work are preserved.
- No real order identifiers, amounts or source links in Git/tests.
- Original qty/price remain, optional values support zero and negative Paid totals.
- Existing proof-backed item changes require clearing the proof via approved request first; unchanged invoice replacements preserve proof.

## Tasks

- [x] Write failing synthetic amount/model/UI tests. Implement invoice-amounts.js, relevant app.js amount consumers and a proof amount request modal. Update index/version/admin field labels and run focused tests.
- [x] Write failing PGlite schema/save preservation tests. Add sql/invoice-amount-evidence.sql: optional pair fields, checks, item change guard, preservation in save_invoice_atomic, claim_invoice_sheet_jobs payload. Verify approval and unchanged rows with synthetic fixtures.
- [x] Keep existing outbound worker pure functions in the isolated work area; add failing amount tests and implement explicit amount fallback in Core.js and authoritative Amount validation in ReportAmounts.js. Verify existing worker tests. Patch only the corresponding expressions in the existing Apps Script files, preserving configuration and timers.
- [ ] Run full syntax/tests, independently review final diff, inspect UI success/pending/failure, integrate latest main, install schema and patch worker source, merge and verify Pages/public files.
- [ ] Re-read current five orders/eight items and source tax totals, submit concrete reasoned amount requests, verify pending then use authorized admin review. Verify resulting amounts, unchanged other data and actual managed Sheet Amount values. Record request IDs/receipts and cleanup.
