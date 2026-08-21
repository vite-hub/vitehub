import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  createProgram,
  flattenDiagnosticMessageText,
  getPreEmitDiagnostics,
  ModuleKind,
  ModuleResolutionKind,
  ScriptTarget,
} from "typescript"
import { build } from "vite"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createRuntimeRegistry } from "../src/core/resolve.ts"
import { resolveServerEnv } from "../src/server.ts"
import { createEnvImportAliases, createEnvTypeScriptPaths, env, hubEnv } from "../src/vite.ts"

import { booleanSchema, stringSchema } from "./helpers.ts"

afterEach(() => vi.unstubAllEnvs())

describe("Vite plugin", () => {
  it("exposes its resolved project root", () => {
    expect(hubEnv({ projectRoot: "../shared" }).api.resolveProjectRoot("/tmp/workspace/apps/site")).toBe("/tmp/workspace/apps/shared")
  })

  it("prepares generated types without running a Vite build", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-env-prepare-"))
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "prepare-types" }), "utf8")
    await mkdir(join(root, ".vitehub", "env"), { recursive: true })
    await writeFile(join(root, ".vitehub", "env", "vite.d.ts"), "stale declarations\n", "utf8")
    const plugin = hubEnv()

    await plugin.api.prepareTypes({
      public: {
        appName: env({ mode: "build" }),
        debug: env({ mode: "build", schema: booleanSchema(), type: "boolean" }),
        port: env({
          default: "3000",
          mode: "build",
          schema: { safeParse: (input: unknown) => ({ data: Number(input), success: true as const }) },
        }),
        optionalLabel: env({ mode: "build", optional: true }),
      },
      server: {
        githubToken: env({ secret: true }),
      },
    }, root)

    const types = await readFile(join(root, ".vitehub", "types", "env.d.ts"), "utf8")
    expect(types).toContain("\"appName\": string")
    expect(types).toContain("\"debug\": boolean")
    expect(types).toContain("\"port\": number")
    expect(types).toContain("\"optionalLabel\": string | undefined")
    expect(types).toContain("\"githubToken\": import(\"@vite-hub/env/secret\").SecretEnv<string>")
    await expect(readFile(join(root, ".vitehub", "env", "public.d.ts"), "utf8")).resolves.toContain("export interface PublicEnv")
    await expect(readFile(join(root, ".vitehub", "env", "server.d.ts"), "utf8")).resolves.toContain("export interface ServerEnv")
    await expect(readFile(join(root, ".vitehub", "env", "vite.d.ts"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("loads Vite env, validates build values, injects define, and serves virtual config", async () => {
    vi.stubEnv("GITHUB_REF_TYPE", "")

    const root = await mkdtemp(join(tmpdir(), "vitehub-env-vite-"))
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "quiver-chat", version: "1.2.3" }), "utf8")
    await writeFile(join(root, ".env.production"), "PUBLIC_APP_NAME=Quiver\nDEFINE_SENTRY_DEBUG=true\n", "utf8")
    await mkdir(join(root, ".vitehub", "env"), { recursive: true })
    await writeFile(join(root, ".vitehub", "env", "vite.d.ts"), "stale env generated types\n", "utf8")

    const plugin = hubEnv({ diagnostics: "trace" })
    const configHook = plugin.config as (config: Record<string, unknown>, env: { command: "build" | "serve", mode: string }) => Promise<unknown>
    const result = await configHook({
      env: {
        define: {
          __APP_VERSION__: env({
            mode: "build",
            schema: stringSchema(),
            source: env.packageJson("version"),
          }),
          __GIT_COMMIT__: env({
            mode: "build",
            schema: stringSchema(),
            source: env.custom("git:commit", () => "abc123"),
          }),
          __SENTRY_DEBUG__: env({
            mode: "build",
            schema: booleanSchema(),
          }),
          __QUIVER_DEPLOYMENT_INFO__: {
            app: {
              name: env({
                mode: "build",
                schema: stringSchema(),
                source: env.packageJson("name"),
              }),
              version: env({
                mode: "build",
                schema: stringSchema(),
                source: env.packageJson("version"),
              }),
            },
            build: {
              timestamp: env({
                mode: "build",
                schema: stringSchema(),
                source: env.buildTimestamp(),
              }),
            },
            git: {
              sha: env({
                mode: "build",
                schema: stringSchema(),
                source: env.custom("git:sha", () => "abc123"),
              }),
              tag: env({
                mode: "build",
                optional: true,
                schema: stringSchema(),
                source: env.gitTag(),
              }),
            },
            hosting: "vercel",
          },
        },
        public: {
          appName: env({
            mode: "build",
            schema: stringSchema(),
          }),
        },
        server: {
          app: {
            name: "Telegram Audio",
          },
          airtableToken: env({ secret: true, source: env.source("AIRTABLE_TOKEN") }),
          optionalSecret: env({ optional: true, secret: true, source: env.source("OPTIONAL_SECRET") }),
          optionalToken: env({
            optional: true,
            secret: true,
          }),
          teams: {
            appType: "SingleTenant",
          },
        },
      },
      root,
    }, { command: "build", mode: "production" })

    expect(result).toMatchObject({
      define: {
        __APP_VERSION__: JSON.stringify("1.2.3"),
        __GIT_COMMIT__: JSON.stringify("abc123"),
        __SENTRY_DEBUG__: JSON.stringify(true),
      },
    })
    const deploymentInfo = JSON.parse((result as { define: Record<string, string> }).define.__QUIVER_DEPLOYMENT_INFO__)
    expect(deploymentInfo).toMatchObject({
      app: {
        name: "quiver-chat",
        version: "1.2.3",
      },
      git: {
        sha: "abc123",
      },
      hosting: "vercel",
    })
    expect(deploymentInfo.git).not.toHaveProperty("tag")
    expect(typeof deploymentInfo.build.timestamp).toBe("string")
    expect(createEnvImportAliases({ projectRoot: root })).toEqual({
      "#vitehub/env/public": join(root, ".vitehub", "env", "public.mjs"),
      "#vitehub/env/server": join(root, ".vitehub", "env", "server.mjs"),
    })
    expect(createEnvTypeScriptPaths({ projectRoot: root })).toEqual({
      "#vitehub/env/public": [join(root, ".vitehub", "env", "public")],
      "#vitehub/env/server": [join(root, ".vitehub", "env", "server")],
    })
    expect(createEnvTypeScriptPaths({ projectRoot: root, relativeTo: join(root, ".nuxt") })).toEqual({
      "#vitehub/env/public": ["../.vitehub/env/public"],
      "#vitehub/env/server": ["../.vitehub/env/server"],
    })
    expect(plugin.api.getPublicEnv()).toEqual({
      appName: "Quiver",
    })
    expect(plugin.api.getServerEnvRegistry()).toMatchObject({
      app: {
        name: {
          kind: "literal",
          value: "Telegram Audio",
        },
      },
      airtableToken: {
        secret: true,
        source: { name: "AIRTABLE_TOKEN" },
      },
      optionalToken: {
        source: { name: "OPTIONAL_TOKEN" },
      },
      teams: {
        appType: {
          kind: "literal",
          value: "SingleTenant",
        },
      },
    })

    const configResolvedHook = plugin.configResolved as (config: unknown) => Promise<void> | void
    await configResolvedHook({
      logger: { info: vi.fn() },
      root,
    } as never)

    expect(JSON.parse(await readFile(join(root, "package.json"), "utf8"))).toEqual({
      name: "quiver-chat",
      version: "1.2.3",
    })

    const types = await readFile(join(root, ".vitehub/types/env.d.ts"), "utf8")
    expect(types).toContain("declare module \"#vitehub/env/public\"")
    expect(types).toContain("declare module \"#vitehub/env/server\"")
    expect(types).toContain("import(\"@vite-hub/env/secret\").SecretEnv<string>")
    expect(types).toContain("export interface PublicEnv")
    expect(types).toContain("export interface ServerEnv")
    expect(types).toContain("\"appName\": string")
    expect(types).toContain("\"app\": {")
    expect(types).toContain("\"name\": \"Telegram Audio\"")
    expect(types).toContain("\"airtableToken\": import(\"@vite-hub/env/secret\").SecretEnv<string>")
    expect(types).toContain("\"optionalSecret\"?: import(\"@vite-hub/env/secret\").SecretEnv<string>")
    expect(types).toContain("\"optionalToken\"?: import(\"@vite-hub/env/secret\").SecretEnv<string>")
    expect(types).toContain("\"appType\": \"SingleTenant\"")
    expect(types).toContain("usePublicEnv(): PublicEnv")
    expect(types).toContain("useServerEnv(event?: unknown): ServerEnv")
    expect(types).toContain("runWithServerEnv")
    expect(types).not.toContain("serverEnv")
    expect(types).not.toContain("buildConfig")
    expect(types).not.toContain("useSafeBuildConfig")
    expect(types).not.toContain("virtual:@vite-hub/env/build")
    expect(types).not.toContain("export {}")
    await expect(readFile(join(root, ".vitehub", "env", "vite.d.ts"), "utf8")).rejects.toThrow()
    await expect(readFile(join(root, ".vitehub", "env", "public.mjs"), "utf8")).resolves.toContain("usePublicEnv")
    await expect(readFile(join(root, ".vitehub", "env", "server.mjs"), "utf8")).resolves.toContain("useServerEnv")
    await expect(readFile(join(root, ".vitehub", "env", "public.d.ts"), "utf8")).resolves.toContain("export function usePublicEnv(): PublicEnv")
    const serverModuleTypes = await readFile(join(root, ".vitehub", "env", "server.d.ts"), "utf8")
    expect(serverModuleTypes).toContain("import type { SecretEnv } from \"@vite-hub/env/secret\"")
    expect(serverModuleTypes).toContain("export interface ServerEnv")
    expect(serverModuleTypes).toContain("\"airtableToken\": SecretEnv<string>")
    expect(serverModuleTypes).toContain("export function useServerEnv(event?: unknown): ServerEnv")
    expect(serverModuleTypes).toContain("runWithServerEnv")

    const loadHook = plugin.load as (id: string) => string | undefined
    const loaded = loadHook("\0#vitehub/env/public")
    expect(loaded).toContain("Quiver")
    expect(loaded).toContain("usePublicEnv")
    expect(loaded).not.toContain("buildConfig")
    expect(loaded).not.toContain("useSafeBuildConfig")

    const serverLoaded = loadHook("\0#vitehub/env/server")
    expect(serverLoaded).toContain("resolveServerEnv")
    expect(serverLoaded).toContain("AIRTABLE_TOKEN")
    expect(serverLoaded).toContain("OPTIONAL_SECRET")
    expect(serverLoaded).toContain("OPTIONAL_TOKEN")
    expect(serverLoaded).not.toContain("SERVER_OPTIONAL_TOKEN")
    expect(serverLoaded).not.toContain("serverEnv")
    expect(serverLoaded).toContain("useServerEnv")
    expect(serverLoaded).toContain("runWithServerEnv")

    const transformHook = plugin.transform as (code: string) => string | undefined
    expect(transformHook('const envId = "#vitehub/env/server"; import(\n/* @vite-ignore */ /* @vitehub-env */ envId\n)'))
      .toBe('const envId = "#vitehub/env/server"; import(\n"#vitehub/env/server"\n)')
  })

  it("does not read package metadata unless packageJson is declared", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-env-no-package-json-"))
    await writeFile(join(root, ".env.production"), "DEFINE_SENTRY_DEBUG=true\n", "utf8")

    const plugin = hubEnv()
    expect(plugin.enforce).toBeUndefined()
    expect(plugin.resolveId).toMatchObject({ order: "pre" })
    const configHook = plugin.config as (config: Record<string, unknown>, env: { command: "build" | "serve", mode: string }) => Promise<unknown>
    const result = await configHook({
      env: {
        define: {
          __SENTRY_DEBUG__: env({
            mode: "build",
            schema: booleanSchema(),
          }),
        },
      },
      root,
    }, { command: "build", mode: "production" })

    expect(result).toMatchObject({
      define: {
        __SENTRY_DEBUG__: JSON.stringify(true),
      },
    })
  })

  it("can generate env runtime modules through a facade import path", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-env-facade-runtime-imports-"))
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "facade-app", type: "module" }), "utf8")
    await writeFile(join(root, "secret.d.ts"), "export interface SecretEnv<T> { unseal(): T }\n", "utf8")

    const plugin = hubEnv({
      runtimeImports: {
        secret: "../../secret.js",
        server: "#app/env/server",
      },
    })
    const configHook = plugin.config as (config: Record<string, unknown>, env: { command: "build" | "serve", mode: string }) => Promise<unknown>
    await configHook({
      env: {
        server: {
          token: env({ secret: true }),
        },
      },
      root,
    }, { command: "build", mode: "production" })

    const configResolvedHook = plugin.configResolved as (config: unknown) => Promise<void> | void
    await configResolvedHook({
      logger: { info: vi.fn() },
      root,
    } as never)

    await expect(readFile(join(root, ".vitehub", "env", "server.mjs"), "utf8")).resolves.toContain("from \"#app/env/server\"")
    await expect(readFile(join(root, ".vitehub", "env", "server.d.ts"), "utf8")).resolves.toContain("from \"../../secret.js\"")
    const typesPath = join(root, ".vitehub", "types", "env.d.ts")
    await expect(readFile(typesPath, "utf8")).resolves.toContain("import(\"../../secret.js\").SecretEnv<string>")
    const program = createProgram({
      options: {
        module: ModuleKind.NodeNext,
        moduleResolution: ModuleResolutionKind.NodeNext,
        noEmit: true,
        skipLibCheck: false,
        strict: true,
        target: ScriptTarget.ES2022,
      },
      rootNames: [typesPath],
    })
    expect(getPreEmitDiagnostics(program).map(diagnostic => flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual([])
  })

  it("applies prefixes to inferred Vite env names", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-env-vite-"))
    await writeFile(join(root, ".env.production"), "VITEHUB_PUBLIC_APP_NAME=Quiver\n", "utf8")

    const plugin = hubEnv({ prefix: "VITEHUB_" })
    const configHook = plugin.config as (config: Record<string, unknown>, env: { command: "build" | "serve", mode: string }) => Promise<unknown>
    await configHook({
      env: {
        public: {
          appName: env({
            mode: "build",
            schema: stringSchema(),
          }),
        },
      },
      root,
    }, { command: "build", mode: "production" })

    expect(plugin.api.getPublicEnv()).toEqual({
      appName: "Quiver",
    })
  })

  it("builds and typechecks a consumer without package imports", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-env-vite-consumer-"))
    const entry = join(root, "consumer.ts")
    const packageJsonPath = join(root, "package.json")
    const packageJson = JSON.stringify({ name: "env-consumer", private: true, type: "module" }, null, 2)
    await writeFile(packageJsonPath, packageJson, "utf8")
    await writeFile(entry, [
      `import { usePublicEnv } from "#vitehub/env/public"`,
      `import { useServerEnv } from "#vitehub/env/server"`,
      `export const appName: string = usePublicEnv().appName`,
      `export const token: string = useServerEnv().token.unseal()`,
      ``,
    ].join("\n"), "utf8")

    await build({
      build: {
        emptyOutDir: true,
        lib: { entry, fileName: () => "consumer.mjs", formats: ["es"] },
        outDir: join(root, "dist"),
      },
      configFile: false,
      env: {
        public: { appName: env({ default: "ViteHub", mode: "build" }) },
        server: { token: env({ secret: true }) },
      },
      logLevel: "silent",
      plugins: [hubEnv()],
      root,
    })

    expect(await readFile(packageJsonPath, "utf8")).toBe(packageJson)
    expect(await readFile(join(root, "dist", "consumer.mjs"), "utf8")).not.toMatch(/from\s+["']#vitehub\/env\//)
    const typesPath = join(root, ".vitehub", "types", "env.d.ts")
    const program = createProgram({
      options: {
        module: ModuleKind.NodeNext,
        moduleResolution: ModuleResolutionKind.NodeNext,
        noEmit: true,
        skipLibCheck: true,
        strict: true,
        target: ScriptTarget.ES2022,
      },
      rootNames: [entry, typesPath],
    })
    expect(getPreEmitDiagnostics(program).map(diagnostic => flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual([])
  }, 15_000)

  it("keeps generated env files in project ViteHub state when Vite root is app", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-env-vite-app-root-"))
    await mkdir(join(root, "app"), { recursive: true })
    await mkdir(join(root, "server", "workspaces"), { recursive: true })

    const plugin = hubEnv()
    const configHook = plugin.config as (config: Record<string, unknown>, env: { command: "build" | "serve", mode: string }) => Promise<unknown>
    await configHook({
      env: {
        server: {
          airtableToken: env({ secret: true }),
        },
      },
      root: join(root, "app"),
    }, { command: "build", mode: "production" })

    const configResolvedHook = plugin.configResolved as (config: unknown) => Promise<void> | void
    await configResolvedHook({
      logger: { info: vi.fn() },
      root: join(root, "app"),
    } as never)

    await expect(readFile(join(root, ".vitehub", "types", "env.d.ts"), "utf8")).resolves.toContain("\"airtableToken\": import(\"@vite-hub/env/secret\").SecretEnv<string>")
    await expect(readFile(join(root, "app", ".vitehub", "types", "env.d.ts"), "utf8")).rejects.toThrow()
  })

  it("writes local targets for nested package roots without changing package imports", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-env-vite-nested-package-"))
    const appRoot = join(root, "app")
    await mkdir(join(appRoot, "src"), { recursive: true })
    await mkdir(join(root, "server", "workspaces"), { recursive: true })
    await writeFile(join(root, ".env.production"), "PUBLIC_APP_NAME=Quiver\n", "utf8")
    await writeFile(join(root, "secret.d.ts"), "export interface SecretEnv<T> { unseal(): T }\n", "utf8")
    const packageJsonPath = join(appRoot, "package.json")
    const packageJson = JSON.stringify({
      imports: {
        "#app/config": "./config.mjs",
      },
      name: "nested-app",
      type: "module",
    })
    await writeFile(packageJsonPath, packageJson, "utf8")

    const plugin = hubEnv({ runtimeImports: { secret: "../../secret.js" } })
    const configHook = plugin.config as (config: Record<string, unknown>, env: { command: "build" | "serve", mode: string }) => Promise<unknown>
    await configHook({
      env: {
        public: {
          appName: env({
            mode: "build",
            schema: stringSchema(),
          }),
        },
        server: { token: env({ secret: true }) },
      },
      root: appRoot,
    }, { command: "build", mode: "production" })

    const configResolvedHook = plugin.configResolved as (config: unknown) => Promise<void> | void
    await configResolvedHook({
      logger: { info: vi.fn() },
      root: appRoot,
    } as never)

    expect(await readFile(packageJsonPath, "utf8")).toBe(packageJson)
    await expect(readFile(join(root, ".vitehub", "env", "public.mjs"), "utf8")).resolves.toContain("Quiver")
    await expect(readFile(join(appRoot, ".vitehub", "env", "public.mjs"), "utf8")).resolves.toContain("Quiver")

    const entry = join(appRoot, "src", "consumer.ts")
    const typesPath = join(appRoot, ".vitehub", "types", "env.d.ts")
    const projectTypesPath = join(root, ".vitehub", "types", "env.d.ts")
    await expect(readFile(typesPath, "utf8")).resolves.toContain('/// <reference path="../../../.vitehub/types/env.d.ts" />')
    await writeFile(entry, [
      `import { usePublicEnv } from "#vitehub/env/public"`,
      `import { useServerEnv } from "#vitehub/env/server"`,
      `export const appName: string = usePublicEnv().appName`,
      `export const serverEnv = useServerEnv()`,
      ``,
    ].join("\n"), "utf8")
    const program = createProgram({
      options: {
        module: ModuleKind.NodeNext,
        moduleResolution: ModuleResolutionKind.NodeNext,
        noEmit: true,
        skipLibCheck: false,
        strict: true,
        target: ScriptTarget.ES2022,
      },
      rootNames: [entry, projectTypesPath, typesPath],
    })
    expect(getPreEmitDiagnostics(program).map(diagnostic => flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual([])
  })

  it("keeps generated env files in project ViteHub state when Vite root is nested", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-env-vite-nested-root-"))
    await mkdir(join(root, "frontend"), { recursive: true })
    await mkdir(join(root, "server", "workspaces"), { recursive: true })

    const plugin = hubEnv()
    const configHook = plugin.config as (config: Record<string, unknown>, env: { command: "build" | "serve", mode: string }) => Promise<unknown>
    await configHook({
      env: {
        server: {
          airtableToken: env({ secret: true }),
        },
      },
      root: join(root, "frontend"),
    }, { command: "build", mode: "production" })

    const configResolvedHook = plugin.configResolved as (config: unknown) => Promise<void> | void
    await configResolvedHook({
      logger: { info: vi.fn() },
      root: join(root, "frontend"),
    } as never)

    await expect(readFile(join(root, ".vitehub", "types", "env.d.ts"), "utf8")).resolves.toContain("\"airtableToken\": import(\"@vite-hub/env/secret\").SecretEnv<string>")
    await expect(readFile(join(root, "frontend", ".vitehub", "types", "env.d.ts"), "utf8")).rejects.toThrow()
  })

  it("uses the nearest package root for env-only nested Vite roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-env-vite-package-root-"))
    await mkdir(join(root, "app"), { recursive: true })
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "env-only" }), "utf8")

    const plugin = hubEnv()
    const configHook = plugin.config as (config: Record<string, unknown>, env: { command: "build" | "serve", mode: string }) => Promise<unknown>
    await configHook({
      env: {
        server: {
          airtableToken: env({ secret: true }),
        },
      },
      root: join(root, "app"),
    }, { command: "build", mode: "production" })

    const configResolvedHook = plugin.configResolved as (config: unknown) => Promise<void> | void
    await configResolvedHook({
      logger: { info: vi.fn() },
      root: join(root, "app"),
    } as never)

    await expect(readFile(join(root, ".vitehub", "types", "env.d.ts"), "utf8")).resolves.toContain("\"airtableToken\": import(\"@vite-hub/env/secret\").SecretEnv<string>")
    await expect(readFile(join(root, "app", ".vitehub", "types", "env.d.ts"), "utf8")).rejects.toThrow()
  })

  it("uses explicit projectRoot when env-only nested apps have no package marker", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-env-vite-explicit-root-"))
    await mkdir(join(root, "app"), { recursive: true })

    const plugin = hubEnv({ projectRoot: ".." })
    const configHook = plugin.config as (config: Record<string, unknown>, env: { command: "build" | "serve", mode: string }) => Promise<unknown>
    await configHook({
      env: {
        server: {
          airtableToken: env({ secret: true }),
        },
      },
      root: join(root, "app"),
    }, { command: "build", mode: "production" })

    const configResolvedHook = plugin.configResolved as (config: unknown) => Promise<void> | void
    await configResolvedHook({
      logger: { info: vi.fn() },
      root: join(root, "app"),
    } as never)

    await expect(readFile(join(root, ".vitehub", "types", "env.d.ts"), "utf8")).resolves.toContain("\"airtableToken\": import(\"@vite-hub/env/secret\").SecretEnv<string>")
    await expect(readFile(join(root, "app", ".vitehub", "types", "env.d.ts"), "utf8")).rejects.toThrow()
  })

  it("resolves Server Env from runtime carriers and active Cloudflare env", async () => {
    const registry = createRuntimeRegistry({
      airtableToken: env({ secret: true }),
      optionalToken: env({ optional: true, secret: true }),
      publicWebhook: env({ source: env.source("WEBHOOK_URL") }),
      nested: {
        staticValue: "ok",
      },
    }, { prefix: "VITEHUB_" })

    const serverEnv = resolveServerEnv<{
      airtableToken: { unseal(): string }
      nested: { staticValue: "ok" }
      optionalToken?: { unseal(): string }
      publicWebhook: string
    }>(registry, {
      env: {
        VITEHUB_AIRTABLE_TOKEN: "airtable-secret",
        WEBHOOK_URL: "https://example.test/hook",
      },
    })

    expect(String(serverEnv.airtableToken)).toBe("<redacted>")
    expect(JSON.stringify(serverEnv.airtableToken)).toBe("\"<redacted>\"")
    expect(serverEnv.airtableToken.unseal()).toBe("airtable-secret")
    expect(serverEnv.optionalToken).toBeUndefined()
    expect(serverEnv.publicWebhook).toBe("https://example.test/hook")
    expect(serverEnv.nested.staticValue).toBe("ok")

    ;(globalThis as { __env__?: Record<string, unknown> }).__env__ = {
      VITEHUB_AIRTABLE_TOKEN: "global-secret",
      WEBHOOK_URL: "https://example.test/global",
    }
    try {
      expect(resolveServerEnv<{ airtableToken: { unseal(): string } }>(registry).airtableToken.unseal()).toBe("global-secret")
    }
    finally {
      delete (globalThis as { __env__?: Record<string, unknown> }).__env__
    }

    expect(() => resolveServerEnv(registry, {
      env: {
        WEBHOOK_URL: "https://example.test/hook",
      },
    })).toThrow("[vitehub] Required Env value is missing.")
  })

})
