import { describe, expect, it } from "vitest"

import { docsMount, docsPageOf, replacesDocsPage } from "../src/page.ts"

import type { DocsManifest } from "../src/types.ts"

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

function manifestOf(base: string, paths: string[]): DocsManifest {
  const page = (path: string) => docsPageOf({ title: path }, { id: path, path, file: `${path}.md` })
  return { base, root: null, sections: [], pages: paths.map(page) }
}

describe("docsMount", () => {
  it("is the base when every page sits below it", () => {
    expect(docsMount(manifestOf("/docs", ["/docs", "/docs/kv"]))).toBe("/docs")
    expect(docsMount(manifestOf("/docs", []))).toBe("/docs")
  })

  it("is the site root when a page sits outside the base", () => {
    expect(docsMount(manifestOf("/docs", ["/", "/docs/kv"]))).toBe("/")
    expect(docsMount(manifestOf("/docs", ["/about"]))).toBe("/")
    expect(docsMount(manifestOf("/", ["/guide"]))).toBe("/")
  })
})

describe("replacesDocsPage", () => {
  it("lets a root catch-all replace docs at the site root", () => {
    expect(replacesDocsPage([{ path: "/" }, { path: "/:slug(.*)*" }], "/")).toBe(true)
    expect(replacesDocsPage([{ path: "/:pathMatch(.*)*" }], "/")).toBe(true)
  })

  it("keeps the docs page at /docs beside the app's root catch-all", () => {
    expect(replacesDocsPage([{ path: "/:slug(.*)*" }], "/docs")).toBe(false)
    expect(replacesDocsPage([{ path: "/docs/:slug(.*)*" }], "/docs")).toBe(true)
  })

  it("keeps the docs page beside a catch-all at another prefix", () => {
    expect(replacesDocsPage([{ path: "/blog/:slug(.*)*" }], "/")).toBe(false)
    expect(replacesDocsPage([{ path: "/docs-old/:slug(.*)*" }], "/docs")).toBe(false)
    expect(replacesDocsPage([{ path: "/docs/:slug(.*)*" }], "/")).toBe(false)
    expect(replacesDocsPage([{ path: "/about" }], "/")).toBe(false)
  })

  it("reads nested catch-all pages with their parent path", () => {
    expect(replacesDocsPage([{ path: "/", children: [{ path: ":slug(.*)*" }] }], "/")).toBe(true)
    expect(replacesDocsPage([{ path: "/docs", children: [{ path: ":slug(.*)*" }] }], "/docs")).toBe(true)
    expect(replacesDocsPage([{ path: "/blog", children: [{ path: ":slug(.*)*" }] }], "/docs")).toBe(false)
  })
})
