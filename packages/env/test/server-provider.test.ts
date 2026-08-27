import { describe, expect, it, vi } from "vitest"
import { ViteHubError } from "@vite-hub/runtime"

import { env } from "../src/core/declarations.ts"
import { createRuntimeRegistry } from "../src/core/resolve.ts"
import { defineEnvProvider } from "../src/provider.ts"
import { inspectServerEnv, loadServerEnv, resolveServerEnv } from "../src/server.ts"
import type { EnvProviderValues } from "../src/types.ts"

function providerRegistry() {
  return createRuntimeRegistry({
    gatewayKey: env({ secret: true, source: env.source("GATEWAY_KEY") }),
    codexAuth: env({ secret: true, source: env.provider("secrets", "codex-auth") }),
    primary: env({ secret: true, source: env.provider("secrets", "remote-token") }),
    secondary: env({ source: env.provider("secrets", "remote-token") }),
    static: { flags: ["one", "two"] },
  })
}

describe("Server Env providers", () => {
  it("keeps local values synchronous and loads one immutable provider snapshot", async () => {
    const providerValues = { "codex-auth": "codex-secret", "remote-token": "first-token" }
    const read = vi.fn(async (input: { env: Readonly<Record<string, unknown>>, keys: readonly string[], signal?: AbortSignal }) => {
      const { env: localEnv, keys } = input
      expect(Object.keys(input).sort()).toEqual(["env", "keys", "signal"])
      expect(Object.hasOwn(input, "event")).toBe(false)
      expect((localEnv.gatewayKey as { unseal(): string }).unseal()).toBe("gateway-secret")
      expect(Object.hasOwn(localEnv, "undeclaredRawSecret")).toBe(false)
      expect(Object.isFrozen(localEnv)).toBe(true)
      expect(keys).toEqual(["codex-auth", "remote-token"])
      expect(Object.isFrozen(keys)).toBe(true)
      return providerValues
    })
    const registry = providerRegistry()
    const event = { env: { GATEWAY_KEY: "gateway-secret", undeclaredRawSecret: "must-not-cross-provider-boundary" } }

    const local = resolveServerEnv<{
      gatewayKey: { unseal(): string }
      codexAuth: { unseal(): string }
      primary: { unseal(): string }
    }>(registry, event)
    expect(local.gatewayKey.unseal()).toBe("gateway-secret")
    expect(() => local.primary).toThrow("Server Env requires asynchronous loading")

    const snapshot = await loadServerEnv<{
      codexAuth: { unseal(): string }
      gatewayKey: { unseal(): string }
      primary: { unseal(): string }
      secondary: string
      static: { flags: string[] }
    }>(registry, event, { providers: { secrets: defineEnvProvider({ read }) } })

    providerValues["remote-token"] = "mutated-after-load"
    expect(read).toHaveBeenCalledTimes(1)
    expect(snapshot.codexAuth.unseal()).toBe("codex-secret")
    expect(snapshot.primary.unseal()).toBe("first-token")
    expect(snapshot.secondary).toBe("first-token")
    expect(String(snapshot.primary)).toBe("<redacted>")
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.static)).toBe(true)
    expect(Object.isFrozen(snapshot.static.flags)).toBe(true)

    const next = await loadServerEnv<typeof snapshot>(registry, event, { providers: { secrets: defineEnvProvider({ read }) } })
    expect(next.static.flags).not.toBe(snapshot.static.flags)
    expect(next.primary.unseal()).toBe("mutated-after-load")
    expect(snapshot.primary.unseal()).toBe("first-token")
  })

  it("observes rotation only on the next load and isolates concurrent loads", async () => {
    const registry = createRuntimeRegistry({
      token: env({ source: env.provider("secrets", "token") }),
    })
    let current = "first"
    const provider = defineEnvProvider({
      read: vi.fn(async () => ({ token: current })),
    })

    await expect(loadServerEnv<{ token: string }>(registry, undefined, { providers: { secrets: provider } }))
      .resolves.toEqual({ token: "first" })
    current = "second"
    await expect(loadServerEnv<{ token: string }>(registry, undefined, { providers: { secrets: provider } }))
      .resolves.toEqual({ token: "second" })
    expect(provider.read).toHaveBeenCalledTimes(2)

    const pending: Array<(value: { token: string }) => void> = []
    const concurrentProvider = defineEnvProvider({
      read: vi.fn(async () => await new Promise<{ token: string }>(resolve => pending.push(resolve))),
    })
    const first = loadServerEnv<{ token: string }>(registry, undefined, { providers: { secrets: concurrentProvider } })
    const second = loadServerEnv<{ token: string }>(registry, undefined, { providers: { secrets: concurrentProvider } })
    await vi.waitFor(() => expect(pending).toHaveLength(2))
    pending[1]!({ token: "second-complete" })
    pending[0]!({ token: "first-complete" })
    await expect(first).resolves.toEqual({ token: "first-complete" })
    await expect(second).resolves.toEqual({ token: "second-complete" })
  })

  it("preserves abort identity before and during non-cooperative provider work", async () => {
    const registry = createRuntimeRegistry({
      token: env({ source: env.provider("secrets", "token") }),
    })
    const before = new AbortController()
    const beforeReason = new Error("cancelled before load")
    before.abort(beforeReason)
    const provider = defineEnvProvider({ read: vi.fn(async () => ({ token: "unused" })) })
    const missingLocalRegistry = createRuntimeRegistry({
      requiredLocal: env({ source: env.source("MISSING_LOCAL") }),
      token: env({ source: env.provider("secrets", "token") }),
    })
    await expect(loadServerEnv(missingLocalRegistry, undefined, {
      providers: { secrets: provider },
      signal: before.signal,
    })).rejects.toBe(beforeReason)
    await expect(inspectServerEnv(missingLocalRegistry, undefined, {
      providers: { secrets: provider },
      signal: before.signal,
    })).rejects.toBe(beforeReason)
    expect(provider.read).not.toHaveBeenCalled()

    const during = new AbortController()
    const duringReason = new Error("cancelled during load")
    const hanging = defineEnvProvider({
      read: vi.fn(async ({ signal }: { signal?: AbortSignal }) => {
        if (!signal) return { token: "independent" }
        expect(signal).toBe(during.signal)
        return await new Promise<EnvProviderValues>(() => {})
      }),
    })
    const loading = loadServerEnv(registry, undefined, {
      providers: { secrets: hanging },
      signal: during.signal,
    })
    await vi.waitFor(() => expect(hanging.read).toHaveBeenCalledOnce())
    await expect(loadServerEnv<{ token: string }>(registry, undefined, {
      providers: { secrets: hanging },
    })).resolves.toEqual({ token: "independent" })
    during.abort(duringReason)
    await expect(loading).rejects.toBe(duringReason)
  })

  it("preserves provider AbortError and ViteHubError identity", async () => {
    const registry = createRuntimeRegistry({ token: env({ source: env.provider("secrets", "token") }) })
    const abort = Object.assign(new Error("provider cancelled"), { name: "AbortError" })
    await expect(loadServerEnv(registry, undefined, {
      providers: { secrets: defineEnvProvider({ read: async () => Promise.reject(abort) }) },
    })).rejects.toBe(abort)

    const existing = new ViteHubError("ENV_SOURCE_FAILED", "Application provider failure.", { details: { source: "provider" } })
    await expect(loadServerEnv(registry, undefined, {
      providers: { secrets: defineEnvProvider({ read: async () => Promise.reject(existing) }) },
    })).rejects.toBe(existing)
  })

  it("applies missing, default, invalid, and safe provider error contracts", async () => {
    const registry = createRuntimeRegistry({
      defaulted: env({ default: "fallback", source: env.provider("values", "missing-default") }),
      invalid: env({ optional: true, source: env.provider("values", "invalid-value") }),
      missing: env({ optional: true, secret: true, source: env.provider("values", "missing-optional") }),
      failed: env({ optional: true, secret: true, source: env.provider("failed", "private/remote-key") }),
    })
    const values = defineEnvProvider({
      // Deliberately bypass the public value type to prove runtime hardening at an untyped boundary.
      read: vi.fn(async () => ({ "invalid-value": { secret: "must-not-leak" } }) as unknown as EnvProviderValues),
    })
    const failed = defineEnvProvider({
      read: vi.fn(async () => {
        throw new Error("https://user:credential@example.test/private/remote-key")
      }),
    })

    const inspection = await inspectServerEnv(registry, undefined, { providers: { failed, values } })
    expect(inspection.entries).toEqual([
      { masked: false, path: "env.server.defaulted", source: "provider", status: "defaulted" },
      { masked: false, path: "env.server.invalid", source: "provider", status: "invalid" },
      { masked: true, path: "env.server.missing", source: "provider", status: "missing" },
      { masked: true, path: "env.server.failed", source: "provider", status: "error" },
    ])
    expect(Object.isFrozen(inspection)).toBe(true)
    expect(JSON.stringify(inspection)).not.toMatch(/remote-key|credential|example\.test|must-not-leak/)

    const required = createRuntimeRegistry({
      token: env({ secret: true, source: env.provider("failed", "private/remote-key") }),
    })
    const error = await loadServerEnv(required, undefined, { providers: { failed } }).then(() => undefined, value => value)
    expect(error).toMatchObject({
      code: "ENV_SOURCE_FAILED",
      details: { source: "provider" },
      message: "[vitehub] Env source resolution failed.",
    })
    expect(JSON.stringify(error)).not.toMatch(/remote-key|credential|example\.test/)

    const missingRequired = await loadServerEnv(required, undefined, {
      providers: { failed: defineEnvProvider({ read: async () => ({}) }) },
    }).then(() => undefined, value => value)
    expect(missingRequired).toMatchObject({
      code: "ENV_REQUIRED_MISSING",
      details: { source: "provider" },
      message: "[vitehub] Required Env value is missing.",
    })

    const hostile = createRuntimeRegistry({
      "https://user:token@example.test": env({ optional: true, source: env.provider("values", "private/remote-key") }),
    })
    const hostileInspection = await inspectServerEnv(hostile, undefined, { providers: { values } })
    expect(hostileInspection.entries).toEqual([
      { masked: false, source: "provider", status: "missing" },
    ])
    expect(JSON.stringify(hostileInspection)).not.toMatch(/token|example\.test|remote-key/)
  })

  it("rejects accessors and prototype-bearing provider snapshots without reading them", async () => {
    const registry = createRuntimeRegistry({
      token: env({ source: env.provider("secrets", "token") }),
    })
    const getter = vi.fn(() => "secret")
    const accessor = Object.defineProperty({}, "token", { enumerable: true, get: getter })
    const accessorError = await loadServerEnv(registry, undefined, {
      providers: { secrets: defineEnvProvider({ read: async () => accessor }) },
    }).then(() => undefined, error => error)
    expect(accessorError).toMatchObject({ code: "ENV_RUNTIME_VALUE_INVALID", details: { source: "provider" } })
    expect(getter).not.toHaveBeenCalled()

    await expect(loadServerEnv(registry, undefined, {
      providers: {
        secrets: defineEnvProvider({
          // Deliberately bypass the public return type to prove runtime hardening at an untyped boundary.
          read: async () => new (class ProviderValues { token = "secret" })() as unknown as EnvProviderValues,
        }),
      },
    })).rejects.toMatchObject({ code: "ENV_RUNTIME_VALUE_INVALID", details: { source: "provider" } })
  })
})
