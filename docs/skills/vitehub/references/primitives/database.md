# Database

Use Database for relational data with Drizzle. Define tables in a Database Definition and query through the generated `useDatabase()` handle.

Read the [Database guide](https://vitehub.dev/docs/database) first. Then choose [Get started](https://vitehub.dev/docs/database/get-started), [Configure](https://vitehub.dev/docs/database/configure), [Server API](https://vitehub.dev/docs/database/server-api), or [Hosts](https://vitehub.dev/docs/database/hosts).

Import `useDatabase` from `vite-hub/database/drizzle` and select the discovered database by name. Do not import generated database definitions or provider bindings into application code. Keep migrations and transaction boundaries with the Database owner.

Prove a migration, a typed read, a write, and a restart or remote-host read. Inspect generated schema and provisioning output before deployment.
