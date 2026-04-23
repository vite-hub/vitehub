import { parseArgs } from "node:util"
import assert from "node:assert/strict"

import { FetchError, ofetch } from "ofetch"

type Provider = "cloudflare" | "vercel"
type Framework = "nitro" | "vite"

const PROVIDERS = ["cloudflare", "vercel"] as const
const FRAMEWORKS = ["nitro", "vite"] as const
const liveOnlyMessage = "Blob e2e requires a deployed app: pnpm --dir packages/blob test:e2e --mode live --url <url>"
const log = (message: string) => console.log(`[blob e2e] ${message}`)

async function assertBlobRoundtrip(baseURL: string) {
  const pathname = `notes/e2e-${Date.now().toString(36)}.txt`
  const body = `hello-${Math.random().toString(36).slice(2, 8)}`

  const put = await ofetch("/api/blob", {
    baseURL,
    body: { pathname, value: body },
    method: "PUT",
  })
  assert.equal(put.pathname, pathname)

  const list = await ofetch("/api/blob", { baseURL }) as { blobs: Array<{ pathname: string }> }
  assert.ok(list.blobs.some(blob => blob.pathname === pathname))

  const head = await ofetch("/api/blob/head", {
    baseURL,
    query: { pathname },
  }) as { pathname: string }
  assert.equal(head.pathname, pathname)

  const get = await ofetch("/api/blob/body", {
    baseURL,
    query: { pathname },
  }) as { ok: boolean, text: string | null }
  assert.deepEqual(get, { ok: true, text: body })

  const served = await fetch(new URL(`/api/blob/serve?pathname=${encodeURIComponent(pathname)}`, baseURL))
  assert.equal(served.status, 200)
  assert.equal(await served.text(), body)

  await ofetch("/api/blob", {
    baseURL,
    body: { pathname },
    method: "DELETE",
  })

  try {
    await ofetch("/api/blob/head", {
      baseURL,
      query: { pathname },
    })
    throw new Error("Expected deleted blob lookup to fail.")
  }
  catch (error) {
    assert.ok(error instanceof FetchError)
  }
}

async function runLive(url: string) {
  log(`live -> ${url}`)
  await assertBlobRoundtrip(url)
  log("live ✓")
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
if (provider) {
  assert.ok(PROVIDERS.includes(provider), `invalid --provider: ${provider}`)
}
if (framework) {
  assert.ok(FRAMEWORKS.includes(framework), `invalid --framework: ${framework}`)
}

if (mode !== "live") {
  throw new TypeError(liveOnlyMessage)
}

assert.ok(values.url, "--url required for live mode")
await runLive(String(values.url))
