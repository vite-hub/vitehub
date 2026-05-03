import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it, vi } from "vitest"

import { rc, runtimeConfigVite } from "../src/vite.ts"

import { booleanSchema, stringSchema } from "./helpers.ts"

describe("Vite plugin", () => {
  it("loads Vite env, validates build values, injects define, and serves virtual config", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-runtime-config-vite-"))
    await writeFile(join(root, "package.json"), JSON.stringify({ version: "1.2.3" }), "utf8")
    await writeFile(join(root, ".env.production"), "PUBLIC_API_BASE=https://api.example.com\nSENTRY_DEBUG=true\n", "utf8")

    const plugin = runtimeConfigVite({ diagnostics: "trace" })
    const configHook = plugin.config as (config: Record<string, unknown>, env: { command: "build" | "serve", mode: string }) => unknown
    const result = configHook({
      root,
      vitehub: {
        runtimeConfig: {
          build: {
            define: {
              __APP_VERSION__: rc.build.define.pkg("version", stringSchema()),
              __SENTRY_DEBUG__: rc.build.env("SENTRY_DEBUG", booleanSchema()),
            },
            public: {
              apiBase: rc.build.env("PUBLIC_API_BASE", stringSchema()),
            },
          },
        },
      },
    }, { command: "build", mode: "production" })

    expect(result).toMatchObject({
      define: {
        __APP_VERSION__: "1.2.3",
        __SENTRY_DEBUG__: true,
      },
    })
    expect(plugin.api.getBuildConfig()).toEqual({
      apiBase: "https://api.example.com",
    })

    const configResolvedHook = plugin.configResolved as (config: unknown) => Promise<void> | void
    await configResolvedHook({
      logger: { info: vi.fn() },
      root,
    } as never)

    await expect(readFile(join(root, ".vitehub/runtime-config/vite.d.ts"), "utf8")).resolves.toContain("apiBase")

    const loadHook = plugin.load as (id: string) => string | undefined
    const loaded = loadHook("\0virtual:vitehub/runtime-config/build")
    expect(loaded).toContain("https://api.example.com")
  })
})
