import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { expectJson, pending, type PrimitiveEntry } from "./row.ts"

const placeholderD1Id = "00000000-0000-0000-0000-000000000000"

export const storage: PrimitiveEntry[] = [
  {
    id: "kv",
    packages: ["@vite-hub/kv"],
    vitehub: () => ({ kv: true }),
    files: {
      "server/api/primitives/kv.ts": `
        import { defineEventHandler, getQuery } from "nitro/h3"
        import { kv } from "vite-hub/kv"

        export default defineEventHandler(async (event) => {
          const key = \`primitives:\${String(getQuery(event).key)}\`
          if (event.req.method === "PUT") {
            const [error] = await kv.set(key, await event.req.text())
            if (error) throw error
            return { stored: true }
          }
          const [error, value] = await kv.get(key)
          if (error) throw error
          return { value: value ?? null }
        })
      `,
    },
    async probe({ fetch, mode }) {
      const key = `${mode}-${crypto.randomUUID()}`
      await expectJson(await fetch(`/api/primitives/kv?key=${key}`, { body: `value of ${key}`, method: "PUT" }), { stored: true })
      await expectJson(await fetch(`/api/primitives/kv?key=${key}`), { value: `value of ${key}` })
    },
  },
  {
    id: "database",
    packages: ["@vite-hub/database"],
    dependencies: { "drizzle-orm": "1.0.0-rc.6" },
    vitehub: target => target === "cloudflare"
      ? { database: { databaseId: placeholderD1Id, databaseName: "nuxt-primitives", driver: "cloudflare" } }
      : { database: { migrateOnStart: true } },
    files: {
      "server/databases/default.ts": `
        import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
        import { defineDatabase } from "vite-hub/database"

        export default defineDatabase({
          schema: {
            primitiveNotes: sqliteTable("primitive_notes", {
              id: integer("id").primaryKey({ autoIncrement: true }),
              title: text("title").notNull(),
            }),
          },
        })
      `,
      "server/databases/default/migrations/20261125000000_primitive_notes/migration.sql": [
        "CREATE TABLE `primitive_notes` (",
        "\t`id` integer PRIMARY KEY AUTOINCREMENT,",
        "\t`title` text NOT NULL",
        ");",
        "",
      ].join("\n"),
      "server/api/primitives/database.ts": `
        import { eq } from "drizzle-orm"
        import { defineEventHandler, getQuery } from "nitro/h3"
        import { useDatabase } from "vite-hub/database"

        export default defineEventHandler(async (event) => {
          const { db, schema } = useDatabase()
          const title = String(getQuery(event).title)
          if (event.req.method === "POST") {
            await db.insert(schema.primitiveNotes).values({ title })
            return { inserted: true }
          }
          const notes = await db.select().from(schema.primitiveNotes).where(eq(schema.primitiveNotes.title, title))
          return { titles: notes.map(note => note.title) }
        })
      `,
    },
    async prepare({ mode, appDir, vitehub, wrangler }) {
      if (mode === "node-build") return
      if (mode !== "cloudflare-build") return vitehub(["database", "migrate"])
      const config = JSON.parse(await readFile(join(appDir, ".output/server/wrangler.json"), "utf8")) as { d1_databases?: { binding: string }[] }
      for (const { binding } of config.d1_databases ?? []) await wrangler(["d1", "migrations", "apply", binding, "--local"])
    },
    async probe({ fetch, mode }) {
      const title = `${mode}-${crypto.randomUUID()}`
      await expectJson(await fetch(`/api/primitives/database?title=${title}`, { method: "POST" }), { inserted: true })
      await expectJson(await fetch(`/api/primitives/database?title=${title}`), { titles: [title] })
    },
  },
  ...pending("U5", ["blob", "cache", "sync", "rate-limit"]),
]
