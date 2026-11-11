import { readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

import { resolveConsoleSectionIds } from "../src/console/runtime/sections"

describe("shared Console navigation layout", () => {
  it("enables every registered Database route through navigation", () => {
    const routes = readFileSync(new URL("../src/console/runtime/client/main.js", import.meta.url), "utf8")
    const enabled = resolveConsoleSectionIds({ database: true })
    const databaseSections = [...routes.matchAll(/consoleSection: "(databases?)"/g)].map(match => match[1])
    expect(databaseSections).toHaveLength(2)
    for (const section of databaseSections) expect(enabled).toContain(section)
  })

  it("loads only the requested syntax grammar for workspace previews", () => {
    const preview = readFileSync(new URL("../src/console/runtime/components/console-session-code-preview.vue", import.meta.url), "utf8")
    const languages = readFileSync(new URL("../src/console/runtime/client/highlight-languages.ts", import.meta.url), "utf8")
    expect(preview).toContain('import("shiki/core")')
    expect(preview).toContain('import { consoleHighlightLanguages } from "../client/highlight-languages"')
    expect(preview).toContain("consoleHighlightLanguages[languageName]")
    expect(languages).toContain('typescript: () => import("shiki/langs/typescript.mjs")')
    expect(preview).not.toContain('import("shiki/bundle/web")')
    expect(languages).not.toContain('import("shiki/bundle/web")')
  })
})
