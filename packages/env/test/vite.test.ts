import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it, vi } from "vitest"

import { createRuntimeRegistry } from "../src/core/resolve.ts"
import { resolveServerEnv, runWithServerEnv } from "../src/server.ts"
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

    const types = await readFile(join(root, ".vitehub/env/vite.d.ts"), "utf8")
    expect(types).toContain("declare module \"#vitehub/env/public\"")
    expect(types).toContain("declare module \"#vitehub/env/server\"")
    expect(types).toContain("import type { SecretEnv } from \"@vite-hub/env/secret\"")
    expect(types).toContain("export interface PublicEnv")
    expect(types).toContain("export interface ServerEnv")
    expect(types).toContain("\"appName\": string")
    expect(types).toContain("\"app\": {")
    expect(types).toContain("\"name\": \"Telegram Audio\"")
    expect(types).toContain("\"airtableToken\": SecretEnv<string>")
    expect(types).toContain("\"optionalSecret\"?: SecretEnv<string>")
    expect(types).toContain("\"optionalToken\"?: SecretEnv<string>")
    expect(types).toContain("\"appType\": \"SingleTenant\"")
    expect(types).toContain("usePublicEnv(): PublicEnv")
    expect(types).toContain("useServerEnv(event?: unknown): ServerEnv")
    expect(types).not.toContain("import(\"@vite-hub/env/secret\")")
    expect(types).not.toContain("serverEnv")
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
    expect(serverLoaded).toContain("AIRTABLE_TOKEN")
    expect(serverLoaded).toContain("OPTIONAL_SECRET")
    expect(serverLoaded).toContain("OPTIONAL_TOKEN")
    expect(serverLoaded).not.toContain("SERVER_OPTIONAL_TOKEN")
    expect(serverLoaded).not.toContain("serverEnv")
    expect(serverLoaded).toContain("useServerEnv")
    expect(serverLoaded).toContain("runWithServerEnv")
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

  it("resolves Server Env from runtime carriers and active Cloudflare env", () => {
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
    })).toThrow("Missing Runtime Env from env:VITEHUB_AIRTABLE_TOKEN.")
  })

  it("runs callbacks with Server Env active for nested runtime helpers", () => {
    const registry = createRuntimeRegistry({
      airtableToken: env({ secret: true }),
    }, { prefix: "VITEHUB_" })

    const resolved = runWithServerEnv({
      env: {
        VITEHUB_AIRTABLE_TOKEN: "callback-secret",
      },
    }, () => resolveServerEnv<{ airtableToken: { unseal(): string } }>(registry))

    expect(resolved.airtableToken.unseal()).toBe("callback-secret")
    expect(() => resolveServerEnv(registry)).toThrow("Missing Runtime Env from env:VITEHUB_AIRTABLE_TOKEN.")
  })
})
