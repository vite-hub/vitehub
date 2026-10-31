import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { nitro } from "nitro/vite"
import { createNitro } from "nitro/builder"
import { resolveConfig } from "vite"
import { afterEach, describe, expect, it, vi } from "vitest"

import { comments } from "../src/vite.ts"

import type { Nitro, NitroConfig } from "nitro/types"
import type { ConfigEnv, Plugin, UserConfig } from "vite"

afterEach(() => vi.unstubAllEnvs())

describe("Comments storage in Nitro's Vite configuration lifecycle", () => {
  it.each([
    { command: "serve", preset: "node-server", development: true, node: true },
    { command: "serve", preset: "cloudflare_module", development: true, node: false },
    { command: "build", preset: "cloudflare_module", development: false, node: false },
    { command: "serve", preset: "node-server", isPreview: true, development: false, node: true },
  ] as const)("generates the standalone plugin through Nitro config alone ($command, $preset, preview: $isPreview)", async ({ command, preset, development, node, ...environment }) => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-comments-host-nitro-"))
    let instance: Nitro | undefined
    try {
      await writeFile(join(root, "package.json"), "{}")
      const existingSetup = vi.fn()
      const config: UserConfig & { nitro: NitroConfig } = {
        root,
        base: "/portal/",
        nitro: { preset, compatibilityDate: "2026-10-27", modules: [{ setup: existingSetup }] },
      }
      const plugin = comments({ database: "d1:COMMENTS" })[0] as Plugin
      const hook = plugin.config as { handler: (config: UserConfig, env: ConfigEnv) => Promise<void> }
      await hook.handler(config, { command, mode: development ? "development" : "production", ...environment })
      // Hosts such as Nuxt forward config.nitro without loading Vite's plugin.nitro convention.
      instance = await createNitro({ ...config.nitro, rootDir: root, dev: development })
      const file = join(root, ".vitehub/nitro/comments/plugin.mjs")
      expect(instance.options.plugins).toContain(file)
      const source = await readFile(file, "utf8")
      expect(source).toContain(`development: ${development}`)
      expect(source).toContain('overlay: "/api/_vitehub/comments/assets/overlay.js?v=3", base: "/portal"')
      expect(instance.options.handlers).toContainEqual({ route: "/portal/_vitehub/page/session", handler: join(root, ".vitehub/nitro/comments/page-session.mjs") })
      expect(source).toContain("session: githubLogin.user, githubLogin,")
      expect(source).toContain(`from "@vite-hub/comments/runtime/connect${node ? "/node" : ""}"`)
      expect(source).toContain(development && node
        ? `connectDatabase(${JSON.stringify(`file:${join(root, ".vitehub/data/comments.sqlite")}`)}`
        : 'connectDatabase("d1:COMMENTS"')
      if (!development || !node) {
        expect(instance.options.cloudflare?.wrangler?.d1_databases).toEqual([{ binding: "COMMENTS", database_name: "comments" }])
      }
      expect(existingSetup).toHaveBeenCalledOnce()
    }
    finally {
      await instance?.close()
      await rm(root, { force: true, recursive: true })
    }
  })

  it.each<{ name: string, pluginConfig: NitroConfig, viteNitro?: NitroConfig, envRunner?: string, moduleRunner?: "miniflare" | "node-worker", workerd: boolean }>([
    { name: "the public Cloudflare plugin options", pluginConfig: { preset: "cloudflare_module" }, workerd: true },
    { name: "an explicit Node runner", pluginConfig: { devServer: { runner: "node-worker" } }, viteNitro: { preset: "cloudflare_module" }, workerd: false },
    { name: "the runner environment fallback", pluginConfig: { preset: "nitro-dev" }, envRunner: "miniflare", workerd: true },
    { name: "the preset runner before the environment fallback", pluginConfig: { preset: "cloudflare_module" }, envRunner: "node-worker", workerd: true },
    { name: "a preceding plugin module selecting Miniflare", pluginConfig: { preset: "node-server" }, moduleRunner: "miniflare", workerd: true },
    { name: "a preceding plugin module selecting Node", pluginConfig: { preset: "cloudflare_module" }, moduleRunner: "node-worker", workerd: false },
  ])("uses the effective runner with $name", async ({ pluginConfig, viteNitro, envRunner, moduleRunner, workerd }) => {
    vi.stubEnv("NITRO_DEV_RUNNER", envRunner)
    const root = await mkdtemp(join(tmpdir(), "vitehub-comments-nitro-"))
    const configured = new Error("Nitro configuration inspected")
    let instance: Nitro | undefined
    try {
      await writeFile(join(root, "package.json"), "{}")
      // Exercise Vite and Nitro's real config hooks, stopping before either runner starts.
      await expect(resolveConfig({
        configFile: false,
        logLevel: "silent",
        root,
        nitro: viteNitro,
        plugins: [moduleRunner && {
          name: "configure-nitro-runner",
          nitro: {
            async setup(nitro) {
              await expect(readFile(join(root, ".vitehub/nitro/comments/plugin.mjs"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
              nitro.options.devServer.runner = moduleRunner
            },
          },
        }, comments(), nitro({
          ...pluginConfig,
          hooks: {
            "build:before": (nitro) => {
              instance = nitro
              throw configured
            },
          },
        })],
      }, "serve")).rejects.toBe(configured)
      expect(instance).toBeDefined()
      expect((instance!.options.devServer.runner || process.env.NITRO_DEV_RUNNER || "node-worker") === "miniflare").toBe(workerd)
      const plugin = await readFile(join(root, ".vitehub/nitro/comments/plugin.mjs"), "utf8")
      expect(plugin).toContain("development: true")
      if (workerd) {
        expect(plugin).toContain('import { connectDatabase } from "@vite-hub/comments/runtime/connect"\n')
        expect(plugin).toContain('connectDatabase("d1:COMMENTS"')
        expect(instance!.options.cloudflare?.wrangler?.d1_databases).toEqual([{ binding: "COMMENTS", database_name: "comments" }])
      }
      else {
        expect(plugin).toContain('import { connectDatabase } from "@vite-hub/comments/runtime/connect/node"\n')
        expect(plugin).toContain(`connectDatabase(${JSON.stringify(`file:${join(root, ".vitehub/data/comments.sqlite")}`)}`)
        expect(instance!.options.cloudflare?.wrangler?.d1_databases).toBeUndefined()
      }
    }
    finally {
      await instance?.close()
      await rm(root, { force: true, recursive: true })
    }
  })
})
