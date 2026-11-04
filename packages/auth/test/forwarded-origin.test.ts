import { afterEach, describe, expect, it, vi } from "vitest"

import type { AuthDefinition, AuthRuntimeContext } from "../src/types.ts"

const definition = vi.hoisted(() => ({ current: { options: {} } as AuthDefinition }))
vi.mock("#vitehub/auth/definition", () => ({
  get default() { return definition.current },
}))

import { defineAuth } from "../src/definition.ts"
import { resolveAuthOptions } from "../src/runtime-options.ts"
import { assertAuthOrigin, resetAuth } from "../src/server.ts"

const secret = "abcdefghijklmnopqrstuvwxyz0123456789"

// A TLS-terminating proxy in front of the Node server: the server sees http on the internal address.
function proxiedRequest(headers: Record<string, string> = {}) {
  return new Request("http://127.0.0.1:3000/api/auth/session", {
    headers: { "x-forwarded-proto": "https", "x-forwarded-host": "app.example.com", ...headers },
  })
}

describe("Auth behind a TLS-terminating proxy", () => {
  afterEach(() => {
    resetAuth()
    vi.unstubAllGlobals()
  })

  it("ignores X-Forwarded-* headers unless the Definition trusts them", () => {
    const callback = vi.fn(({ requestOrigin }: AuthRuntimeContext) => ({ baseURL: requestOrigin, secret }))
    const resolved = resolveAuthOptions(defineAuth(callback), { request: proxiedRequest() })

    expect(callback).toHaveBeenCalledOnce()
    expect(callback.mock.calls[0]![0].requestOrigin).toBe("http://127.0.0.1:3000")
    expect(resolved.options.baseURL).toBe("http://127.0.0.1:3000")
  })

  it("gives a callback that sets advanced.trustedProxyHeaders the origin the client used", () => {
    const callback = vi.fn(({ requestOrigin }: AuthRuntimeContext) => ({
      advanced: { trustedProxyHeaders: true, useSecureCookies: requestOrigin.startsWith("https://") },
      baseURL: requestOrigin,
      secret,
    }))
    const resolved = resolveAuthOptions(defineAuth(callback), { request: proxiedRequest() })

    expect(callback.mock.lastCall![0].requestOrigin).toBe("https://app.example.com")
    expect(resolved.options).toMatchObject({
      advanced: { useSecureCookies: true },
      baseURL: "https://app.example.com",
      trustedOrigins: ["https://app.example.com"],
    })
  })

  it("runs a trusting callback once when the request carries no proxy headers", () => {
    const callback = vi.fn(({ requestOrigin }: AuthRuntimeContext) => ({ advanced: { trustedProxyHeaders: true }, baseURL: requestOrigin, secret }))
    resolveAuthOptions(defineAuth(callback), { request: new Request("https://app.example.com/api/auth/session") })
    expect(callback).toHaveBeenCalledOnce()
  })

  it.each([true, false])("uses runtime proxy trust (%s) over the static Definition", (trustedProxyHeaders) => {
    const runtime = vi.fn(({ requestOrigin }: AuthRuntimeContext) => ({
      advanced: { trustedProxyHeaders },
      baseURL: requestOrigin,
      secret,
    }))
    const definition = defineAuth({ advanced: { trustedProxyHeaders: !trustedProxyHeaders }, runtime })
    const resolved = resolveAuthOptions(definition, { request: proxiedRequest() })
    const origin = trustedProxyHeaders ? "https://app.example.com" : "http://127.0.0.1:3000"

    expect(runtime.mock.lastCall![0].requestOrigin).toBe(origin)
    expect(resolved.providerOptions).toMatchObject({ advanced: { trustedProxyHeaders }, baseURL: origin, trustedOrigins: [origin] })
    if (!trustedProxyHeaders) {
      expect(runtime.mock.calls.every(([context]) => context.requestOrigin === origin)).toBe(true)
    }
  })

  it.each([true, false])("uses caller proxy trust (%s) over a callback Definition", (trustedProxyHeaders) => {
    const callback = vi.fn(({ requestOrigin }: AuthRuntimeContext) => ({
      advanced: { trustedProxyHeaders: !trustedProxyHeaders },
      baseURL: requestOrigin,
      secret,
    }))
    const resolved = resolveAuthOptions(defineAuth(callback), {
      request: proxiedRequest(),
      runtimeOptions: { advanced: { trustedProxyHeaders } },
    })
    const origin = trustedProxyHeaders ? "https://app.example.com" : "http://127.0.0.1:3000"

    expect(callback.mock.lastCall![0].requestOrigin).toBe(origin)
    expect(resolved.providerOptions).toMatchObject({ advanced: { trustedProxyHeaders }, baseURL: origin, trustedOrigins: [origin] })
    if (!trustedProxyHeaders) expect(callback).toHaveBeenCalledOnce()
  })

  it.each([true, false])("uses caller proxy trust (%s) over a runtime callback", (trustedProxyHeaders) => {
    const runtime = vi.fn(({ requestOrigin }: AuthRuntimeContext) => ({
      advanced: { trustedProxyHeaders: !trustedProxyHeaders },
      baseURL: requestOrigin,
      secret,
    }))
    const definition = defineAuth({ advanced: { trustedProxyHeaders: true }, runtime })
    const resolved = resolveAuthOptions(definition, {
      request: proxiedRequest(),
      runtimeOptions: { advanced: { trustedProxyHeaders } },
    })
    const origin = trustedProxyHeaders ? "https://app.example.com" : "http://127.0.0.1:3000"

    expect(runtime.mock.lastCall![0].requestOrigin).toBe(origin)
    expect(resolved.providerOptions).toMatchObject({ advanced: { trustedProxyHeaders }, baseURL: origin, trustedOrigins: [origin] })
    if (!trustedProxyHeaders) expect(runtime).toHaveBeenCalledOnce()
  })

  it("treats a caller advanced object as a replacement for the Definition's advanced options", () => {
    const callback = vi.fn(({ requestOrigin }: AuthRuntimeContext) => ({
      advanced: { trustedProxyHeaders: true },
      baseURL: requestOrigin,
      secret,
    }))
    const resolved = resolveAuthOptions(defineAuth(callback), { request: proxiedRequest(), runtimeOptions: { advanced: {} } })

    expect(callback).toHaveBeenCalledOnce()
    expect(resolved.providerOptions).toMatchObject({ baseURL: "http://127.0.0.1:3000", trustedOrigins: ["http://127.0.0.1:3000"] })
  })

  it("discards forwarded values if the callback revokes proxy trust on its second run", () => {
    const callback = vi.fn(({ requestOrigin }: AuthRuntimeContext) => ({
      advanced: { trustedProxyHeaders: requestOrigin.startsWith("http://") },
      baseURL: requestOrigin,
      secret,
    }))
    const resolved = resolveAuthOptions(defineAuth(callback), { request: proxiedRequest() })

    expect(callback).toHaveBeenCalledTimes(2)
    expect(resolved.providerOptions).toMatchObject({
      advanced: { trustedProxyHeaders: false },
      baseURL: "http://127.0.0.1:3000",
      trustedOrigins: ["http://127.0.0.1:3000"],
    })
  })

  it("resolves request-scoped providers when a static runtime object enables proxy trust", async () => {
    definition.current = defineAuth({ advanced: { trustedProxyHeaders: false }, runtime: { advanced: { trustedProxyHeaders: true }, secret } })
    const auth = await assertAuthOrigin(proxiedRequest({ origin: "https://app.example.com" }))
    expect((await auth.$context).options.baseURL).toBe("https://app.example.com")

    const other = await assertAuthOrigin(proxiedRequest({ origin: "https://other.example.com", "x-forwarded-host": "other.example.com" }))
    expect((await other.$context).options.baseURL).toBe("https://other.example.com")
  })

  it("keeps the request host when the proxy sends only X-Forwarded-Proto", () => {
    const definition = defineAuth({ advanced: { trustedProxyHeaders: true }, runtime: { secret } })
    const request = new Request("http://app.example.com/api/auth/session", { headers: { "x-forwarded-proto": "https" } })
    expect(resolveAuthOptions(definition, { request }).options.baseURL).toBe("https://app.example.com")
  })

  it("prefers the configured public URL over proxy headers", () => {
    vi.stubGlobal("__VITEHUB_PUBLIC_URL__", { url: "https://public.example.com" })
    const definition = defineAuth({ advanced: { trustedProxyHeaders: true }, runtime: { secret } })
    expect(resolveAuthOptions(definition, { request: proxiedRequest() }).options.baseURL).toBe("https://public.example.com")
  })

  it("preserves an explicit caller baseURL and trustedOrigins", () => {
    vi.stubGlobal("__VITEHUB_PUBLIC_URL__", { url: "https://public.example.com" })
    const definition = defineAuth({ advanced: { trustedProxyHeaders: true }, runtime: { secret } })
    const resolved = resolveAuthOptions(definition, {
      request: proxiedRequest(),
      runtimeOptions: { baseURL: "https://auth.example.com", trustedOrigins: ["https://trusted.example.com"] },
    })
    expect(resolved.providerOptions).toMatchObject({ baseURL: "https://auth.example.com", trustedOrigins: ["https://trusted.example.com"] })
  })

  it("checks request origins against the forwarded origin in assertAuthOrigin", async () => {
    definition.current = defineAuth({ advanced: { trustedProxyHeaders: true }, runtime: { secret } })
    const auth = await assertAuthOrigin(proxiedRequest({ origin: "https://app.example.com" }))
    expect((await auth.$context).options.baseURL).toBe("https://app.example.com")

    await expect(assertAuthOrigin(proxiedRequest({ origin: "http://127.0.0.1:3000" }))).rejects.toThrow("The request origin is not trusted.")
  })

  it("rejects the client's origin in assertAuthOrigin without trusting proxy headers", async () => {
    definition.current = defineAuth(({ requestOrigin }) => ({ baseURL: requestOrigin, secret }))
    await expect(assertAuthOrigin(proxiedRequest({ origin: "https://app.example.com" }))).rejects.toThrow("The request origin is not trusted.")
  })
})
