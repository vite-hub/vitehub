import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it, onTestFinished, vi } from "vitest"
import { createSSRApp, h, type Component } from "vue"
import { renderToString } from "vue/server-renderer"

import { comarkBlocksSource } from "../src/comark-blocks.ts"

const legacy = vi.hoisted(() => ({ enabled: false }))
vi.mock("node:module", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:module")>()
  return {
    ...original,
    createRequire: (...args: Parameters<typeof original.createRequire>) => {
      const require = original.createRequire(...args)
      const resolve = require.resolve.bind(require)
      require.resolve = Object.assign((id: string) => legacy.enabled && id === "comark-ui/vue"
        ? fileURLToPath(new URL("./fixtures/comark-ui-legacy.mjs", import.meta.url))
        : resolve(id), require.resolve)
      return require
    },
  }
})

describe("comarkBlocksSource", () => {
  it("supports a default-only preset export during generation and lazy fallback rendering", async () => {
    legacy.enabled = true
    onTestFinished(() => { legacy.enabled = false })
    const source = await comarkBlocksSource()
    const dir = mkdtempSync(join(tmpdir(), "docs-legacy-blocks-"))
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
    writeFileSync(join(dir, "blocks.mjs"), source)
    const { default: blocks } = await import(join(dir, "blocks.mjs")) as { default: Record<string, Component> }
    expect(blocks.Tabs).toBeDefined()
    expect(blocks.pele).toBeDefined()
    const html = await renderToString(createSSRApp({ render: () => h(blocks["typeset-styles"]!) }))
    expect(html).toContain("data-comark-typeset")
  })
  it("loads each comark-ui block from its own package on first use", async () => {
    const source = await comarkBlocksSource()
    expect(source).not.toMatch(/^import .*comark/m)
    expect(source).toMatch(/"Tabs": defineAsyncComponent\(\(\) => import\("[^"]*\/comark-tabs\/dist\/vue\.mjs"\)/)
    expect(source).toMatch(/"GithubCallout": defineAsyncComponent\(\(\) => import\("[^"]*\/comark-github\/dist\/vue\.mjs"\)/)
    // comark-ui defines the Mermaid wrapper itself.
    expect(source).toMatch(/"pele": defineAsyncComponent\(\(\) => import\("[^"]*\/comark-ui\/dist\/vue\.mjs"\)/)

    const dir = mkdtempSync(join(tmpdir(), "docs-blocks-"))
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
    writeFileSync(join(dir, "blocks.mjs"), source)
    const { default: blocks } = await import(join(dir, "blocks.mjs")) as { default: Record<string, Component> }
    const html = await renderToString(createSSRApp({ render: () => h(blocks.GithubCallout!, { type: "tip", title: "Tip" }, () => "Body") }))
    expect(html).toMatch(/<div\b(?=[^>]*\bclass="cgc")(?=[^>]*\bdata-type="tip")[^>]*>/)
    expect(html).toContain("Body")
  })
})
