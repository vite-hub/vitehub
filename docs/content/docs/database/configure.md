---
title: Database configuration
description: Set Database integration options and define Default and Named Databases.
navigation.title: Configure
navigation.order: 3
icon: i-lucide-sliders-horizontal
---

## Configure the Vite Integration

`hubDb()` accepts the integration options below. You can also set them under the `database` key in `vite.config.ts`. That key takes precedence over the options passed to `hubDb()`.

```ts [vite.config.ts]
import { hubDb } from '@vite-hub/database/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [hubDb()],
  database: {
    cli: { generate: false },
  },
})
```

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `database` | `boolean` or `DBModulePublicOptions` | disabled | Enables database discovery and generated runtime imports through `vitehub()` with `true` or an options object. `false` leaves it disabled. |
| `database.projectRoot` | `string` | effective application root | Sets the root used for Database Definition discovery, generated artifacts, and provisioning. Relative paths resolve from the Vite root in a Vite app and from the Nuxt `rootDir` in a Nuxt app. |
| `database.cli.generate` | `false` | enabled | Disables the package-owned `db generate` command. |
| `database.cli.migrate` | `false` | enabled | Disables the package-owned `db migrate` command. |
| `database.connection` | `DatabaseConnectionConfig` | local SQLite | Supplies a hosted libSQL connection for Database Definitions that do not declare one. Definition connection values override matching integration values. |
| `database.driver` | `DatabaseRuntimeD1Options['driver']` | none | Selects Cloudflare D1 runtime output at integration level. Value: `d1`. |
| `database.binding` | `string` | `DB` | Integration D1 binding used by the Default Database. Named Databases infer their own binding names. |
| `database.databaseId` | `DatabaseConfigValue` | Provision State | Cloudflare D1 database id. |
| `database.previewDatabaseId` | `DatabaseConfigValue` | none | Cloudflare D1 preview database id. |
| `database.databaseName` | `DatabaseConfigValue` | none | Cloudflare D1 database name. |
| `database.migrationsTable` | `string` | provider default | Cloudflare D1 migrations table. |

With `vitehub()`, a discovered Database Definition does not enable Database. Without the `database` option, a build or `vite dev` that imports `vite-hub/database/drizzle` fails with `VITE_HUB_B0013`, and `vitehub db generate` and `vitehub db migrate` exit with an error. Add `database: true` or an options object to enable them. A directly composed `hubDb()` also provides Database.

## Define a database

A Database Definition keeps the Database Table Schema next to the server code that uses it. ViteHub discovers Definitions from these files:

| File | Database |
| --- | --- |
| `src/database.ts` or `server/databases/config.ts` | Default Database, addressed as `default`. |
| `src/<name>.database.ts` or `server/databases/<name>/config.ts` | Named Database, addressed as `<name>`. The Definition must set `name: '<name>'`. |

A project uses either one Default Database or a set of Named Databases. Mixing both modes, or declaring two Default Databases, fails discovery.

```ts [src/database.ts]
import { defineDatabase } from '@vite-hub/database'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export default defineDatabase({
  schema: {
    notes: sqliteTable('notes', {
      id: integer('id').primaryKey(),
      title: text('title').notNull(),
      body: text('body').notNull(),
    }),
  },
})
```

`schema` does not have to be an object literal. You can pass an imported schema object, a namespace import such as `import * as schema from './schema'`, or a spread that combines several schemas. Each time ViteHub writes generated artifacts, it loads the Definition and exports every Drizzle table and view in the evaluated schema, so `vitehub db generate` writes migrations for all of them. A schema key cannot be `schema` or `default`, because the generated schema module already uses those export names.

ViteHub loads the Definition with your Vite or Nuxt string aliases. If the Definition still cannot load, for example because it imports a module that only a Vite plugin provides, `vite dev` and builds print a warning and fall back to the keys of a literal `schema: { ... }` object. `vitehub db generate` fails in that case, so a migration never silently omits a table.

## Contribute tables from a package

A package can add Drizzle tables to an application's Database from its own Vite plugin, so the application does not edit its Definition. Add `vitehub.databases` to the plugin object. Each entry names a module and an export that hold an object of tables:

```ts [my-package/vite.ts]
import type { Plugin } from 'vite'
import type { DatabaseContributingPlugin } from '@vite-hub/database/vite'

export function myPackage(): Plugin & DatabaseContributingPlugin {
  return {
    name: 'my-package/vite',
    vitehub: {
      databases: () => [{ module: 'my-package/schema', export: 'historySchema' }],
    },
  }
}
```

```ts [my-package/schema.ts]
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const historySchema = {
  historyRefs: sqliteTable('history_refs', { workspace: text('workspace').primaryKey(), head: text('head') }),
  historyRevisions: sqliteTable('history_revisions', { id: integer('id').primaryKey() }),
}
```

| Field | Type | Description |
| --- | --- | --- |
| `database` | `string` | Database that receives the tables. Omit it to target the default or only Database. |
| `module` | `string` | Absolute file path, or a package specifier that the application can import. Relative paths are rejected. |
| `export` | `string` | Export that holds the object of tables. Defaults to `default`. |

`vitehub.databases` accepts an array or a factory. The factory receives `{ rootDir, serverDirs }`, the roots that Database Definitions are discovered from, and can be async. It runs once per discovery pass and must return the same result each time.

Contributed tables join the target Database everywhere the Definition schema goes:

- The generated Drizzle schema exports each contributed table, so `vitehub db generate` writes their migrations.
- `useDatabase(name).schema`, `db.query`, and the generated `DatabaseRegistry` types include them, in Vite, Nuxt, Nitro, and provider output.
- `vitehub inspect definitions` and the Console Database section list them in a `Contributed tables` field with the contributing plugin.

The Definition object that you import from its file keeps only its own `schema`. Read contributed tables from `useDatabase(name).schema` or import them from their package.

A contribution without `database` targets the Database named `default`, or the only Database when there is one. `resolveDefaultDatabase(names)` from `@vite-hub/database/config` applies the same rule, so a package can pick the same Database for its own runtime code. The Console uses it to choose its D1 journal.

### Contribute a Database

When the application has no Database a package can use, the package can add a whole Database Definition. Write the Definition module, for example under `.vitehub/`, and return `{ name, definition, reason? }` from `vitehub.databases`, next to its tables:

```ts [my-package/vite.ts]
import { discoverDatabaseDefinitions } from '@vite-hub/database/config'

// In the plugin object:
vitehub: {
  databases: async ({ rootDir }) => {
    const names = discoverDatabaseDefinitions(rootDir).map(definition => definition.name)
    if (names.length) return [{ module: 'my-package/schema', export: 'historySchema' }]
    const definition = await writeDefinition(rootDir) // export default defineDatabase({ schema: {} })
    return [
      { name: 'default', definition, reason: 'my-package stores its history here because the app has no Database.' },
      { database: 'default', module: 'my-package/schema', export: 'historySchema' },
    ]
  },
},
```

| Field | Type | Description |
| --- | --- | --- |
| `name` | `string` | Database name. The application must not define a Database with this name. |
| `definition` | `string` | Absolute path of a module whose default export is `defineDatabase({ schema })` with the same `name`. |
| `reason` | `string` | Why the package adds the Database. `vitehub inspect` shows it. |

A contributed Database works like one in `server/databases/`: `vitehub db generate` and `db migrate`, the runtime registry, `vitehub provision`, and `vitehub inspect definitions` include it. Inspection lists its `Contributed by`, `Reason`, and `Migrations` fields. Its migrations go where an application Definition with the same name keeps them, `server/databases/migrations/` for `default` and `server/databases/<name>/migrations/` otherwise, so adding that Definition later keeps the migration history. The [Content CMS preset](/docs/content/cms-preset) uses this to add the `default` Database.

### Contribution errors

| Code | Cause |
| --- | --- |
| `DATABASE_B0010` | A contributed table uses the key or SQL table name of an application table or another contribution. If the Definition already lists the contributed tables, remove them from its schema. |
| `DATABASE_B0011` | The target Database does not exist, the app has no Database, or `database` is omitted while several Named Databases exist and none is named `default`. The message lists the Database names to choose from. |
| `DATABASE_B0012` | The contribution is not `{ database?, module, export? }` or `{ name, definition, reason? }`, its `module` is relative, its `definition` is not an absolute path to an existing file, or its export is missing or is not an object of tables. |
| `DATABASE_B0013` | Two plugins contribute different Definitions with one Database name, or the application already defines the contributed Database. |
| `DATABASE_B0007` | The contributed module cannot load. `vitehub db generate` fails. `vite dev` and builds print a warning and keep the tables in the runtime schema, without drizzle-kit exports. |

`collectDatabaseContributions(plugins, context)` from `@vite-hub/database/vite` returns the validated `{ definitions, tables }`, and `resolveDatabaseContributionTargets(names, tables)` returns the target of each table contribution, for other build steps.

## Database Definition options

`defineDatabase()` accepts one object.

| Option | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | `string` | Named Databases only | Runtime identity. Must match the discovered file or directory name. |
| `schema` | `Record<string, Drizzle table>` | Yes | Database Table Schema source of truth. Packages can [contribute more tables](#contribute-tables-from-a-package). |
| `connection.url` | `DatabaseConfigValue` | No | SQLite or libSQL connection URL. Defaults to `file:.vitehub/data/database/sqlite.db` for a Default Database and `file:.vitehub/data/database/<name>.sqlite.db` for a Named Database. |
| `connection.authToken` | `DatabaseConfigValue` | No | Hosted database auth token. |
| `cloudflare.binding` | `string` | No | D1 binding. Defaults to `DB` for a Default Database and `DB_<NAME>` for a Named Database. |
| `cloudflare.databaseId` | `DatabaseConfigValue` | No | D1 database id. |
| `cloudflare.http` | `true \| { url?, authToken? }` | No | Selects authenticated D1 raw HTTP access for local and hosted runtimes. `true` uses Cloudflare's API. An object selects a compatible proxy. |
| `cloudflare.previewDatabaseId` | `DatabaseConfigValue` | No | D1 preview database id. |
| `cloudflare.databaseName` | `DatabaseConfigValue` | No | D1 database name. |
| `cloudflare.migrationsTable` | `string` | No | D1 migrations table. |
| `drizzle.casing` | `DrizzleCasing` | No | Drizzle casing option. Values: `snake_case`, `camelCase`. |

A Definition inherits the integration resource when it omits both `cloudflare.databaseId` and `cloudflare.databaseName`. Setting either selects its own resource, so it inherits no integration database ID, name, or preview ID. Other D1 settings still inherit their defaults. HTTP proxy URLs and tokens inherit by field. Both must be available after inheritance for HTTP access to work.

Owned native resources need a nonblank database ID and name at build time. For native D1 provider output, use a Cloudflare block that ViteHub can read as a literal. An identifier, top-level spread, or other opaque resource expression fails the provider build when no D1 HTTP or remote libSQL connection is known, even if the evaluated block would inherit the integration resource. A known HTTP or libSQL connection keeps opaque Definitions supported.

Keep an explicit `cloudflare` property when its value is opaque. For a wholly hidden Definition, declare D1 intent with `hubDb({ driver: 'd1' })` in Vite or set `database.driver` to `'d1'` in Nuxt. Without that intent, ViteHub does not project native D1 output. Opaque local SQLite Definitions remain supported.

A Named Definition without an explicit `cloudflare.binding` uses its per-name binding. A Default Definition without an explicit binding keeps the integration binding. Named Definitions can inherit the integration resource through different binding names. Generated native D1 binding names must be unique, including bindings for identical resources. Set distinct binding values when explicit bindings or normalized names collide.

An opaque Definition that selects its own resource uses HTTP or libSQL access. Native bindings are not used, even when the Definition supplies the integration binding name.

Direct Vite and Nuxt output retain provisioned IDs as fallbacks for unset runtime Env values. Runtime values take precedence. Opaque Definitions that select their own resource do not receive integration provision IDs. Provision state is read from the Vite root even when `projectRoot` sets another root for Definitions and generated files.

ViteHub currently exposes `sqlite` as the only public `DatabaseDialect`.
