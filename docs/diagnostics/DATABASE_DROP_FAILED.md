---
description: "Fix DATABASE_DROP_FAILED in ViteHub. Check database credentials and ownership dependencies, then retry the transactional database reset."
seo.title: "DATABASE_DROP_FAILED: reset failed"
---

`vitehub database drop` cannot drop the tables. `error.why` has the reason, such as a remote database without `--remote`, missing credentials, or a database error. The drop runs in one transaction, so nothing was dropped.
