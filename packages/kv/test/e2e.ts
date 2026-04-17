import { rm } from "node:fs/promises"
import { createServer } from "node:http"
import { resolve } from "node:path"
import { parseArgs } from "node:util"
import assert from "node:assert/strict"

import { Miniflare } from "miniflare"
import { type FetchOptions, ofetch } from "ofetch"

import { execCommand, getFreePort, startCommand } from "./helpers/http.ts"

const PROVIDERS = ["cloudflare", "vercel"] as const
const FRAMEWORKS = ["nitro", "nuxt", "vite"] as const

type Provider = typeof PROVIDERS[number]
type Framework = typeof FRAMEWORKS[number]
type Fetcher = (url: string, options?: FetchOptions) => Promise<any>

const root = process.cwd()
const buildScript = resolve(import.meta.dirname, "helpers/build-nitro.ts")
const vercelServer = resolve(import.meta.dirname, "helpers/vercel-server.ts")
const dir = (fw: Framework) => resolve(root, "playground", fw)
const log = (msg: string) => console.log(`[e2e] ${msg}`)

const assertProbe = async (f: Fetcher, expected: Record<string, unknown>) =>
  assert.deepEqual(await f("/api/tests/probe"), { feature: "kv", hasWaitUntil: true, ok: true, ...expected })

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
      const re = typeof pattern === "string" ? new RegExp(`^${pattern.replace(/\*/g, ".*")}$`) : null
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

async function build(fw: Framework, preset: string, extra?: Record<string, string>) {
  await Promise.all([".output", ".vercel", ".nuxt", ".nitro"].map(n => rm(resolve(dir(fw), n), { force: true, recursive: true })))
  const env = { ...process.env, ...extra, NITRO_PRESET: preset, NODE_PATH: resolve(root, "node_modules") }
  if (fw === "nuxt") return execCommand("npx", ["nuxi", "build"], { cwd: dir(fw), env })
  return execCommand("node", ["--import", "tsx/esm", buildScript, dir(fw), preset], { cwd: root, env })
}

const providerProbe: Record<Provider, Record<string, unknown>> = {
  cloudflare: { hosting: "cloudflare-module", provider: "cloudflare-kv-binding", runtime: "cloudflare" },
  vercel: { hosting: "vercel", provider: "upstash", runtime: "node" },
}

async function runCloudflare(fw: Framework) {
  log(`cloudflare × ${fw}`)
  await build(fw, "cloudflare-module")
  const mf = new Miniflare({ compatibilityDate: "2025-01-01", compatibilityFlags: ["nodejs_compat"], kvNamespaces: ["KV"], modules: true, modulesRoot: ".output/server", rootPath: dir(fw), scriptPath: ".output/server/index.mjs" })
  try {
    const f: Fetcher = async (p, i) => (await mf.dispatchFetch(`http://localhost${p}`, i as never)).json()
    await assertProbe(f, providerProbe.cloudflare)
    await assertKvWrite(f)
    log(`cloudflare × ${fw} ✓`)
  }
  finally { await mf.dispose() }
}

async function runVercel(fw: Framework) {
  log(`vercel × ${fw}`)
  const upstash = await upstashStub()
  const port = await getFreePort()
  const env = { KV_REST_API_TOKEN: "t", KV_REST_API_URL: upstash.url }
  try {
    await build(fw, "vercel", env)
    const entry = resolve(dir(fw), ".vercel/output/functions/__fallback.func/index.mjs")
    const child = await startCommand("node", ["--import", "tsx/esm", vercelServer, entry], {
      cwd: dir(fw),
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
