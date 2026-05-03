import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it, vi } from "vitest"

import { envSource, envVariable, envVite } from "../src/vite.ts"

import { booleanSchema, stringSchema } from "./helpers.ts"

describe("Vite plugin", () => {
  it("loads Vite env, validates build values, injects define, and serves virtual config", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-env-vite-"))
    await writeFile(join(root, "package.json"), JSON.stringify({ version: "1.2.3" }), "utf8")
    await writeFile(join(root, ".env.production"), "PUBLIC_APP_NAME=Quiver\nSENTRY_DEBUG=true\n", "utf8")

    const plugin = envVite({ diagnostics: "trace" })
    const configHook = plugin.config as (config: Record<string, unknown>, env: { command: "build" | "serve", mode: string }) => Promise<unknown>
    const result = await configHook({
      env: {
        define: {
          __APP_VERSION__: envVariable({
            mode: "build",
            schema: stringSchema(),
            source: envSource.packageJson("version"),
          }),
          __GIT_COMMIT__: envVariable({
            mode: "build",
            schema: stringSchema(),
            source: envSource.custom("git:commit", () => "abc123"),
          }),
          __SENTRY_DEBUG__: envVariable("SENTRY_DEBUG", {
            mode: "build",
            schema: booleanSchema(),
          }),
        },
        public: {
          appName: envVariable("PUBLIC_APP_NAME", {
            mode: "build",
            schema: stringSchema(),
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
    expect(plugin.api.getBuildConfig()).toEqual({
      appName: "Quiver",
    })

    const configResolvedHook = plugin.configResolved as (config: unknown) => Promise<void> | void
    await configResolvedHook({
      logger: { info: vi.fn() },
      root,
    } as never)

    await expect(readFile(join(root, ".vitehub/env/vite.d.ts"), "utf8")).resolves.toContain("appName")

    const loadHook = plugin.load as (id: string) => string | undefined
    const loaded = loadHook("\0virtual:@vitehub/env/build")
    expect(loaded).toContain("Quiver")
    expect(loaded).toContain("useSafeBuildConfig")
  })
})
