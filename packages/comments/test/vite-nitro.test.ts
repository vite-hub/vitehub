import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { nitro } from "nitro/vite"
import { resolveConfig } from "vite"
import { afterEach, describe, expect, it, vi } from "vitest"

import { comments } from "../src/vite.ts"

import type { Nitro, NitroConfig } from "nitro/types"

afterEach(() => vi.unstubAllEnvs())

describe("Comments storage in Nitro's Vite configuration lifecycle", () => {
  it.each<{ name: string, pluginConfig: NitroConfig, viteNitro?: NitroConfig, envRunner?: string, workerd: boolean }>([
    { name: "the public Cloudflare plugin options", pluginConfig: { preset: "cloudflare_module" }, workerd: true },
    { name: "an explicit Node runner", pluginConfig: { devServer: { runner: "node-worker" } }, viteNitro: { preset: "cloudflare_module" }, workerd: false },
    { name: "the runner environment fallback", pluginConfig: { preset: "nitro-dev" }, envRunner: "miniflare", workerd: true },
    { name: "the preset runner before the environment fallback", pluginConfig: { preset: "cloudflare_module" }, envRunner: "node-worker", workerd: true },
  ])("uses the effective runner with $name", async ({ pluginConfig, viteNitro, envRunner, workerd }) => {
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
        plugins: [comments(), nitro({
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
      }
    }
    finally {
      await instance?.close()
      await rm(root, { force: true, recursive: true })
    }
  })
})
