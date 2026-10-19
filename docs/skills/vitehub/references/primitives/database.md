# Database

<!-- Generated from docs/content/docs/database/index.md. Edit the agent-only block there. -->

Source page: https://vitehub.dev/raw/docs/database.md

Use Database for relational data with Drizzle. Define tables in a Database Definition and query through the generated `useDatabase()` handle.

Read [Get started](https://vitehub.dev/raw/docs/database/get-started.md), [Configure](https://vitehub.dev/raw/docs/database/configure.md), [Server API](https://vitehub.dev/raw/docs/database/server-api.md), or [Hosts](https://vitehub.dev/raw/docs/database/hosts.md).

Import `useDatabase` from `vite-hub/database/drizzle` and select the discovered database by name. Do not import generated database definitions or provider bindings into application code. Keep migrations and transaction boundaries with the Database owner.

Prove a migration, a typed read, a write, and a restart or remote-host read. Inspect generated schema and provisioning output before deployment.
