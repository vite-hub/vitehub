import { describe, expect, it } from "vitest"
import { env } from "../src/core/declarations.ts"
import { createRuntimeRegistry } from "../src/core/resolve.ts"
import { describeServerEnv } from "../src/server.ts"

describe("Server Env declaration inventory", () => {
  it("describes host, provider and literal declarations without exposing their values or storage keys", () => {
    const registry = createRuntimeRegistry({
      host: env({ secret: true, source: env.source("PRIVATE_HOST_NAME"), default: "private-default" }),
      nested: { token: env({ secret: true, source: env.provider("vault", "private/storage/path") }) },
      label: "private-literal",
      optional: env({ optional: true }),
    })
    const description = describeServerEnv(registry)
    expect(description.entries).toEqual([
      { path: "env.server.host", source: "env", secret: true, required: true, hasDefault: true },
      { path: "env.server.nested.token", source: "provider", provider: "vault", secret: true, required: true, hasDefault: false },
      { path: "env.server.label", source: "literal", secret: false, required: false, hasDefault: false },
      { path: "env.server.optional", source: "env", secret: false, required: false, hasDefault: false },
    ])
    const serialized = JSON.stringify(description)
    for (const value of ["PRIVATE_HOST_NAME", "private-default", "private/storage/path", "private-literal"]) expect(serialized).not.toContain(value)
  })

  it("returns independent metadata and withholds unsafe declaration names ", () => {
    const registry = createRuntimeRegistry({ "secret in name!": env({ source: env.provider("vault", "key") }) })
    expect(describeServerEnv(registry).entries).toEqual([{ source: "provider", provider: "vault", secret: false, required: true, hasDefault: false }])
    expect(describeServerEnv({})).toEqual({ entries: [] })
  })
})

it("manages only declared unambiguous provider paths without resolving credentials", async () => {
  const { createServerEnvManagement } = await import("../src/server.ts")
  const { createEnvBridge } = await import("../src/bridge.ts")
  const { vi } = await import("vitest")
  const inspect = vi.fn(async () => ({ revision: "revision", updatedAt: "now" }))
  const bridge = createEnvBridge({
    secrets: { inspect, read: vi.fn(), replace: vi.fn() },
    access: { append: vi.fn(), activity: vi.fn(), grants: vi.fn(), setGrant: vi.fn(), revokeGrant: vi.fn() },
    runtimeContext: () => ({ actor: { kind: "service", id: "runtime" } }),
  })
  const authenticate = vi.fn(async () => ({ actor: { kind: "user" as const, id: "owner" }, admin: true }))
  const read = vi.fn(() => { throw new Error("Inventory must not resolve") })
  const providers = { vault: { read, management: { bridge, authenticate } } }
  const registry = createRuntimeRegistry({
    host: env({ source: env.source("HOST") }),
    token: env({ source: env.provider("vault", "private-key") }),
    "nested.token": env({ source: env.provider("vault", "ambiguous") }),
    "unsafe name": env({ source: env.provider("vault", "other") }),
  })
  expect(describeServerEnv(registry).entries[1]).toMatchObject({ source: "provider", provider: "vault" })
  expect(read).not.toHaveBeenCalled()
  const handler = createServerEnvManagement(registry, providers)
  const request = (path: string) => new Request("https://example.com/manage", { method: "POST", headers: { origin: "https://example.com" }, body: JSON.stringify({ action: "inspect", path }) })
  for (const path of ["env.server.host", "private-key", "env.server.unsafe name", "env.server.nested.token", "env.server.missing"]) expect((await handler(request(path))).status).toBe(404)
  const req = request("env.server.token")
  expect((await handler(req)).status).toBe(200)
  expect(authenticate).toHaveBeenCalledWith(req)
  expect(inspect).toHaveBeenCalledWith("private-key")
  expect(read).not.toHaveBeenCalled()
})
