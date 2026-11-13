---
description: "Fix DATABASE_DISABLED in ViteHub. Code reads the Default Database, but the runtime has none. Use a Named Database or enable Database."
seo.title: "DATABASE_DISABLED: no Default Database"
---

A query on `db`, or on `useDatabase('default').db`, throws `DATABASE_DISABLED`. Code reads the Default Database, but the runtime has no Default Database.

## Why it happens

The generated Database registry has no `default` entry. ViteHub then gives the Default Database a placeholder that throws on first use. This occurs when:

- The app has only Named Databases, such as `server/databases/analytics.ts`. No Database is named `default`. The Agent `db()` Capability without a `database` option also reads `default`.
- An app that uses `@vite-hub/database` alone passes `false` to `hubDb()`. The registry is then empty.

With `vitehub()`, a disabled Database fails earlier. The build stops with `VITE_HUB_B0013` when code imports `vite-hub/database/drizzle`. An enabled Vite Database without a Definition always has an empty Default Database.

Some generated runtimes report a missing Default Database as [`DATABASE_NOT_FOUND`](/docs/database/diagnostics/database_not_found) for `default`. Examples are the Nuxt module and hosted Cloudflare and Vercel builds.

## Fix it

```diff [server/api/events.get.ts]
 import { useDatabase } from 'vite-hub/database/drizzle'

 export default defineEventHandler(() => {
-  const { db, schema } = useDatabase('default')
+  const { db, schema } = useDatabase('analytics')
   return db.select().from(schema.events)
 })
```

Use the name of the Named Database that has the tables. For an Agent, set `db({ database: 'analytics' })`. If the app needs one database only, use a Default Database instead: `server/databases/default.ts`.

```diff [vite.config.ts]
 export default defineConfig({
-  plugins: [hubDb(false)],
+  plugins: [hubDb()],
 })
```

Remove `false` when you register `hubDb()` directly. With `vitehub()`, set `database: true`.

## Check the fix

Run `vitehub inspect definitions --kind database`. The list must contain the name that the code uses. Then restart `vite dev` and call the route again.

## Related

- [Define a database](/docs/database/configure#define-a-database)
- [Use Named Databases](/docs/database/server-api#use-named-databases)
- [Enable Database](/docs/database/get-started#enable-database)
- [Database Capability options](/docs/database/agent-capability#options)
- [`DATABASE_NOT_FOUND`](/docs/database/diagnostics/database_not_found)
- [`DATABASE_MIXED_DEFINITIONS`](/docs/database/diagnostics/database_mixed_definitions)
