import { existsSync } from "node:fs"
import { readFile, rm } from "node:fs/promises"
import { randomUUID } from "node:crypto"
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
const queueName = (fw: Framework) => `welcome-email-${fw}`
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

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

async function eventually<T>(
  fn: () => Promise<T>,
  assertFn: (value: T) => void | Promise<void>,
  options: { attempts?: number, delayMs?: number } = {},
) {
  const attempts = options.attempts ?? 80
  const delayMs = options.delayMs ?? 250
  let lastError: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      const value = await fn()
      await assertFn(value)
      return value
    }
    catch (error) {
      lastError = error
      await delay(delayMs)
    }
  }
  throw lastError
}

async function enqueueWelcome(f: Fetcher, marker = `queue-e2e-${randomUUID()}`) {
  const queued = await f("/api/queues/welcome", {
    body: JSON.stringify({ email: "ava@example.com", marker }),
    headers: { "content-type": "application/json", "x-vitehub-e2e-marker": marker },
    method: "POST",
  })
  assert.equal(queued.ok, true)
  assert.equal(queued.result.status, "queued")
  assert.ok(["string", "undefined"].includes(typeof queued.result.messageId), `messageId type: ${typeof queued.result.messageId}`)
  return { marker, queued }
}

async function assertQueueProcessed(f: Fetcher, marker = `queue-e2e-${randomUUID()}`) {
  await f("/api/tests/queue-state", { method: "DELETE" })
  await enqueueWelcome(f, marker)
  await eventually(() => f("/api/tests/queue-state"), (state) => {
    assert.equal(state.ok, true)
    assert.equal(state.jobs.length, 1)
    assert.deepEqual(state.jobs[0].payload, { email: "ava@example.com", marker })
  })
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function getCloudflareWorkerName(url: string) {
  const hostname = new URL(url).hostname
  return hostname.split(".")[0] || hostname
}

async function assertCloudflareQueueProcessedFromLogs(url: string, marker: string) {
  const workerName = getCloudflareWorkerName(url)
  const tailLog = resolve(root, `.wrangler-tail-${workerName}-${randomUUID()}.log`)
  const payload = JSON.stringify({ email: "ava@example.com", marker })
  const command = [
    "set -eu",
    `tail_log=${shellQuote(tailLog)}`,
    "cleanup() {",
    "  if [ -n \"${tail_pid:-}\" ]; then",
    "    kill \"$tail_pid\" >/dev/null 2>&1 || true",
    "    wait \"$tail_pid\" >/dev/null 2>&1 || true",
    "  fi",
    "  rm -f \"$tail_log\"",
    "}",
    "trap cleanup EXIT",
    `npx wrangler tail ${shellQuote(workerName)} --format json > "$tail_log" 2>&1 &`,
    "tail_pid=$!",
    "sleep 3",
    `curl -fsS -X POST ${shellQuote(`${url}/api/queues/welcome`)} -H 'content-type: application/json' -H ${shellQuote(`x-vitehub-e2e-marker: ${marker}`)} --data ${shellQuote(payload)} >/dev/null`,
    "attempt=0",
    "while [ \"$attempt\" -lt 120 ]; do",
    `  if grep -F ${shellQuote(marker)} "$tail_log" >/dev/null 2>&1; then`,
    "    exit 0",
    "  fi",
    "  sleep 1",
    "  attempt=$((attempt + 1))",
    "done",
    `echo ${shellQuote(`Cloudflare queue marker ${marker} was not observed in worker logs.`)} >&2`,
    "cat \"$tail_log\" >&2 || true",
    "exit 1",
  ].join("\n")

  await execCommand("sh", ["-lc", command], { cwd: root, env: process.env })
}

async function runCloudflare(fw: Framework) {
  log(`cloudflare x ${fw}`)
  await build(fw, "cloudflare-module")
  const mf = new Miniflare({
    compatibilityDate: "2025-01-01",
    compatibilityFlags: ["nodejs_compat"],
    modules: true,
    modulesRoot: ".output/server",
    queueConsumers: [queueName(fw)],
    queueProducers: { [getCloudflareQueueBindingName(queueName(fw))]: { queueName: queueName(fw) } },
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
  return resolve(dir(fw), `.vercel/output/functions/api/vitehub/queues/vercel/${queueName(fw)}.func/.vc-config.json`)
}

async function assertVercelFunctionConfig(fw: Framework) {
  const file = vercelFunctionConfigPath(fw)
  assert.equal(existsSync(file), true, `missing generated Vercel queue function config: ${file}`)
  const config = JSON.parse(await readFile(file, "utf8"))
  assert.deepEqual(config.experimentalTriggers, [{ consumer: queueName(fw), topic: queueName(fw), type: "queue/v2beta" }])
}

async function resolveVercelEntry(fw: Framework) {
  const functionsDir = resolve(dir(fw), ".vercel/output/functions")
  const { readdir } = await import("node:fs/promises")
  const entries = await readdir(functionsDir, { withFileTypes: true })
  const fallback = entries.find(entry => entry.isDirectory() && entry.name === "__fallback.func")
  const server = entries.find(entry => entry.isDirectory() && entry.name === "__server.func")
  const entry = fallback || server || entries.find(entry => entry.isDirectory() && entry.name.endsWith(".func"))
  assert.ok(entry, `No Vercel function output found in ${functionsDir}`)
  return resolve(functionsDir, entry.name, "index.mjs")
}

async function runVercel(fw: Framework) {
  log(`vercel x ${fw}`)
  const port = await getFreePort()
  const env = { VERCEL: "1", VERCEL_REGION: "iad1" }
  await build(fw, "vercel", env)
  await assertVercelFunctionConfig(fw)

  const entry = await resolveVercelEntry(fw)
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

async function assertVercelQueueProcessedFromLogs(url: string, f: Fetcher, marker: string, fw: Framework) {
  const token = process.env.VERCEL_TOKEN
  assert.ok(token, "VERCEL_TOKEN is required for Vercel queue live e2e log verification.")

  const logs = await startCommand("npx", ["--yes", "vercel", "logs", url, "--json", "--token", token], {
    cwd: dir(fw),
    env: process.env,
  })

  try {
    await delay(1000)
    await enqueueWelcome(f, marker)
    await eventually(
      async () => `${logs.stdout.join("")}\n${logs.stderr.join("")}`,
      (output) => {
        assert.match(output, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
      },
      { attempts: 120, delayMs: 1000 },
    )
  }
  catch (error) {
    throw new Error([
      `Vercel queue marker ${marker} was not observed in runtime logs.`,
      String(error),
      `stdout:\n${logs.stdout.join("")}`,
      `stderr:\n${logs.stderr.join("")}`,
    ].join("\n\n"))
  }
  finally {
    logs.kill("SIGTERM")
    await Promise.race([logs.exit, delay(1000)])
  }
}

async function runLive(url: string, provider: Provider, fw: Framework) {
  log(`live ${provider} -> ${url}`)
  const f: Fetcher = (p, i) => ofetch(p, { baseURL: url, ...i })
  await assertProbe(f, providerProbe[provider])
  const marker = `queue-live-${provider}-${randomUUID()}`
  if (provider === "cloudflare") {
    await assertCloudflareQueueProcessedFromLogs(url, marker)
  }
  else {
    await assertVercelQueueProcessedFromLogs(url, f, marker, fw)
  }
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
  assert.ok(framework, "--framework required for live mode")
  await runLive(values.url, provider, framework)
}
else {
  const providers = provider ? [provider] : PROVIDERS
  const frameworks = framework ? [framework] : FRAMEWORKS
  // serialize providers per framework — they share build artifacts (.output/.vercel)
  await Promise.all(frameworks.map(async (fw) => {
    for (const currentProvider of providers) await providerRunner[currentProvider](fw)
  }))
}
