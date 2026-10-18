import { spawn } from "node:child_process"
import { mkdir, readdir, readFile, symlink } from "node:fs/promises"
import { createServer } from "node:net"
import { join, resolve } from "node:path"

import { createClient } from "@libsql/client"

const repositoryRoot = resolve(import.meta.dirname, "../../..")
const historyMigration = join(repositoryRoot, "packages/workspace/test/fixtures/history.sql")

/** 32 bytes as base64: a production signing key, so preview does not rely on the development fallback. */
export const contentKey = Buffer.alloc(32, 5).toString("base64")

/**
 * `server/content.ts` for a built app: a real Content runtime over a Blob + Database Workspace with retained history.
 * Blob objects live in memory; the SQLite file comes from CONTENT_FIXTURE_DATABASE.
 */
export const contentModule = `
import { createClient } from "@libsql/client"
import { drizzle } from "drizzle-orm/libsql"
import * as v from "valibot"
import { createBlobDatabaseWorkspaceStore, workspaceHistorySchema } from "@vite-hub/workspace/blob-database"
import { registerWorkspace } from "@vite-hub/workspace/test"
import { defineContent, documents } from "vite-hub/content"

const objects = new Map()
const object = (pathname, bytes) => ({ pathname, size: bytes.byteLength, contentType: "application/octet-stream", uploadedAt: new Date() })
const blob = {
  async get(pathname) { const bytes = objects.get(pathname); return [undefined, bytes ? new Blob([bytes]) : null] },
  async head(pathname) { const bytes = objects.get(pathname); return [undefined, bytes ? object(pathname, bytes) : null] },
  async put(pathname, body) { const bytes = new Uint8Array(await new Response(body).arrayBuffer()); objects.set(pathname, bytes); return [undefined, object(pathname, bytes)] },
  async del(pathnames) { for (const pathname of [pathnames].flat()) objects.delete(pathname); return [undefined, undefined] },
  async list({ prefix = "" } = {}) { return [undefined, { blobs: [...objects].filter(([key]) => key.startsWith(prefix)).map(([key, bytes]) => object(key, bytes)), hasMore: false }] },
}
const database = drizzle(createClient({ url: "file:" + process.env.CONTENT_FIXTURE_DATABASE }), { schema: workspaceHistorySchema })
registerWorkspace("site", { store: createBlobDatabaseWorkspaceStore({ blob, database, workspace: "site" }) })

export const content = defineContent({
  workspace: "site",
  collections: { posts: documents({ path: "posts/**/*.md", fields: { title: v.string() } }) },
  logger: false,
})
`

/**
 * Server routes, as `[path, source]`, relative to the server directory. `handler` wraps each handler expression:
 * Nitro 3 takes a plain function, and Nuxt's Nitro 2 takes `defineEventHandler()`.
 */
export function contentRoutes(contentImport: string, handler = (code: string) => code): Array<[string, string]> {
  const page = (delay: number) => `
import { content } from ${JSON.stringify(contentImport)}

let renders = 0
export default ${handler(`async () => {
  ${delay ? `await new Promise(resolve => setTimeout(resolve, ${delay}))` : ""}
  const post = await content.collection("posts").get("hello")
  return { title: post?.data.title, render: ++renders }
}`)}
`
  return [
    ["routes/page.ts", page(0)],
    ["routes/slow.ts", page(300)],
    ["routes/seed.post.ts", `
import { content } from ${JSON.stringify(contentImport)}

export default ${handler(`async () => {
  const posts = content.collection("posts")
  await posts.save("hello", { data: { title: "Published" }, body: "# Hello" })
  await content.publish()
  await posts.save("hello", { data: { title: "Draft" }, body: "# Hello" })
  return { ok: true }
}`)}
`],
    ["routes/preview.post.ts", `
import { content } from ${JSON.stringify(contentImport)}

export default ${handler(`async event => await content.preview.enable(event)`)}
`],
  ]
}

/** Route rules that cache the content pages for a minute, served stale while revalidating. */
export const cachedRouteRules = { "/page": { swr: 60 }, "/slow": { swr: 60 } }

/** Link the packages a fixture app needs: the repository's root packages, the libSQL client, and `extra` packages. */
export async function linkFixtureModules(root: string, extra: Record<string, string> = {}): Promise<void> {
  const modules = join(root, "node_modules")
  await mkdir(modules, { recursive: true })
  const rootModules = join(repositoryRoot, "node_modules")
  for (const entry of await readdir(rootModules)) {
    if (entry === ".bin" || entry === ".pnpm" || entry.startsWith(".")) continue
    await symlink(join(rootModules, entry), join(modules, entry), "dir")
  }
  await mkdir(join(modules, "@libsql"))
  await symlink(join(repositoryRoot, "packages/vite-hub/node_modules/@libsql/client"), join(modules, "@libsql/client"), "dir")
  for (const [name, path] of Object.entries(extra)) await symlink(path, join(modules, name), "dir")
}

/** Create the Workspace history tables in a fresh SQLite file. */
export async function createHistoryDatabase(path: string): Promise<void> {
  const client = createClient({ url: `file:${path}` })
  try {
    await client.executeMultiple(await readFile(historyMigration, "utf8"))
  }
  finally {
    client.close()
  }
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done))
  const address = server.address()
  await new Promise<void>(done => server.close(() => done()))
  if (!address || typeof address === "string") throw new TypeError("Expected a TCP address.")
  return address.port
}

export interface BuiltServer {
  close(): void
  fetch(path: string, init?: RequestInit): Promise<Response>
}

/** Start `.output/server/index.mjs` and wait until it answers. */
export async function startBuiltServer(root: string, env: Record<string, string>): Promise<BuiltServer> {
  const port = await freePort()
  let output = ""
  const server = spawn(process.execPath, [join(root, ".output/server/index.mjs")], {
    env: { ...process.env, ...env, HOST: "127.0.0.1", NITRO_HOST: "127.0.0.1", NITRO_PORT: String(port), PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  })
  server.stdout.on("data", (chunk: Buffer) => { output += chunk.toString() })
  server.stderr.on("data", (chunk: Buffer) => { output += chunk.toString() })
  const fetchServer = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${path}`, init)
  const deadline = Date.now() + 20_000
  while (true) {
    try {
      await fetchServer("/__vitehub_fixture_ready")
      break
    }
    catch (error) {
      if (Date.now() > deadline || server.exitCode !== null) throw new Error(`Built server did not start:\n${output}`, { cause: error })
      await new Promise(done => setTimeout(done, 100))
    }
  }
  return { close: () => server.kill(), fetch: fetchServer }
}

interface PageRead {
  body: unknown
  cacheControl: string | null
  robots: string | null
}

/**
 * Seed a published and a draft title, then show that preview requests to `cache`/`swr` routes never populate the
 * cache, never receive the cached public response, and never share an in-flight render with a public request.
 */
export async function expectPreviewBypassesCache(server: BuiltServer, expect: typeof import("vitest").expect): Promise<void> {
  expect((await server.fetch("/seed", { method: "POST" })).status).toBe(200)
  const enabled = await server.fetch("/preview", { method: "POST" })
  expect(enabled.status).toBe(200)
  const cookie = enabled.headers.get("set-cookie")?.split(";", 1)[0]
  expect(cookie).toMatch(/^vitehub-content-preview=v1\./)
  const read = async (path: string, preview: boolean): Promise<PageRead> => {
    const response = await server.fetch(path, preview ? { headers: { cookie: `theme=dark; ${cookie}` } } : undefined)
    expect(response.status).toBe(200)
    return { body: await response.json(), cacheControl: response.headers.get("cache-control"), robots: response.headers.get("x-robots-tag") }
  }
  const privately = { cacheControl: "private, no-store", robots: "noindex, nofollow" }

  // (a) A preview render on a cold cache is not stored: the next public request renders the published title.
  expect(await read("/page", true)).toEqual({ body: { title: "Draft", render: 1 }, ...privately })
  const publicMiss = await read("/page", false)
  expect(publicMiss.body).toEqual({ title: "Published", render: 2 })
  expect(publicMiss.robots).toBeNull()
  expect((await read("/page", false)).body).toEqual({ title: "Published", render: 2 })

  // (b) A preview request renders the draft instead of receiving the cached public page, and leaves that entry alone.
  expect(await read("/page", true)).toEqual({ body: { title: "Draft", render: 3 }, ...privately })
  expect((await read("/page", false)).body).toEqual({ title: "Published", render: 2 })

  // A public request that arrives during a preview render of the same cold key does not join that render.
  const [preview, publicRead] = await Promise.all([
    read("/slow", true),
    new Promise<PageRead>(done => setTimeout(() => done(read("/slow", false)), 50)),
  ])
  expect(preview).toMatchObject({ body: { title: "Draft" }, ...privately })
  expect(publicRead.body).toMatchObject({ title: "Published" })
  expect((await read("/slow", false)).body).toEqual(publicRead.body)
}
