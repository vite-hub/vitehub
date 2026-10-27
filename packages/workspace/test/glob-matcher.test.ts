import { describe, expect, it } from "vitest"

import { createWorkspaceGlobMatcher } from "../src/core/glob.ts"

describe("Workspace glob matching", () => {
  const paths = ["docs/readme.md", "docs/.hidden.mdx", "docs/nested/data.json", "docs/skip.txt", "docs/keep.txt", "other/readme.md"]

  it("matches braces, multiple patterns, and dotfiles within cwd", () => {
    const { matches } = createWorkspaceGlobMatcher(["**/*.{md,mdx}", "**/*.json"], { cwd: "docs" })
    expect(paths.filter(matches)).toEqual(["docs/readme.md", "docs/.hidden.mdx", "docs/nested/data.json"])
  })

  it("keeps pattern-array OR semantics for negated patterns", () => {
    const { matches } = createWorkspaceGlobMatcher(["!**/*.txt", "**/keep.txt"], { cwd: "docs" })
    expect(paths.filter(matches)).toEqual(["docs/readme.md", "docs/.hidden.mdx", "docs/nested/data.json", "docs/keep.txt"])
  })

  it("normalizes pattern separators and surrounding slashes", () => {
    const { matches } = createWorkspaceGlobMatcher("\\**\\*.md\\", { cwd: "docs" })
    expect(paths.filter(matches)).toEqual(["docs/readme.md"])
  })

  it("keeps an empty string unfiltered and an empty pattern list unmatched", () => {
    expect(paths.filter(createWorkspaceGlobMatcher("", { cwd: "docs" }).matches)).toEqual(paths.slice(0, -1))
    expect(paths.filter(createWorkspaceGlobMatcher([], { cwd: "docs" }).matches)).toEqual([])
  })
})
