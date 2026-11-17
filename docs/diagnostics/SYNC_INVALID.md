---
description: The Sync write has invalid row values, unknown columns, or an unknown action. Read the reported issues and correct the write.
---

The row did not pass `schema`, the write has a column that the table does not have, or the action name is unknown. `issues` tells each problem. Fix the value, then write again or call `retry()`.
