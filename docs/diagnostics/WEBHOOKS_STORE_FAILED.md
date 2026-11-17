---
description: "Restore webhook delivery storage by checking the Database connection, applying migrations, and inspecting the underlying error cause."
---

The Database could not read or write a delivery. Most often the table is missing: run `vitehub database generate` and `vitehub database migrate`. `error.cause` holds the Database error.
