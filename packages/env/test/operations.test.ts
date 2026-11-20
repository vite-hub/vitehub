import { describe, expect, it, vi } from "vitest"

import { createOperationRegistry, runOperation } from "@vite-hub/internal/operations"

import { env } from "../src/core/declarations.ts"
import { createRuntimeRegistry } from "../src/core/resolve.ts"
import { envOperations } from "../src/operations.ts"
import { defineEnvProvider } from "../src/provider.ts"
import { inspectServerEnv } from "../src/server.ts"

const canary = "canary-7f3a9c-do-not-return"

const serverEnv = createRuntimeRegistry({
  apiKey: env({ secret: true, source: env.source("VENDOR_API_KEY") }),
  region: env({ default: "eu" }),
  databaseUrl: env({ secret: true, source: env.source(["DATABASE_URL", "TURSO_DATABASE_URL"], { canonical: false }) }),
  webhook: env({ secret: true }),
  token: env({ secret: true, source: env.provider("vault", "token") }),
  lost: env({ optional: true, source: env.provider("vault", "lost") }),
})

vi.mock("#vitehub/env/server", () => ({
  inspectServerEnv: () => inspectServerEnv(serverEnv, undefined, { providers: { vault: defineEnvProvider({ read: ({ keys }) => Object.fromEntries(keys.filter(key => key === "token").map(key => [key, canary])) }) } }),
}))

const registry = createOperationRegistry([{ operations: envOperations }])

function call(bindings: Record<string, unknown> | undefined, sections: "all" | readonly string[] = "all") {
  return runOperation(registry, "env.inspect", {}, { access: { mode: "app", sections }, ...(bindings ? { env: bindings } : {}), surface: "cli", user: null })
}

describe("env.inspect", () => {
  it("returns the status of each Server Env entry and the name that supplied it, without values", async () => {
    const result = await call({ VITEHUB_API_KEY: "", VENDOR_API_KEY: canary, TURSO_DATABASE_URL: canary, VITEHUB_WEBHOOK: "" })
    expect(result).toEqual({
      ok: true,
      value: {
        entries: [
          { blocking: false, name: "VENDOR_API_KEY", names: ["VITEHUB_API_KEY", "VENDOR_API_KEY"], path: "env.server.apiKey", required: true, secret: true, source: "env", status: "available" },
          { blocking: false, names: ["VITEHUB_REGION", "REGION"], path: "env.server.region", required: true, secret: false, source: "env", status: "defaulted" },
          { blocking: false, name: "TURSO_DATABASE_URL", names: ["DATABASE_URL", "TURSO_DATABASE_URL"], path: "env.server.databaseUrl", required: true, secret: true, source: "env", status: "available" },
          { blocking: true, names: ["VITEHUB_WEBHOOK", "WEBHOOK"], path: "env.server.webhook", required: true, secret: true, source: "env", status: "missing" },
          { blocking: false, path: "env.server.token", provider: "vault", required: true, secret: true, source: "provider", status: "available" },
          { blocking: false, path: "env.server.lost", provider: "vault", required: false, secret: false, source: "provider", status: "missing" },
        ],
        ok: false,
      },
    })
    expect(JSON.stringify(result)).not.toContain(canary)
    expect(JSON.stringify(result)).not.toContain(String(canary.length))
  })

  it("is ok when every required value is set", async () => {
    const result = await call({ VENDOR_API_KEY: canary, DATABASE_URL: canary, WEBHOOK: canary })
    expect(result).toMatchObject({ ok: true, value: { ok: true } })
    expect(JSON.stringify(result)).not.toContain(canary)
  })

  it("names the host that the app runs on", async () => {
    vi.stubEnv("VITEHUB_HOST", "cloudflare")
    try {
      expect(await call({})).toMatchObject({ ok: true, value: { host: "cloudflare" } })
    }
    finally {
      vi.unstubAllEnvs()
    }
  })

  it("answers only to a call whose access includes the env section", async () => {
    expect(await call({}, ["kv"])).toMatchObject({ code: "INTERNAL_R0023", ok: false, status: 403 })
    expect(await call({}, ["env:read"])).toMatchObject({ ok: true })
  })

  it("is a read operation with a `vitehub env status` command", () => {
    expect(registry.get("env.inspect")).toMatchObject({ cli: { command: "status" }, kind: "read", section: "env" })
  })
})
