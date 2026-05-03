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
  delete process.env.TELEGRAM_BOT_TOKEN
})

describe("Nitro module", () => {
  it("writes runtime files, installs aliases, and describes runtime env", async () => {
    process.env.AUTH_SECRET = "a".repeat(32)
    process.env.DATABASE_URL = "https://db.example.com"
    process.env.TELEGRAM_BOT_TOKEN = "telegram-secret"

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
          authSecret: envVariable({ secret: true }),
          databaseUrl: envVariable(),
          optionalApiBase: envVariable({ optional: true, source: envSource.env("PUBLIC_API_BASE") }),
          telegram: {
            apiBaseUrl: envVariable({ optional: true }),
            botToken: envVariable({ secret: true }),
          },
          vertex: {
            model: envVariable({ default: "gemini-3.1-pro-preview-customtools" }),
          },
        },
        preset: "cloudflare-module",
        rootDir: root,
      },
    }

    await envNitro({ diagnostics: "trace" }).setup(nitro as never)

    expect(nitro.options.alias?.["#vitehub/env/server"]).toContain("/packages/env/src/runtime/server.ts")
    expect(nitro.options.plugins).toHaveLength(1)
    expect(nitro.options.handlers).toBeUndefined()
    expect(nitro.options.cloudflare?.wrangler?.secrets?.required).toEqual(["EXISTING_SECRET", "AUTH_SECRET", "TELEGRAM_BOT_TOKEN"])
    expect(nitro.logger.info).toHaveBeenCalledWith(expect.stringContaining("env.databaseUrl"))
    expect(nitro.logger.info).toHaveBeenCalledWith(expect.stringContaining("env.telegram.botToken"))

    const typesHook = nitro.hooks.hook.mock.calls.find(([name]) => name === "types:extend")?.[1]
    const tsConfig = { include: [] as string[] }
    await typesHook?.({ tsConfig })
    const types = await readFile(join(root, ".nitro/types/vitehub-env.d.ts"), "utf8")
    expect(types).toContain("export interface SafeRuntimeConfig")
    expect(types).toContain("\"databaseUrl\": string")
    expect(types).toContain("\"optionalApiBase\": string | undefined")
    expect(types).toContain("\"telegram\": {")
    expect(types).toContain("\"apiBaseUrl\": string | undefined")
    expect(types).toContain("\"botToken\": string")
    expect(types).toContain("\"vertex\": {")
    expect(types).toContain("\"model\": string")
    expect(types).toContain("useSafeRuntimeConfig(event?: unknown): SafeRuntimeConfig")
    expect(types).toContain("declare module \"nitro/types\"")
    expect(types).toContain("export interface NitroRuntimeConfig")
    expect(types).not.toContain("declare module \"@vitehub/chat\"")
    expect(types).not.toContain("ChatRuntimeConfig")
    expect(types).not.toContain("declare module \"@vitehub/chat/nitro\"")
    expect(types).not.toContain("NitroChatRuntimeConfig")
    expect(tsConfig.include).toContain(join(root, ".nitro/types/vitehub-env.d.ts"))

    const registry = await readFile(join(root, ".vitehub/nitro-runtime/env/registry.mjs"), "utf8")
    expect(registry).toContain("DATABASE_URL")
    expect(registry).toContain("TELEGRAM_BOT_TOKEN")
    expect(registry).toContain("\"required\": false")
    expect(registry).not.toContain("aaaaaaaa")
    expect(registry).not.toContain("telegram-secret")
  })

  it("applies prefixes to inferred Nitro env names and required Cloudflare secrets", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-env-nitro-"))
    const nitro: NitroStub = {
      hooks: { hook: vi.fn() },
      logger: { info: vi.fn() },
      options: {
        buildDir: join(root, ".nitro"),
        cloudflare: {},
        env: {
          telegram: {
            botToken: envVariable({ secret: true }),
          },
        },
        rootDir: root,
      },
    }

    await envNitro({ prefix: "VITEHUB_" }).setup(nitro as never)

    expect(nitro.options.cloudflare?.wrangler?.secrets?.required).toEqual(["VITEHUB_TELEGRAM_BOT_TOKEN"])
    const registry = await readFile(join(root, ".vitehub/nitro-runtime/env/registry.mjs"), "utf8")
    expect(registry).toContain("VITEHUB_TELEGRAM_BOT_TOKEN")
  })

  it("resolves nested runtime config objects", async () => {
    const { applyEnvRegistryToRuntimeConfig, setEnvRegistry, useSafeRuntimeConfig } = await import("../src/runtime/server.ts")
    process.env.TELEGRAM_BOT_TOKEN = "telegram-secret"

    setEnvRegistry({
      telegram: {
        apiBaseUrl: {
          required: false,
          secret: false,
          source: { kind: "env", label: "env:TELEGRAM_API_BASE_URL", name: "TELEGRAM_API_BASE_URL", serializable: true },
        },
        botToken: {
          required: true,
          secret: true,
          source: { kind: "env", label: "env:TELEGRAM_BOT_TOKEN", name: "TELEGRAM_BOT_TOKEN", serializable: true },
        },
      },
      vertex: {
        model: {
          default: "gemini-3.1-pro-preview-customtools",
          required: true,
          secret: false,
          source: { kind: "env", label: "env:VERTEX_MODEL", name: "VERTEX_MODEL", serializable: true },
        },
      },
    })

    const config = useSafeRuntimeConfig(undefined) as {
      telegram: { apiBaseUrl?: string, botToken: string }
      vertex: { model: string }
    }

    expect(config.telegram.botToken).toBe("telegram-secret")
    expect(config.telegram.apiBaseUrl).toBeUndefined()
    expect(config.vertex.model).toBe("gemini-3.1-pro-preview-customtools")

    const runtimeConfig = { chat: { enabled: true } } as Record<string, unknown>
    applyEnvRegistryToRuntimeConfig(runtimeConfig)
    expect(runtimeConfig).toMatchObject({
      chat: { enabled: true },
      telegram: { botToken: "telegram-secret" },
      vertex: { model: "gemini-3.1-pro-preview-customtools" },
    })
    expect((runtimeConfig.telegram as { apiBaseUrl?: string }).apiBaseUrl).toBeUndefined()
  })

  it("throws when required runtime config values are missing", async () => {
    const { applyEnvRegistryToRuntimeConfig, setEnvRegistry } = await import("../src/runtime/server.ts")

    setEnvRegistry({
      telegram: {
        botToken: {
          required: true,
          secret: true,
          source: { kind: "env", label: "env:TELEGRAM_BOT_TOKEN", name: "TELEGRAM_BOT_TOKEN", serializable: true },
        },
      },
    })

    expect(() => applyEnvRegistryToRuntimeConfig({})).toThrow("Missing runtime env value env.telegram.botToken")
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
