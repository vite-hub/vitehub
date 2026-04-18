import { existsSync } from "node:fs"
import { readFile, rm } from "node:fs/promises"
import { resolve } from "node:path"
import { parseArgs } from "node:util"
import assert from "node:assert/strict"

import { Miniflare } from "miniflare"
import { type FetchOptions, ofetch } from "ofetch"

import { getCloudflareQueueBindingName } from "../src/index.ts"

import { execCommand, getFreePort, startCommand } from "./helpers/proc.ts"

const PROVIDERS = ["cloudflare", "vercel"] as const
const FRAMEWORKS = ["nitro", "nuxt", "vite-plugin"] as const

type Provider = typeof PROVIDERS[number]
type Framework = typeof FRAMEWORKS[number]
type Fetcher = (url: string, options?: FetchOptions) => Promise<any>

const providerProbe: Record<Provider, Record<string, unknown>> = {
  cloudflare: { hosting: "cloudflare-module", provider: "cloudflare", runtime: "cloudflare" },
  vercel: { hosting: "vercel", provider: "vercel", runtime: "vercel" },
}

const root = resolve(import.meta.dirname, "..")
const buildScript = resolve(import.meta.dirname, "helpers/build-nitro.ts")
const vercelServer = resolve(import.meta.dirname, "helpers/vercel-server.ts")
const dir = (fw: Framework) => resolve(root, "playground", fw)
const log = (msg: string) => console.log(`[e2e] ${msg}`)

async function dumpChild(child: Awaited<ReturnType<typeof startCommand>>, label: string, error: unknown) {
  const code = await Promise.race([child.exit, new Promise<number>(resolve => setTimeout(() => resolve(-1), 100))])
  throw new Error([`${label} failed (exit: ${code})`, String(error), `stdout:\n${child.stdout.join("")}`, `stderr:\n${child.stderr.join("")}`].join("\n\n"))
}

async function build(fw: Framework, preset: string, extra?: Record<string, string>) {
  await Promise.all([".output", ".vercel", ".nuxt", ".nitro"].map(name => rm(resolve(dir(fw), name), { force: true, recursive: true })))
  const env = { ...process.env, ...extra, NITRO_PRESET: preset, NODE_PATH: resolve(root, "node_modules") }
  if (fw === "nuxt") return execCommand("npx", ["nuxi", "build"], { cwd: dir(fw), env })
  return execCommand("node", ["--import", "tsx/esm", buildScript, dir(fw), preset], { cwd: root, env })
}

async function assertProbe(f: Fetcher, expected: Record<string, unknown>) {
  const probe = await f("/api/tests/probe")
  assert.equal(probe.feature, "queue")
  assert.equal(probe.ok, true)
  assert.equal(typeof probe.hasWaitUntil, "boolean")
  assert.deepEqual({ hosting: probe.hosting, provider: probe.provider, runtime: probe.runtime }, expected)
}

async function eventually<T>(fn: () => Promise<T>, assertFn: (value: T) => void | Promise<void>) {
  let lastError: unknown
  for (let i = 0; i < 40; i++) {
    try {
      const value = await fn()
      await assertFn(value)
      return value
    }
    catch (error) {
      lastError = error
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  throw lastError
}

async function assertQueueProcessed(f: Fetcher) {
  await f("/api/tests/queue-state", { method: "DELETE" })
  const queued = await f("/api/queues/welcome", {
    body: JSON.stringify({ email: "ava@example.com" }),
    headers: { "content-type": "application/json" },
    method: "POST",
  })
  assert.equal(queued.ok, true)
  assert.equal(queued.result.status, "queued")
  assert.ok(["string", "undefined"].includes(typeof queued.result.messageId), `messageId type: ${typeof queued.result.messageId}`)
  await eventually(() => f("/api/tests/queue-state"), (state) => {
    assert.equal(state.ok, true)
    assert.equal(state.jobs.length, 1)
    assert.deepEqual(state.jobs[0].payload, { email: "ava@example.com" })
  })
}

async function runCloudflare(fw: Framework) {
  log(`cloudflare x ${fw}`)
  await build(fw, "cloudflare-module")
  const mf = new Miniflare({
    compatibilityDate: "2025-01-01",
    compatibilityFlags: ["nodejs_compat"],
    modules: true,
    modulesRoot: ".output/server",
    queueConsumers: ["welcome-email"],
    queueProducers: { [getCloudflareQueueBindingName("welcome-email")]: { queueName: "welcome-email" } },
    rootPath: dir(fw),
    scriptPath: ".output/server/index.mjs",
  })

  try {
    const f: Fetcher = async (p, i) => (await mf.dispatchFetch(`http://localhost${p}`, i as never)).json()
    await assertProbe(f, providerProbe.cloudflare)
    await assertQueueProcessed(f)
    log(`cloudflare x ${fw} ok`)
  }
  finally {
    await mf.dispose()
  }
}

function vercelFunctionConfigPath(fw: Framework) {
  return resolve(dir(fw), ".vercel/output/functions/api/vitehub/queues/vercel/welcome-email.func/.vc-config.json")
}

async function assertVercelFunctionConfig(fw: Framework) {
  const file = vercelFunctionConfigPath(fw)
  assert.equal(existsSync(file), true, `missing generated Vercel queue function config: ${file}`)
  const config = JSON.parse(await readFile(file, "utf8"))
  assert.deepEqual(config.experimentalTriggers, [{ topic: "welcome-email", type: "queue/v2beta" }])
  assert.equal(JSON.stringify(config).includes("consumer"), false)
}

async function runVercel(fw: Framework) {
  log(`vercel x ${fw}`)
  const port = await getFreePort()
  const env = { VERCEL: "1", VERCEL_REGION: "iad1" }
  await build(fw, "vercel", env)
  await assertVercelFunctionConfig(fw)

  const entry = resolve(dir(fw), ".vercel/output/functions/__fallback.func/index.mjs")
  const child = await startCommand("node", ["--import", "tsx/esm", vercelServer, entry], {
    cwd: dir(fw),
    env: { ...process.env, ...env, HOST: "127.0.0.1", NITRO_HOST: "127.0.0.1", NITRO_PORT: String(port), PORT: String(port) },
  })

  const baseURL = `http://127.0.0.1:${port}`
  const f: Fetcher = (p, i) => ofetch(p, { baseURL, ...i })

  try {
    await ofetch("/api/tests/probe", { baseURL, retry: 40, retryDelay: 250 })
    await assertProbe(f, providerProbe.vercel)
    log(`vercel x ${fw} ok`)
  }
  catch (error) {
    await dumpChild(child, `vercel x ${fw} on port ${port}`, error)
  }
  finally {
    child.kill("SIGTERM")
    await child.exit
  }
}

async function runLive(url: string, provider: Provider) {
  log(`live ${provider} -> ${url}`)
  const f: Fetcher = (p, i) => ofetch(p, { baseURL: url, ...i })
  await assertProbe(f, providerProbe[provider])
  if (provider === "cloudflare") await assertQueueProcessed(f)
  log(`live ${provider} ok`)
}

const providerRunner = { cloudflare: runCloudflare, vercel: runVercel } satisfies Record<Provider, (fw: Framework) => Promise<void>>

const { values } = parseArgs({
  options: {
    framework: { type: "string" },
    mode: { type: "string" },
    provider: { type: "string" },
    url: { type: "string" },
  },
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
  // serialize providers per framework — they share build artifacts (.output/.vercel)
  await Promise.all(frameworks.map(async (fw) => {
    for (const currentProvider of providers) await providerRunner[currentProvider](fw)
  }))
}
