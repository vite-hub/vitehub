import { readFile } from "node:fs/promises"

import { describe, expect, it } from "vitest"

describe("Browser optional peer bundle", () => {
  it("keeps page-session peers out of root entry points", async () => {
    const files = [
      "../dist/actions.js",
      "../dist/index.js",
    ]
    const output = (await Promise.all(files.map(file => readFile(new URL(file, import.meta.url), "utf8")))).join("\n")

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
