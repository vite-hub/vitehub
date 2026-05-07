import { execFile } from "node:child_process"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { afterEach, describe, expect, it, vi } from "vitest"

import { env, envNitro } from "../src/nitro.ts"

import { booleanSchema, stringSchema } from "./helpers.ts"

const execFileAsync = promisify(execFile)

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
    vite?: {
      plugins?: unknown
    }
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
    process.env.PUBLIC_API_BASE = "https://api.example.com"
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
          authSecret: env({ secret: true }),
          databaseUrl: env(),
          optionalApiBase: env({ optional: true, source: env.source("PUBLIC_API_BASE") }),
          public: {
            apiBase: env({ source: env.source("PUBLIC_API_BASE") }),
          },
          teams: {
            apiUrl: env({ optional: true }),
            appId: env({ secret: true }),
            appPassword: env({ secret: true }),
            appTenantId: env({ secret: true }),
            appType: "SingleTenant",
          },
          telegram: {
            apiBaseUrl: env({ optional: true }),
            botToken: env({ secret: true }),
          },
          vertex: {
            model: env({ default: "gemini-3.1-pro-preview-customtools" }),
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
    expect(nitro.options.cloudflare?.wrangler?.secrets?.required).toEqual(["EXISTING_SECRET", "AUTH_SECRET", "TEAMS_APP_ID", "TEAMS_APP_PASSWORD", "TEAMS_APP_TENANT_ID", "TELEGRAM_BOT_TOKEN"])
    expect(nitro.logger.info).toHaveBeenCalledWith(expect.stringContaining("env.databaseUrl"))
    expect(nitro.logger.info).toHaveBeenCalledWith(expect.stringContaining("env.public.apiBase"))
    expect(nitro.logger.info).toHaveBeenCalledWith(expect.stringContaining("public runtime transport"))
    expect(nitro.logger.info).not.toHaveBeenCalledWith(expect.stringContaining("env.teams.appType"))
    expect(nitro.logger.info).toHaveBeenCalledWith(expect.stringContaining("env.telegram.botToken"))

    const typesHook = nitro.hooks.hook.mock.calls.find(([name]) => name === "types:extend")?.[1]
    const tsConfig = { include: [] as string[] }
    await typesHook?.({ tsConfig })
    const types = await readFile(join(root, ".nitro/types/vitehub-env.d.ts"), "utf8")
    const integrationTypes = await readFile(join(root, ".nitro/types/vitehub-env-integrations.d.ts"), "utf8")
    expect(types).toContain("export interface SafeRuntimeConfig")
    expect(types).toContain("\"databaseUrl\": string")
    expect(types).toContain("\"optionalApiBase\": string | undefined")
    expect(types).toContain("\"public\": {")
    expect(types).toContain("\"apiBase\": string")
    expect(types).toContain("\"teams\": {")
    expect(types).toContain("\"appType\": \"SingleTenant\"")
    expect(types).toContain("\"telegram\": {")
    expect(types).toContain("\"apiBaseUrl\": string | undefined")
    expect(types).toContain("\"botToken\": string")
    expect(types).toContain("\"vertex\": {")
    expect(types).toContain("\"model\": string")
    expect(types).toContain("export type RuntimeEnvConfig = SafeRuntimeConfig")
    expect(types).toContain("export type ViteHubEnvConfig = SafeRuntimeConfig")
    expect(types).toContain("useSafeRuntimeConfig(event?: unknown): SafeRuntimeConfig")
    expect(types).not.toContain("declare module \"nitro/types\"")
    expect(types).not.toContain("export {}")
    expect(integrationTypes).not.toContain("import \"@vitehub/chat\"")
    expect(integrationTypes).toContain("import \"nitro/types\"")
    expect(integrationTypes).toContain("declare module \"nitro/types\"")
    expect(integrationTypes).toContain("export interface NitroRuntimeConfig")
    expect(integrationTypes).toContain("declare module \"@vitehub/chat\"")
    expect(integrationTypes).toContain("export interface ChatRuntimeConfig")
    expect(types).toContain("\"botToken\": string")
    expect(integrationTypes).toContain("\"botToken\": string")
    expect(integrationTypes).not.toContain("NitroChatRuntimeConfig")
    expect(integrationTypes).toContain("export {}")
    expect(tsConfig.include).toContain(join(root, ".nitro/types/vitehub-env.d.ts"))
    expect(tsConfig.include).toContain(join(root, ".nitro/types/vitehub-env-integrations.d.ts"))

    const registry = await readFile(join(root, ".vitehub/nitro-runtime/env/registry.mjs"), "utf8")
    expect(registry).toContain("DATABASE_URL")
    expect(registry).toContain("PUBLIC_API_BASE")
    expect(registry).toContain("SingleTenant")
    expect(registry).toContain("\"kind\": \"literal\"")
    expect(registry).not.toContain("TEAMS_APP_TYPE")
    expect(registry).toContain("TELEGRAM_BOT_TOKEN")
    expect(registry).toContain("\"required\": false")
    expect(registry).not.toContain("aaaaaaaa")
    expect(registry).not.toContain("telegram-secret")
  })

  it("types defineChat runtime config from generated env declarations", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-env-chat-types-"))
    const nitro: NitroStub = {
      hooks: { hook: vi.fn() },
      logger: { info: vi.fn() },
      options: {
        buildDir: join(root, ".nitro"),
        env: {
          teams: {
            apiUrl: env({ optional: true }),
            appId: env({ secret: true }),
          },
          vertex: {
            model: env({ default: "gemini-3.1-pro-preview-customtools" }),
          },
        },
        rootDir: root,
      },
    }

    await envNitro().setup(nitro as never)
    const typesHook = nitro.hooks.hook.mock.calls.find(([name]) => name === "types:extend")?.[1]
    await typesHook?.({ tsConfig: { include: [] } })

    await writeFile(join(root, "typecheck.ts"), [
      "import { defineChat } from '@vitehub/chat'",
      "",
      "defineChat({",
      "  adapters({ runtimeConfig }) {",
      "    const apiUrl: string | undefined = runtimeConfig.teams.apiUrl",
      "    const appId: string = runtimeConfig.teams.appId",
      "    const model: string = runtimeConfig.vertex.model",
      "    void apiUrl",
      "    void appId",
      "    void model",
      "    return {}",
      "  },",
      "  state: {} as never,",
      "})",
      "",
    ].join("\n"), "utf8")
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        allowSyntheticDefaultImports: true,
        allowImportingTsExtensions: true,
        baseUrl: root,
        ignoreDeprecations: "6.0",
        paths: {
          "@vitehub/chat": [join(import.meta.dirname, "../../chat/src/index.ts")],
        },
        module: "NodeNext",
        moduleResolution: "NodeNext",
        noEmit: true,
        skipLibCheck: true,
        strict: true,
        target: "ES2023",
      },
      files: [
        join(root, ".nitro/types/vitehub-env.d.ts"),
        join(root, ".nitro/types/vitehub-env-integrations.d.ts"),
        join(root, "typecheck.ts"),
      ],
    }, null, 2))

    await execFileAsync("pnpm", ["exec", "tsc", "--noEmit", "-p", join(root, "tsconfig.json")], {
      cwd: join(import.meta.dirname, ".."),
      maxBuffer: 1024 * 1024 * 4,
    })
  })

  it("exports generated runtime config types for application code", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-env-runtime-types-"))
    const nitro: NitroStub = {
      hooks: { hook: vi.fn() },
      logger: { info: vi.fn() },
      options: {
        buildDir: join(root, ".nitro"),
        env: {
          telegram: {
            apiBaseUrl: env({ optional: true }),
            botToken: env({ secret: true }),
          },
          vertex: {
            apiKey: env({ secret: true }),
            model: env({ default: "gemini-3.1-pro-preview-customtools" }),
          },
        },
        rootDir: root,
      },
    }

    await envNitro().setup(nitro as never)
    const typesHook = nitro.hooks.hook.mock.calls.find(([name]) => name === "types:extend")?.[1]
    await typesHook?.({ tsConfig: { include: [] } })

    await writeFile(join(root, "typecheck.ts"), [
      "import { useSafeRuntimeConfig } from '#vitehub/env/server'",
      "import type { RuntimeEnvConfig, SafeRuntimeConfig, ViteHubEnvConfig } from '#vitehub/env/server'",
      "",
      "function createAgent(config: RuntimeEnvConfig) {",
      "  const apiKey: string = config.vertex.apiKey",
      "  const model: string = config.vertex.model",
      "  void apiKey",
      "  void model",
      "}",
      "",
      "function createTelegramAdapter(config: ViteHubEnvConfig) {",
      "  const apiBaseUrl: string | undefined = config.telegram.apiBaseUrl",
      "  const botToken: string = config.telegram.botToken",
      "  void apiBaseUrl",
      "  void botToken",
      "}",
      "",
      "const config: SafeRuntimeConfig = useSafeRuntimeConfig()",
      "createAgent(config)",
      "createTelegramAdapter(config)",
      "",
    ].join("\n"), "utf8")
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        allowSyntheticDefaultImports: true,
        allowImportingTsExtensions: true,
        baseUrl: root,
        ignoreDeprecations: "6.0",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        noEmit: true,
        skipLibCheck: true,
        strict: true,
        target: "ES2023",
      },
      files: [
        join(root, ".nitro/types/vitehub-env.d.ts"),
        join(root, ".nitro/types/vitehub-env-integrations.d.ts"),
        join(root, "typecheck.ts"),
      ],
    }, null, 2))

    await execFileAsync("pnpm", ["exec", "tsc", "--noEmit", "-p", join(root, "tsconfig.json")], {
      cwd: join(import.meta.dirname, ".."),
      maxBuffer: 1024 * 1024 * 4,
    })
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
            botToken: env({ secret: true }),
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

  it("rejects direct Vite plugin configuration with the Nitro module", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-env-nitro-"))
    const nitro: NitroStub = {
      hooks: { hook: vi.fn() },
      logger: { info: vi.fn() },
      options: {
        buildDir: join(root, ".nitro"),
        env: {
          authSecret: env({ secret: true }),
        },
        rootDir: root,
        vite: {
          plugins: [{ name: "@vitehub/env/vite" }],
        },
      },
    }

    await expect(envNitro().setup(nitro as never)).rejects.toThrow(
      "Do not configure @vitehub/env/vite when using @vitehub/env/nitro",
    )
  })

  it("resolves nested runtime config objects", async () => {
    const { applyEnvRegistryToRuntimeConfig, setEnvRegistry, useSafeRuntimeConfig } = await import("../src/runtime/server.ts")
    process.env.PUBLIC_API_BASE = "https://api.example.com"
    process.env.TELEGRAM_BOT_TOKEN = "telegram-secret"

    setEnvRegistry({
      public: {
        apiBase: {
          required: true,
          secret: false,
          source: { kind: "env", label: "env:PUBLIC_API_BASE", name: "PUBLIC_API_BASE", serializable: true },
        },
      },
      teams: {
        appType: {
          kind: "literal",
          value: "SingleTenant",
        },
      },
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
      public: { apiBase: string }
      teams: { appType: "SingleTenant" }
      telegram: { apiBaseUrl?: string, botToken: string }
      vertex: { model: string }
    }

    expect(config.teams.appType).toBe("SingleTenant")
    expect(config.telegram.botToken).toBe("telegram-secret")
    expect(config.telegram.apiBaseUrl).toBeUndefined()
    expect(config.public.apiBase).toBe("https://api.example.com")
    expect(config.vertex.model).toBe("gemini-3.1-pro-preview-customtools")

    const runtimeConfig = { chat: { enabled: true }, public: { existing: "keep" } } as Record<string, unknown>
    applyEnvRegistryToRuntimeConfig(runtimeConfig)
    expect(runtimeConfig).toMatchObject({
      chat: { enabled: true },
      public: { apiBase: "https://api.example.com", existing: "keep" },
      teams: { appType: "SingleTenant" },
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

  it("validates serialized runtime registry defaults", async () => {
    const { applyEnvRegistryToRuntimeConfig, setEnvRegistry } = await import("../src/runtime/server.ts")

    setEnvRegistry({
      vertex: {
        model: {
          default: false,
          required: true,
          schema: { kind: "string" },
          secret: false,
          source: { kind: "env", label: "env:VERTEX_MODEL", name: "VERTEX_MODEL", serializable: true },
        },
      },
    })

    expect(() => applyEnvRegistryToRuntimeConfig({})).toThrow("Invalid env.vertex.model: Expected string")
  })

  it("rejects custom Nitro runtime schemas because generated registries cannot preserve them", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-env-nitro-"))
    const nitro: NitroStub = {
      hooks: { hook: vi.fn() },
      logger: { info: vi.fn() },
      options: {
        buildDir: join(root, ".nitro"),
        env: {
          sentryDebug: env({
            schema: booleanSchema(),
            type: "boolean",
          }),
        },
        rootDir: root,
      },
    }

    await expect(envNitro().setup(nitro as never)).rejects.toThrow("custom schema")
  })

  it("accepts default runtime schemas from another module instance", async () => {
    process.env.AUTH_SECRET = "a".repeat(32)

    const root = await mkdtemp(join(tmpdir(), "vitehub-env-nitro-"))
    const declaration = env({ secret: true })
    const nitro: NitroStub = {
      hooks: { hook: vi.fn() },
      logger: { info: vi.fn() },
      options: {
        buildDir: join(root, ".nitro"),
        env: {
          authSecret: {
            ...declaration,
            schema: { ...(declaration.schema as Record<string, unknown>) },
          },
        },
        rootDir: root,
      },
    }

    await envNitro().setup(nitro as never)
  })

  it("rejects runtime schemas that spoof default schema metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-env-nitro-"))
    const nitro: NitroStub = {
      hooks: { hook: vi.fn() },
      logger: { info: vi.fn() },
      options: {
        buildDir: join(root, ".nitro"),
        env: {
          apiKey: env({
            schema: {
              __vitehubDefaultRuntimeSchema: "string",
              safeParse(input: unknown) {
                return { data: String(input), success: true as const }
              },
            },
          }),
        },
        rootDir: root,
      },
    }

    await expect(envNitro().setup(nitro as never)).rejects.toThrow("custom schema")
  })

  it("rejects default runtime declarations that are mutated to custom schemas", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-env-nitro-"))
    const apiKey = env()
    apiKey.schema = stringSchema()

    const nitro: NitroStub = {
      hooks: { hook: vi.fn() },
      logger: { info: vi.fn() },
      options: {
        buildDir: join(root, ".nitro"),
        env: { apiKey },
        rootDir: root,
      },
    }

    await expect(envNitro().setup(nitro as never)).rejects.toThrow("custom schema")
  })

  it("rejects custom runtime schemas that copy default runtime markers", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-env-nitro-"))
    const defaultDeclaration = env()
    const marker = (defaultDeclaration as unknown as Record<string, unknown>).__vitehubDefaultRuntimeSchema
    const schema = stringSchema() as ReturnType<typeof stringSchema> & { __vitehubDefaultRuntimeSchema?: unknown }
    schema.__vitehubDefaultRuntimeSchema = marker
    const apiKey = env({ schema })
    const apiKeyRecord = apiKey as unknown as Record<string, unknown>
    apiKeyRecord.__vitehubDefaultRuntimeSchema = marker

    const nitro: NitroStub = {
      hooks: { hook: vi.fn() },
      logger: { info: vi.fn() },
      options: {
        buildDir: join(root, ".nitro"),
        env: { apiKey },
        rootDir: root,
      },
    }

    await expect(envNitro().setup(nitro as never)).rejects.toThrow("custom schema")
  })

  it("rejects custom runtime schemas that spoof the default parser source", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-env-nitro-"))
    const defaultDeclaration = env()
    const marker = (defaultDeclaration as unknown as Record<string, unknown>).__vitehubDefaultRuntimeSchema
    const defaultSchema = defaultDeclaration.schema as { safeParse: (input: unknown) => unknown }
    const schema = stringSchema() as ReturnType<typeof stringSchema> & { __vitehubDefaultRuntimeSchema?: unknown }
    schema.__vitehubDefaultRuntimeSchema = marker
    schema.safeParse.toString = () => defaultSchema.safeParse.toString()
    const apiKey = env({ schema })
    const apiKeyRecord = apiKey as unknown as Record<string, unknown>
    apiKeyRecord.__vitehubDefaultRuntimeSchema = marker

    const nitro: NitroStub = {
      hooks: { hook: vi.fn() },
      logger: { info: vi.fn() },
      options: {
        buildDir: join(root, ".nitro"),
        env: { apiKey },
        rootDir: root,
      },
    }

    await expect(envNitro().setup(nitro as never)).rejects.toThrow("custom schema")
  })

  it("rejects custom runtime schemas registered through a forged global parser allowlist", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-env-nitro-"))
    const defaultDeclaration = env()
    const marker = (defaultDeclaration as unknown as Record<string, unknown>).__vitehubDefaultRuntimeSchema
    const schema = stringSchema() as ReturnType<typeof stringSchema> & { __vitehubDefaultRuntimeSchema?: unknown }
    schema.__vitehubDefaultRuntimeSchema = marker
    const parsersKey = Symbol.for("vitehub.env.defaultRuntimeSchemaParsers")
    const forgedGlobal = globalThis as typeof globalThis & Record<symbol, WeakSet<typeof schema.safeParse> | undefined>
    forgedGlobal[parsersKey] = new WeakSet([schema.safeParse])
    const apiKey = env({ schema })
    const apiKeyRecord = apiKey as unknown as Record<string, unknown>
    apiKeyRecord.__vitehubDefaultRuntimeSchema = marker

    const nitro: NitroStub = {
      hooks: { hook: vi.fn() },
      logger: { info: vi.fn() },
      options: {
        buildDir: join(root, ".nitro"),
        env: { apiKey },
        rootDir: root,
      },
    }

    try {
      await expect(envNitro().setup(nitro as never)).rejects.toThrow("custom schema")
    }
    finally {
      delete forgedGlobal[parsersKey]
    }
  })

  it("rejects custom runtime sources", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-env-nitro-"))
    const nitro: NitroStub = {
      hooks: { hook: vi.fn() },
      logger: { info: vi.fn() },
      options: {
        buildDir: join(root, ".nitro"),
        env: {
          commit: env({
            schema: stringSchema(),
            source: env.custom("custom", () => "abc123"),
          }),
        },
        rootDir: root,
      },
    }

    await expect(envNitro().setup(nitro as never)).rejects.toThrow("build-only")
  })
})
