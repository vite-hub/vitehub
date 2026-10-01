import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("#vitehub/auth/definition", () => ({
  default: { options: { appName: "Static Auth", secret: "abcdefghijklmnopqrstuvwxyz0123456789" } },
}))

import { assertAuthOrigin, getAuthForRequest, resetAuth } from "../src/server.ts"

describe("static Auth public URL request helpers", () => {
  afterEach(() => {
    resetAuth()
    vi.unstubAllGlobals()
  })

  it.each([
    { url: "https://public.example.com" },
    { agents: { bot: "https://public.example.com", other: "https://other.example.com" } },
  ])("trusts the configured public origin behind a TLS proxy: %j", async (config) => {
    vi.stubGlobal("__VITEHUB_PUBLIC_URL__", config)
    const request = new Request("http://public.example.com/api/auth/session", {
      headers: { origin: "https://public.example.com" },
    })
    const auth = await assertAuthOrigin(request)
    expect((await auth.$context).options.baseURL).toBe("https://public.example.com")
    const other = getAuthForRequest(new Request("http://other.example.com/api/auth/session"))
    expect((await other.$context).options.baseURL).toBe("url" in config ? config.url : "https://other.example.com")
  })

  it("preserves the cached provider when no public URL is configured", () => {
    const request = new Request("http://localhost/api/auth/session")
    expect(getAuthForRequest(request)).toBe(getAuthForRequest(request))
  })

  it("preserves explicit runtime origins", async () => {
    vi.stubGlobal("__VITEHUB_PUBLIC_URL__", { url: "https://public.example.com" })
    const auth = getAuthForRequest(new Request("http://internal/api/auth/session"), {
      baseURL: "https://explicit.example.com",
    })
    expect((await auth.$context).options.baseURL).toBe("https://explicit.example.com")
  })
})
