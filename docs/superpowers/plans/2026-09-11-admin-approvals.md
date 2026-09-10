# Admin approvals implementation plan

> Execute using superpowers:subagent-driven-development with independent file ownership and final review.

**Goal:** Every human business-data change requires separate administrator approval, including self-authored changes.
**Architecture:** Immutable request payloads with optimistic before snapshots, server validation and an atomic privileged reviewer; separate administrator page; explicit pending results in existing forms.
**Tech Stack:** Vanilla JS, Supabase Postgres, Node test runner, PGlite.
**Spec:** ../specs/2026-09-11-admin-approvals-design.md

## Global constraints
- No production test data, no secrets in repository, no direct-write bypass.
- Retain current main behavior outside approval workflow; external source inventory snapshots remain acquisition data.
- User approved administrator self-approval; never auto-approve upon submission.

## Task 1 — database (root)
- [x] Write PGlite tests for pending isolation, self approval, access denial, rollback and conflicts; run `node --test tests/change-approvals-db.test.cjs` and observe initial missing script failure.
- [x] Implement SQL RPC contracts from spec. Re-run tests until pass.

## Task 2 — existing forms and submit client
- [x] Read every write call in app.js and drive-documents.js; build explicit operations and preserve current displayed data upon submission.
- [x] Add failing tests for submission RPC request shape, no direct write, pending/error UI and duplicate-submission handling.
- [x] Implement change-requests.js and integrate forms, updating obsolete immediate-save assertions to pending assertions.
- [x] Run `node --test tests/change-requests*.test.cjs` and relevant existing form tests.

## Task 3 — administrator page
- [x] Add behavioral tests for safe diff display, no mutation on opening page, explicit approval and rejection, error state retention.
- [x] Build admin.html, admin-approvals.js, approvals.css with company session checks and server-derived authorization. Paginate requests and retain returned errors.
- [x] Run UI module tests; inspect browser rendering.

## Task 4 — integration and review
- [x] Run `npm run check` and `npm test`, review all mutation callsites and DB grants/triggers, obtain independent review.
- [x] Write installation/rollback/deployment instructions with exact scope and limitations. Record latest handoff before final response.
