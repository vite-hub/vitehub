import { existsSync } from "node:fs"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { dirname, resolve } from "node:path"
import { parseArgs } from "node:util"
import assert from "node:assert/strict"

import { type FetchOptions, ofetch } from "ofetch"

import { execCommand, getFreePort, startCommand } from "./helpers/http.ts"

const PROVIDERS = ["cloudflare", "vercel"] as const
const FRAMEWORKS = ["nitro", "vite"] as const

type Provider = typeof PROVIDERS[number]
type Framework = typeof FRAMEWORKS[number]
type Fetcher = (url: string, options?: FetchOptions) => Promise<any>

const workspaceRoot = resolve(import.meta.dirname, "../../..")
const vercelServer = resolve(import.meta.dirname, "helpers/vercel-server.ts")
const dir = (fw: Framework) => resolve(workspaceRoot, "playground", fw)
const cloudflareServerDir = (fw: Framework) => resolve(dir(fw), ".output/server")
const log = (msg: string) => console.log(`[e2e] ${msg}`)
const nitroBuildScript = [
  'import { build, createNitro, prepare } from "nitro/builder"',
  "const [rootDir, preset] = process.argv.slice(1)",
  "const nitro = await createNitro({ rootDir, preset })",
  "await prepare(nitro)",
  "await build(nitro)",
  "await nitro.close()",
].join("; ")
let packagesBuiltPromise: Promise<void> | undefined

const assertProbe = async (f: Fetcher, expected: Record<string, unknown>) =>
  assert.deepEqual(await f("/api/tests/probe"), { feature: "kv", ok: true, ...expected })

const assertKvWrite = async (f: Fetcher) =>
  assert.deepEqual(
    await f("/api/tests/kv", { method: "POST", body: JSON.stringify({ key: "smoke" }), headers: { "content-type": "application/json" } }),
    { ok: true, value: { key: "smoke", store: "kv" } },
  )

async function dumpChild(child: Awaited<ReturnType<typeof startCommand>>, label: string, error: unknown) {
  const code = await Promise.race([child.exit, new Promise<number>(r => setTimeout(() => r(-1), 100))])
  throw new Error([`${label} failed (exit: ${code})`, String(error), `stdout:\n${child.stdout.join("")}`, `stderr:\n${child.stderr.join("")}`].join("\n\n"))
}

async function upstashStub() {
  const store = new Map<string, unknown>()
  const port = await getFreePort()
  const handlers: Record<string, (args: any[]) => unknown> = {
    set: ([k, v]) => { store.set(String(k), v); return { result: "OK" } },
    get: ([k]) => ({ result: store.get(String(k)) ?? null }),
    scan: ([, , pattern]) => {
      const re = typeof pattern === "string"
        ? new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`)
        : null
      return { result: ["0", [...store.keys()].filter(k => !re || re.test(k))] }
    },
    unlink: ([k]) => { store.delete(String(k)); return { result: 1 } },
    del: args => { for (const k of args) store.delete(String(k)); return { result: args.length } },
  }
  const exec = (body: unknown) => {
    const [cmd, ...args] = Array.isArray(body) ? body : []
    return handlers[String(cmd).toLowerCase()]?.(args) ?? { error: "not-found" }
  }

  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(Buffer.from(c))
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : []
    const pipeline = Array.isArray(body) && Array.isArray(body[0])
    const result: any = pipeline ? body.map(exec) : exec(body)
    res.setHeader("content-type", "application/json")
    res.setHeader("upstash-sync-token", "stub-sync-token")
    if (!pipeline && "error" in result) res.statusCode = 404
    res.end(JSON.stringify(result))
  })
  await new Promise<void>(r => server.listen(port, "127.0.0.1", () => r()))

  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>(r => server.close(() => r())) }
}

async function ensurePlaygroundPackagesBuilt() {
  packagesBuiltPromise ||= Promise.all([
    execCommand("pnpm", ["--filter", "@vitehub/kv", "build"], { cwd: workspaceRoot, env: process.env }),
    execCommand("pnpm", ["--filter", "@vitehub/queue", "build"], { cwd: workspaceRoot, env: process.env }),
  ]).then(() => undefined)
  await packagesBuiltPromise
}

async function ensureCloudflareStorageShim(fw: Framework) {
  const runtimeChunk = resolve(cloudflareServerDir(fw), "_chunks/runtime.mjs")
  const runtimeSource = await readFile(runtimeChunk, "utf8")
  if (!runtimeSource.includes("#nitro-internal-virtual/storage")) {
    return
  }

  const shimPath = resolve(cloudflareServerDir(fw), "_chunks/nitro-storage.mjs")

  await mkdir(dirname(shimPath), { recursive: true })
  await writeFile(
    runtimeChunk,
    runtimeSource.replaceAll("#nitro-internal-virtual/storage", "./nitro-storage.mjs"),
  )
  await writeFile(
    shimPath,
    [
      "function normalizeKey(key = '', sep = ':') {",
      "  return key.replace(/[:/\\\\]/g, sep).replace(/^[:/\\\\]|[:/\\\\]$/g, '')",
      "}",
      "function joinKeys(...keys) {",
      "  return keys.map((key) => normalizeKey(key)).filter(Boolean).join(':')",
      "}",
      "function createMemoryDriver() {",
      "  const data = new Map()",
      "  return {",
      "    async hasItem(key) { return data.has(key) },",
      "    async getItem(key) { return data.get(key) ?? null },",
      "    async setItem(key, value) { data.set(key, value) },",
      "    async removeItem(key) { data.delete(key) },",
      "    async getKeys(base = '') {",
      "      return [...data.keys()].filter((key) => !base || key === base || key.startsWith(base + ':'))",
      "    },",
      "    async clear(base = '') {",
      "      for (const key of [...data.keys()]) {",
      "        if (!base || key === base || key.startsWith(base + ':')) data.delete(key)",
      "      }",
      "    },",
      "    async dispose() { data.clear() },",
      "  }",
      "}",
      "export function initStorage() {",
      "  const mounts = new Map([['', createMemoryDriver()]])",
      "  const resolveMount = (key = '') => {",
      "    const normalized = normalizeKey(key)",
      "    const mountpoints = [...mounts.keys()].sort((a, b) => b.length - a.length)",
      "    for (const base of mountpoints) {",
      "      if (!base || normalized === base || normalized.startsWith(base + ':')) {",
      "        return {",
      "          driver: mounts.get(base),",
      "          relativeKey: base ? normalized.slice(base.length + 1) : normalized,",
      "          base,",
      "        }",
      "      }",
      "    }",
      "    return { driver: mounts.get(''), relativeKey: normalized, base: '' }",
      "  }",
      "  return {",
      "    async hasItem(key) {",
      "      const { driver, relativeKey } = resolveMount(key)",
      "      return driver.hasItem(relativeKey)",
      "    },",
      "    async getItem(key) {",
      "      const { driver, relativeKey } = resolveMount(key)",
      "      const value = await driver.getItem(relativeKey)",
      "      if (value == null) return null",
      "      try { return JSON.parse(value) } catch { return value }",
      "    },",
      "    async setItem(key, value, opts) {",
      "      const { driver, relativeKey } = resolveMount(key)",
      "      await driver.setItem(relativeKey, JSON.stringify(value), opts)",
      "    },",
      "    async removeItem(key, opts) {",
      "      const { driver, relativeKey } = resolveMount(key)",
      "      await driver.removeItem(relativeKey, opts)",
      "    },",
      "    async getKeys(base = '') {",
      "      const { driver, relativeKey, base: mountBase } = resolveMount(base)",
      "      const keys = await driver.getKeys(relativeKey)",
      "      return keys.map((key) => joinKeys(mountBase, key))",
      "    },",
      "    async clear(base = '') {",
      "      const { driver, relativeKey } = resolveMount(base)",
      "      await driver.clear(relativeKey)",
      "    },",
      "    mount(base, driver) {",
      "      mounts.set(normalizeKey(base), driver)",
      "    },",
      "    async unmount(base, dispose = true) {",
      "      const normalized = normalizeKey(base)",
      "      const driver = mounts.get(normalized)",
      "      mounts.delete(normalized)",
      "      if (dispose && driver?.dispose) await driver.dispose()",
      "    },",
      "  }",
      "}",
      "",
    ].join("\n"),
  )
}

async function build(fw: Framework, preset: string, extra?: Record<string, string>) {
  await ensurePlaygroundPackagesBuilt()
  await Promise.all([".output", ".vercel", ".nuxt", ".nitro"].map(n => rm(resolve(dir(fw), n), { force: true, recursive: true })))
  const env = { ...process.env, ...extra, NITRO_PRESET: preset, NODE_PATH: resolve(workspaceRoot, "node_modules") }
  await execCommand("node", ["--input-type=module", "-e", nitroBuildScript, dir(fw), preset], { cwd: dir(fw), env })
  if (preset === "cloudflare-module") {
    await ensureCloudflareStorageShim(fw)
  }
}

const providerProbe: Record<Provider, Record<string, unknown>> = {
  cloudflare: { hasWaitUntil: true, hosting: "cloudflare-module", provider: "cloudflare-kv-binding", runtime: "cloudflare" },
  vercel: { hasWaitUntil: true, hosting: "vercel", provider: "upstash", runtime: "node" },
}

async function runCloudflare(fw: Framework) {
  log(`cloudflare × ${fw}`)
  await build(fw, "cloudflare-module")
  const port = await getFreePort()
  const inspectorPort = await getFreePort()
  const child = await startCommand("npx", [
    "wrangler",
    "--cwd",
    ".output/server",
    "dev",
    "--config",
    "wrangler.json",
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
    "--inspector-port",
    String(inspectorPort),
    "--show-interactive-dev-session=false",
  ], {
    cwd: dir(fw),
    env: { ...process.env, NO_COLOR: "1" },
  })
  const base = `http://127.0.0.1:${port}`
  const f: Fetcher = (p, i) => ofetch(p, { baseURL: base, ...i })
  try {
    await ofetch("/api/tests/probe", { baseURL: base, retry: 40, retryDelay: 250 })
    await assertProbe(f, providerProbe.cloudflare)
    await assertKvWrite(f)
    log(`cloudflare × ${fw} ✓`)
  }
  catch (error) { await dumpChild(child, `cloudflare × ${fw} on port ${port}`, error) }
  finally { child.kill("SIGTERM"); await child.exit }
}

async function runVercel(fw: Framework) {
  log(`vercel × ${fw}`)
  const upstash = await upstashStub()
  const port = await getFreePort()
  const env = { KV_REST_API_TOKEN: "t", KV_REST_API_URL: upstash.url }
  try {
    await build(fw, "vercel", env)
    const entry = [
      resolve(dir(fw), ".vercel/output/functions/__fallback.func/index.mjs"),
      resolve(dir(fw), ".vercel/output/functions/__server.func/index.mjs"),
    ].find(existsSync)
    if (!entry) {
      throw new Error(`Missing Vercel server entry for ${fw}.`)
    }
    const child = await startCommand("pnpm", ["exec", "tsx", vercelServer, entry], {
      cwd: workspaceRoot,
      env: { ...process.env, ...env, HOST: "127.0.0.1", NITRO_HOST: "127.0.0.1", NITRO_PORT: String(port), PORT: String(port) },
    })
    const base = `http://127.0.0.1:${port}`
    const f: Fetcher = (p, i) => ofetch(p, { baseURL: base, ...i })
    try {
      await ofetch("/api/tests/probe", { baseURL: base, retry: 40, retryDelay: 250 })
      await assertProbe(f, providerProbe.vercel)
      await assertKvWrite(f)
      log(`vercel × ${fw} ✓`)
    }
    catch (error) { await dumpChild(child, `vercel × ${fw} on port ${port}`, error) }
    finally { child.kill("SIGTERM"); await child.exit }
  }
  finally { await upstash.close() }
}

async function runLive(url: string, provider: Provider) {
  log(`live ${provider} → ${url}`)
  const f: Fetcher = (p, i) => ofetch(p, { baseURL: url, ...i })
  await assertProbe(f, providerProbe[provider])
  await assertKvWrite(f)
  log(`live ${provider} ✓`)
}

const providerRunner = { cloudflare: runCloudflare, vercel: runVercel } satisfies Record<Provider, (fw: Framework) => Promise<void>>

const { values } = parseArgs({
  options: { mode: { type: "string" }, url: { type: "string" }, provider: { type: "string" }, framework: { type: "string" } },
  strict: true,
})
const mode = values.mode ?? "local"
const provider = values.provider as Provider | undefined
const framework = values.framework as Framework | undefined
if (provider) assert.ok(PROVIDERS.includes(provider), `invalid --provider: ${provider}`)
if (framework) assert.ok(FRAMEWORKS.includes(framework), `invalid --framework: ${framework}`)

if (mode === "live") {
  assert.ok(values.url, "--url required for live mode")
  assert.ok(provider, "--provider required for live mode")
  await runLive(values.url, provider)
}
else {
  const providers = provider ? [provider] : PROVIDERS
  const frameworks = framework ? [framework] : FRAMEWORKS
  // serialize providers per framework — they share build artifacts (.output, .vercel, .nuxt, .nitro)
  await Promise.all(frameworks.map(async (fw) => {
    for (const p of providers) await providerRunner[p](fw)
  }))
}
