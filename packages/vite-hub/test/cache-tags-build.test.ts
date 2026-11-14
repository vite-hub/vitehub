import { spawn, type ChildProcess } from "node:child_process"
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { createBuilder } from "vite"
import { afterAll, beforeAll, expect, it } from "vitest"

import { vitehub } from "../src/index.ts"

let root: string
let server: ChildProcess | undefined
let baseURL: string
let output = ""

async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>(done => probe.listen(0, "127.0.0.1", done))
  const address = probe.address()
  await new Promise<void>(done => probe.close(() => done()))
  if (!address || typeof address === "string") throw new TypeError("Expected a TCP address.")
  return address.port
}

async function get(path: string): Promise<{ body: string, tagHeader: string | null }> {
  const response = await fetch(`${baseURL}${path}`)
  expect(response.status, output).toBe(200)
  return { body: await response.text(), tagHeader: response.headers.get("x-vitehub-cache-tags") }
}

/** Calls a route until two calls in a row agree, so the background cache write has landed. */
async function stable(path: string): Promise<string> {
  const deadline = Date.now() + 5000
  let previous = (await get(path)).body
  for (;;) {
    const current = (await get(path)).body
    if (current === previous) return current
    if (Date.now() > deadline) throw new TypeError(`${path} did not settle: ${previous}, ${current}`)
    previous = current
  }
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "vitehub-cache-tags-build-"))
  await mkdir(join(root, "server/api/posts"), { recursive: true })
  await symlink(resolve(import.meta.dirname, "../../../node_modules"), join(root, "node_modules"), "dir")
  await writeFile(join(root, "package.json"), JSON.stringify({ private: true, type: "module" }))
  await writeFile(join(root, "server/posts.ts"), [
    'import { defineCachedFunction } from "vite-hub/cache"',
    "let runs = 0",
    "export const getPost = defineCachedFunction(async (id: string) => `post ${id} run ${++runs}`, {",
    "  getKey: (id: string) => id, maxAge: 3600, name: \"post\", tags: (id: string) => [\"posts\", `post:${id}`],",
    "})",
    "let aboutRuns = 0",
    "export const getAbout = defineCachedFunction(async () => `about run ${++aboutRuns}`, { maxAge: 3600, name: \"about\" })",
  ].join("\n"))
  await writeFile(join(root, "server/api/posts/[id].get.ts"), [
    'import { getRouterParam } from "nitro/h3"',
    'import { getPost } from "../../posts.ts"',
    'export default (event) => getPost(getRouterParam(event, "id"))',
  ].join("\n"))
  await writeFile(join(root, "server/api/about.get.ts"), 'import { getAbout } from "../posts.ts"\nexport default () => getAbout()\n')
  await writeFile(join(root, "server/api/page.get.ts"), [
    'import { defineCachedHandler } from "vite-hub/cache"',
    "let runs = 0",
    "export default defineCachedHandler(() => `page run ${++runs}`, { maxAge: 3600, tags: [\"pages\"] })",
  ].join("\n"))
  await writeFile(join(root, "server/api/invalidate.post.ts"), [
    'import { invalidateTag } from "vite-hub/cache"',
    'export default async (event) => { await invalidateTag(new URL(event.req.url).searchParams.getAll("tag")); return "ok" }',
  ].join("\n"))
  const { nitro } = (await import("nitro/vite" as string)) as { nitro: () => unknown }
  const builder = await createBuilder({
    logLevel: "silent",
    plugins: [nitro() as never, vitehub({ host: "node", cache: true })],
    root,
  })
  await builder.buildApp()

  const port = await freePort()
  baseURL = `http://127.0.0.1:${port}`
  server = spawn(process.execPath, [join(root, ".output/server/index.mjs")], {
    cwd: root,
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  })
  server.stdout?.on("data", (chunk: Buffer) => (output += chunk))
  server.stderr?.on("data", (chunk: Buffer) => (output += chunk))
  const deadline = Date.now() + 15_000
  for (;;) {
    try {
      await fetch(`${baseURL}/api/about`)
      break
    } catch (error) {
      if (Date.now() > deadline) throw error
      await new Promise(done => setTimeout(done, 100))
    }
  }
}, 180_000)

afterAll(async () => {
  server?.kill()
  if (root) await rm(root, { force: true, recursive: true, maxRetries: 3 })
})

it("runs tagged functions and handlers again after invalidateTag() in a Nitro build with the fs-lite cache", async () => {
  const about = await stable("/api/about")
  const post1 = await stable("/api/posts/1")
  const post2 = await stable("/api/posts/2")
  const page = await stable("/api/page")
  expect(page).toMatch(/^page run \d+$/)
  expect((await get("/api/page")).tagHeader).toBeNull()

  await fetch(`${baseURL}/api/invalidate?tag=post:1`, { method: "POST" })
  expect((await get("/api/posts/1")).body).not.toBe(post1)
  expect(await stable("/api/posts/2")).toBe(post2)
  // The tag record sits in the same `cache` mount as the entries: fs-lite at .vitehub/data/cache.
  expect(await readdir(join(root, ".vitehub/data/cache/tags"))).toEqual(["post%3A1"])
  expect(await stable("/api/page")).toBe(page)

  await fetch(`${baseURL}/api/invalidate?tag=pages`, { method: "POST" })
  expect((await get("/api/page")).body).not.toBe(page)
  expect(await stable("/api/about")).toBe(about)
}, 60_000)
