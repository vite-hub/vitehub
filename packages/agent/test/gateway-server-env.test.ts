import { afterEach, expect, it, vi } from "vitest"

import { ask, cloudflare, vercel } from "@vite-hub/gateways"
import { ViteHubError } from "@vite-hub/runtime"

afterEach(() => {
  vi.doUnmock("#vitehub/env/server")
  vi.unstubAllEnvs()
})

function providerEnv(preset: string, values: Record<string, unknown>) {
  vi.resetModules()
  const declared = Object.fromEntries(Object.keys(values).map(field => [field, {
    enumerable: true,
    get: () => { throw new ViteHubError("ENV_ASYNC_REQUIRED", "Server Env requires asynchronous loading.") },
  }]))
  const loadServerEnv = vi.fn(async () => ({ [preset]: values }))
  vi.doMock("#vitehub/env/server", () => ({
    loadServerEnv,
    useServerEnv: () => ({ [preset]: Object.defineProperties({}, declared) }),
  }))
  return loadServerEnv
}

it("authenticates with a provider-backed Vercel OIDC token", async () => {
  vi.stubEnv("AI_GATEWAY_API_KEY", "host-key")
  vi.stubEnv("VERCEL_OIDC_TOKEN", "host-token")
  const loadServerEnv = providerEnv("vercel", { apiKey: undefined, oidcToken: { unseal: () => "provider-token" } })
  const { askJev } = await import("../src/internal/ask-runtime.ts")
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ answers: { accepted: { type: "boolean", probability: 0.9 } } }))
  const signal = new AbortController().signal

  await expect(askJev({ abortSignal: signal, gateway: vercel({ fetch }) }, "state", { accepted: ask.if("Accept?") })).resolves.toEqual({ accepted: true })
  expect(loadServerEnv).toHaveBeenCalledExactlyOnceWith(undefined, { signal })
  const headers = new Headers(fetch.mock.calls[0]?.[1]?.headers)
  expect(headers.get("authorization")).toBe("Bearer provider-token")
  expect(headers.get("ai-gateway-auth-method")).toBe("oidc")
})

it("shares one provider snapshot and abort signal across Cloudflare gateway fields", async () => {
  const loadServerEnv = providerEnv("cloudflare", {
    accountId: "account",
    apiKey: "provider-key",
    gatewayId: "gateway",
    slug: "jev",
    token: "gateway-token",
  })
  const { askJev } = await import("../src/internal/ask-runtime.ts")
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ answers: { accepted: { type: "noul", noul: 0.9 } } }))
  const signal = new AbortController().signal

  await expect(askJev({ abortSignal: signal, gateway: cloudflare({ fetch }) }, "state", { accepted: ask.if("Accept?") })).resolves.toEqual({ accepted: true })
  expect(loadServerEnv).toHaveBeenCalledExactlyOnceWith(undefined, { signal })
  expect(fetch.mock.calls[0]?.[0]).toBe("https://gateway.ai.cloudflare.com/v1/account/gateway/custom-jev/v1/systemone")
  const headers = new Headers(fetch.mock.calls[0]?.[1]?.headers)
  expect(headers.get("authorization")).toBe("Bearer provider-key")
  expect(headers.get("cf-aig-authorization")).toBe("Bearer gateway-token")
})
