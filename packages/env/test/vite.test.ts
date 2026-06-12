import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { describe, expect, it, vi } from "vitest"

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
          airtableToken: env({ secret: true, source: env.source("AIRTABLE_TOKEN") }),
          optionalSecret: env({ optional: true, secret: true, source: env.source("OPTIONAL_SECRET") }),
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
    expect(plugin.api.getPublicEnv()).toEqual({
      appName: "Quiver",
    })
    expect(plugin.api.getServerEnvRegistry()).toMatchObject({
      airtableToken: {
        secret: true,
        source: { name: "AIRTABLE_TOKEN" },
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

    const types = await readFile(join(root, ".vitehub/env/vite.d.ts"), "utf8")
    expect(types).toContain("declare module \"#vitehub/env/public\"")
    expect(types).toContain("declare module \"#vitehub/env/server\"")
    expect(types).toContain("export interface PublicEnv")
    expect(types).toContain("export interface ServerEnv")
    expect(types).toContain("\"appName\": string")
    expect(types).toContain("\"airtableToken\": SecretEnv<string>")
    expect(types).toContain("\"optionalSecret\"?: SecretEnv<string>")
    expect(types).toContain("\"appType\": \"SingleTenant\"")
    expect(types).toContain("usePublicEnv(): PublicEnv")
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

    const serverModule = loadHook("\0#vitehub/env/server")
    expect(serverModule).toContain("useServerEnv")
    expect(serverModule).toContain("SecretEnv")
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

  it("serves Server Env from runtime carriers and redacts secrets", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-env-server-"))
    const plugin = hubEnv({ prefix: "VITEHUB_" })
    const configHook = plugin.config as (config: Record<string, unknown>, env: { command: "build" | "serve", mode: string }) => Promise<unknown>
    await configHook({
      env: {
        server: {
          airtableToken: env({ secret: true }),
          optionalToken: env({ optional: true, secret: true }),
          publicWebhook: env({ source: env.source("WEBHOOK_URL") }),
          nested: {
            staticValue: "ok",
          },
        },
      },
      root,
    }, { command: "build", mode: "production" })

    const loadHook = plugin.load as (id: string) => string | undefined
    const modulePath = join(root, "server-env.mjs")
    await writeFile(
      modulePath,
      loadHook("\0#vitehub/env/server")!.replace(
        "\"@vite-hub/env/secret\"",
        JSON.stringify(pathToFileURL(join(import.meta.dirname, "..", "src", "secret.ts")).href),
      ),
      "utf8",
    )

    const mod = await import(`${pathToFileURL(modulePath).href}?t=${Date.now()}`) as {
      serverEnv: { airtableToken: unknown }
      useServerEnv: (event?: unknown) => {
        airtableToken: { unseal(): string }
        nested: { staticValue: "ok" }
        optionalToken?: { unseal(): string }
        publicWebhook: string
      }
    }

    const serverEnv = mod.useServerEnv({
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
    expect((mod.serverEnv.airtableToken as { unseal(): string }).unseal()).toBe("global-secret")
    delete (globalThis as { __env__?: Record<string, unknown> }).__env__

    expect(() => mod.useServerEnv({ env: { WEBHOOK_URL: "https://example.test/hook" } })).toThrow("Missing Server Env airtableToken")
  })
})
