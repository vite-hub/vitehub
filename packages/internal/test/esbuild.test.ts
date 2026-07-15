import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { afterEach, describe, expect, it } from "vitest"

import type { Plugin } from "esbuild"

const tempDirs: string[] = []

async function createTempDir() {
  const dir = await mkdtemp(join(tmpdir(), "vitehub-internal-esbuild-"))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

describe("bundleEsmEntry", () => {
  it("loads files as text only when imported with Vite's raw query", async () => {
    const rootDir = await createTempDir()
    const rawEntry = join(rootDir, "raw-entry.mjs")
    const plainEntry = join(rootDir, "plain-entry.mjs")
    const markdown = join(rootDir, "context.md")
    const outfile = join(rootDir, "bundle.mjs")
    await writeFile(markdown, "# Repository context\n\nUse **trusted** Markdown.\n", "utf8")
    await writeFile(rawEntry, 'import context from "./context.md?raw"\nexport default context\n', "utf8")
    await writeFile(plainEntry, 'import context from "./context.md"\nexport default context\n', "utf8")

    const { bundleEsmEntry } = await import("../src/build/esbuild.ts")
    await bundleEsmEntry(rawEntry, outfile, { format: "esm", platform: "node" })

    const loaded = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`) as { default: string }
    expect(loaded.default).toBe("# Repository context\n\nUse **trusted** Markdown.\n")
    await expect(bundleEsmEntry(plainEntry, outfile, { format: "esm", platform: "node" }))
      .rejects.toThrow('No loader is configured for ".md" files')
  })

  it("bundles caller-relative Markdown prompt templates without runtime source files", async () => {
    const rootDir = await createTempDir()
    const entry = join(rootDir, "babysitter.schedule.mjs")
    const template = join(rootDir, "prompt.md")
    const outfile = join(rootDir, "bundle.mjs")
    await writeFile(template, "Review PR {{ context.number }}.\n\n{{{ blocker }}}\n", "utf8")
    await writeFile(entry, [
      `import prompt from "./prompt.md?markdown-template"`,
      `export default () => prompt({ blocker: "> Waiting", context: { number: 42 } })`,
      ``,
    ].join("\n"), "utf8")

    const { bundleEsmEntry } = await import("../src/build/esbuild.ts")
    await bundleEsmEntry(entry, outfile, {
      alias: { "@vite-hub/markdown-template": fileURLToPath(import.meta.resolve("@vite-hub/markdown-template")) },
      format: "esm",
      platform: "node",
      rootDir,
    })
    await rm(template)

    const bundled = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`) as { default: () => Promise<string> }
    await expect(bundled.default()).resolves.toBe("Review PR 42.\n\n> Waiting")
  })

  it("resolves root-absolute raw imports from the Vite root", async () => {
    const rootDir = await createTempDir()
    const sourceDir = join(rootDir, "src")
    const entry = join(rootDir, "entry.mjs")
    const outfile = join(rootDir, "bundle.mjs")
    await mkdir(sourceDir, { recursive: true })
    await writeFile(join(sourceDir, "context.md"), "# Root context\n", "utf8")
    await writeFile(entry, 'import context from "/src/context.md?raw"\nexport default context\n', "utf8")

    const { bundleEsmEntry } = await import("../src/build/esbuild.ts")
    await bundleEsmEntry(entry, outfile, { format: "esm", platform: "node", rootDir })

    const loaded = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`) as { default: string }
    expect(loaded.default).toBe("# Root context\n")
  })

  it("resolves public and /@fs/ raw imports with Vite semantics", async () => {
    const rootDir = await createTempDir()
    const publicDir = join(rootDir, "public")
    const entry = join(rootDir, "entry.mjs")
    const outsideRoot = join(await createTempDir(), "outside.md")
    const outfile = join(rootDir, "bundle.mjs")
    await mkdir(publicDir, { recursive: true })
    await writeFile(join(rootDir, "robots.txt"), "root robots\n", "utf8")
    await writeFile(join(publicDir, "robots.txt"), "public robots\n", "utf8")
    await writeFile(outsideRoot, "outside context\n", "utf8")
    await writeFile(entry, [
      `import robots from "/robots.txt?raw"`,
      `import outside from ${JSON.stringify(`/@fs/${outsideRoot}?raw`)}`,
      `export default { outside, robots }`,
      ``,
    ].join("\n"), "utf8")

    const { bundleEsmEntry } = await import("../src/build/esbuild.ts")
    await bundleEsmEntry(entry, outfile, { format: "esm", platform: "node", rootDir })

    const loaded = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`) as { default: { outside: string, robots: string } }
    expect(loaded.default).toEqual({ outside: "outside context\n", robots: "public robots\n" })
  })

  it("lets caller plugins handle raw queries before the fallback", async () => {
    const rootDir = await createTempDir()
    const entry = join(rootDir, "entry.mjs")
    const outfile = join(rootDir, "bundle.mjs")
    await writeFile(entry, 'import context from "virtual:context?raw"\nexport default context\n', "utf8")
    const callerPlugin: Plugin = {
      name: "caller-raw",
      setup(build) {
        build.onResolve({ filter: /^virtual:context\?raw$/ }, () => ({
          namespace: "caller-raw",
          path: "context",
        }))
        build.onLoad({ filter: /.*/, namespace: "caller-raw" }, () => ({
          contents: 'export default "caller handled raw"',
          loader: "js",
        }))
      },
    }

    const { bundleEsmEntry } = await import("../src/build/esbuild.ts")
    await bundleEsmEntry(entry, outfile, { format: "esm", platform: "node", plugins: [callerPlugin] })

    const loaded = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`) as { default: string }
    expect(loaded.default).toBe("caller handled raw")
  })

  it("preserves external results from raw fallback resolution", async () => {
    const rootDir = await createTempDir()
    const entry = join(rootDir, "entry.mjs")
    const outfile = join(rootDir, "bundle.mjs")
    const importerData = { owner: "caller-plugin" }
    let resolverContext: { pluginData: unknown, with: Record<string, string> } | undefined
    await writeFile(entry, 'import context from "external-context?raw" with { type: "text" }\nexport default context\n', "utf8")
    const externalPlugin: Plugin = {
      name: "external-context",
      setup(build) {
        build.onLoad({ filter: /entry\.mjs$/, namespace: "file" }, async args => ({
          contents: await readFile(args.path),
          loader: "js",
          pluginData: importerData,
        }))
        build.onResolve({ filter: /^external-context$/ }, (args) => {
          resolverContext = { pluginData: args.pluginData, with: args.with }
          return {
            external: true,
            path: "external-context",
          }
        })
      },
    }

    const { bundleEsmEntry } = await import("../src/build/esbuild.ts")
    await bundleEsmEntry(entry, outfile, { format: "esm", platform: "node", plugins: [externalPlugin] })

    await expect(readFile(outfile, "utf8")).resolves.toContain('from "external-context"')
    expect(resolverContext).toEqual({ pluginData: importerData, with: { type: "text" } })
  })

  it("rejects non-file raw fallback results with a targeted error", async () => {
    const rootDir = await createTempDir()
    const entry = join(rootDir, "entry.mjs")
    const outfile = join(rootDir, "bundle.mjs")
    await writeFile(entry, 'import context from "virtual:context?raw"\nexport default context\n', "utf8")
    const virtualPlugin: Plugin = {
      name: "virtual-context",
      setup(build) {
        build.onResolve({ filter: /^virtual:context$/ }, () => ({
          namespace: "virtual-context",
          path: "context",
        }))
        build.onLoad({ filter: /.*/, namespace: "virtual-context" }, () => ({
          contents: "virtual contents",
          loader: "text",
        }))
      },
    }

    const { bundleEsmEntry } = await import("../src/build/esbuild.ts")
    await expect(bundleEsmEntry(entry, outfile, { format: "esm", platform: "node", plugins: [virtualPlugin] }))
      .rejects.toThrow('Vite raw fallback cannot load "virtual:context?raw" from the "virtual-context" namespace')
  })

  it("keeps CommonJS globals available in Node ESM bundles", async () => {
    const rootDir = await createTempDir()
    const entry = join(rootDir, "entry.mjs")
    const outfile = join(rootDir, "bundle.mjs")
    await writeFile(entry, "export default () => ({ dirname: __dirname, filename: __filename, requireType: typeof require })\n", "utf8")

    const { bundleEsmEntry } = await import("../src/build/esbuild.ts")
    await bundleEsmEntry(entry, outfile, { format: "esm", platform: "node" })

    await expect(readFile(outfile, "utf8")).resolves.toContain("globalThis.__filename = __vitehubFileURLToPath(import.meta.url);")
    const loaded = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`) as { default: () => { dirname: string, filename: string, requireType: string } }
    expect(loaded.default()).toEqual({
      dirname: dirname(outfile),
      filename: outfile,
      requireType: "function",
    })
  })

  it("does not redeclare Netlify runtime filename globals", async () => {
    const rootDir = await createTempDir()
    const entry = join(rootDir, "entry.mjs")
    const outfile = join(rootDir, "bundle.mjs")
    await writeFile(entry, "export default () => ({ filename: __filename, requireType: typeof require })\n", "utf8")

    const { bundleEsmEntry } = await import("../src/build/esbuild.ts")
    await bundleEsmEntry(entry, outfile, { format: "esm", minifyIdentifiers: true, platform: "node" })

    const bundled = await readFile(outfile, "utf8")
    expect(bundled).not.toContain("var __filename")
    expect(bundled).not.toContain("const __filename")
    await writeFile(outfile, `${bundled}\nconst __filename = "netlify-runtime";\n`, "utf8")

    const loaded = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`) as { default: () => { filename: string, requireType: string } }
    expect(loaded.default()).toEqual({
      filename: "netlify-runtime",
      requireType: "function",
    })
  })

  it("resolves package entry fields in neutral bundles", async () => {
    const rootDir = await createTempDir()
    const packageDir = join(rootDir, "node_modules", "main-only-package")
    const entry = join(rootDir, "entry.mjs")
    const outfile = join(rootDir, "bundle.mjs")
    await mkdir(packageDir, { recursive: true })
    await writeFile(join(packageDir, "package.json"), JSON.stringify({ main: "index.js", name: "main-only-package", type: "module" }), "utf8")
    await writeFile(join(packageDir, "index.js"), "export const value = 'neutral-main'\n", "utf8")
    await writeFile(entry, "import { value } from 'main-only-package'\nexport default value\n", "utf8")

    const { bundleEsmEntry } = await import("../src/build/esbuild.ts")
    await bundleEsmEntry(entry, outfile, { format: "esm", platform: "neutral" })

    const loaded = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`) as { default: string }
    expect(loaded.default).toBe("neutral-main")
  })
})
