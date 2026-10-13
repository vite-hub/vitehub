import { describe, expect, it, vi } from "vitest"

import { defineAuth } from "../src/definition.ts"
import { resolveAuthOptions } from "../src/runtime-options.ts"
import type { AuthRuntimeContext } from "../src/types.ts"

describe("Auth option resolution", () => {
  it("resolves one snapshot and projects provider options without repeating callbacks", () => {
    const request = new Request("https://auth.example.com/api/auth")
    const event = { req: request }
    const env = vi.fn(() => ({ secret: "env-secret" }))
    const runtime = vi.fn(({ requestOrigin, env: values }: AuthRuntimeContext) => ({ baseURL: requestOrigin, secret: String(values.secret) }))
    const definition = defineAuth({
      appName: "ViteHub",
      basePath: "/auth/",
      database: { name: "auth", dedicated: true },
      secondaryStorage: { store: "auth" },
      access: { routes: ["/private"] },
      runtime,
    })
    const resolved = resolveAuthOptions(definition, { request, event, env, runtimeOptions: { secret: "override" } })

    expect(resolved.options).toMatchObject({ access: { routes: ["/private"] }, secret: "override" })
    expect(resolved.requestRuntimeOptions).toMatchObject({ baseURL: "https://auth.example.com", trustedOrigins: ["https://auth.example.com"] })
    expect(resolved.providerOptions).toMatchObject({ appName: "ViteHub", basePath: "/auth", secret: "override" })
    for (const name of ["access", "runtime", "database", "secondaryStorage"]) expect(resolved.providerOptions).not.toHaveProperty(name)
    expect(runtime).toHaveBeenCalledOnce()
    expect(env).toHaveBeenCalledExactlyOnceWith(event)
  })

  it("projects a Definition callback without evaluating it again", () => {
    const callback = vi.fn(({ requestOrigin }: AuthRuntimeContext) => ({
      appName: "ViteHub",
      baseURL: requestOrigin,
      secret: "callback-secret",
      access: { routes: ["/private"] },
    }))
    const resolved = resolveAuthOptions(defineAuth(callback), { request: new Request("https://callback.example.com/auth") })
    expect(resolved.options).toMatchObject({ access: { routes: ["/private"] }, secret: "callback-secret" })
    expect(resolved.providerOptions).not.toHaveProperty("access")
    expect(resolved.providerOptions.baseURL).toBe("https://callback.example.com")
    expect(callback).toHaveBeenCalledOnce()
  })

  it("keeps static request origins and avoids loading unused runtime environment", () => {
    const env = vi.fn(() => { throw new Error("Unused environment must not load") })
    const definition = defineAuth({ appName: "ViteHub", trustedOrigins: ["https://trusted.example.com"] })
    const request = new Request("https://request.example.com/api/auth")
    const resolved = resolveAuthOptions(definition, { request, env })

    expect(resolved.requestRuntimeOptions).toEqual({ baseURL: "https://request.example.com" })
    expect(resolved.providerOptions.trustedOrigins).toEqual(["https://trusted.example.com"])
    expect(env).not.toHaveBeenCalled()
  })

  it("does not treat inherited trusted origins as a static configuration", () => {
    const options = Object.create({ trustedOrigins: ["https://inherited.example.com"] }) as { appName: string }
    options.appName = "ViteHub"
    const resolved = resolveAuthOptions(defineAuth(options), { request: new Request("https://request.example.com/api/auth") })

    expect(resolved.requestRuntimeOptions).toEqual({
      baseURL: "https://request.example.com",
      trustedOrigins: ["https://request.example.com"],
    })
    expect(resolved.providerOptions.trustedOrigins).toEqual(["https://request.example.com"])
  })

  it("reads static metadata only when full or provider options are needed", () => {
    const appName = vi.fn(() => "ViteHub")
    const definition = defineAuth({ appName: "ViteHub" })
    Object.defineProperty(definition.options, "appName", { enumerable: true, get: appName })
    const resolved = resolveAuthOptions(definition, { request: new Request("https://request.example.com/api/auth") })

    expect(resolved.requestRuntimeOptions).toEqual({
      baseURL: "https://request.example.com",
      trustedOrigins: ["https://request.example.com"],
    })
    expect(appName).not.toHaveBeenCalled()
    expect(resolved.options.appName).toBe("ViteHub")
    expect(resolved.providerOptions.appName).toBe("ViteHub")
    expect(resolved.providerOptions.appName).toBe("ViteHub")
    expect(appName).toHaveBeenCalledOnce()
  })

  it.each([
    { name: "request", request: new Request("https://request.example.com/api/auth"), expectedOrder: ["runtime", "env"], expectedSecret: "early" },
    { name: "default", request: undefined, expectedOrder: ["env", "runtime"], expectedSecret: "late" },
  ])("preserves static runtime and environment evaluation order for $name options", ({ request, expectedOrder, expectedSecret }) => {
    const order: string[] = []
    const definition = defineAuth({ appName: "ViteHub" })
    Object.defineProperty(definition.options, "runtime", {
      enumerable: true,
      get() {
        order.push("runtime")
        return { secret: order.includes("env") ? "late" : "early" }
      },
    })
    const env = () => {
      order.push("env")
      return {}
    }

    const resolved = resolveAuthOptions(definition, { request, env })
    expect(resolved.requestRuntimeOptions.secret).toBe(expectedSecret)
    expect(order).toEqual(expectedOrder)
  })
})
