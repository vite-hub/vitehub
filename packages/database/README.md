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
// server/databases/config.ts
import { defineDatabase } from "@vite-hub/database"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

export default defineDatabase({
  tables: {
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

## Vite and Nitro

Use `server/databases/config.ts` for the default database, or `server/databases/<name>/config.ts` for named databases. Vite discovers those files, writes generated Drizzle artifacts, and lets Nitro handlers import `@vite-hub/database/drizzle`.

Built on [Drizzle ORM](https://orm.drizzle.team/), [Drizzle Kit](https://orm.drizzle.team/docs/kit-overview), [libSQL](https://www.npmjs.com/package/%40libsql/client), and Cloudflare [D1](https://developers.cloudflare.com/d1/) bindings when deployed to Cloudflare.

Learn more at [vitehub.dev](https://vitehub.dev).
