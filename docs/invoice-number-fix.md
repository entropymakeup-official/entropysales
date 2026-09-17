# Approval-aware invoice numbers

User authorized applying the automatic-number collision fix on 2026-09-17.

## Design and execution plan

- Preserve existing approval permissions, validation, transaction rollback and review flow.
- Allocate numbers at request submission under the existing transaction advisory lock.
- Require explicit `auto_number:true` intent from new RAW/manual and RAW Excel requests, and recognize the existing automatic format: customer code + order date + optional numeric suffix. Preserve custom invoice numbers and existing invoice edits. Old clients without intent get a conflict error and must refresh.
- Check confirmed invoices, pending request operations and other operations in the same batch. Pending numbers stay reserved until approved/rejected.
- Keep the original submitted payload in a private column so network retries with the same client ID return the original request even after number assignment.
- Return assigned numbers as additional response metadata; existing clients remain compatible, and the approval page already displays the stored number.
- Regression test two pending submissions, reversed approvals, confirmed collisions, batches, idempotent retries, custom numbers, edits, permissions and rollback before installation.
- Repair the one reported pending request separately with an exact original-payload/status guard. Change only its number; preserve status and all business values. Do not approve it.
- Install the tested SQL, verify stored function/permissions and repaired request, then record deployment and source revision.

Files: `sql/invoice-number-allocation.sql`, `tests/invoice-number-allocation-db.test.cjs`, `app.js`, `change-requests.js`, `index.html`, `tests/invoice-number-message.test.cjs`, `tests/raw-save.test.cjs`. No change to `apply_operations` or existing contract functionality.

The frontend confirmation number is labeled as a proposal; the final reserved number is shown in the submission message and on the administrator approval page.
