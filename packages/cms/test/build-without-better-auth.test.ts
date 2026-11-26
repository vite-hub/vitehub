import { fileURLToPath } from "node:url"

import { build } from "vite"
import { describe, expect, it } from "vitest"

import type { Plugin, Rolldown } from "vite"

const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url))

const missingBetterAuth: Plugin = {
  name: "missing-better-auth",
  enforce: "pre",
  resolveId: id => id.startsWith("better-auth") ? `\0missing:${id}` : undefined,
  load: id => id.startsWith("\0missing:") ? "export default {}" : undefined,
}

const external = (id: string) => !id.startsWith(".") && !id.startsWith("/") && !id.startsWith("\0")

describe("an app without better-auth", () => {
  it("bundles the cms preset", async () => {
    await expect(build({
      configFile: false,
      logLevel: "silent",
      plugins: [missingBetterAuth],
      build: {
        write: false,
        ssr: entry,
        rolldownOptions: { external: id => external(id) && !id.startsWith("better-auth") },
      },
    })).resolves.toBeDefined()
  })

  it("loads the cms preset from one file, as Nitro dev bundles it", async () => {
    const output = await build({
      configFile: false,
      logLevel: "silent",
      build: { write: false, ssr: entry, rolldownOptions: { external, output: { codeSplitting: false } } },
    }) as Rolldown.RolldownOutput
    expect(output.output[0].code).not.toMatch(/^import\b[^;]*["']better-auth[/"']/m)
  })
})
