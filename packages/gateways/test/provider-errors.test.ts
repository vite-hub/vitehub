import { afterEach, describe, expect, it, vi } from "vitest"

import { ask, typesafe, vercel } from "../src/index.ts"

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

const questions = { accepted: ask.if("Accept it?", { threshold: 0.5 }) }
const answered = () => Response.json({ answers: { accepted: { type: "noul", noul: 0.75 } } })
const failed = (status: number) => Response.json({ error: { message: `provider said ${status}` } }, { status, headers: { "x-vercel-id": `request-${status}` } })

describe("Jev provider errors", () => {
  it("retries a transient provider failure and returns the answer", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(failed(502))
      .mockResolvedValueOnce(failed(429))
      .mockResolvedValueOnce(answered())
    vi.stubGlobal("fetch", fetch)
    await expect(typesafe({ apiKey: "test-sdk-key" }).ask("state", questions)).resolves.toEqual({ accepted: true })
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it("names a provider that keeps failing and keeps its response as the cause", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => failed(503))
    vi.stubGlobal("fetch", fetch)
    const error = await typesafe({ apiKey: "test-sdk-key" }).ask("state", questions).catch((error: unknown) => error)
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(error).toMatchObject({ code: "GATEWAYS_R0009", status: 502, providerStatus: 503, requestId: "request-503" })
    expect(String((error as Error).message)).toContain("failed with HTTP 503 after 3 attempts")
    expect((error as Error).cause).toMatchObject({ status: 503 })
  })

  it.each([401, 403])("names the API key variable when the provider answers %i, without retrying", async (status) => {
    vi.stubEnv("AI_GATEWAY_API_KEY", "expired-key")
    const fetch = vi.fn<typeof globalThis.fetch>(async () => failed(status))
    vi.stubGlobal("fetch", fetch)
    const error = await vercel().ask("state", questions).catch((error: unknown) => error)
    expect(fetch).toHaveBeenCalledOnce()
    expect(error).toMatchObject({ code: "GATEWAYS_R0008", status: 503, providerStatus: status })
    expect(String((error as Error).message)).toContain(`Vercel AI Gateway Jev provider rejected the API key with HTTP ${status}`)
    expect((error as { fix?: string }).fix).toContain("AI_GATEWAY_API_KEY")
  })

  it("does not retry a request the provider rejects as invalid", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => failed(400))
    vi.stubGlobal("fetch", fetch)
    await expect(typesafe({ apiKey: "test-sdk-key" }).ask("state", questions)).rejects.toMatchObject({ status: 400 })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it("requires AI_GATEWAY_API_KEY for Vercel outside Vercel, before any request", async () => {
    for (const name of ["AI_GATEWAY_API_KEY", "VITEHUB_VERCEL_API_KEY", "VERCEL_OIDC_TOKEN"]) vi.stubEnv(name, "")
    const fetch = vi.fn<typeof globalThis.fetch>()
    vi.stubGlobal("fetch", fetch)
    await expect(vercel().ask("state", questions)).rejects.toMatchObject({ code: "GATEWAYS_R0002", message: expect.stringContaining("AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN") })
    expect(fetch).not.toHaveBeenCalled()
  })

  it("lets Vercel use VERCEL_OIDC_TOKEN when no key is set", async () => {
    vi.stubEnv("AI_GATEWAY_API_KEY", "")
    vi.stubEnv("VITEHUB_VERCEL_API_KEY", "")
    vi.stubEnv("VERCEL_OIDC_TOKEN", "oidc-token")
    const fetch = vi.fn<typeof globalThis.fetch>(async () => answered())
    vi.stubGlobal("fetch", fetch)
    await vercel().ask("state", questions)
    expect(fetch).toHaveBeenCalledOnce()
    const headers = new Headers(fetch.mock.calls[0]?.[1]?.headers)
    expect(headers.get("authorization")).toBe("Bearer oidc-token")
    expect(headers.get("ai-gateway-auth-method")).toBe("oidc")
  })
})
