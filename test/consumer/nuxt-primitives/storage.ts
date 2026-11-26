import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { syncTables } from "../../../packages/sync/src/database.ts"
import { expectJson, type PrepareContext, type PrimitiveRow } from "./row.ts"

const placeholderD1Id = "00000000-0000-0000-0000-000000000000"
const placeholderKVId = "00000000000000000000000000000000"
const syncTablesSql = syncTables.map(statement => `${statement};`).join("\n--> statement-breakpoint\n")

export async function migrateDatabase({ mode, appDir, vitehub, wrangler }: PrepareContext) {
  if (mode === "node-build") return
  if (mode !== "cloudflare-build") return vitehub(["database", "migrate"])
  const config = JSON.parse(await readFile(join(appDir, ".output/server/wrangler.json"), "utf8")) as { d1_databases?: { binding: string }[] }
  for (const { binding } of config.d1_databases ?? []) await wrangler(["d1", "migrations", "apply", binding, "--local"])
}

interface SyncPull {
  account: string
  cursor: number
  reset: boolean
  rows: Record<string, unknown>[]
  scope: { id: string }
  version: string
}

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.text()
  if (!response.ok) throw new Error(`${response.url} answered ${response.status}: ${body.slice(0, 2000)}`)
  return JSON.parse(body) as T
}

async function waitUntilEarlyInClockMinute() {
  const second = new Date().getUTCSeconds()
  if (second > 45) await new Promise(resolve => setTimeout(resolve, (61 - second) * 1000))
}

function expectEqual(actual: unknown, expected: unknown, what: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${what}: ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
}

export const storage: PrimitiveRow[] = [
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

        export const primitiveTodos = sqliteTable("primitive_todos", {
          id: text("id").primaryKey(),
          title: text("title").notNull(),
        })

        export default defineDatabase({
          schema: {
            primitiveNotes: sqliteTable("primitive_notes", {
              id: integer("id").primaryKey({ autoIncrement: true }),
              title: text("title").notNull(),
            }),
            primitiveTodos,
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
    prepare: migrateDatabase,
    async probe({ fetch, mode }) {
      const title = `${mode}-${crypto.randomUUID()}`
      await expectJson(await fetch(`/api/primitives/database?title=${title}`, { method: "POST" }), { inserted: true })
      await expectJson(await fetch(`/api/primitives/database?title=${title}`), { titles: [title] })
    },
  },
  {
    id: "blob",
    packages: ["@vite-hub/blob"],
    vitehub: target => ({ blob: target === "cloudflare" ? { bucketName: "nuxt-primitives" } : true }),
    files: {
      "server/api/primitives/blob.ts": `
        import { defineEventHandler, getQuery } from "nitro/h3"
        import { blob } from "vite-hub/blob"

        export default defineEventHandler(async (event) => {
          const folder = \`primitives/\${String(getQuery(event).key)}/\`
          const pathname = \`\${folder}note.txt\`
          if (event.req.method === "PUT") {
            const [error, object] = await blob.put(pathname, await event.req.text(), { contentType: "text/plain" })
            if (error) throw error
            return { pathname: object.pathname, size: object.size }
          }
          if (event.req.method === "DELETE") {
            const [error] = await blob.delete(pathname)
            if (error) throw error
            return { deleted: true }
          }
          const [listError, listed] = await blob.list({ prefix: folder })
          if (listError) throw listError
          const [error, file] = await blob.get(pathname)
          if (error) throw error
          return {
            listed: listed.blobs.map(object => object.pathname),
            text: file ? await file.text() : null,
            type: file ? file.type.split(";")[0] : null,
          }
        })
      `,
    },
    async probe({ fetch, mode }) {
      const key = `${mode}-${crypto.randomUUID()}`
      const pathname = `primitives/${key}/note.txt`
      const text = `blob of ${key}`
      await expectJson(await fetch(`/api/primitives/blob?key=${key}`, { body: text, method: "PUT" }), { pathname, size: text.length })
      await expectJson(await fetch(`/api/primitives/blob?key=${key}`), { listed: [pathname], text, type: "text/plain" })
      await expectJson(await fetch(`/api/primitives/blob?key=${key}`, { method: "DELETE" }), { deleted: true })
      await expectJson(await fetch(`/api/primitives/blob?key=${key}`), { listed: [], text: null, type: null })
    },
  },
  {
    id: "cache",
    packages: [],
    vitehub: target => ({ cache: target === "cloudflare" ? { driver: "cloudflare", namespaceId: placeholderKVId } : true }),
    files: {
      "server/api/primitives/cache.ts": `
        import { defineEventHandler, getQuery } from "nitro/h3"
        import { useKV } from "nitro/kv"
        import { defineCachedFunction, invalidateTag } from "vite-hub/cache"

        const stamp = defineCachedFunction(async (key: string) => ({ key, stamp: crypto.randomUUID() }), {
          getKey: (key: string) => key,
          maxAge: 3600,
          name: "primitiveStamp",
          tags: (key: string) => [\`primitive:\${key}\`],
        })

        export default defineEventHandler(async (event) => {
          const key = String(getQuery(event).key)
          if (event.req.method === "DELETE") {
            await invalidateTag(\`primitive:\${key}\`)
            return { invalidated: true }
          }
          return { ...await stamp(key), driver: useKV().getMount("cache").driver.name }
        })
      `,
    },
    async probe({ fetch, mode }) {
      const key = `${mode}-${crypto.randomUUID()}`
      const first = await readJson<{ driver: string, key: string, stamp: string }>(await fetch(`/api/primitives/cache?key=${key}`))
      if (first.key !== key || typeof first.stamp !== "string") throw new Error(`The cached function returned ${JSON.stringify(first)}.`)
      if (mode === "cloudflare-build") expectEqual(first.driver, "cloudflare-kv-binding", "Cache driver")
      await expectJson(await fetch(`/api/primitives/cache?key=${key}`), first)
      await expectJson(await fetch(`/api/primitives/cache?key=${key}`, { method: "DELETE" }), { invalidated: true })
      const fresh = await readJson<{ key: string, stamp: string }>(await fetch(`/api/primitives/cache?key=${key}`))
      if (fresh.key !== key || fresh.stamp === first.stamp) throw new Error(`invalidateTag() kept the entry: ${JSON.stringify(fresh)}.`)
      await expectJson(await fetch(`/api/primitives/cache?key=${key}`), fresh)
    },
  },
  {
    id: "sync",
    packages: ["@vite-hub/sync", "@vite-hub/database"],
    files: {
      "server/sync/primitive-todos.ts": `
        import { defineSync } from "vite-hub/sync"
        import { primitiveTodos } from "../databases/default"

        export default defineSync({ table: primitiveTodos, where: () => ({}), write: true })
      `,
      "server/api/primitives/sync-todo.ts": `
        import { defineEventHandler, getQuery } from "nitro/h3"
        import { useDatabase } from "vite-hub/database"

        export default defineEventHandler(async (event) => {
          const { db, schema } = useDatabase()
          const query = getQuery(event)
          await db.insert(schema.primitiveTodos).values({ id: String(query.id), title: String(query.title) })
          return { inserted: true }
        })
      `,
      "server/databases/default/migrations/20261125000001_primitive_sync/migration.sql": [
        "CREATE TABLE `primitive_todos` (",
        "\t`id` text PRIMARY KEY,",
        "\t`title` text NOT NULL",
        ");",
        "--> statement-breakpoint",
        syncTablesSql,
        "",
      ].join("\n"),
    },
    async probe({ fetch, mode }) {
      const route = "/_vitehub/sync/primitive-todos"
      const pulled = await readJson<SyncPull>(await fetch(route))
      const inserted = { id: `${mode}-insert-${crypto.randomUUID()}`, title: "from the browser" }
      const mutation = { id: crypto.randomUUID(), op: "insert", value: inserted }
      const push = (body: unknown) => fetch(route, { body: JSON.stringify(body), headers: { "content-type": "application/json" }, method: "POST" })
      const base = { account: pulled.account, cursor: pulled.cursor, scope: pulled.scope.id, version: pulled.version }
      const pushed = await readJson<{ results: unknown[], pull: SyncPull }>(await push({ ...base, mutations: [mutation] }))
      expectEqual(pushed.results, [{ id: mutation.id, status: "applied" }], "push results")
      expectEqual(pushed.pull.rows.filter(row => row.id === inserted.id), [inserted], "rows of the push answer")

      const server = { id: `${mode}-server-${crypto.randomUUID()}`, title: "from server code" }
      await expectJson(await fetch(`/api/primitives/sync-todo?id=${server.id}&title=${encodeURIComponent(server.title)}`, { method: "POST" }), { inserted: true })
      const next = await readJson<SyncPull>(await fetch(`${route}?cursor=${pushed.pull.cursor}&scope=${pushed.pull.scope.id}&version=${pushed.pull.version}`))
      expectEqual({ reset: next.reset, rows: next.rows }, { reset: false, rows: [server] }, "pull after a server write")

      const retried = await readJson<{ results: unknown[] }>(await push({ ...base, cursor: next.cursor, mutations: [mutation] }))
      expectEqual(retried.results, [{ id: mutation.id, status: "duplicate" }], "results of a retried push")
    },
  },
  {
    id: "rate-limit",
    packages: ["@vite-hub/rate-limit"],
    vitehub: () => ({ rateLimit: true }),
    files: {
      "server/api/primitives/rate-limit.ts": `
        import { defineEventHandler, getQuery } from "nitro/h3"
        import { requireRateLimit } from "vite-hub/rate-limit"

        export default defineEventHandler(async (event) => {
          await requireRateLimit(event, "primitive-burst", { key: String(getQuery(event).key), limit: 2, window: "1m" })
          return { allowed: true }
        })
      `,
    },
    async probe({ fetch, mode }) {
      await waitUntilEarlyInClockMinute()
      const key = `${mode}-${crypto.randomUUID()}`
      await expectJson(await fetch(`/api/primitives/rate-limit?key=${key}`), { allowed: true })
      await expectJson(await fetch(`/api/primitives/rate-limit?key=${key}`), { allowed: true })
      const limited = await fetch(`/api/primitives/rate-limit?key=${key}`)
      if (limited.status !== 429) throw new Error(`The third request answered ${limited.status}: ${(await limited.text()).slice(0, 2000)}`)
      if (mode === "cloudflare-build") expectEqual(limited.headers.get("Retry-After"), null, "Cloudflare Rate Limit Retry-After")
      await expectJson(await fetch(`/api/primitives/rate-limit?key=${key}-other`), { allowed: true })
    },
  },
]
