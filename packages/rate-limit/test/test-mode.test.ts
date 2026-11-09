import { afterAll, expect, it } from "vitest"

import { enableViteHubTestMode } from "@vite-hub/runtime/internal/test-mode-setup"

import { checkRateLimit } from "../src/index.ts"
import { setRateLimitRuntimeConfig } from "../src/runtime.ts"

const mode = enableViteHubTestMode()

afterAll(async () => {
  await mode.reset()
  Reflect.deleteProperty(globalThis, Symbol.for("vitehub.test"))
  setRateLimitRuntimeConfig({ provider: "memory" })
})

it("counts in memory per test, also with a Cloudflare config and a request without an address", async () => {
  setRateLimitRuntimeConfig({ provider: "cloudflare" })
  const request = () => new Request("https://example.com/upload", { method: "POST" })

  expect((await checkRateLimit(request(), "uploads", { limit: 1, window: "1m" }))[1]?.allowed).toBe(true)
  expect((await checkRateLimit(request(), "uploads", { limit: 1, window: "1m" }))[1]?.allowed).toBe(false)

  await mode.reset()

  expect((await checkRateLimit(request(), "uploads", { limit: 1, window: "1m" }))[1]?.allowed).toBe(true)
})
