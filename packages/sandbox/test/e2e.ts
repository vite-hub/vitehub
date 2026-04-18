import { readdir, rm } from "node:fs/promises"
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
const vercelServer = resolve(import.meta.dirname, "helpers/vercel-server.ts")
const dir = (fw: Framework) => resolve(root, "playground", fw)
const log = (msg: string) => console.log(`[e2e] ${msg}`)

const providerProbe: Record<Provider, Record<string, unknown | unknown[]>> = {
  cloudflare: { hasWaitUntil: [true, false], hosting: "cloudflare-module", provider: "cloudflare", runtime: ["cloudflare", null] },
  vercel: { hasWaitUntil: [true, false], hosting: "vercel", provider: "vercel", runtime: ["vercel", "node", null] },
}

const releaseNotesPayload = {
  notes: "- Added weekly digest\n- Fixed invite flow\n- Tightened signup copy",
}

const expectedReleaseNotes = {
  result: {
    summary: "Added weekly digest",
    items: ["Added weekly digest", "Fixed invite flow", "Tightened signup copy"],
  },
}

async function assertProbe(f: Fetcher, expected: Record<string, unknown | unknown[]>) {
  const actual = await f("/api/tests/probe")
  assert.equal(actual.feature, "sandbox")
  assert.equal(actual.ok, true)

  for (const [key, value] of Object.entries(expected)) {
    if (Array.isArray(value)) {
      assert.ok(value.some(item => Object.is(item, actual[key])), `expected ${key} to be one of ${JSON.stringify(value)}, got ${JSON.stringify(actual[key])}`)
      continue
    }
    assert.deepEqual(actual[key], value)
  }
}

const assertSandboxRun = async (f: Fetcher) =>
  assert.deepEqual(
    await f("/api/sandboxes/release-notes", {
      method: "POST",
      body: JSON.stringify(releaseNotesPayload),
      headers: { "content-type": "application/json" },
    }),
    expectedReleaseNotes,
  )

async function dumpChild(child: Awaited<ReturnType<typeof startCommand>>, label: string, error: unknown) {
  const code = await Promise.race([child.exit, new Promise<number>(r => setTimeout(() => r(-1), 100))])
  throw new Error([`${label} failed (exit: ${code})`, String(error), `stdout:\n${child.stdout.join("")}`, `stderr:\n${child.stderr.join("")}`].join("\n\n"))
}

async function build(fw: Framework, preset: string, provider: Provider) {
  await Promise.all([".output", ".vercel", ".nuxt", ".nitro"].map(n => rm(resolve(dir(fw), n), { force: true, recursive: true })))
  const env = {
    ...process.env,
    NITRO_PRESET: preset,
    NODE_PATH: resolve(root, "node_modules"),
    SANDBOX_PROVIDER: provider,
    VERCEL_TOKEN: process.env.VERCEL_TOKEN || "test-token",
    VERCEL_TEAM_ID: process.env.VERCEL_TEAM_ID || process.env.VERCEL_ORG_ID || "test-team",
    VERCEL_PROJECT_ID: process.env.VERCEL_PROJECT_ID || "test-project",
  }
  if (fw === "nuxt") return execCommand("npx", ["nuxi", "build"], { cwd: dir(fw), env })
  if (fw === "vite") return execCommand("npx", ["vite", "build"], { cwd: dir(fw), env })
  return execCommand("npx", ["nitro", "build"], { cwd: dir(fw), env })
}

async function resolveVercelEntry(fw: Framework) {
  const functionsDir = resolve(dir(fw), ".vercel/output/functions")
  const entries = await readdir(functionsDir, { withFileTypes: true })
  const functionDir = entries.find(entry => entry.isDirectory() && entry.name.endsWith(".func"))
  if (!functionDir) {
    throw new Error(`No Vercel function output found in ${functionsDir}`)
  }
  return resolve(functionsDir, functionDir.name, "index.mjs")
}

async function runCloudflare(fw: Framework) {
  log(`cloudflare × ${fw}`)
  await build(fw, "cloudflare-module", "cloudflare")
  const mf = new Miniflare({
    compatibilityDate: "2025-07-15",
    compatibilityFlags: ["nodejs_compat"],
    modules: true,
    modulesRoot: ".output/server",
    rootPath: dir(fw),
    scriptPath: ".output/server/index.mjs",
  })
  try {
    const f: Fetcher = async (p, i) => (await mf.dispatchFetch(`http://localhost${p}`, i as never)).json()
    await assertProbe(f, providerProbe.cloudflare)
    log(`cloudflare × ${fw} ✓`)
  }
  finally {
    await mf.dispose()
  }
}

async function runVercel(fw: Framework) {
  log(`vercel × ${fw}`)
  const port = await getFreePort()
  await build(fw, "vercel", "vercel")
  const entry = await resolveVercelEntry(fw)
  const child = await startCommand("node", ["--import", "tsx/esm", vercelServer, entry], {
    cwd: dir(fw),
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      NITRO_HOST: "127.0.0.1",
      NITRO_PORT: String(port),
      PORT: String(port),
      SANDBOX_PROVIDER: "vercel",
      VERCEL: "1",
      VERCEL_TOKEN: process.env.VERCEL_TOKEN || "test-token",
      VERCEL_TEAM_ID: process.env.VERCEL_TEAM_ID || process.env.VERCEL_ORG_ID || "test-team",
      VERCEL_PROJECT_ID: process.env.VERCEL_PROJECT_ID || "test-project",
    },
  })
  const base = `http://127.0.0.1:${port}`
  const f: Fetcher = (p, i) => ofetch(p, { baseURL: base, ...i })
  try {
    await ofetch("/api/tests/probe", { baseURL: base, retry: 40, retryDelay: 250 })
    await assertProbe(f, providerProbe.vercel)
    log(`vercel × ${fw} ✓`)
  }
  catch (error) {
    await dumpChild(child, `vercel × ${fw} on port ${port}`, error)
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
  await assertSandboxRun(f)
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
  await Promise.all(frameworks.map(async (fw) => {
    for (const p of providers) await providerRunner[p](fw)
  }))
}
