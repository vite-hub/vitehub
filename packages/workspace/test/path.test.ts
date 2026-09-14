import { describe, expect, it } from "vitest"

import { normalizeSafeWorkspacePath, normalizeSafeWorkspacePattern } from "../src/core/path.ts"

describe("reserved Workspace metadata namespace", () => {
  it.each([".vitehub", ".VITEHUB", ".ViteHub"])("rejects public paths and patterns under %s", (root) => {
    for (const path of [root, `${root}/file-metadata/foo/metadata.json`, `${root}\\file-metadata\\foo\\metadata.json`]) {
      expect(() => normalizeSafeWorkspacePath(path)).toThrow()
      expect(() => normalizeSafeWorkspacePattern(path)).toThrow()
    }
    expect(() => normalizeSafeWorkspacePattern(`${root}/**`)).toThrow()
  })

  it("preserves internal access and unrelated public paths", () => {
    expect(normalizeSafeWorkspacePath(".VITEHUB/file-metadata/foo/metadata.json", { allowReserved: true }))
      .toBe(".VITEHUB/file-metadata/foo/metadata.json")
    for (const path of [".vitehub-notes/file", "nested/.VITEHUB/file", "ordinary/file"]) {
      expect(normalizeSafeWorkspacePath(path)).toBe(path)
    }
    expect(normalizeSafeWorkspacePath("", { allowEmpty: true })).toBe("")
  })
})
