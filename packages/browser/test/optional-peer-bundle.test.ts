import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"
import { build } from "vite"

async function bundle(entry: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vitehub-browser-optional-peer-"))
  try {
    const source = join(root, "entry.ts")
    await writeFile(source, `export * from ${JSON.stringify(entry)}\n`)
    const result = await build({
      build: {
        rollupOptions: { external: ["@vite-hub/runtime", "cloudflare:workers"] },
        ssr: source,
        write: false,
      },
      logLevel: "silent",
      root,
    })
    const results = Array.isArray(result) ? result : [result]
    return results.flatMap(output => "output" in output ? output.output : [])
      .flatMap(output => output.type === "chunk" ? [output.code] : [])
      .join("\n")
  }
  finally {
    await rm(root, { force: true, recursive: true })
  }
}

describe("Browser optional peer bundle", () => {
  it("keeps page-session peers out of root entry points", async () => {
    const builtEntry = new URL(`../${"dist"}/index.js`, import.meta.url).pathname
    const output = await bundle(builtEntry)

    expect(output).not.toContain('import("@cloudflare/playwright")')
    expect(output).not.toContain('import("playwright-core")')
  })

  it("keeps page-session peers discoverable in feature entry points", async () => {
    const files = [
      "../dist/controllers/playwright.js",
      "../dist/providers/cloudflare.js",
    ]
    const output = (await Promise.all(files.map(file => readFile(new URL(file, import.meta.url), "utf8")))).join("\n")

    expect(output).toContain('import("@cloudflare/playwright")')
    expect(output).toContain('import("playwright-core")')
  })
})
