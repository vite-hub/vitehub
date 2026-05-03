import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { envNitro, envSource, envVariable } from "../src/nitro.ts"

import { stringSchema } from "./helpers.ts"

interface NitroStub {
  hooks: { hook: ReturnType<typeof vi.fn> }
  logger: { info: ReturnType<typeof vi.fn> }
  options: {
    alias?: Record<string, string>
    buildDir: string
    cloudflare?: {
      wrangler?: {
        secrets?: {
          required?: string[]
        }
      }
    }
    env?: unknown
    handlers?: Array<{ handler: string, route: string }>
    plugins?: string[]
    preset?: string
    rootDir: string
  }
}

afterEach(() => {
  delete process.env.AUTH_SECRET
  delete process.env.DATABASE_URL
  delete process.env.PUBLIC_API_BASE
})

describe("Nitro module", () => {
  it("writes runtime files, installs aliases, and describes runtime env", async () => {
    process.env.AUTH_SECRET = "a".repeat(32)
    process.env.DATABASE_URL = "https://db.example.com"

    const root = await mkdtemp(join(tmpdir(), "vitehub-env-nitro-"))
    const nitro: NitroStub = {
      hooks: { hook: vi.fn() },
      logger: { info: vi.fn() },
      options: {
        buildDir: join(root, ".nitro"),
        cloudflare: {
          wrangler: {
            secrets: {
              required: ["EXISTING_SECRET"],
            },
          },
        },
        env: {
          authSecret: envVariable("AUTH_SECRET", { secret: true }),
          databaseUrl: envVariable("DATABASE_URL"),
          optionalApiBase: envVariable("PUBLIC_API_BASE", { optional: true }),
        },
        preset: "cloudflare-module",
        rootDir: root,
      },
    }

    await envNitro({ diagnostics: "trace" }).setup(nitro as never)

    expect(nitro.options.alias?.["#vitehub/env/server"]).toContain("/packages/env/src/runtime/server.ts")
    expect(nitro.options.plugins).toHaveLength(1)
    expect(nitro.options.handlers).toBeUndefined()
    expect(nitro.options.cloudflare?.wrangler?.secrets?.required).toEqual(["EXISTING_SECRET", "AUTH_SECRET"])
    expect(nitro.logger.info).toHaveBeenCalledWith(expect.stringContaining("env.databaseUrl"))

    const typesHook = nitro.hooks.hook.mock.calls.find(([name]) => name === "types:extend")?.[1]
    const tsConfig = { include: [] as string[] }
    await typesHook?.({ tsConfig })
    const types = await readFile(join(root, ".nitro/types/vitehub-env.d.ts"), "utf8")
    expect(types).toContain("export interface SafeRuntimeConfig")
    expect(types).toContain("\"databaseUrl\": string")
    expect(types).toContain("\"optionalApiBase\": string | undefined")
    expect(types).toContain("useSafeRuntimeConfig(event?: unknown): SafeRuntimeConfig")
    expect(tsConfig.include).toContain(join(root, ".nitro/types/vitehub-env.d.ts"))

    const registry = await readFile(join(root, ".vitehub/nitro-runtime/env/registry.mjs"), "utf8")
    expect(registry).toContain("DATABASE_URL")
    expect(registry).toContain("\"required\": false")
    expect(registry).not.toContain("aaaaaaaa")
  })

  it("rejects custom runtime sources", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-env-nitro-"))
    const nitro: NitroStub = {
      hooks: { hook: vi.fn() },
      logger: { info: vi.fn() },
      options: {
        buildDir: join(root, ".nitro"),
        env: {
          commit: envVariable({
            schema: stringSchema(),
            source: envSource.custom("custom", () => "abc123"),
          }),
        },
        rootDir: root,
      },
    }

    await expect(envNitro().setup(nitro as never)).rejects.toThrow("build-only")
  })
})
