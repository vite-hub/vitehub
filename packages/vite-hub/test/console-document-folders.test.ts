import { describe, expect, it } from "vitest"

import { consoleDocumentFolders } from "../src/console/runtime/client/documents.ts"
import { parseConsoleDocumentCollections, parseConsoleSectionContent } from "../src/console/runtime/definitions.ts"

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

  it("preserves folder choices and id prefixes from the definitions response", () => {
    const paths = ["docs/pages/**/*.md", "packages/*/docs/**/*.md"]
    const section = parseConsoleSectionContent({
      section: "content",
      kind: "document-editor",
      collections: [{ access: { read: true, write: true }, label: "Pages", name: "pages", path: paths.join(", "), paths, schema: { type: "object" } }],
    }, "content")
    if (section?.kind !== "document-editor") throw new Error("Expected document collections")
    const collection = section.collections[0]!
    expect(collection.paths).toEqual(paths)
    expect(consoleDocumentFolders(collection)).toEqual([
      { folder: "docs/pages/", prefix: "docs/pages/" },
      { folder: "packages/", prefix: "packages/" },
    ])
  })

  it.each([
    { paths: undefined },
    { paths: null },
    { paths: "posts/**/*.md" },
    { paths: ["posts/**/*.md", 42] },
  ])("uses the legacy path when paths is invalid: $paths", ({ paths }) => {
    const [collection] = parseConsoleDocumentCollections([{ label: "Posts", name: "posts", path: "posts/**/*.md", paths, schema: { type: "object" } }])
    expect(collection).not.toHaveProperty("paths")
    expect(consoleDocumentFolders(collection!)).toEqual([{ folder: "posts/", prefix: "" }])
  })
})
