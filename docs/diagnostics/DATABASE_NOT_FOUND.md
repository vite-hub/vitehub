---
description: "Fix DATABASE_NOT_FOUND in ViteHub. A database name has no Database Definition. Add the Definition or use a discovered name."
seo.title: "DATABASE_NOT_FOUND: unknown Database name"
---

ViteHub throws `DATABASE_NOT_FOUND` when you select a database by a name that has no Database Definition. `error.why` names the database. For `useDatabase()`, it also lists the discovered Database names, or `none` when the app has no Database.

## Why it happens

ViteHub discovers one Database for each Definition. A Named Database gets its name from `server/databases/<name>.ts`, `server/databases/<name>/index.ts`, or `src/<name>.database.ts`. The Default Database is `default`. The error comes from these calls:

- The Agent `db()` Capability with a `database` option. It calls `agentDb.database(name)`, which throws for an unknown name.
- `useDatabase(name)` with an unknown name, including `default` when the app has only Named Databases.
- `useDatabase()` without a name when the app has no Database. With a Default Database or one Named Database, it returns that Database. With several Named Databases and no Default Database, it throws `DATABASE_NAME_REQUIRED`.
- `vitehub database export --database <name>`. The command prints the error and exits with code 1.
- A query through the `db` export or `databases.default` when the app has only Named Databases. The Nuxt module and hosted Cloudflare and Vercel builds report this case as `DATABASE_NOT_FOUND` for `default`. Other runtimes report [`DATABASE_DISABLED`](/docs/database/diagnostics/database_disabled).

An unknown name throws from `useDatabase(name)` before a query runs.

## Fix it

```diff [server/agents/support.ts]
 export default defineAgent({
   driver: { model },
   capabilities: [
-    db({ mode: 'read', database: 'analytic' }),
+    db({ mode: 'read', database: 'analytics' }),
   ],
 })
```

Use a discovered name. If the database does not exist yet, add a Definition, for example `src/analytics.database.ts` with `defineDatabase({ name: 'analytics', schema })`. A Named Database Definition must set `name` to the same name as its file.

For the Default Database case, select the Named Database that has the tables, as `useDatabase('analytics')`.

## Check the fix

Run `vitehub inspect definitions --kind database`. It lists the discovered databases with their names and files. The name in your code must be in that list. For the export command, run `vitehub database export --database <name>` with a listed name.

## Related

- [Define a database](/docs/database/configure#define-a-database)
- [Use Named Databases](/docs/database/server-api#use-named-databases)
- [Database Capability options](/docs/database/agent-capability#options)
- [Export a Database](/docs/cli/database#export-a-database)
- [`DATABASE_DISABLED`](/docs/database/diagnostics/database_disabled)
- [`DATABASE_NAME_MISMATCH`](/docs/database/diagnostics/database_name_mismatch)
