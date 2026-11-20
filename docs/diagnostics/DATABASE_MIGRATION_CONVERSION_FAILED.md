---
description: "Find out why ViteHub cannot convert an old migration folder and how to preserve the migrations that your database has already applied."
---

`vitehub database up` reports why it cannot convert the old layout. If it fails while it checks the journal, loads the Database Definitions, or replays the SQL, it leaves the migration files as they were.

Fix the problem and run `vitehub database up` again. To restore a missing migration or journal entry, use version control. Do not change a recorded timestamp to make room for another file: an existing Drizzle ledger can use that second to identify an applied migration.

If automatic conversion cannot preserve the migration order and ledger matches, convert the history manually. Run `vitehub database migrate --dry-run` on a copy of an existing database and check that it lists the right migrations as applied before you deploy.
