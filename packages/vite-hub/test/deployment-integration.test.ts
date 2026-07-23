import { mkdtemp, rm } from "node:fs/promises"
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
        blob: false,
        env: false,
        queue: false,
        rateLimit: false,
      })],
    }, "build")
    expect(config.plugins.map(plugin => plugin.name)).not.toContain("@vite-hub/sandbox/vite")
    expect((config as typeof config & { nitro?: { preset?: string } }).nitro?.preset).toBeTruthy()
  })

  it("preserves a Worker name configured through the Nitro plugin", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-worker-name-"))
    try {
      const config = await resolveConfig({
        root,
        plugins: [
          vitehub({ name: "logical-app", preset: "cloudflare" }),
          {
            name: "nitro-config",
            config() {
              return {
                nitro: {
                  cloudflare: {
                    wrangler: {
                      name: "physical-worker",
                    },
                  },
                },
              } as never
            },
          },
        ],
      }, "build")
      expect((config as typeof config & {
        nitro?: { cloudflare?: { wrangler?: { name?: string } } }
      }).nitro?.cloudflare?.wrangler?.name).toBe("physical-worker")
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})
