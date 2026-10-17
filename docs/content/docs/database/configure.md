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

An enabled Vite Database without a Definition is one empty Default Database. It works like `server/databases/config.ts` with `defineDatabase({ schema: {} })`: it uses `database.connection`, keeps migrations in `server/databases/migrations`, receives contributed tables, and is listed by `vitehub inspect` and the Console. Connections use it for their tables. The Nuxt module does not add it.

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

## Tables from Nuxt layers

In a Nuxt application, ViteHub also discovers Database Definitions in the server
directory of each layer. Definitions with the same name join one database. The
database has the tables of all of them, and `vitehub db generate` writes one set
of migrations for it.

```ts [layers/blog/server/databases/config.ts]
import { defineDatabase } from '@vite-hub/database'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export default defineDatabase({
  schema: {
    posts: sqliteTable('posts', {
      id: integer('id').primaryKey(),
      title: text('title').notNull(),
    }),
  },
})
```

These rules apply:

- `connection`, `cloudflare`, and `drizzle` come from one Definition. When the application Definition sets one of them, it replaces all layer options, so it must also set each option that a layer sets. The application and each layer that sets options must then pass an object literal to `defineDatabase()`, so that ViteHub can read their options. Otherwise one layer can set them. Two layers that set them fail discovery until the application sets them.
- An application table replaces a layer table with the same key. Use this to add columns to a layer table. Two layers that declare the same table key fail discovery.
- Migrations go to the application, in `server/databases/migrations` or `server/databases/<name>/migrations`, also when only layers define the database.
- A project still uses either one Default Database or Named Databases. A layer with a Default Database and another layer with Named Databases fail discovery.

ViteHub finds duplicate table keys when `schema` is an object literal. Query the merged database with `useDatabase()` or the `db` server auto-import. A layer that queries its own `defineDatabase()` object directly sees only its own tables.

## Contribute tables from a package

A package can add Drizzle tables to an application's Database from its own Vite plugin, so the application does not edit its Definition. Add `vitehub.databases` to the plugin object. Each entry has a `name` and a `definition` that names the module and export of an object of tables:

```ts [my-package/vite.ts]
import type { Plugin } from 'vite'
import type { DatabaseContributingPlugin } from '@vite-hub/database/vite'

export function myPackage(): Plugin & DatabaseContributingPlugin {
  return {
    name: 'my-package/vite',
    vitehub: {
      databases: () => [{
        name: 'history',
        definition: { module: 'my-package/schema', export: 'historySchema' },
        reason: 'Stores Workspace history.',
      }],
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
| `name` | `string` | Name of this group of tables. Each name has one contribution. Inspection and errors show it. |
| `definition.module` | `string` | Absolute file path, `file:` URL, or package specifier that the application can import. Relative paths are rejected. |
| `definition.export` | `string` | Export that holds the object of tables. Defaults to `default`. |
| `reason` | `string` | Optional. Why the package adds the tables. `vitehub inspect definitions` and the Console show it. |
| `database` | `string` | Optional. Database that receives the tables. Omit it to target the default or only Database. |
| `dialect` | `'sqlite' \| 'postgresql'` | Optional. SQL dialect of the tables. When set, the build fails if the target Database uses another dialect. |

`vitehub.databases` accepts an array or a factory. The factory receives `{ root, projectRoot, serverDirs }`, where `root` is the Vite root, and can be async. It runs once per discovery pass and must return the same result each time. ViteHub sorts contributions by name.

### Contribute tables from a Nuxt module

A Nuxt module uses the same contribution. Add the plugin to `nuxt.options.vite.plugins` during module setup:

```ts [my-module/module.ts]
import { defineNuxtModule } from '@nuxt/kit'
import { myPackage } from 'my-package/vite'

export default defineNuxtModule({
  setup(_options, nuxt) {
    nuxt.options.vite.plugins ||= []
    nuxt.options.vite.plugins.push(myPackage())
  },
})
```

The Database module reads the contributions after every module has run setup, so the module order does not matter. Do not use `addVitePlugin()` for a contribution. It adds the plugin when Vite starts, after Nitro has built its Database runtime.

Contributed tables join the target Database everywhere the Definition schema goes:

- The generated Drizzle schema exports each contributed table, so `vitehub db generate` writes their migrations.
- `useDatabase(name).schema`, `db.query`, and the generated `DatabaseRegistry` types include them, in Vite, Nuxt, and Nitro.
- `vitehub inspect definitions` and the Console Database section list them in a `Contributed tables` field with the contributing plugin.

The Definition object that you import from its file keeps only its own `schema`. Read contributed tables from `useDatabase(name).schema` or import them from their package.

A contribution without `database` targets the Database named `default`, or the only Database when there is one. `resolveDefaultDatabase(names)` from `@vite-hub/database/config` applies the same rule, so a package can pick the same Database for its own runtime code. The Console uses it to choose its D1 journal.

### Contribution errors

| Code | Cause |
| --- | --- |
| `DATABASE_B0010` | Two plugins contribute tables with one `name`, or a contributed table uses the key or SQL table name of an application table or another contribution. The message names both sources. If the Definition already lists the contributed tables, remove them from its schema. |
| `DATABASE_B0011` | The target Database does not exist, the app has no Database, `database` is omitted while several Named Databases exist and none is named `default`, or `dialect` does not match the target Database. The message lists the Database names to choose from. |
| `DATABASE_B0012` | The contribution is not `{ name, definition: { module, export? }, reason?, database?, dialect? }`, its `definition.module` is relative, or its export is missing or is not an object of tables. |
| `DATABASE_B0007` | The contributed module cannot load. `vitehub db generate` fails. `vite dev` and builds print a warning and keep the tables in the runtime schema, without drizzle-kit exports. |

`collectDatabaseContributions(plugins, context)` and `resolveDatabaseContributionTargets(names, contributions)` from `@vite-hub/database/vite` return the validated contributions and their targets for other build steps.

## Database Definition options

`defineDatabase()` accepts one object.

| Option | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | `string` | Named Databases only | Runtime identity. Must match the discovered file or directory name. |
| `dialect` | `'sqlite' \| 'postgresql'` | No | Database dialect. Defaults to `sqlite`. Write it as a string literal. See [Define a Postgres database](#define-a-postgres-database) for the `postgresql` options. |
| `schema` | `Record<string, Drizzle table>` | Yes | Database Table Schema source of truth. Packages can [contribute more tables](#contribute-tables-from-a-package). |
| `connection.url` | `DatabaseConfigValue` | No | SQLite or libSQL connection URL. Defaults to `file:.vitehub/data/database/sqlite.db` for a Default Database and `file:.vitehub/data/database/<name>.sqlite.db` for a Named Database. |
| `connection.authToken` | `DatabaseConfigValue` | No | Hosted database auth token. |
| `cloudflare.binding` | `string` | No | D1 binding. Defaults to `DB` for a Default Database and `DB_<NAME>` for a Named Database. |
| `cloudflare.databaseId` | `DatabaseConfigValue` | No | D1 database id. |
| `cloudflare.http` | `true \| { url?, authToken? }` | No | Selects authenticated D1 raw HTTP access for local and hosted runtimes. `true` uses Cloudflare's API. An object selects a compatible proxy. |
| `cloudflare.previewDatabaseId` | `DatabaseConfigValue` | No | D1 preview database id. |
| `cloudflare.databaseName` | `DatabaseConfigValue` | No | D1 database name. |
| `cloudflare.migrationsTable` | `string` | No | D1 migrations table. |
| `drizzle.casing` | `DrizzleCasing` | No | Drizzle casing option. Values: `snake_case`, `camelCase`. Applies to queries and to migrations from `vitehub db generate`. |

A Definition inherits the integration resource when it omits both `cloudflare.databaseId` and `cloudflare.databaseName`. Setting either selects its own resource, so it inherits no integration database ID, name, or preview ID. Other D1 settings still inherit their defaults. HTTP proxy URLs and tokens inherit by field. Both must be available after inheritance for HTTP access to work.

Owned native resources need a nonblank database ID and name at build time. For a native D1 binding, use a Cloudflare block that ViteHub can read as a literal. An identifier, top-level spread, or other opaque resource expression fails the Cloudflare build when no D1 HTTP or remote libSQL connection is known, even if the evaluated block would inherit the integration resource. A known HTTP or libSQL connection keeps opaque Definitions supported.

Keep an explicit `cloudflare` property when its value is opaque. For a wholly hidden Definition, declare D1 intent with `hubDb({ driver: 'd1' })` in Vite or set `database.driver` to `'d1'` in Nuxt. Without that intent, ViteHub does not project native D1 output. Opaque local SQLite Definitions remain supported.

A Named Definition without an explicit `cloudflare.binding` uses its per-name binding. A Default Definition without an explicit binding keeps the integration binding. Named Definitions can inherit the integration resource through different binding names. Generated native D1 binding names must be unique, including bindings for identical resources. Set distinct binding values when explicit bindings or normalized names collide.

An opaque Definition that selects its own resource uses HTTP or libSQL access. Native bindings are not used, even when the Definition supplies the integration binding name.

Direct Vite and Nuxt output retain provisioned IDs as fallbacks for unset runtime Env values. Runtime values take precedence. Opaque Definitions that select their own resource do not receive integration provision IDs. Provision state is read from the Vite root even when `projectRoot` sets another root for Definitions and generated files.

## Define a Postgres database

Set `dialect: 'postgresql'` and declare the tables with `drizzle-orm/pg-core`. Install the [`postgres`](https://github.com/porsager/postgres) driver in the app.

```bash
pnpm add postgres
```

```ts [server/databases/config.ts]
import { defineDatabase } from '@vite-hub/database'
import { pgTable, serial, text } from 'drizzle-orm/pg-core'

export default defineDatabase({
  dialect: 'postgresql',
  cloudflare: { hyperdriveId: process.env.CLOUDFLARE_HYPERDRIVE_ID },
  connection: { url: process.env.DATABASE_URL },
  schema: {
    notes: pgTable('notes', {
      id: serial('id').primaryKey(),
      title: text('title').notNull(),
    }),
  },
})
```

| Option | Type | Required | Description |
| --- | --- | --- | --- |
| `connection.url` | `DatabaseConfigValue` | No | Postgres connection URL. Node, Vercel, local development, and `vitehub db migrate` use it. |
| `cloudflare.binding` | `string` | No | Cloudflare Hyperdrive binding. Defaults to `HYPERDRIVE` for a Default Database and `HYPERDRIVE_<NAME>` for a Named Database. |
| `cloudflare.hyperdriveId` | `DatabaseConfigValue` | No | Hyperdrive configuration id. When it resolves at build time, ViteHub adds the binding to the generated Wrangler config. |
| `drizzle.casing` | `DrizzleCasing` | No | Drizzle casing option. |

A Postgres Definition owns its connection. It does not use the integration `connection`, the D1 options, or the local SQLite default. When the Hyperdrive binding is present at runtime, ViteHub uses its connection string. Otherwise it uses `connection.url`. A query fails with `DATABASE_R0017` when neither is available.

`defineDatabase()` returns the Definition for a Postgres database. Query it with `useDatabase()`. See [Hosts](/docs/database/hosts#use-postgres) for how ViteHub creates clients on each host.
