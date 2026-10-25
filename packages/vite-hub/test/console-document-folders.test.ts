import { describe, expect, it } from "vitest"

import { consoleDocumentFolders } from "../src/console/runtime/client/documents.ts"

describe("consoleDocumentFolders()", () => {
  it("has one folder and no prefix for a collection with one glob", () => {
    expect(consoleDocumentFolders({ path: "posts/**/*.md" })).toEqual([{ folder: "posts/", prefix: "" }])
    expect(consoleDocumentFolders({ path: "*.md", paths: ["*.md"] })).toEqual([{ folder: "", prefix: "" }])
  })

  it("offers the folder before the first wildcard of each glob", () => {
    expect(consoleDocumentFolders({ path: "", paths: ["docs/pages/**/*.md", "packages/*/docs/**/*.md"] })).toEqual([
      { folder: "docs/pages/", prefix: "docs/pages/" },
      { folder: "packages/", prefix: "packages/" },
    ])
  })

  it("starts the id below the folder that every glob shares", () => {
    expect(consoleDocumentFolders({ path: "", paths: ["content/posts/**/*.md", "content/news/*.md"] })).toEqual([
      { folder: "content/posts/", prefix: "posts/" },
      { folder: "content/news/", prefix: "news/" },
    ])
  })
})
