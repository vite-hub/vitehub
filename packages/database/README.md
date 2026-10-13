# @vite-hub/database

<p>
  <a href="https://vitehub.dev"><img alt="ViteHub" src="https://img.shields.io/badge/ViteHub-vitehub.dev-646cff?style=flat-square"></a>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-ready-3178c6?style=flat-square">
  <img alt="Drizzle" src="https://img.shields.io/badge/Drizzle-schema-16a34a?style=flat-square">
  <img alt="Vite" src="https://img.shields.io/badge/Vite-discovery-646cff?style=flat-square">
</p>

`@vite-hub/database` turns a colocated Drizzle schema into a generated `useDatabase()` lookup for server code.

## Install

```sh
pnpm add @vite-hub/database drizzle-orm
pnpm add -D drizzle-kit
```

## Minimal API

```ts
// src/database.ts
import { defineDatabase } from "@vite-hub/database"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

export default defineDatabase({
  schema: {
    notes: sqliteTable("notes", {
      id: integer("id").primaryKey({ autoIncrement: true }),
      title: text("title").notNull(),
    }),
  },
})
```

```ts
// server/api/notes.get.ts
import { useDatabase } from "@vite-hub/database/drizzle"
import { defineEventHandler } from "h3"

export default defineEventHandler(() => {
  const { db, schema } = useDatabase("default")
  return db.select().from(schema.notes)
})
```

```ts
// vite.config.ts
import { hubDb } from "@vite-hub/database/vite"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [hubDb()],
})
```

## Vite Integration

Database instances expose Drizzle's `batch()` method on D1, D1 HTTP, and libSQL.
The batch executes atomically. Use conditional statements in a batch when a
change must compare and update shared state without an interactive transaction.

```ts
await db.batch([
  db.insert(schema.notes).values({ title: "First note" }),
  db.insert(schema.notes).values({ title: "Second note" }),
])
```

Use `src/database.ts` or `server/databases/config.ts` for one default database. Use `src/<name>.database.ts` or `server/databases/<name>/config.ts` with the same `name` option when every database is named. Vite discovers those files, writes generated Drizzle artifacts, and lets server handlers import `@vite-hub/database/drizzle`. A project cannot mix a default Database Definition with Named Database Definitions.

`@vite-hub/database/drizzle` is resolved by the Vite integration for server code and provider output. Plain `node` execution of files that import it is not a supported local runtime path.

Application code calls `useDatabase()` with the discovered name. Use `default` for a Default Database.

When the Nitro Vite plugin builds with a Cloudflare preset, the Vite integration merges each resolved D1 binding into `nitro.cloudflare.wrangler.d1_databases` and copies the Definition's migration SQL to `.output/server/.vitehub/database/migrations/<binding>`. A Definition's binding replaces a Nitro binding with the same name.

Production Nuxt builds with only D1-over-HTTP Databases do not bundle libSQL or its native libraries. Local SQLite development and projects with libSQL connections keep their existing drivers.

## Remote D1 development

Set `cloudflare.http` on a Database Definition to query remote D1 during local development. `true` uses Cloudflare's API with `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`; an object selects an authenticated D1-compatible proxy.

```ts
export default defineDatabase({
  cloudflare: {
    databaseId: process.env.CLOUDFLARE_D1_DATABASE_ID,
    http: true,
  },
  schema,
})
```

Remote access is explicit. Local development uses SQLite when neither the Definition nor its integration configures `cloudflare.http`. Cloudflare output prefers a matching D1 binding.

A Definition inherits the integration resource when it omits both `databaseId` and `databaseName`. Setting either selects its own resource, so it inherits no integration database ID, name, or preview ID. Other D1 settings still inherit their defaults. HTTP proxy URLs and tokens inherit by field. Both must be available after inheritance for HTTP access to work.

A literal resource field that reads an Env value remains owned when that value is absent. It can use its own provisioned ID, but it does not fall back to the integration resource.

Native D1 output requires a Cloudflare block that ViteHub can read as a literal. An identifier, top-level spread, or other opaque resource expression fails the provider build when no D1 HTTP or remote libSQL connection is known. This rule also applies when the evaluated block would inherit the integration resource. Use a literal block for native output, or configure HTTP or libSQL access.

Keep an explicit `cloudflare` property in the Definition when its value is opaque. If the whole Definition hides that property in an identifier or spread, set `hubDb({ driver: 'd1' })` to declare D1 intent. Without that declaration, a wholly hidden Definition does not project native D1 output. Opaque local SQLite Definitions remain supported.

An owned native resource must resolve a nonblank database ID and name at build time. Its own provisioned ID can supply the ID. Use D1 HTTP or remote libSQL access when the resource values become available only at runtime.

Named Definitions without an explicit binding use their per-name binding, such as `DB_ANALYTICS`. A default Definition retains the integration binding. Named Definitions can inherit the integration resource through different binding names. Generated native D1 bindings must have unique names, including bindings for identical resources. Set distinct `cloudflare.binding` values when explicit bindings or normalized names collide.

An opaque Definition that selects its own resource uses remote HTTP or libSQL access. It does not use a native binding, including an explicit binding that matches the integration resource.

Provisioned IDs remain fallbacks for runtime Env values in direct Vite and Nuxt output. A value supplied at runtime takes precedence. An opaque Definition that selects its own resource does not receive the integration resource's provisioned ID. Provision state is read from the Vite root even when `projectRoot` sets another root for Definitions and generated files.

When a libSQL connection URL or auth token changes at runtime, the next database
access creates a client with the new credentials and closes the previous client.
Credential refresh is therefore a lifecycle boundary: await outstanding database
work before changing the credential, because libSQL closes can abort operations
that are still in flight.

## Nuxt D1 host wiring

Nuxt apps can declare one D1 database resource and let the Database Nuxt bridge wire framework consumers and Cloudflare output.

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ["@vite-hub/database/nuxt", "@nuxt/content"],
  database: {
    driver: "d1",
    databaseName: "app-content",
  },
})
```

Run `vitehub provision run --provider cloudflare` once to create or resolve the database and write its non-secret id to `.vitehub/provision.json`. The bridge reads that state, configures Nuxt Content, merges the D1 binding into `nitro.cloudflare.wrangler.d1_databases`, and stages discovered migrations. Set `databaseId` explicitly when the build cannot access provision state; a complete matching binding already present in Nitro Wrangler config is also preserved.

A Definition that owns a different D1 resource must use a binding that differs from the Nuxt host's `database.binding`. Nuxt rejects native bindings that would point Content and the Definition at different resources through the same binding. One Definition with statically fixed database ID and name values that match the host can share that binding. Generated binding names must remain distinct between Definitions. Env declarations require a distinct binding, including declarations with a provisioned default.

Built on [Drizzle ORM](https://orm.drizzle.team/), [Drizzle Kit](https://orm.drizzle.team/docs/kit-overview), [libSQL](https://www.npmjs.com/package/%40libsql/client), and Cloudflare [D1](https://developers.cloudflare.com/d1/) bindings when deployed to Cloudflare.

Learn more at [vitehub.dev](https://vitehub.dev).
