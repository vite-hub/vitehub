import { describe, expect, it, vi } from "vitest"

import { createSourceContext, normalizeWorkspaceSource } from "../src/sources/config.ts"

// The file Source fails to load once, as an import can fail during a development rebuild.
const fileSource = vi.hoisted(() => ({ failures: 1 }))

vi.mock("../src/sources/file.ts", async (importOriginal) => {
  if (fileSource.failures > 0) {
    fileSource.failures--
    throw new Error("transient file Source import failure")
  }
  return await importOriginal()
})

describe("inferred Workspace Sources", () => {
  it("loads the Source again on the next call after a failed load", async () => {
    const resolved = normalizeWorkspaceSource("docs", { content: "# Docs\n", workspacePath: "README.md" })
    const source = resolved.source
    const context = createSourceContext({ name: "docs" }, resolved)

    await expect(source.getKeys(context)).rejects.toThrow()
    await expect(source.getKeys(context)).resolves.toEqual(["README.md"])
  })
})
