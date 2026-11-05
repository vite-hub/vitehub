import { describe, expect, it } from "vitest"

import { coversDocsPages } from "../src/page.ts"

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
