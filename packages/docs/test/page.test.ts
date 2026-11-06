import { describe, expect, it } from "vitest"

import { coversDocsPages, docsPageOf } from "../src/page.ts"

describe("docsPageOf", () => {
  const at = { id: "annotate", path: "/docs/annotate", file: "docs/annotate.md" }

  it("shows the tagline under the heading, else the description", () => {
    expect(docsPageOf({ title: "Annotate", description: "Marks on screenshots.", tagline: "Marks, notes, and arrows." }, at)).toMatchObject({ description: "Marks on screenshots.", tagline: "Marks, notes, and arrows." })
    expect(docsPageOf({ title: "Annotate", description: "Marks on screenshots." }, at).tagline).toBe("Marks on screenshots.")
    expect(docsPageOf({ title: "Annotate" }, at).tagline).toBeNull()
  })

  it("reads keywords as a list or as one string with commas", () => {
    expect(docsPageOf({ title: "Annotate", keywords: "image annotation, markup ,, PR evidence" }, at).keywords).toEqual(["image annotation", "markup", "PR evidence"])
    expect(docsPageOf({ title: "Annotate", keywords: ["markup", " circle "] }, at).keywords).toEqual(["markup", "circle"])
    expect(docsPageOf({ title: "Annotate" }, at).keywords).toEqual([])
  })

  it("keeps credits as Markdown, and none when blank", () => {
    expect(docsPageOf({ title: "Icon", credits: "Icons from [Lucide](https://lucide.dev)." }, at).credits).toBe("Icons from [Lucide](https://lucide.dev).")
    expect(docsPageOf({ title: "Icon", credits: "  " }, at).credits).toBeNull()
  })
})

const pages = ["/", "/docs", "/docs/kv", "/docs/kv/get-started"]

describe("coversDocsPages", () => {
  it("lets a root catch-all replace the docs page", () => {
    expect(coversDocsPages([{ path: "/" }, { path: "/:slug(.*)*" }], pages)).toBe(true)
    expect(coversDocsPages([{ path: "/:pathMatch(.*)*" }], pages)).toBe(true)
  })

  it("keeps the docs page beside a catch-all in a folder", () => {
    expect(coversDocsPages([{ path: "/blog/:slug(.*)*" }], pages)).toBe(false)
    expect(coversDocsPages([{ path: "/docs-old/:slug(.*)*" }], ["/docs/kv"])).toBe(false)
    expect(coversDocsPages([{ path: "/about" }], pages)).toBe(false)
  })

  it("lets a catch-all under the base replace the docs page only when no page is outside it", () => {
    expect(coversDocsPages([{ path: "/docs/:slug(.*)*" }], ["/docs", "/docs/kv"])).toBe(true)
    expect(coversDocsPages([{ path: "/docs/:slug(.*)*" }], pages)).toBe(false)
  })

  it("reads nested catch-all pages with their parent path", () => {
    expect(coversDocsPages([{ path: "/", children: [{ path: ":slug(.*)*" }] }], pages)).toBe(true)
    expect(coversDocsPages([{ path: "/docs", children: [{ path: ":slug(.*)*" }] }], ["/docs/kv"])).toBe(true)
    expect(coversDocsPages([{ path: "/blog", children: [{ path: ":slug(.*)*" }] }], ["/docs/kv"])).toBe(false)
  })
})
