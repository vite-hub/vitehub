---
description: A Postgres migration ran outside a transaction and remains pending. Learn how to check its SQL and retry.
---

A Postgres migration with `-- vitehub:no-transaction` runs one statement at a time. If a statement fails, the earlier statements stay applied. If the ledger write fails, all statements stay applied. In both cases the next run starts from the first statement of the file.

If the error names an invalid index, drop that index with `DROP INDEX CONCURRENTLY IF EXISTS` in `vitehub database sql`. The list has only the indexes that this file left. An invalid index does not become valid when `CREATE INDEX CONCURRENTLY IF NOT EXISTS` skips it, so the file stays pending until you drop it.

If a statement between `BEGIN` and `COMMIT` fails, or the file ends without `COMMIT`, ViteHub rolls back that transaction and does not record the file.

Fix the reported problem and make each statement safe to run again. Then use `vitehub database migrate` or start the server again.
