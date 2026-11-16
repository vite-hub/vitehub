---
description: "Fix DATABASE_SQL_FAILED in ViteHub. Check the SQL statement, database connection, remote flag, and credentials before running the query again."
seo.title: "DATABASE_SQL_FAILED: query failed"
---

`vitehub database sql` cannot run the SQL. `error.why` has the reason, such as a SQL error, a local file that does not exist, a remote database without `--remote`, or missing credentials. Statements before the failed one stay applied. See [Run SQL and drop tables](/docs/database/configure#run-sql-and-drop-tables).
