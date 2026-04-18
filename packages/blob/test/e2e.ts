import { rm } from "node:fs/promises"
import { resolve } from "node:path"
import { parseArgs } from "node:util"
import assert from "node:assert/strict"
import { existsSync } from "node:fs"

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
const dir = (fw: Framework): string => resolve(root, "playground", fw)
const log = (msg: string): void => console.log(`[e2e] ${msg}`)

function resolveVercelEntry(fw: Framework): string {
  const functionsDir = resolve(dir(fw), ".vercel/output/functions")
  for (const name of ["__server.func", "__fallback.func"]) {
    const entry = resolve(functionsDir, name, "index.mjs")
    if (existsSync(entry)) return entry
  }
  throw new Error(`No Vercel server entry found in ${functionsDir}`)
}

async function dumpChild(child: Awaited<ReturnType<typeof startCommand>>, label: string, error: unknown): Promise<never> {
  const code = await Promise.race([child.exit, new Promise<number>(resolve => setTimeout(() => resolve(-1), 100))])
  throw new Error([`${label} failed (exit: ${code})`, String(error), `stdout:\n${child.stdout.join("")}`, `stderr:\n${child.stderr.join("")}`].join("\n\n"))
}

async function build(fw: Framework, preset: string, extra?: Record<string, string>): Promise<void> {
  await Promise.all([".output", ".vercel", ".nuxt", ".nitro"].map(name => rm(resolve(dir(fw), name), { force: true, recursive: true })))
  const env = { ...process.env, ...extra, NITRO_PRESET: preset, NODE_PATH: resolve(root, "node_modules") }
  if (fw === "nuxt") return execCommand("npx", ["nuxi", "build"], { cwd: dir(fw), env })
  return execCommand("npx", ["nitro", "build"], { cwd: dir(fw), env })
}

async function assertProbe(f: Fetcher, expected: Record<string, unknown>): Promise<void> {
  const probe = await f("/api/tests/probe")
  assert.equal(probe.feature, "blob")
  assert.equal(probe.ok, true)
  assert.equal(typeof probe.hasWaitUntil, "boolean")
  assert.deepEqual({ hosting: probe.hosting, provider: probe.provider, runtime: probe.runtime }, expected)
}

async function assertBlobRoundTrip(f: Fetcher): Promise<void> {
  const direct = await f("/api/tests/blob", { method: "POST" })
  assert.equal(direct.ok, true)
  assert.equal(direct.text, "hello blob")
  assert.equal(direct.head.pathname, direct.uploaded.pathname)
  assert.ok(direct.listed.includes(direct.uploaded.pathname))

  const served = await f(`/api/files/${direct.uploaded.pathname}`, { responseType: "text" })
  assert.equal(served, "hello blob")
  const deletePath = (pathname: string): string => `/api/tests/blob-delete?pathname=${encodeURIComponent(pathname)}`
  await f(deletePath(direct.uploaded.pathname), { method: "POST" })

  const uploadName = `upload-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`
  const boundary = `----vitehub-blob-${Date.now()}`
  const uploaded = await f("/api/upload", {
    body: [
      `--${boundary}`,
      `Content-Disposition: form-data; name="files"; filename="${uploadName}"`,
      "Content-Type: text/plain",
      "",
      "uploaded blob",
      `--${boundary}--`,
      "",
    ].join("\r\n"),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    method: "POST",
  })
  assert.equal(uploaded.length, 1)
  assert.equal(uploaded[0].pathname, uploadName)

  const uploadedText = await f(`/api/files/${uploadName}`, { responseType: "text" })
  assert.equal(uploadedText, "uploaded blob")
  await f(deletePath(uploadName), { method: "POST" })
}

async function runCloudflare(fw: Framework): Promise<void> {
  log(`cloudflare x ${fw}`)
  await build(fw, "cloudflare-module")
  const mf = new Miniflare({
    compatibilityDate: "2025-01-01",
    compatibilityFlags: ["nodejs_compat"],
    modules: true,
    modulesRoot: ".output/server",
    r2Buckets: ["BLOB"],
    rootPath: dir(fw),
    scriptPath: ".output/server/index.mjs",
  })

  try {
    const f: Fetcher = async (path, init) => {
      const response = await mf.dispatchFetch(`http://localhost${path}`, init as never)
      if (init?.responseType === "text") return await response.text()
      return await response.json()
    }
    await assertProbe(f, { hosting: "cloudflare-module", provider: "cloudflare-r2", runtime: "cloudflare" })
    await assertBlobRoundTrip(f)
    log(`cloudflare x ${fw} ok`)
  }
  finally {
    await mf.dispose()
  }
}

async function runVercel(fw: Framework): Promise<void> {
  log(`vercel x ${fw}`)
  const port = await getFreePort()
  const env = { VERCEL: "1", VERCEL_REGION: "iad1" }
  await build(fw, "vercel", env)

  const entry = resolveVercelEntry(fw)
  const child = await startCommand("node", ["--import", "tsx/esm", vercelServer, entry], {
    cwd: dir(fw),
    env: { ...process.env, ...env, HOST: "127.0.0.1", NITRO_HOST: "127.0.0.1", NITRO_PORT: String(port), PORT: String(port) },
  })

  const baseURL = `http://127.0.0.1:${port}`
  const f: Fetcher = (path, init) => ofetch(path, { baseURL, ...init })

  try {
    await ofetch("/api/tests/probe", { baseURL, retry: 40, retryDelay: 250 })
    await assertProbe(f, { hosting: "vercel", provider: "vercel-blob", runtime: "vercel" })
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

async function runLive(url: string, provider: Provider): Promise<void> {
  log(`live ${provider} -> ${url}`)
  const f: Fetcher = (path, init) => ofetch(path, { baseURL: url, ...init })
  const expected = provider === "cloudflare"
    ? { hosting: "cloudflare-module", provider: "cloudflare-r2", runtime: "cloudflare" }
    : { hosting: "vercel", provider: "vercel-blob", runtime: "vercel" }
  await assertProbe(f, expected)
  await assertBlobRoundTrip(f)
  log(`live ${provider} ok`)
}

const providerRunner = { cloudflare: runCloudflare, vercel: runVercel } satisfies Record<Provider, (fw: Framework) => Promise<void>>

const { values } = parseArgs({
  args: process.argv.slice(2).filter(arg => arg !== "--"),
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
  await Promise.all(frameworks.map(async (fw) => {
    for (const currentProvider of providers) await providerRunner[currentProvider](fw)
  }))
}
