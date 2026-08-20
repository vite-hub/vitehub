import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"

import { afterEach, describe, expect, it } from "vitest"
import { build } from "vite"

import { hubBrowser } from "../src/vite.ts"

const execFileAsync = promisify(execFile)
const roots: string[] = []
const tsc = resolve(import.meta.dirname, "../../../node_modules/typescript/bin/tsc")

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

describe("hubBrowser", () => {
  it("rejects an explicitly empty Browser engine", () => {
    expect(() => hubBrowser({ engine: "" as "chromium" })).toThrow(
      'Browser engine must be "chromium" or "kitesurf"',
    )
  })

  it("composes the Cloudflare binding into Nitro config", () => {
    const config: Record<string, unknown> = {
      nitro: {
        cloudflare: { wrangler: { compatibility_flags: ["existing"] } },
        rollupConfig: { external: ["existing-module"] },
      },
    }
    const plugin = hubBrowser({ binding: "MY_BROWSER", remote: true })

    ;(plugin.config as unknown as (config: Record<string, unknown>) => void)(config)

    expect(config).toHaveProperty("nitro.cloudflare.wrangler.browser", { binding: "MY_BROWSER", remote: true })
    expect(config).toHaveProperty("nitro.cloudflare.nodeCompat", true)
    expect(config).toHaveProperty("nitro.cloudflare.wrangler.compatibility_flags", ["existing"])
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
    expect(plugin.api.getConfig()).toEqual({ binding: "TOP_LEVEL_BROWSER", engine: "kitesurf", remote: false })
  })

  it("generates the provider runtime and discovered Browser Definition registry", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-browser-registry-"))
    roots.push(root)
    await mkdir(join(root, "server", "browsers"), { recursive: true })
    await writeFile(
      join(root, "server", "browsers", "code-image.ts"),
      "export default defineBrowser(async () => new Uint8Array())\n",
      "utf8",
    )
    const plugin = hubBrowser({ binding: "CODE_BROWSER" })
    const config = {
      browser: { binding: "CODE_BROWSER" },
      build: { outDir: "dist" },
      command: "serve",
      mode: "development",
      nitro: {},
      root,
    }

    ;(plugin.config as unknown as (config: Record<string, unknown>) => void)(config)
    await (plugin.configResolved as unknown as (config: Record<string, unknown>) => Promise<void>)(config)

    const registryId = (plugin.resolveId as (id: string) => string)("#vitehub/browser/registry")
    const runtimeId = (plugin.resolveId as (id: string) => string)("#vitehub/browser/runtime")
    const registry = await (plugin.load as (id: string) => string | Promise<string>)(registryId)
    const runtime = await (plugin.load as (id: string) => string | Promise<string>)(runtimeId)
    const types = await readFile(join(root, ".vitehub", "types", "browser.d.ts"), "utf8")

    expect(registry).toContain('"code-image": async () => import(')
    expect(registry).toContain("server/browsers/code-image.ts")
    expect(runtime).toContain('"binding": "CODE_BROWSER"')
    expect(runtime).toContain('"engine": "kitesurf"')
    expect(types).toContain("interface ViteHubBrowserDefinitionModules")
    expect(types).toContain('"code-image": typeof import(')
    expect(types).toContain("server/browsers/code-image.ts")

    const jsxDefinition = join(root, "server", "browsers", "jsx-browser.jsx")
    await writeFile(jsxDefinition, "export default defineBrowser(async () => undefined)\n", "utf8")
    await (plugin.handleHotUpdate as unknown as (context: Record<string, unknown>) => Promise<void>)({
      file: jsxDefinition,
      server: {
        config: { root },
        moduleGraph: {
          getModuleById: () => undefined,
          invalidateModule: () => {},
        },
      },
    })
    await expect(readFile(join(root, ".vitehub", "types", "browser.d.ts"), "utf8")).resolves.toContain(
      "server/browsers/jsx-browser.jsx",
    )
  })

  it("discovers Browser Definitions from the project root when Vite runs from app", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-browser-app-root-"))
    roots.push(root)
    const appRoot = join(root, "app")
    await mkdir(join(root, "server", "browsers"), { recursive: true })
    await mkdir(appRoot)
    await writeFile(
      join(root, "server", "browsers", "parent-definition.ts"),
      "export default defineBrowser(async () => undefined)\n",
      "utf8",
    )
    const plugin = hubBrowser()
    const config = {
      browser: {},
      build: { outDir: "dist" },
      command: "serve",
      mode: "development",
      nitro: {},
      root: appRoot,
    }

    ;(plugin.config as unknown as (config: Record<string, unknown>) => void)(config)
    await (plugin.configResolved as unknown as (config: Record<string, unknown>) => Promise<void>)(config)

    await expect(readFile(join(root, ".vitehub", "types", "browser.d.ts"), "utf8")).resolves.toContain(
      "server/browsers/parent-definition.ts",
    )
  })

  it("generates an empty Browser registry when disabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-browser-disabled-"))
    roots.push(root)
    await mkdir(join(root, "server", "browsers"), { recursive: true })
    await writeFile(
      join(root, "server", "browsers", "disabled-definition.ts"),
      "export default defineBrowser(async () => undefined)\n",
      "utf8",
    )
    const plugin = hubBrowser(false)
    const config = {
      browser: false,
      build: { outDir: "dist" },
      command: "serve",
      mode: "development",
      nitro: {},
      root,
    }

    ;(plugin.config as unknown as (config: Record<string, unknown>) => void)(config)
    await (plugin.configResolved as unknown as (config: Record<string, unknown>) => Promise<void>)(config)

    const types = await readFile(join(root, ".vitehub", "types", "browser.d.ts"), "utf8")
    expect(types).not.toContain("disabled-definition")
  })

  it("compiles generated runBrowser names, inputs, and results", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-browser-types-"))
    roots.push(root)
    await mkdir(join(root, "server", "browsers"), { recursive: true })
    await writeFile(
      join(root, "server", "browsers", "code-image.ts"),
      [
        `import { defineBrowser } from "@vite-hub/browser"`,
        `export default defineBrowser(async (input: { code: string }) => ({ length: input.code.length }))`,
        "",
      ].join("\n"),
      "utf8",
    )
    const plugin = hubBrowser()
    const config = {
      browser: {},
      build: { outDir: "dist" },
      command: "serve",
      mode: "development",
      nitro: {},
      root,
    }

    ;(plugin.config as unknown as (config: Record<string, unknown>) => void)(config)
    await (plugin.configResolved as unknown as (config: Record<string, unknown>) => Promise<void>)(config)
    await writeFile(
      join(root, "consumer.ts"),
      [
        `import { runBrowser, type BrowserRunResult } from "@vite-hub/browser"`,
        `const result: Promise<BrowserRunResult<{ length: number }>> = runBrowser("code-image", { code: "const ok = true" })`,
        `void result`,
        `// @ts-expect-error unknown Browser Definition`,
        `runBrowser("missing", { code: "const ok = false" })`,
        `// @ts-expect-error incorrect input`,
        `runBrowser("code-image", { url: "https://example.com" })`,
        "",
      ].join("\n"),
      "utf8",
    )
    await writeFile(
      join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          module: "ESNext",
          moduleResolution: "Bundler",
          noEmit: true,
          paths: {
            "@vite-hub/browser": [resolve(import.meta.dirname, "../dist/index.d.ts")],
          },
          skipLibCheck: true,
          strict: true,
          target: "ESNext",
        },
        files: [
          ".vitehub/types/browser.d.ts",
          "consumer.ts",
          "server/browsers/code-image.ts",
        ],
      }, null, 2),
      "utf8",
    )

    try {
      await execFileAsync(process.execPath, [tsc, "-p", root], { cwd: root })
    }
    catch (error) {
      const output = error as Error & { stderr?: string, stdout?: string }
      throw new Error([output.message, output.stdout, output.stderr].filter(Boolean).join("\n"), { cause: error })
    }
  })

  it("bundles discovered Browser Definitions without provider imports in application code", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-browser-build-"))
    roots.push(root)
    await mkdir(join(root, "server", "browsers"), { recursive: true })
    await writeFile(join(root, "package.json"), JSON.stringify({ private: true, type: "module" }), "utf8")
    await writeFile(
      join(root, "server", "browsers", "code-image.ts"),
      [
        `import { defineBrowser } from "@vite-hub/browser"`,
        `export default defineBrowser(async (_input, { browser }) => {`,
        `  const { page } = await browser.open()`,
        `  await page.goto(_input.url)`,
        `  return await page.locator("title").count()`,
        `})`,
        "",
      ].join("\n"),
      "utf8",
    )
    await writeFile(
      join(root, "server.ts"),
      [
        `import { runBrowser } from "@vite-hub/browser"`,
        `export async function render() { return await runBrowser("code-image") }`,
        "",
      ].join("\n"),
      "utf8",
    )

    const buildResult = await build({
      build: {
        outDir: "dist",
        rollupOptions: {
          external: [
            "@cloudflare/playwright",
            "@vite-hub/runtime",
            "cloudflare:workers",
          ],
        },
        ssr: "server.ts",
      },
      logLevel: "silent",
      plugins: [hubBrowser({ binding: "CODE_BROWSER" })],
      resolve: {
        alias: {
          "@vite-hub/browser": join(import.meta.dirname, "../dist/index.js"),
        },
      },
      root,
    })

    const results = Array.isArray(buildResult) ? buildResult : [buildResult]
    const output = results
      .flatMap(result => "output" in result ? result.output : [])
      .flatMap(chunk => chunk.type === "chunk" ? [chunk.code] : [])
      .join("\n")
    expect(output).toContain("code-image")
    expect(output).toContain("CODE_BROWSER")
    expect(output).toContain("Target.getTargets")
    expect(output).not.toContain("@vite-hub/browser/providers/cloudflare")
    expect(output).not.toContain("playwright-core")
  })

  it("bundles Browser Run actions without Playwright", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-browser-action-build-"))
    roots.push(root)
    await writeFile(join(root, "package.json"), JSON.stringify({ private: true, type: "module" }), "utf8")
    await writeFile(
      join(root, "server.ts"),
      [
        `import { runBrowserContent } from "@vite-hub/browser/actions"`,
        `export async function render() { return await runBrowserContent("https://example.com") }`,
        "",
      ].join("\n"),
      "utf8",
    )

    const buildResult = await build({
      build: {
        outDir: "dist",
        rollupOptions: {
          external: ["cloudflare:workers"],
        },
        ssr: "server.ts",
      },
      logLevel: "silent",
      plugins: [hubBrowser({ binding: "CODE_BROWSER", engine: "chromium" })],
      resolve: {
        alias: {
          "@vite-hub/browser/actions": join(import.meta.dirname, "../dist/actions.js"),
        },
      },
      root,
    })

    const results = Array.isArray(buildResult) ? buildResult : [buildResult]
    const output = results
      .flatMap(result => "output" in result ? result.output : [])
      .flatMap(chunk => chunk.type === "chunk" ? [chunk.code] : [])
      .join("\n")
    expect(output).toContain("quickAction")
    expect(output).toContain("CODE_BROWSER")
    expect(output).not.toContain("@cloudflare/playwright")
    expect(output).not.toContain("playwright-core")
  })

  it("writes and cleans owned standalone Provider Output", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-browser-vite-"))
    roots.push(root)
    const outputDir = join(root, "dist", root.split("/").at(-1)!.toLowerCase())
    const outputFile = join(outputDir, "wrangler.json")
    await mkdir(outputDir, { recursive: true })
    await writeFile(outputFile, JSON.stringify({ compatibility_flags: ["custom"] }))
    const plugin = hubBrowser({ binding: "BROWSER", remote: true })
    ;(plugin.configResolved as unknown as (config: Record<string, unknown>) => void)({
      browser: { binding: "BROWSER", remote: true },
      build: { outDir: "dist" },
      command: "build",
      mode: "production",
      nitro: {},
      root,
    })
    await (plugin.closeBundle as { handler(): Promise<void> }).handler()

    const output = JSON.parse(await readFile(outputFile, "utf8"))
    expect(output).toEqual({
      browser: { binding: "BROWSER", remote: true },
      compatibility_date: "2026-04-20",
      compatibility_flags: ["custom", "nodejs_compat"],
    })

    const disabledPlugin = hubBrowser(false)
    ;(disabledPlugin.configResolved as unknown as (config: Record<string, unknown>) => void)({
      browser: false,
      build: { outDir: "dist" },
      command: "build",
      mode: "production",
      nitro: {},
      root,
    })
    await (disabledPlugin.closeBundle as { handler(): Promise<void> }).handler()
    await expect(readFile(outputFile, "utf8").then(JSON.parse)).resolves.toEqual({
      compatibility_date: "2026-04-20",
      compatibility_flags: ["custom", "nodejs_compat"],
    })
  })

  it("preserves an existing standalone compatibility date", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-browser-date-"))
    roots.push(root)
    const outputDir = join(root, "dist", root.split("/").at(-1)!.toLowerCase())
    const outputFile = join(outputDir, "wrangler.json")
    await mkdir(outputDir, { recursive: true })
    await writeFile(outputFile, JSON.stringify({ compatibility_date: "2026-08-01" }))
    const plugin = hubBrowser()
    ;(plugin.configResolved as unknown as (config: Record<string, unknown>) => void)({
      build: { outDir: "dist" },
      command: "build",
      mode: "production",
      nitro: {},
      root,
    })
    await (plugin.closeBundle as { handler(): Promise<void> }).handler()

    await expect(readFile(outputFile, "utf8").then(JSON.parse)).resolves.toMatchObject({
      compatibility_date: "2026-08-01",
    })
  })

  it("validates Browser options", () => {
    expect(() => hubBrowser({ binding: "bad-binding" })).toThrow("valid Cloudflare binding name")
    expect(() => hubBrowser({ engine: "webkit" as "kitesurf" })).toThrow("Browser engine")
  })
})
