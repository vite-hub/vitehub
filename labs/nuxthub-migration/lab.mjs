import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { existsSync } from "node:fs"
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { homedir } from "node:os"
import { basename, dirname, extname, join, relative, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"

const root = resolve(import.meta.dirname, "../..")
// Keep consumers outside the checkout so Node cannot resolve workspace dependencies.
const work = process.env.VITEHUB_MIGRATION_LAB_DIR || join(homedir(), ".t3/worktrees", `${basename(root)}-consumers`)
const projects = join(work, "projects")
// NuxtHub selects remote stores from these variables even when local storage was intended.
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(?:TURSO_|UPSTASH_|REDIS_|KV_|S3_|AWS_|BLOB_|NUXT_HUB_|CLOUDFLARE_|CF_|VERCEL|NETLIFY|VITEHUB_HOSTING)/.test(name))),
  CI: "1",
  npm_config_offline: "true",
  NUXT_TELEMETRY_DISABLED: "1",
  WRANGLER_SEND_METRICS: "false",
}
const schema = `import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
export const users = sqliteTable("users", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
})
`
const initialSql = "CREATE TABLE users (id integer PRIMARY KEY NOT NULL, name text NOT NULL);\n"
const kvValues = { settings: { theme: "dark" }, "users:1:preferences": { locale: "en" }, "json-string": '{"enabled":true}' }

async function file(path, content) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

async function run(cwd, args, label = args.join("-")) {
  console.log(`[lab] ${relative(cwd.startsWith(root) ? root : work, cwd) || "."}: pnpm ${args.join(" ")}`)
  const child = spawn("corepack", ["pnpm", ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] })
  let output = ""
  let stdout = ""
  child.stdout.on("data", chunk => { output += chunk; stdout += chunk })
  child.stderr.on("data", chunk => { output += chunk })
  const [code] = await once(child, "exit")
  await file(join(work, "logs", `${label.replaceAll(/[^a-z0-9.-]/gi, "_")}.log`), output)
  if (code !== 0) throw new Error(`Exit ${code}: pnpm ${args.join(" ")}\n${output.slice(-14000)}`)
  return stdout
}

async function serve(project, callback) {
  const port = 4531
  const instance = randomUUID()
  const controller = new AbortController()
  const child = spawn(process.execPath, [".output/server/index.mjs"], {
    cwd: project,
    env: { ...env, HOST: "127.0.0.1", PORT: String(port), VITEHUB_LAB_INSTANCE: instance },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let output = ""
  child.stdout.on("data", chunk => { output += chunk })
  child.stderr.on("data", chunk => { output += chunk })
  const origin = `http://127.0.0.1:${port}`
  const exited = new Promise((_, reject) => {
    child.once("error", reject)
    child.once("exit", (code, signal) => reject(new Error(`Lab server exited (${code ?? signal}).\n${output}`)))
  })
  async function ready() {
    for (let attempt = 0; attempt < 200; attempt++) {
      let response
      try {
        response = await fetch(`${origin}/api/lab-instance`, { signal: controller.signal })
      }
      catch (error) {
        if (!(error instanceof TypeError && error.message === "fetch failed")) throw error
      }
      if (response) {
        assert.equal(response.status, 200)
        assert.equal((await response.json()).instance, instance, "Port 4531 belongs to another server")
        return
      }
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error(`Server did not become ready.\n${output}`)
  }
  try {
    await Promise.race([ready(), exited])
    return await Promise.race([callback(async (path, options, expectedStatus = 200) => {
      const response = await fetch(`${origin}${path}`, { ...options, signal: controller.signal })
      const body = await response.text()
      assert.equal(response.status, expectedStatus, body)
      return JSON.parse(body)
    }, origin), exited])
  }
  finally {
    controller.abort()
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM")
      await once(child, "exit")
    }
    await file(join(project, "server.log"), output)
  }
}

async function definition(project, extra = "") {
  await file(join(project, "server/databases/config.ts"), `import { defineDatabase } from "vite-hub/database"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
export default defineDatabase({
  ${extra}
  schema: {
    users: sqliteTable("users", {
      id: integer("id").primaryKey(),
      name: text("name").notNull(),
    }),
  },
})
`)
}

async function modern(project, preset = "node") {
  await file(join(project, "nuxt.config.ts"), `export default defineNuxtConfig({
  modules: ["vite-hub/nuxt"],
  vitehub: { preset: "${preset}", database: true, kv: true, blob: true },
  devtools: { enabled: false },
})
`)
  await file(join(project, "server/api/users.get.ts"), `import { useDatabase } from "vite-hub/database/drizzle"
export default defineEventHandler(async () => {
  const { db, schema } = useDatabase("default")
  return await db.select().from(schema.users)
})
`)
  await file(join(project, "server/api/settings.get.ts"), `import { kv } from "vite-hub/kv"
export default defineEventHandler(async () => {
  const values: Record<string, unknown> = {}
  for (const key of ${JSON.stringify(Object.keys(kvValues))}) {
    const [error, value] = await kv.get(key)
    if (error) throw error
    values[key] = value
  }
  return values
})
`)
  await file(join(project, "server/routes/files/[...pathname].get.ts"), `import { blob } from "vite-hub/blob"
export default defineEventHandler(async (event) => {
  const { pathname } = getRouterParams(event)
  const [error, stream] = await blob.serve(event, pathname)
  if (error?.code === "BLOB_NOT_FOUND") {
    throw createError({ statusCode: 404, statusMessage: "File not found" })
  }
  if (error) throw error
  return stream
})\n`)
  await definition(project)
}

async function setup() {
  await mkdir(join(work, "packs"), { recursive: true })
  const overrides = {}
  for (const entry of await readdir(join(root, "packages"))) {
    const directory = join(root, "packages", entry)
    if (!existsSync(join(directory, "package.json"))) continue
    const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"))
    if (manifest.private) continue
    await run(directory, ["pack", "--pack-destination", join(work, "packs")], `pack-${entry}`)
    overrides[manifest.name] = `file:${join(work, "packs", `${manifest.name.replace(/^@/, "").replaceAll("/", "-")}-${manifest.version}.tgz`)}`
  }
  await file(join(work, "pnpm-workspace.yaml"), `packages:\n  - projects/*\nblockExoticSubdeps: false\nallowBuilds:\n  esbuild: true\n  msgpackr-extract: false\noverrides:\n${Object.entries(overrides).map(([name, path]) => `  ${JSON.stringify(name)}: ${JSON.stringify(path)}`).join("\n")}\n`)
  await file(join(work, "package.json"), JSON.stringify({ name: "nuxthub-migration-lab", private: true, packageManager: "pnpm@10.34.6" }))
  for (const name of ["legacy-node", "fresh-node", "existing-node", "existing-d1"]) {
    const project = join(projects, name)
    const dependencies = { nuxt: "4.5.2", vite: "8.3.2", "drizzle-orm": "0.45.3" }
    if (name === "legacy-node") Object.assign(dependencies, { "@nuxthub/core": process.env.VITEHUB_NUXTHUB_PACKAGE || "0.10.4", "@libsql/client": "0.18.0", "drizzle-kit": "0.31.11" })
    else dependencies["vite-hub"] = overrides["vite-hub"]
    if (name === "existing-node") dependencies["drizzle-kit"] = "0.31.11"
    if (name === "existing-d1") dependencies.wrangler = "4.147.0"
    await file(join(project, "package.json"), JSON.stringify({ name, private: true, type: "module", dependencies }, null, 2))
    await file(join(project, "app/app.vue"), "<template><main>NuxtHub migration lab</main></template>\n")
    await file(join(project, "server/api/lab-instance.get.ts"), 'export default defineEventHandler(() => ({ instance: process.env.VITEHUB_LAB_INSTANCE }))\n')
    await file(join(project, "tsconfig.json"), '{"extends":"./.nuxt/tsconfig.json"}\n')
    if (name !== "legacy-node") await modern(project)
  }
  const legacy = join(projects, "legacy-node")
  await file(join(legacy, "nuxt.config.ts"), `export default defineNuxtConfig({
  modules: ["@nuxthub/core"],
  hub: { db: "sqlite", kv: true, blob: true },
  devtools: { enabled: false },
})\n`)
  await file(join(legacy, "server/db/schema.ts"), schema)
  await file(join(legacy, "server/db/migrations/sqlite/0000_users.sql"), initialSql)
  await file(join(legacy, "server/api/users.get.ts"), `import { db, schema } from "hub:db"
export default defineEventHandler(async () => await db.select().from(schema.users))\n`)
  await file(join(legacy, "server/api/settings.get.ts"), `import { kv } from "hub:kv"
export default defineEventHandler(async () => Object.fromEntries(await Promise.all(
  ${JSON.stringify(Object.keys(kvValues))}.map(async key => [key, await kv.get(key)]),
)))\n`)
  await file(join(legacy, "server/api/seed.post.ts"), `import { db, schema } from "hub:db"
import { kv } from "hub:kv"
import { blob } from "hub:blob"
export default defineEventHandler(async () => {
  await db.insert(schema.users).values({ id: 1, name: "Ada" }).onConflictDoNothing()
  for (const [key, value] of Object.entries(${JSON.stringify(kvValues)})) await kv.set(key, value)
  const uploaded = await blob.put("hello.txt", "NuxtHub migration bytes", { contentType: "text/plain", addRandomSuffix: false, customMetadata: { owner: "Ada" } })
  return uploaded
})\n`)
  await file(join(legacy, "server/api/blob.get.ts"), `import { blob } from "hub:blob"
export default defineEventHandler(async () => ({
  metadata: await blob.head("hello.txt"),
  body: await (await blob.get("hello.txt"))?.text(),
  listing: (await blob.list()).blobs.map(entry => entry.pathname),
}))\n`)
  await file(join(legacy, "server/routes/files/[...pathname].get.ts"), `import { blob } from "hub:blob"
export default defineEventHandler(async (event) => {
  const { pathname } = getRouterParams(event)
  return blob.serve(event, pathname)
})\n`)
  await run(work, ["install", "--offline", "--ignore-scripts"], "install-lab")
}

async function checkServedBlob(origin) {
  const response = await fetch(`${origin}/files/hello.txt`)
  assert.equal(response.status, 200)
  assert.match(response.headers.get("content-type"), /^text\/plain(?:;|$)/)
  assert.equal(await response.text(), "NuxtHub migration bytes")
}

async function legacy() {
  const project = join(projects, "legacy-node")
  await run(project, ["nuxt", "build"], "legacy-build")
  await serve(project, async (request, origin) => {
    const blob = await request("/api/seed", { method: "POST" })
    assert.equal(blob.pathname, "hello.txt")
    assert.deepEqual(await request("/api/users"), [{ id: 1, name: "Ada" }])
    const values = await request("/api/settings")
    // NuxtHub's fs-lite store parses JSON-looking strings on read.
    assert.deepEqual(values, { ...kvValues, "json-string": { enabled: true } })
    await file(join(work, "kv-export.json"), JSON.stringify(values, null, 2))
    await request("/files/missing.txt", undefined, 404)
    await checkServedBlob(origin)
    await file(join(work, "legacy-blob.json"), JSON.stringify(blob, null, 2))
    const exported = await request("/api/blob")
    assert.equal(exported.body, "NuxtHub migration bytes")
    assert.deepEqual(exported.metadata.customMetadata, { owner: "Ada" })
    assert.deepEqual(exported.listing, ["hello.txt"])
    await file(join(work, "blob-export.json"), JSON.stringify(exported, null, 2))
  })
  const database = new DatabaseSync(join(project, ".data/db/sqlite.db"))
  const history = database.prepare("SELECT * FROM _hub_migrations").all()
  assert.equal(history.length, 1)
  assert.equal(history[0].name, "0000_users")
  database.close()
  console.log("PASS NuxtHub build applied its SQL migration and routes persisted users, KV and Blob.")
}

async function fresh() {
  const project = join(projects, "fresh-node")
  const nuxtConfig = join(project, "nuxt.config.ts")
  await file(nuxtConfig, (await readFile(nuxtConfig, "utf8")).replace("blob: true", "blob: { serve: true }"))
  await file(join(project, "server/api/lab-blob.post.ts"), `import { blob } from "vite-hub/blob"
export default defineEventHandler(async () => {
  const [error, value] = await blob.put("hello.txt", "ViteHub generated route", { contentType: "text/plain", addRandomSuffix: false })
  if (error) throw error
  return value
})\n`)
  await run(project, ["vitehub", "db", "generate", "--name", "initial"], "fresh-generate")
  await run(project, ["vitehub", "db", "migrate"], "fresh-migrate")
  await run(project, ["nuxt", "build"], "fresh-build")
  await serve(project, async (request, origin) => {
    assert.deepEqual(await request("/api/users"), [])
    await request("/api/lab-blob", { method: "POST" })
    const response = await fetch(`${origin}/api/_vitehub/blob/hello.txt`)
    assert.equal(response.status, 200, await response.clone().text())
    assert.equal(await response.text(), "ViteHub generated route")
    const etag = response.headers.get("etag")
    assert.ok(etag)
    const unchanged = await fetch(`${origin}/api/_vitehub/blob/hello.txt`, { headers: { "if-none-match": etag } })
    assert.equal(unchanged.status, 304, await unchanged.text())
    await request("/api/_vitehub/blob/missing.txt", undefined, 404)
  })
  console.log("PASS fresh database generated, migrated, built, and served through Nuxt, including the generated Blob route.")
}

async function baseline(project) {
  await run(project, ["vitehub", "db", "generate", "--name", "baseline"], `${project.split("/").at(-1)}-baseline`)
  const migrations = join(project, "server/databases/migrations")
  const files = (await readdir(migrations)).filter(name => name.endsWith(".sql"))
  assert.equal(files.length, 1, "Only one baseline SQL file is allowed")
  const sql = await readFile(join(migrations, files[0]), "utf8")
  assert.match(sql, /CREATE TABLE `users`/)
  const expected = new DatabaseSync(":memory:")
  expected.exec(sql)
  assert.deepEqual(expected.prepare("PRAGMA table_info(users)").all().map(({ name, type, notnull, pk }) => ({ name, type, notnull, pk })), [
    { name: "id", type: "INTEGER", notnull: 1, pk: 1 },
    { name: "name", type: "TEXT", notnull: 1, pk: 0 },
  ])
  expected.close()
  await file(join(migrations, files[0]), "SELECT 1;\n")
  return files[0]
}

async function addColumn(project) {
  const path = join(project, "server/databases/config.ts")
  const source = await readFile(path, "utf8")
  await file(path, source.replace('name: text("name").notNull(),', 'name: text("name").notNull(),\n      email: text("email"),'))
  await run(project, ["vitehub", "db", "generate", "--name", "email"], `${project.split("/").at(-1)}-email`)
  const migrations = join(project, "server/databases/migrations")
  const files = (await readdir(migrations)).filter(name => name.endsWith(".sql")).sort()
  assert.equal(files.length, 2)
  const sql = await readFile(join(migrations, files[1]), "utf8")
  assert.match(sql, /ALTER TABLE `users` ADD `email` text/)
  assert.doesNotMatch(sql, /CREATE TABLE|DROP TABLE/)
}

async function existing() {
  const project = join(projects, "existing-node")
  const legacy = join(projects, "legacy-node")
  // The old process is stopped before taking the copy, including any SQLite sidecars.
  await cp(join(legacy, ".data"), join(project, ".data-backup"), { recursive: true })
  await mkdir(join(project, ".vitehub/data/database"), { recursive: true })
  await cp(join(legacy, ".data/db/sqlite.db"), join(project, ".vitehub/data/database/sqlite.db"))
  await cp(join(legacy, ".data/kv"), join(project, ".vitehub/data/kv"), { recursive: true })
  await baseline(project)
  await run(project, ["vitehub", "db", "migrate"], "existing-record-baseline")
  await addColumn(project)
  await run(project, ["vitehub", "db", "migrate"], "existing-apply-email")
  await run(project, ["vitehub", "db", "migrate"], "existing-repeat-migrate")
  await file(join(project, "server/api/blob.post.ts"), `import { blob } from "vite-hub/blob"
export default defineEventHandler(async (event) => {
  const { metadata, body } = await readBody(event)
  const [error, value] = await blob.put(metadata.pathname, body, {
    contentType: metadata.contentType,
    customMetadata: metadata.customMetadata,
    addRandomSuffix: false,
  })
  if (error) throw error
  return value
})\n`)
  await file(join(project, "server/api/blob.get.ts"), `import { blob } from "vite-hub/blob"
export default defineEventHandler(async () => {
  const [headError, metadata] = await blob.head("hello.txt")
  if (headError) throw headError
  const [getError, body] = await blob.get("hello.txt")
  if (getError) throw getError
  const [listError, listing] = await blob.list()
  if (listError) throw listError
  return { metadata, body: await body?.text(), listing: listing.blobs.map(entry => entry.pathname) }
})\n`)
  await run(project, ["nuxt", "build"], "existing-build")
  const exported = JSON.parse(await readFile(join(work, "blob-export.json"), "utf8"))
  await serve(project, async request => {
    await request("/api/blob", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(exported) })
  })
  await serve(project, async (request, origin) => {
    assert.deepEqual(await request("/api/users"), [{ id: 1, name: "Ada", email: null }])
    assert.deepEqual(await request("/api/settings"), JSON.parse(await readFile(join(work, "kv-export.json"), "utf8")))
    const actual = await request("/api/blob")
    assert.equal(actual.body, exported.body)
    assert.deepEqual(actual.metadata.customMetadata, exported.metadata.customMetadata)
    assert.equal(actual.metadata.contentType, exported.metadata.contentType)
    assert.deepEqual(actual.listing, exported.listing)
    await request("/files/missing.txt", undefined, 404)
    await checkServedBlob(origin)
  })
  const database = new DatabaseSync(join(project, ".vitehub/data/database/sqlite.db"))
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM _hub_migrations").get().count, 1)
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM __drizzle_migrations").get().count, 2)
  database.close()
  console.log("PASS existing Node data survived the baseline, later migration, repeated migrate, and server restart.")
}

async function d1() {
  const project = join(projects, "existing-d1")
  await modern(project, "cloudflare")
  const nuxtConfig = join(project, "nuxt.config.ts")
  await file(nuxtConfig, (await readFile(nuxtConfig, "utf8")).replace(
    'database: true, kv: true, blob: true',
    'database: true, kv: { driver: "cloudflare-kv-binding", binding: "KV", namespaceId: "00000000000000000000000000000001" }, blob: { driver: "cloudflare-r2", binding: "BLOB", bucketName: "nuxthub-migration-lab" }',
  ))
  await definition(project, 'cloudflare: { binding: "DB", databaseId: "00000000-0000-0000-0000-000000000001", databaseName: "nuxthub-migration-lab" },')
  await file(join(project, "wrangler.legacy.json"), JSON.stringify({
    name: "nuxthub-migration-lab", compatibility_date: "2026-10-01",
    d1_databases: [{ binding: "DB", database_name: "nuxthub-migration-lab", database_id: "00000000-0000-0000-0000-000000000001" }],
  }))
  await file(join(project, "legacy.sql"), `${initialSql}\nINSERT INTO users VALUES (1, 'Ada');\nCREATE TABLE _hub_migrations (id INTEGER PRIMARY KEY, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);\nINSERT INTO _hub_migrations (name) VALUES ('0000_users');\n`)
  const persist = join(project, ".wrangler/state")
  await run(project, ["wrangler", "d1", "execute", "DB", "--local", "--config", "wrangler.legacy.json", "--persist-to", persist, "--file", "legacy.sql"], "d1-seed")
  const name = await baseline(project)
  await run(project, ["nuxt", "build"], "d1-baseline-build")
  const config = ".output/server/wrangler.json"
  const output = JSON.parse(await readFile(join(project, config), "utf8"))
  assert.equal(output.d1_databases.find(binding => binding.binding === "DB").database_id, "00000000-0000-0000-0000-000000000001")
  assert.equal(output.kv_namespaces.find(binding => binding.binding === "KV").id, "00000000000000000000000000000001")
  assert.equal(output.r2_buckets.find(binding => binding.binding === "BLOB").bucket_name, "nuxthub-migration-lab")
  const args = ["wrangler", "d1", "migrations"]
  const suffix = ["DB", "--local", "--config", config, "--persist-to", persist]
  const pending = await run(project, [...args, "list", ...suffix], "d1-list-baseline")
  assert.ok(pending.includes(name))
  await run(project, [...args, "apply", ...suffix], "d1-record-baseline")
  await addColumn(project)
  await run(project, ["nuxt", "build"], "d1-email-build")
  const inspected = JSON.parse(await run(project, ["vitehub", "inspect", "provider-output", "--json"], "d1-inspect-provider-output"))
  assert.ok(Array.isArray(inspected.providerOutput))
  // Nuxt's Vite root is app/, and inspection paths are relative to that root.
  const inspectedConfig = inspected.providerOutput.find(entry => entry.path === relative(join(project, "app"), join(project, config)))
  assert.equal(inspectedConfig?.exists, true, "Inspection must find the emitted Wrangler configuration")
  assert.equal(inspectedConfig.type, "file")
  assert.deepEqual(inspectedConfig.content.d1_databases, output.d1_databases)
  assert.deepEqual(inspectedConfig.content.kv_namespaces, output.kv_namespaces)
  assert.deepEqual(inspectedConfig.content.r2_buckets, output.r2_buckets)
  await run(project, [...args, "apply", ...suffix], "d1-apply-email")
  await run(project, [...args, "apply", ...suffix], "d1-repeat-migrate")
  const result = await run(project, ["wrangler", "d1", "execute", ...suffix, "--command", "SELECT * FROM users", "--json"], "d1-read-users")
  assert.deepEqual(JSON.parse(result)[0].results, [{ id: 1, name: "Ada", email: null }])
  const history = await run(project, ["wrangler", "d1", "execute", ...suffix, "--command", "SELECT (SELECT COUNT(*) FROM _hub_migrations) AS legacy, (SELECT COUNT(*) FROM d1_migrations) AS current", "--json"], "d1-read-history")
  assert.deepEqual(JSON.parse(history)[0].results, [{ legacy: 1, current: 2 }])
  const names = await run(project, ["wrangler", "d1", "execute", ...suffix, "--command", "SELECT name FROM d1_migrations ORDER BY id", "--json"], "d1-read-filenames")
  const sqlFiles = (await readdir(join(project, "server/databases/migrations"))).filter(name => name.endsWith(".sql")).sort()
  assert.deepEqual(JSON.parse(names)[0].results.map(row => row.name), sqlFiles)
  await checkCloudflareRuntime(project, persist)
  console.log("PASS existing D1 data survived Wrangler baseline, later migration, repeated apply, and built Worker HTTP reads.")
}

async function checkCloudflareRuntime(project, persist) {
  const require = createRequire(join(project, "package.json"))
  const { Miniflare, convertV4MiniflareOptions } = createRequire(require.resolve("wrangler"))("miniflare")
  const outputDir = join(project, ".output/server")
  const config = JSON.parse(await readFile(join(outputDir, "wrangler.json"), "utf8"))
  const moduleTypes = { ".mjs": "ESModule", ".js": "ESModule", ".cjs": "CommonJS", ".wasm": "CompiledWasm" }
  const entry = resolve(outputDir, config.main)
  const modules = [entry, ...(await readdir(outputDir, { recursive: true }))
    .filter(path => Object.hasOwn(moduleTypes, extname(path)))
    .map(path => resolve(outputDir, path))
    .filter(path => path !== entry)]
    .map(path => ({ path, type: moduleTypes[extname(path)] }))
  const worker = new Miniflare(convertV4MiniflareOptions({
    name: config.name,
    port: 4532,
    modules,
    modulesRoot: outputDir,
    compatibilityDate: config.compatibility_date,
    compatibilityFlags: config.compatibility_flags,
    resourcePersistencePath: join(persist, "v3"),
    d1Databases: Object.fromEntries(config.d1_databases.map(item => [item.binding, item.database_id])),
    kvNamespaces: Object.fromEntries(config.kv_namespaces.map(item => [item.binding, item.id])),
    r2Buckets: Object.fromEntries(config.r2_buckets.map(item => [item.binding, item.bucket_name])),
    outboundService: () => { throw new Error("The migration lab must not make external requests") },
  }))
  try {
    const kv = await worker.getKVNamespace("KV")
    for (const [key, value] of Object.entries(kvValues)) await kv.put(key, JSON.stringify(value))
    const bucket = await worker.getR2Bucket("BLOB")
    await bucket.put("hello.txt", "NuxtHub migration bytes", { httpMetadata: { contentType: "text/plain" }, customMetadata: { owner: "Ada" } })
    const users = await worker.dispatchFetch("http://lab.test/api/users")
    assert.equal(users.status, 200, await users.clone().text())
    assert.deepEqual(await users.json(), [{ id: 1, name: "Ada", email: null }])
    const settings = await worker.dispatchFetch("http://lab.test/api/settings")
    assert.equal(settings.status, 200, await settings.clone().text())
    assert.deepEqual(await settings.json(), kvValues)
    const blob = await worker.dispatchFetch("http://lab.test/files/hello.txt")
    assert.equal(blob.status, 200, await blob.clone().text())
    assert.match(blob.headers.get("content-type"), /^text\/plain(?:;|$)/)
    assert.equal(await blob.text(), "NuxtHub migration bytes")
    const missing = await worker.dispatchFetch("http://lab.test/files/missing.txt")
    assert.equal(missing.status, 404, await missing.text())
  }
  finally {
    await worker.dispose()
  }
}

const stages = { setup, legacy, fresh, existing, d1 }
const stage = process.argv[2]
assert.ok(Object.hasOwn(stages, stage), `Choose a stage: ${Object.keys(stages).join(", ")}`)
await stages[stage]()
