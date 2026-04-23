import { parseArgs } from "node:util"
import assert from "node:assert/strict"

import { type FetchOptions, ofetch } from "ofetch"

const PROVIDERS = ["cloudflare", "vercel"] as const
const FRAMEWORKS = ["nitro", "vite"] as const

type Provider = typeof PROVIDERS[number]
type Framework = typeof FRAMEWORKS[number]
type Fetcher = (url: string, options?: FetchOptions) => Promise<any>

const liveOnlyMessage = "KV e2e requires a deployed app: pnpm --dir packages/kv test:e2e --mode live --provider cloudflare|vercel --framework nitro|vite --url <url>"
const log = (msg: string) => console.log(`[e2e] ${msg}`)

const assertProbe = async (f: Fetcher, expected: Record<string, unknown>) =>
  assert.deepEqual(await f("/api/tests/probe"), { ok: true, ...expected })

const assertKvWrite = async (f: Fetcher) =>
  assert.deepEqual(
    await f("/api/tests/kv", { method: "POST" }),
    { ok: true, value: { key: "smoke", store: "kv" } },
  )

const providerProbe: Record<Provider, Record<string, unknown>> = {
  cloudflare: { provider: "cloudflare-kv-binding" },
  vercel: { provider: "upstash" },
}

async function assertLiveProbe(f: Fetcher, provider: Provider) {
  const expected = providerProbe[provider]

  if (provider !== "cloudflare") {
    await assertProbe(f, expected)
    return
  }

  let lastError: unknown
  for (let attempt = 1; attempt <= 20; attempt++) {
    try {
      await assertProbe(f, expected)
      return
    }
    catch (error) {
      lastError = error
      if (attempt === 20) break
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
  }

  throw lastError
}

async function runLive(url: string, provider: Provider) {
  log(`live ${provider} -> ${url}`)
  const f: Fetcher = (p, i) => ofetch(p, { baseURL: url, ...i })
  await assertLiveProbe(f, provider)
  await assertKvWrite(f)
  log(`live ${provider} ✓`)
}

const { values } = parseArgs({
  options: { mode: { type: "string" }, url: { type: "string" }, provider: { type: "string" }, framework: { type: "string" } },
  strict: true,
})
const mode = values.mode ?? "local"
const provider = values.provider as Provider | undefined
const framework = values.framework as Framework | undefined
if (provider) assert.ok(PROVIDERS.includes(provider), `invalid --provider: ${provider}`)
if (framework) assert.ok(FRAMEWORKS.includes(framework), `invalid --framework: ${framework}`)

if (mode !== "live") {
  throw new TypeError(liveOnlyMessage)
}

assert.ok(values.url, "--url required for live mode")
assert.ok(provider, "--provider required for live mode")
await runLive(values.url, provider)
