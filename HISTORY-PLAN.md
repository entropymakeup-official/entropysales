# 위킵 최근 30일 입출고 이력 Implementation Plan

> Agentic workers: use superpowers:subagent-driven-development. User approved phase 1 on 2026-09-10 ('wlsgod', Korean keyboard 진행).

Goal: Existing 실시간 재고 gets 현재 재고 / 입출고 이력 tabs, product drilldown, daily quantities and trends, backed by validated browser collections for all current products.

Architecture: Separate inventory-history.js module, company-authenticated Supabase RPC and private catalog/product window tables. Import complete windows per product in batches; preserve other products on each import. Existing live quantities and planned stocks are unchanged. User sees collected coverage and missing records distinctly. Initial window today KST minus29 days to today, inclusive. Phase 2 individual shipment details excluded.

## Global constraints and exact interface
- Never call Wekeep APIs directly or read auth tokens. Collect visible DOM via CUA. The inventory row history button onclick exposes source SKU identity; read that attribute as a DOM link identity, never invoke its JS directly.
- source SKU is a digit string 1..40 chars. Preserve blank/duplicate management codes, negative quantities. No auto merge or sales/forecast mapping.
- Import `save_wekeep_history(p_batch jsonb)` accepts exactly `{version:1,source:'wekeep',collected_at:ISO,from:'YYYY-MM-DD',to:'YYYY-MM-DD',catalog:[{sku,name,code,supplier}],products:[{sku,days:[{date,inbound,returned,faulty,damaged,outbound,balance}]}]}`.
- catalog 1..10000 unique SKUs, names nonblank <=1000, code<=300/supplier<=500. products 1..200 unique SKUs all in catalog. Numeric daily fields signed int32. Dates valid exact calendar dates within [from,to], no repeated dates. Window 1..31 days. Missing dates are missing source records, never zeros. Empty days allowed only collector verified empty entire range. No unknown/missing keys. Payload<=4MB; collection timestamp <=5min future and <=24h old on write.
- `get_wekeep_history()` returns `{catalog:[...],products:[{sku,from,to,collected_at,days:[...]}],checked_at:ISO}`. Only latest full window per product retained; mixed windows clearly labeled. No implicit 7-day merging. Catalog current timestamp monotonic; older product window rejected atomically. Same timestamp exact idempotent content accepted, conflicting rejected. Advisory transaction lock serialize writes. Company auth policy matches sql/wekeep-live.sql; no anonymous/direct table reads.
- Save ack `{saved:true,collected_at:originalISO,product_count:N,day_count:N}`. UI validates batch first and ack, then authoritative readback. Timeout15sec, do not automatically resubmit uncertain saves. Safe cached display, no false fresh status after failed reads.
- History view default30days KST, product dropdown/search and from/to filters, type filter for nonzero chosen category, summary explicitly '수집된 기록 합계', coverage count/all catalog, collection timestamps. Never label missing as 0 or all outbound as overseas sales. Product-only charts: inbound/outbound bars; separate balance trend (do not conflate balance with current available). Show gap/missing days, accessible table.
- Existing current-inventory row action matches name/code/supplier EXACTLY to history catalog ONLY if unique; ambiguous matches show selection, never arbitrary SKU. Input drafts, filtering, tab/nav/logout lifecycle and poll cancellation preserved.
- UI import collapsed '입출고 수집 자료 반영', textarea aria '입출고 수집 자료', button '입출고 검증 후 반영'. Ordinary display does not expose implementation details beyond collection status.

## Task 1 — UI/model integration
Files inventory-history.js, live-inventory.js, app.js, index.html, style.css, package.json, tests/inventory-history.test.cjs, DEVELOPMENT.md.
- [ ] Write failing validation/filter/coverage/matching/stale-timeout tests using node:test (e.g. duplicate dates rejected, empty dates not zero, code collision never arbitrarily linked).
- [ ] Run focused failing test, implement module and integrate tabs; import/read adapter uses RPC contract above.
- [ ] Run focused and existing live-inventory tests; preserve existing behavior. Include synthetic preview for empty/partial/error.
- [ ] Commit only owned files, write .local/history-ui-report.md and concise test output. Parent collects real source data independently.

## Task 2 — SQL storage and authorization
Files sql/wekeep-history.sql, tests/wekeep-history-db.test.cjs.
- [ ] Write failing PGlite test matching existing DB harness. Cases company/anon/auth-user restriction, malformed payload rollback, duplicate SKU/date rejection, stale atomic batch rejection, empty days accepted, metadata preservation and no other-product loss.
- [ ] Implement private catalog + product window storage and RPC contract. Validate all batch before changes, monotonic catalog and product windows, exact ack.
- [ ] Run focused DB test, commit only owned files, write .local/history-db-report.md.

## Task 3 — Collection, deployment and operation (parent)
- [ ] Collect source catalog all188 via row button DOM ID; recent30day windows via modal, validate dates/unique/calendar coverage and all pages. Keep source gap explicit. Checkpoint partial batches locally without credentials.
- [ ] Review task diffs then full tests/check; install SQL via authenticated editor UI, verify grants and RLS.
- [ ] Push feature PR, merge following CI; verify published assets. Import all collected products using dashboard UI; compare catalog and quantities/readback.
- [ ] Measure collection time and add bounded history batch work to existing scheduled collector only after first successful full collection; no duplicate automation. Each batch complete product windows, preserve old product on failure.
- [ ] Update guide and handoff, close temporary tabs. Report actual count/coverage and limits.

## Preflight / ledger
Task1 and Task2 share RPC contract only, disjoint files. Both consume exact schema above; no contradictory field names. Task3 calls validated UI import. Task1 own tests match coverage and identity requirements; Task2 tests match atomic per-product storage. All constraints covered. Existing isolated worktree reused on codex/wekeep-history-20260910 from origin/main. Approved scope is phase1 daily records; individual shipping memo collection excluded.

Measured collection decision: initial188 products /5490 daily rows took about7minutes. Extend existing10minute heartbeat with up to20 oldest/missing history products perrun, always each full trailing30day window. Fullcycle roughly100minutes; history stale threshold180minutes. Currentinventory stale15minutes unchanged. Source fields faulty=하자입고,damaged=불량입고,returned=반품입고 (source labels authoritative). Parent controls this scheduling decision based on observed runtime; do not create another automation.
