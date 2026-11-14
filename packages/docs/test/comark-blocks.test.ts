import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it, onTestFinished } from "vitest"
import { createSSRApp, h, type Component } from "vue"
import { renderToString } from "vue/server-renderer"

import { comarkBlocksSource } from "../src/comark-blocks.ts"

describe("comarkBlocksSource", () => {
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
    expect(html).toContain('class="cgc" data-type="tip"')
    expect(html).toContain("Body")
  })
})
