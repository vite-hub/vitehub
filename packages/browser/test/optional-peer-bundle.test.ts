import { readFile } from "node:fs/promises"

import { describe, expect, it } from "vitest"

describe("Browser optional peer bundle", () => {
  it("leaves page-session peers runtime-optional", async () => {
    const files = [
      "../dist/controllers/playwright.js",
      "../dist/providers/cloudflare.js",
      "../dist/index.js",
    ]
    const output = (await Promise.all(files.map(file => readFile(new URL(file, import.meta.url), "utf8")))).join("\n")

    expect(output).not.toContain('import("@cloudflare/playwright")')
    expect(output).not.toContain('import("playwright-core")')
  })
})
