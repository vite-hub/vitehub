# @vite-hub/database

<p>
  <a href="https://vitehub.dev"><img alt="ViteHub" src="https://img.shields.io/badge/ViteHub-vitehub.dev-646cff?style=flat-square"></a>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-ready-3178c6?style=flat-square">
  <img alt="Drizzle" src="https://img.shields.io/badge/Drizzle-schema-16a34a?style=flat-square">
  <img alt="Vite" src="https://img.shields.io/badge/Vite-discovery-646cff?style=flat-square">
</p>

`@vite-hub/database` turns a colocated Drizzle schema into generated `db` and `schema` imports for server code.

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
import { db, schema } from "@vite-hub/database/drizzle"
import { defineEventHandler } from "h3"

export default defineEventHandler(() => {
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

Use `src/database.ts` or `server/databases/config.ts` for one default database. Use `src/<name>.database.ts` or `server/databases/<name>/config.ts` with the same `name` option when every database is named. Vite discovers those files, writes generated Drizzle artifacts, and lets server handlers import `@vite-hub/database/drizzle`. A project cannot mix a default Database Definition with Named Database Definitions.

`@vite-hub/database/drizzle` is resolved by the Vite integration for server code and provider output. Plain `node` execution of files that import it is not a supported local runtime path.

`defineDatabase()` also returns the typed Drizzle database, so application code can import a definition directly and query it without another runtime factory.

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

Remote access is explicit. Omitting `cloudflare.http` keeps the local SQLite default, and a Cloudflare deployment still prefers its D1 binding.

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

Run `vitehub provision run --provider cloudflare` once to create or resolve the database and write its non-secret id to `.vitehub/provision.json`. The bridge reads that state, configures Nuxt Content, merges the D1 binding into `nitro.cloudflare.wrangler.d1_databases`, and stages discovered migrations. Set `databaseId` explicitly only when the build cannot access provision state.

Built on [Drizzle ORM](https://orm.drizzle.team/), [Drizzle Kit](https://orm.drizzle.team/docs/kit-overview), [libSQL](https://www.npmjs.com/package/%40libsql/client), and Cloudflare [D1](https://developers.cloudflare.com/d1/) bindings when deployed to Cloudflare.

Learn more at [vitehub.dev](https://vitehub.dev).
