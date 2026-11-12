import { execFileSync } from "node:child_process"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { afterAll, expect, it } from "vitest"

import { runCodemod } from "../src/index.ts"
import { planWrangler } from "../src/nuxthub/wrangler.ts"
import { blobBindings, readLocalKV, serveMigratedRoute } from "./nuxthub-runtime.mjs"

const scratch = fileURLToPath(new URL("../.tmp/nuxthub-contracts/", import.meta.url))
afterAll(() => rm(scratch, { recursive: true, force: true }))

async function app(name: string, hub: string, files: Record<string, string>) {
  const directory = join(scratch, name)
  await rm(directory, { recursive: true, force: true })
  const inputs = { "nuxt.config.ts": `export default defineNuxtConfig({ modules: ['@nuxthub/core'], hub: ${hub} })\n`, ...files }
  for (const [path, content] of Object.entries(inputs)) {
    await mkdir(join(directory, path, ".."), { recursive: true })
    await writeFile(join(directory, path), content)
  }
  return directory
}

it("executes a migrated Blob serving route with bytes and a missing object", async () => {
  const file = "server/routes/object.get.js"
  const directory = await app("serve", "{ blob: true }", {
    [file]: "export default defineEventHandler(async (event) => {\n  return blob.serve(event, event.url.pathname.slice(1))\n})\n",
  })
  const run = await runCodemod("nuxthub", { cwd: directory, dryRun: true })
  const code = run.result.edits.find(edit => edit.path === file)?.after
  expect(code).toContain("blob.serve(event.req,")
  const { response, missing } = await serveMigratedRoute(code!, directory)
  expect(response.status).toBe(200)
  expect(await response.text()).toBe("hello")
  expect(missing.status).toBe(404)
  expect(run.result.followUps.filter(followUp => followUp.file === file)).toEqual([])
})

it("reports the Request and Response contracts when a Blob event cannot be identified", async () => {
  const file = "server/utils/serve.ts"
  const directory = await app("serve-unknown", "{ blob: true }", {
    [file]: "export function serve(input) { return blob.serve(input, 'x') }\n",
  })
  const run = await runCodemod("nuxthub", { cwd: directory, dryRun: true })
  expect(run.result.edits.some(edit => edit.path === file)).toBe(false)
  expect(run.result.followUps).toContainEqual({ file, line: 1, message: expect.stringMatching(/returns a Response unchanged.*Pass a Request.*event.req/) })
})

it("preserves computed Blob delete keys in statements, returns, and expressions", async () => {
  const file = "server/utils/delete.js"
  const directory = await app("computed", "{ blob: true }", {
    [file]: "export async function remove() {\n  await blob['delete']('a')\n  if (true) await blob['delete']('b')\n  return blob['delete']('c')\n}\nexport const later = () => blob['delete']('d')\n",
  })
  const run = await runCodemod("nuxthub", { cwd: directory, dryRun: true })
  const code = run.result.edits.find(edit => edit.path === file)?.after
  expect(code).not.toContain("[del]")
  expect(code?.match(/blob\['del'\]/g)).toHaveLength(4)
  const deleted: string[] = []
  const remove = new Function("blob", code!.replace("export async function", "async function").replace("export const later", "const later") + "\nreturn remove")({ del: async (key: string) => { deleted.push(key); return [null, key] } }) as () => Promise<string>
  expect(await remove()).toBe("c")
  expect(deleted).toEqual(["a", "b", "c"])
})

it.each([false, true])("matches feature bindings independently of Wrangler order (custom: %s)", async (custom) => {
  const kv = custom ? "APP_KV" : "KV"
  const cache = custom ? "PAGE_CACHE" : "CACHE"
  const blob = custom ? "UPLOADS" : "BLOB"
  const hub = custom ? `{ kv: { binding: '${kv}' }, cache: { binding: '${cache}' }, blob: { binding: '${blob}' } }` : "{ kv: true, cache: true, blob: true }"
  const directory = await app(`bindings-${custom}`, hub, {
    "wrangler.jsonc": JSON.stringify({
      kv_namespaces: [{ binding: "SESSIONS", id: "sessions" }, { binding: "CACHE", id: "other-cache" }, { binding: kv, id: "keys" }, { binding: cache, id: "pages" }].filter((entry, index) => custom || index !== 1),
      r2_buckets: [{ binding: "ARCHIVE", bucket_name: "archive" }, { binding: blob, bucket_name: "uploads", jurisdiction: "eu" }],
    }),
  })
  const run = await runCodemod("nuxthub", { cwd: directory, dryRun: true })
  const config = run.result.edits.find(edit => edit.path === "nuxt.config.ts")?.after
  expect(config).toContain(`binding: '${kv}', namespaceId: 'keys'`)
  expect(config).toContain(`binding: '${cache}', namespaceId: 'pages'`)
  expect(config).toContain(`binding: '${blob}', bucketName: 'uploads', jurisdiction: 'eu'`)
  const messages = run.result.followUps.filter(followUp => followUp.file === "wrangler.jsonc").map(followUp => followUp.message).join("\n")
  expect(messages).not.toMatch(/SESSIONS|ARCHIVE|other-cache/)
  expect(messages.split("\n")).toHaveLength(3)
  const migrated = new Function("defineNuxtConfig", config!.replace("export default", "return"))((value: unknown) => value) as { vitehub: { blob: { driver: "cloudflare-r2", binding: string, bucketName: string, jurisdiction: "eu" } } }
  expect(blobBindings(migrated.vitehub.blob)).toEqual([{ binding: blob, bucket_name: "uploads", jurisdiction: "eu" }])
})

it.each(["{ kv: true, blob: true }", "{ kv: { binding: selected }, blob: { binding: selected } }"])("leaves unrelated resources alone when there is no proven match: %s", async (hub) => {
  const directory = await app(`unmatched-${hub.length}`, hub, {
    "wrangler.json": JSON.stringify({ kv_namespaces: [{ binding: "SESSIONS", id: "sessions" }], r2_buckets: [{ binding: "ARCHIVE", bucket_name: "archive" }] }),
  })
  const run = await runCodemod("nuxthub", { cwd: directory, dryRun: true })
  const code = run.result.edits.find(edit => edit.path === "nuxt.config.ts")?.after
  expect(code).not.toMatch(/SESSIONS|ARCHIVE|sessions|archive/)
  expect(run.result.followUps.filter(followUp => followUp.file === "wrangler.json")).toEqual([])
})

it("retains R2 jurisdiction in manual replacement options too", async () => {
  const directory = await app("jurisdiction", "{ blob: true }", { "wrangler.toml": '[[r2_buckets]]\nbinding = "BLOB"\nbucket_name = "uploads"\njurisdiction = "eu"\n' })
  const result = await planWrangler(directory, "wrangler.toml", { kv: false, blob: true, cache: false }, true, { blob: "BLOB" })
  expect(result.followUps[0]?.message).toContain('bucketName: "uploads", jurisdiction: "eu"')
})

it("rewrites dynamic, type, CommonJS, and TS external references before deleting schema files", async () => {
  const directory = await app("references", "{ db: 'sqlite' }", {
    "server/utils/id.ts": "export const id = 1\n",
    "server/db/schema/users.ts": "const { id } = await import('../../utils/id')\ntype Id = typeof import('../../utils/id')\nimport util = require('../../utils/id')\nconst other = require('../../utils/id')\nexport const users = { id }\n",
    "server/utils/consumer.cts": "const schema = require('../db/schema/users')\nimport tables = require('../db/schema')\n",
  })
  const run = await runCodemod("nuxthub", { cwd: directory, dryRun: true })
  const moved = run.result.edits.find(edit => edit.path === "server/databases/default/schema/users.ts")?.after
  expect(moved?.match(/\.\.\/\.\.\/\.\.\/utils\/id/g)).toHaveLength(4)
  expect(run.result.edits.find(edit => edit.path === "server/utils/consumer.cts")?.after).toBe("const schema = require('../databases/default/schema/users')\nimport tables = require('../databases/default/schema')\n")
  expect(run.result.followUps.filter(followUp => followUp.message.includes("cannot find"))).toEqual([])
})

it("keeps all discovered schema exports when the existing index is empty", async () => {
  const directory = await app("aggregate", "{ db: 'sqlite' }", {
    "package.json": '{"type":"module"}',
    "server/db/schema/index.mjs": "export {}\n",
    "server/db/schema/users.mjs": "export const users = { name: 'users' }\n",
  })
  const run = await runCodemod("nuxthub", { cwd: directory })
  const index = run.result.edits.find(edit => edit.path === "server/databases/default/schema/index.mjs")
  expect(index?.after).toBe("export {}\n")
  const barrel = run.result.edits.find(edit => edit.path === "server/databases/default/schema.js")?.after
  expect(barrel).toContain("export * from \"./schema/index\"")
  expect(barrel).toContain("export * from \"./schema/users\"")
  // Node's ESM loader needs extensions; the generated app resolves them through Vite.
  await writeFile(join(directory, "server/databases/default/schema.js"), barrel!.replaceAll('"./schema/index"', '"./schema/index.mjs"').replaceAll('"./schema/users"', '"./schema/users.mjs"'))
  const tables = await import(pathToFileURL(join(directory, "server/databases/default/schema.js")).href)
  expect(tables.users).toEqual({ name: "users" })
  expect(run.result.followUps).toContainEqual({ file: "server/databases/default/schema.js", message: expect.stringContaining("conflicting export names") })
})

it("reports every legacy relational query including an aliased database and ownership callbacks", async () => {
  const file = "server/api/users.ts"
  const directory = await app("queries", "{ db: 'sqlite' }", {
    [file]: "import { db as database } from 'hub:db'\nexport const own = database.query.users.findMany({ where: (users, { eq }) => eq(users.ownerId, userId) })\nexport const nested = database.query.users.findFirst({ with: { posts: true } })\n",
  })
  const run = await runCodemod("nuxthub", { cwd: directory, dryRun: true })
  expect(run.result.followUps.filter(followUp => followUp.file === file).map(followUp => [followUp.line, followUp.message])).toEqual([
    [2, expect.stringMatching(/Replace callback where.*Check ownership filters/)],
    [3, expect.stringMatching(/migrate declared relations.*nested queries/)],
  ])
})

it.each(["KV", "APP_KV"])("copies a local key to the effective Cloudflare development store for %s", async (binding) => {
  const directory = await app(`kv-copy-${binding}`, `{ kv: { binding: '${binding}' } }`, {
    "wrangler.json": JSON.stringify({ kv_namespaces: [{ binding, id: "namespace" }] }),
    ".data/kv/theme": '"dark"',
  })
  const run = await runCodemod("nuxthub", { cwd: directory, dryRun: true })
  const message = run.result.followUps.find(followUp => followUp.message.startsWith("Copy the local KV data"))?.message
  expect(message).toContain("Binding-backed development")
  const command = message?.split("`")[1]
  expect(command).toBeDefined()
  execFileSync("sh", ["-c", command!], { cwd: directory })
  expect(await readLocalKV(directory, binding)).toBe('"dark"')
  expect(await readFile(join(directory, ".data/kv/theme"), "utf8")).toBe('"dark"')
})
