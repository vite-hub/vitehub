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
})
