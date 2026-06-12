import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it, vi } from "vitest"

import { createRuntimeRegistry } from "../src/core/resolve.ts"
import { resolveServerEnv } from "../src/server.ts"
import { env, hubEnv } from "../src/vite.ts"

import { booleanSchema, stringSchema } from "./helpers.ts"

describe("Vite plugin", () => {
  it("loads Vite env, validates build values, injects define, and serves virtual config", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-env-vite-"))
    await writeFile(join(root, "package.json"), JSON.stringify({ version: "1.2.3" }), "utf8")
    await writeFile(join(root, ".env.production"), "PUBLIC_APP_NAME=Quiver\nDEFINE_SENTRY_DEBUG=true\n", "utf8")

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
          openai: {
            apiKey: env({
              secret: true,
              source: env.source("OPENAI_API_KEY"),
            }),
          },
          optionalToken: env({
            optional: true,
            secret: true,
          }),
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
    expect(plugin.api.getPublicEnv()).toEqual({
      appName: "Quiver",
    })

    const configResolvedHook = plugin.configResolved as (config: unknown) => Promise<void> | void
    await configResolvedHook({
      logger: { info: vi.fn() },
      root,
    } as never)

    const types = await readFile(join(root, ".vitehub/env/vite.d.ts"), "utf8")
    expect(types).toContain("declare module \"#vitehub/env/public\"")
    expect(types).toContain("export interface PublicEnv")
    expect(types).toContain("\"appName\": string")
    expect(types).toContain("usePublicEnv(): PublicEnv")
    expect(types).toContain("declare module \"#vitehub/env/server\"")
    expect(types).toContain("export interface ServerEnv")
    expect(types).toContain("\"app\": { \"name\": \"Telegram Audio\" }")
    expect(types).toContain("\"apiKey\": import(\"@vite-hub/env/secret\").SecretEnv<string>")
    expect(types).toContain("\"optionalToken\": import(\"@vite-hub/env/secret\").SecretEnv<string> | undefined")
    expect(types).toContain("useServerEnv(event?: unknown): ServerEnv")
    expect(types).not.toContain("buildConfig")
    expect(types).not.toContain("useSafeBuildConfig")
    expect(types).not.toContain("virtual:@vite-hub/env/build")

    const loadHook = plugin.load as (id: string) => string | undefined
    const loaded = loadHook("\0#vitehub/env/public")
    expect(loaded).toContain("Quiver")
    expect(loaded).toContain("usePublicEnv")
    expect(loaded).not.toContain("buildConfig")
    expect(loaded).not.toContain("useSafeBuildConfig")

    const serverLoaded = loadHook("\0#vitehub/env/server")
    expect(serverLoaded).toContain("resolveServerEnv")
    expect(serverLoaded).toContain("OPENAI_API_KEY")
    expect(serverLoaded).toContain("OPTIONAL_TOKEN")
    expect(serverLoaded).not.toContain("SERVER_OPTIONAL_TOKEN")
    expect(serverLoaded).toContain("useServerEnv")
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

  it("resolves server env from Cloudflare event env and redacts secrets", () => {
    const registry = createRuntimeRegistry({
      appName: "Audio Bitacora",
      openai: {
        apiKey: env({
          secret: true,
          source: env.source("OPENAI_API_KEY"),
        }),
      },
      optionalToken: env({
        optional: true,
        secret: true,
      }),
    })

    const serverEnv = resolveServerEnv<{
      appName: string
      openai: { apiKey: { unseal: () => string } }
      optionalToken?: unknown
    }>(registry, {
      env: {
        OPENAI_API_KEY: "runtime-openai-key",
      },
    })

    expect(serverEnv.appName).toBe("Audio Bitacora")
    expect(serverEnv.openai.apiKey.unseal()).toBe("runtime-openai-key")
    expect(String(serverEnv.openai.apiKey)).toBe("<redacted>")
    expect(JSON.stringify(serverEnv.openai.apiKey)).toBe("\"<redacted>\"")
    expect(serverEnv.optionalToken).toBeUndefined()
  })

  it("throws when required server env is missing at runtime", () => {
    const registry = createRuntimeRegistry({
      openai: {
        apiKey: env({
          secret: true,
          source: env.source("OPENAI_API_KEY"),
        }),
      },
    })

    expect(() => resolveServerEnv(registry, { env: {} }))
      .toThrow("Missing Runtime Env from env:OPENAI_API_KEY.")
  })
})
