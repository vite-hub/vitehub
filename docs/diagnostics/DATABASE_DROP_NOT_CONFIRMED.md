---
description: "Fix DATABASE_DROP_NOT_CONFIRMED in ViteHub. Confirm the database reset in a terminal or pass --force when running a script or CI job."
seo.title: "DATABASE_DROP_NOT_CONFIRMED: confirm reset"
---

`vitehub database drop` was not confirmed. On a terminal, answer `y`. Without a terminal, such as in CI, add `--force`. Nothing was dropped.
