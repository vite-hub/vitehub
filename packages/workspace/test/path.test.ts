import { describe, expect, it } from "vitest"
import { resolve } from "node:path"

import { normalizeSafeWorkspacePath, normalizeSafeWorkspacePattern, resolveInside } from "../src/core/path.ts"

describe("Workspace path containment", () => {
  it.each(["C:/outside/file", "C:\\outside\\file", "C:outside", "a\0b", ".. /outside", ".. ./outside", ".. . /outside", ".:$DATA/file", "..:$DATA/outside", "..::$INDEX_ALLOCATION/outside", "docs/.. /outside", "docs/.. ./outside", "docs/..:$DATA/outside"])("rejects non-portable path %j", path => {
    expect(() => normalizeSafeWorkspacePath(path)).toThrow()
    expect(() => normalizeSafeWorkspacePattern(path)).toThrow()
  })

  it("allows ordinary names containing dots and rejects parent traversal", () => {
    const root = resolve("workspace")
    for (const path of ["..notes/file", "docs../file", "docs/.../file", ""]) {
      expect(resolveInside(root, path)).toBe(resolve(root, path))
    }
    expect(() => resolveInside(root, "../outside")).toThrow()
    expect(() => resolveInside(root, "docs/../../outside")).toThrow()
    expect(() => resolveInside(root, ".. /outside")).toThrow()
    expect(() => resolveInside(root, ".. ./outside")).toThrow()
    expect(() => resolveInside(root, ".. . /outside")).toThrow()
    expect(() => resolveInside(root, "..:$DATA/outside")).toThrow()
    expect(() => resolveInside(root, "..::$INDEX_ALLOCATION/outside")).toThrow()
  })
})

describe("reserved Workspace metadata namespace", () => {
  it.each([".vitehub", ".VITEHUB", ".ViteHub"])("rejects public paths and patterns under %s", (root) => {
    for (const path of [root, `${root}/file-metadata/foo/metadata.json`, `${root}\\file-metadata\\foo\\metadata.json`]) {
      expect(() => normalizeSafeWorkspacePath(path)).toThrow()
      expect(() => normalizeSafeWorkspacePattern(path)).toThrow()
    }
    expect(() => normalizeSafeWorkspacePattern(`${root}/**`)).toThrow()
  })

  it.each([
    ".vitehub.",
    ".VITEHUB ",
    ".ViteHub. . ",
    ".vitehub::$INDEX_ALLOCATION",
    ".VITEHUB:$I30:$INDEX_ALLOCATION",
    ".vitehub. :stream",
    "vitehu~1",
    ".git.",
    ".GIT ",
    ".git::$INDEX_ALLOCATION",
    "git~1",
    "nested/.git. . ",
    "nested/.GIT:$I30:$INDEX_ALLOCATION",
    "nested/git~1",
  ])("rejects reserved component aliases in %j", (root) => {
    for (const path of [root, `${root}/config`, `${root}\\config`]) {
      expect(() => normalizeSafeWorkspacePath(path)).toThrow()
      expect(() => normalizeSafeWorkspacePath(path, { allowReserved: true })).toThrow()
      expect(() => normalizeSafeWorkspacePattern(path)).toThrow()
    }
    expect(() => normalizeSafeWorkspacePattern(`${root}/**`)).toThrow()
  })

  it("preserves internal access and unrelated public paths", () => {
    expect(normalizeSafeWorkspacePath(".VITEHUB/file-metadata/foo/metadata.json", { allowReserved: true }))
      .toBe(".VITEHUB/file-metadata/foo/metadata.json")
    expect(normalizeSafeWorkspacePath("nested/.GIT/config", { allowReserved: true }))
      .toBe("nested/.GIT/config")
    for (const path of [".vitehub-notes/file", "nested/.VITEHUB/file", "ordinary/file", "..notes/file", "ordinary./file", "report:final.txt", "git~1-notes/file", "vitehu~1-notes/file", "vitehub~1/file"]) {
      expect(normalizeSafeWorkspacePath(path)).toBe(path)
    }
    expect(normalizeSafeWorkspacePattern("[[:alpha:]]/**/*.md")).toBe("[[:alpha:]]/**/*.md")
    expect(normalizeSafeWorkspacePath("", { allowEmpty: true })).toBe("")
  })
})
