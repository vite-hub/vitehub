import assert from "node:assert/strict"
import { parseArgs } from "node:util"

import { type FetchOptions, ofetch } from "ofetch"

const providers = ["cloudflare", "vercel"] as const
const frameworks = ["vite"] as const
const liveOnlyMessage = "Sandbox e2e requires a deployed app: pnpm --dir packages/sandbox test:e2e --mode live --provider cloudflare|vercel --framework vite --url <url>"

type Provider = typeof providers[number]
type Framework = typeof frameworks[number]

const expectedProbe: Record<Provider, Record<string, unknown | unknown[]>> = {
  cloudflare: { feature: "sandbox", hasWaitUntil: [true, false], hosting: "cloudflare-module", ok: true, provider: "cloudflare", runtime: ["cloudflare", null] },
  vercel: { feature: "sandbox", hasWaitUntil: [true, false], hosting: "vercel", ok: true, provider: "vercel", runtime: ["vercel", "node", null] },
}

const releaseNotesRequest = {
  notes: "- Added weekly digest\n- Fixed invite flow\n- Tightened signup copy",
}

const expectedReleaseNotes = {
  result: {
    items: ["Added weekly digest", "Fixed invite flow", "Tightened signup copy"],
    summary: "Added weekly digest",
  },
}

const log = (message: string) => console.log(`[e2e] ${message}`)

async function retry(label: string, run: () => Promise<void>) {
  let lastError: unknown
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      return await run()
    }
    catch (error) {
      lastError = error
      if (attempt < 10) {
        log(`${label} retry ${attempt}/9`)
        await new Promise(resolve => setTimeout(resolve, 3000))
      }
    }
  }
  throw lastError
}

function assertMatches(actual: Record<string, unknown>, expected: Record<string, unknown | unknown[]>) {
  for (const [key, value] of Object.entries(expected)) {
    if (Array.isArray(value)) {
      assert.ok(value.some(item => Object.is(item, actual[key])), `expected ${key} to be one of ${JSON.stringify(value)}, got ${JSON.stringify(actual[key])}`)
    }
    else {
      assert.deepEqual(actual[key], value)
    }
  }
}

async function runLive(url: string, provider: Provider) {
  const request = (path: string, options?: FetchOptions) => ofetch(path, { baseURL: url, ...options })
  log(`live ${provider} -> ${url}`)

  await retry(`${provider} probe`, async () => {
    assertMatches(await request("/api/tests/probe"), expectedProbe[provider])
  })
  await retry(`${provider} sandbox`, async () => {
    assert.deepEqual(await request("/api/sandboxes/release-notes", {
      body: JSON.stringify(releaseNotesRequest),
      headers: { "content-type": "application/json" },
      method: "POST",
    }), expectedReleaseNotes)
  })

  log(`live ${provider} ok`)
}

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

if (mode !== "live")
  throw new TypeError(liveOnlyMessage)
assert.ok(values.url, "--url required for live mode")
assert.ok(provider && providers.includes(provider), "--provider required for live mode")
assert.ok(framework && frameworks.includes(framework), "--framework required for live mode")

await runLive(values.url, provider)
