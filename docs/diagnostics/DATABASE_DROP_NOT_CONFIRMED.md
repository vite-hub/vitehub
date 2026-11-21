---
description: "Fix DATABASE_DROP_NOT_CONFIRMED in ViteHub. Confirm the database reset in a terminal or pass --yes when running a script or CI job."
seo.title: "DATABASE_DROP_NOT_CONFIRMED: confirm reset"
---

`vitehub database drop` or `vitehub database reset` was not confirmed. On a terminal, answer `y`. Without a terminal, such as in CI, add `--yes`. Nothing was dropped.
