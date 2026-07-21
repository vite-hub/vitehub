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
      },
    }
    const plugin = hubBrowser({ binding: "MY_BROWSER" })

    ;(plugin.config as unknown as (config: Record<string, unknown>) => void)(config)

    expect(config).toHaveProperty("nitro.cloudflare.wrangler.browser", { binding: "MY_BROWSER" })
    expect(config).toHaveProperty("nitro.cloudflare.wrangler.compatibility_flags", ["existing", "nodejs_compat"])
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
    await (plugin.closeBundle as () => Promise<void>)()

    const output = JSON.parse(await readFile(join(root, "dist", root.split("/").at(-1)!.toLowerCase(), "wrangler.json"), "utf8"))
    expect(output).toEqual({ browser: { binding: "BROWSER" } })
  })

  it("validates binding names", () => {
    expect(() => hubBrowser({ binding: "bad-binding" })).toThrow("valid Cloudflare binding name")
  })
})
