import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { resolveConfig } from "vite"
import { describe, expect, it } from "vitest"

import { vitehub } from "../src/index.ts"

describe("built-in deployment preset integration", () => {
  it.each(["cloudflare", "netlify", "vercel", "deno", "node"] as const)("resolves the minimal %s preset with real owner plugins", async (preset) => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-preset-config-"))
    const config = await resolveConfig({
      root,
      plugins: [vitehub({
        preset,
        agent: false,
        blob: false,
        database: false,
        devtools: false,
        env: false,
        queue: false,
        rateLimit: false,
        workflow: false,
        workspace: false,
      })],
    }, "build")
    expect(config.plugins.map(plugin => plugin.name)).not.toContain("@vite-hub/sandbox/vite")
    expect((config as typeof config & { nitro?: { preset?: string } }).nitro?.preset).toBeTruthy()
  })
})
