import { readFile } from "node:fs/promises"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { rc, runtimeConfigNitro } from "../src/nitro.ts"

import { stringSchema } from "./helpers.ts"

interface NitroStub {
  hooks: { hook: ReturnType<typeof vi.fn> }
  logger: { info: ReturnType<typeof vi.fn> }
  options: {
    alias?: Record<string, string>
    buildDir: string
    handlers?: Array<{ handler: string, route: string }>
    plugins?: string[]
    rootDir: string
    vitehub?: unknown
  }
}

afterEach(() => {
  delete process.env.AUTH_SECRET
  delete process.env.DATABASE_URL
  delete process.env.PUBLIC_API_BASE
})

describe("Nitro module", () => {
  it("writes runtime files, installs aliases, validates runtime env, and exposes public transport", async () => {
    process.env.AUTH_SECRET = "a".repeat(32)
    process.env.DATABASE_URL = "https://db.example.com"
    process.env.PUBLIC_API_BASE = "https://api.example.com"

    const root = await mkdtemp(join(tmpdir(), "vitehub-runtime-config-nitro-"))
    const nitro: NitroStub = {
      hooks: { hook: vi.fn() },
      logger: { info: vi.fn() },
      options: {
        buildDir: join(root, ".nitro"),
        rootDir: root,
        vitehub: {
          runtimeConfig: {
            runtime: {
              public: {
                apiBase: rc.runtime.env("PUBLIC_API_BASE", stringSchema()),
              },
              server: {
                authSecret: rc.runtime.secret("AUTH_SECRET", stringSchema()),
                databaseUrl: rc.runtime.env("DATABASE_URL", stringSchema()),
              },
            },
          },
        },
      },
    }

    await runtimeConfigNitro({ diagnostics: "trace" }).setup(nitro as never)

    expect(nitro.options.alias?.["#vitehub/runtime-config/server"]).toContain("/packages/runtime-config/src/runtime/server.ts")
    expect(nitro.options.plugins).toHaveLength(1)
    expect(nitro.options.handlers).toContainEqual(expect.objectContaining({
      route: "/_vitehub/runtime-config",
    }))
    expect(nitro.logger.info).toHaveBeenCalledWith(expect.stringContaining("runtime.server.databaseUrl"))

    const registry = await readFile(join(root, ".vitehub/nitro-runtime/runtime-config/registry.mjs"), "utf8")
    expect(registry).toContain("DATABASE_URL")
    expect(registry).not.toContain("aaaaaaaa")
  })
})
