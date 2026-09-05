import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { build } from "vite"

async function bundle(entry: string, conditions: string[] = ["node"]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vitehub-browser-optional-peer-"))
  try {
    const source = join(root, "entry.ts")
    await writeFile(source, `export * from ${JSON.stringify(entry)}\n`)
    const result = await build({
      build: {
        rollupOptions: { external: ["@cloudflare/playwright", "@vite-hub/runtime", "cloudflare:workers", "playwright-core"] },
        ssr: source,
        write: false,
      },
      logLevel: "silent",
      ssr: { resolve: { conditions } },
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
  let packedRoot: string
  beforeAll(async () => {
    packedRoot = await mkdtemp(join(tmpdir(), "vitehub-browser-packed-"))
    const archive = join(packedRoot, "browser.tgz")
    await promisify(execFile)("pnpm", ["pack", "--out", archive], {
      cwd: new URL("..", import.meta.url),
    })
    await promisify(execFile)("tar", ["-xzf", archive, "-C", packedRoot])
  })
  afterAll(async () => {
    if (packedRoot) await rm(packedRoot, { force: true, recursive: true })
  })

  it("keeps esbuild external in the Vite entry", async () => {
    const output = await readFile(new URL(`../${"dist"}/vite.js`, import.meta.url), "utf8")

    expect(output).toContain(`from "esbuild"`)
  })

  it("keeps page-session peers out of root entry points", async () => {
    const builtEntry = new URL(`../${"dist"}/index.js`, import.meta.url).pathname
    const output = await bundle(builtEntry)

    expect(output).not.toContain('import("@cloudflare/playwright")')
    expect(output).not.toContain('import("playwright-core")')
  })

  it("keeps the Node CDP loader out of Cloudflare Playwright bundles", async () => {
    const entry = join(packedRoot, "package/dist/controllers/playwright.js")
    const output = await bundle(entry, ["workerd", "worker"])

    expect(output).toContain('import("@cloudflare/playwright")')
    expect(output).not.toContain('import("playwright-core")')
    expect(output).not.toContain("chromium-bidi")
    expect(output).toContain("requires Node.js")
  })

  it("keeps the Node CDP loader available outside Workers", async () => {
    const entry = join(packedRoot, "package/dist/controllers/playwright.js")
    const output = await bundle(entry)

    expect(output).toContain('import("playwright-core")')
    expect(output).not.toContain("requires Node.js")
  })

  it("keeps page-session peers discoverable in feature entry points", async () => {
    const files = [
      "../dist/controllers/playwright.js",
      "../dist/internal/chromium.js",
      "../dist/providers/cloudflare.js",
    ]
    const output = (await Promise.all(files.map(file => readFile(new URL(file, import.meta.url), "utf8")))).join("\n")

    expect(output).toContain('import("@cloudflare/playwright")')
    expect(output).toContain('import("playwright-core")')
  })
})
