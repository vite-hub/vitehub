import { readFile } from "node:fs/promises"

import { describe, expect, it } from "vitest"

describe("Workspace Provider Output bundle", () => {
  it("keeps esbuild external in the Vite entry", async () => {
    const output = await readFile(new URL(`../${"dist"}/vite.js`, import.meta.url), "utf8")

    expect(output).toContain(`from "esbuild"`)
    expect(output).not.toContain("esbuildCommandAndArgs")
  })
})
