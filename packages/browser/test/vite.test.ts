import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { hubBrowser } from "../src/vite.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

describe("hubBrowser", () => {
  it("composes the Cloudflare binding into Nitro config", () => {
    const config: Record<string, unknown> = {
      nitro: {
        cloudflare: { wrangler: { compatibility_flags: ["existing"] } },
        rollupConfig: { external: ["existing-module"] },
      },
    }
    const plugin = hubBrowser({ binding: "MY_BROWSER" })

    ;(plugin.config as unknown as (config: Record<string, unknown>) => void)(config)

    expect(config).toHaveProperty("nitro.cloudflare.wrangler.browser", { binding: "MY_BROWSER" })
    expect(config).toHaveProperty("nitro.cloudflare.wrangler.compatibility_flags", ["existing", "nodejs_compat"])
    expect(config).toHaveProperty("nitro.rollupConfig.external", ["existing-module", "cloudflare:workers"])
  })

  it("honors top-level Browser config", () => {
    const config: Record<string, unknown> = {
      browser: { binding: "TOP_LEVEL_BROWSER" },
      nitro: {},
    }
    const plugin = hubBrowser()

    ;(plugin.config as unknown as (config: Record<string, unknown>) => void)(config)

    expect(config).toHaveProperty("nitro.cloudflare.wrangler.browser", { binding: "TOP_LEVEL_BROWSER" })
    expect(plugin.api.getConfig()).toEqual({ binding: "TOP_LEVEL_BROWSER", provider: "cloudflare" })
  })

  it("writes and cleans owned standalone Provider Output", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-browser-vite-"))
    roots.push(root)
    const plugin = hubBrowser({ binding: "BROWSER" })
    ;(plugin.configResolved as unknown as (config: Record<string, unknown>) => void)({
      browser: { binding: "BROWSER" },
      build: { outDir: "dist" },
      command: "build",
      mode: "production",
      nitro: {},
      root,
    })
    await (plugin.closeBundle as { handler(): Promise<void> }).handler()

    const output = JSON.parse(await readFile(join(root, "dist", root.split("/").at(-1)!.toLowerCase(), "wrangler.json"), "utf8"))
    expect(output).toEqual({ browser: { binding: "BROWSER" } })
  })

  it("validates binding names", () => {
    expect(() => hubBrowser({ binding: "bad-binding" })).toThrow("valid Cloudflare binding name")
  })
})
