import assert from "node:assert/strict"
import { parseArgs } from "node:util"

const providers = ["cloudflare"]
const usage = "Rate Limit e2e requires --mode local|live --provider cloudflare --url <url>; Vercel has no native Rate Limit provider."
const log = message => console.log(`[rate-limit e2e] ${message}`)

async function request(baseURL, path) {
  const response = await fetch(new URL(path, baseURL), { method: "POST" })
  const body = await response.text()
  return { body, status: response.status }
}

async function run(url, mode, provider) {
  log(`${mode} ${provider} -> ${url}`)
  const key = `e2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  const keyedPath = `/api/tests/rate-limit?key=${encodeURIComponent(key)}`

  const first = await request(url, keyedPath)
  assert.equal(first.status, 200, `Fresh Rate Limit key failed with ${first.status}: ${first.body}`)

  const address = await request(url, "/api/tests/rate-limit/address")
  assert.equal(address.status, 200, `Default request address failed with ${address.status}: ${address.body}`)

  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await request(url, keyedPath)
    if (response.status === 429) {
      log(`${mode} ${provider} ✓`)
      return
    }
    assert.equal(response.status, 200, `Unexpected Rate Limit response ${response.status}: ${response.body}`)
    await new Promise(resolve => setTimeout(resolve, 250))
  }

  assert.fail("Cloudflare Rate Limit did not eventually reject repeated requests.")
}

const { values } = parseArgs({
  options: {
    mode: { type: "string" },
    provider: { type: "string" },
    url: { type: "string" },
  },
  strict: true,
})

const mode = values.mode
const provider = values.provider
if (mode !== "local" && mode !== "live") throw new TypeError(usage)
if (!provider || !providers.includes(provider)) throw new TypeError(usage)
assert.ok(values.url, usage)

await run(String(values.url), mode, provider)
