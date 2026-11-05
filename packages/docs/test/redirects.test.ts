import { resolve } from "node:path"

import { describe, expect, it } from "vitest"

import { createDocsManifest } from "../src/manifest.ts"
import { docsRedirectProblems, docsRedirects } from "../src/redirects.ts"

const manifest = createDocsManifest({ dir: resolve(import.meta.dirname, "fixtures/content"), base: "/docs" })

describe("docsRedirects", () => {
  it("reads exact redirects, as a string or as an object, including external targets", () => {
    expect(docsRedirects({
      "/docs/old": { redirect: "/docs/kv" },
      "/docs/moved": { redirect: { to: "/docs/kv/configure#ttl" } },
      "/docs/off": { redirect: false },
      "/docs/start/**": { redirect: "/docs/kv/**" },
      "/docs/away": { redirect: "https://example.com/docs" },
      "/docs/cached": {},
    })).toEqual([
      { from: "/docs/old", to: "/docs/kv" },
      { from: "/docs/moved", to: "/docs/kv/configure#ttl" },
      { from: "/docs/away", to: "https://example.com/docs" },
    ])
  })
})

describe("docsRedirectProblems", () => {
  it("treats exact redirects to external URLs as terminal in a chain", () => {
    for (const to of ["https://example.com/docs", "//example.com/docs"]) {
      expect(docsRedirectProblems(manifest, docsRedirects({
        "/docs/old": { redirect: "/docs/alias" },
        "/docs/alias": { redirect: to },
      }))).toEqual([])
    }
  })

  it("passes redirects to docs pages, their Markdown copies, other redirects, and app pages", () => {
    expect(docsRedirectProblems(manifest, [
      { from: "/docs/old", to: "/docs/kv" },
      { from: "/docs/old/", to: "/docs/kv/configure#ttl" },
      { from: "/raw/docs/old.md", to: "/raw/docs/kv.md" },
      { from: "/docs/older", to: "/docs/old" },
      // The app owns paths outside the docs, so the docs do not check them.
      { from: "/docs/playground", to: "/playground" },
    ])).toEqual([])
  })

  it("names a redirect into the docs that no page answers", () => {
    expect(docsRedirectProblems(manifest, [{ from: "/docs/gone", to: "/docs/kv/removed#intro" }])).toEqual([
      "The redirect from /docs/gone goes to /docs/kv/removed#intro, which is not a docs page. Point it to a page, or remove the route rule.",
    ])
    expect(docsRedirectProblems(manifest, [{ from: "/raw/docs/gone.md", to: "/raw/docs/removed.md" }])).toHaveLength(1)
  })

  it("follows a chain of redirects, and names one that loops", () => {
    expect(docsRedirectProblems(manifest, [{ from: "/docs/a", to: "/docs/b" }, { from: "/docs/b", to: "/docs/gone" }])).toEqual([
      "The redirect from /docs/a goes to /docs/gone, which is not a docs page. Point it to a page, or remove the route rule.",
      "The redirect from /docs/b goes to /docs/gone, which is not a docs page. Point it to a page, or remove the route rule.",
    ])
    expect(docsRedirectProblems(manifest, [{ from: "/docs/a", to: "/docs/b#x" }, { from: "/docs/b/", to: "/docs/a" }])).toEqual([
      "The redirect from /docs/a comes back to /docs/a and never reaches a page. Point one of its route rules to a page.",
      "The redirect from /docs/b/ comes back to /docs/b and never reaches a page. Point one of its route rules to a page.",
    ])
    expect(docsRedirectProblems(manifest, [{ from: "/docs/self", to: "/docs/self" }])).toHaveLength(1)
  })

  it("names a redirect that hides a docs page", () => {
    expect(docsRedirectProblems(manifest, [{ from: "/docs/kv/configure/", to: "/docs/kv" }])).toEqual([
      "The redirect from /docs/kv/configure/ hides the page docs/kv/configure.md. Remove the route rule, or move the page.",
    ])
    expect(docsRedirectProblems(manifest, docsRedirects({
      "/raw/docs/kv.md": { redirect: "https://example.com/docs" },
    }))).toEqual([
      "The redirect from /raw/docs/kv.md hides the page docs/kv/index.md. Remove the route rule, or move the page.",
    ])
  })

  it("checks targets inside sections on a site whose docs base is /", () => {
    const root = createDocsManifest({ dir: resolve(import.meta.dirname, "fixtures/content/docs"), base: "/" })
    expect(docsRedirectProblems(root, [{ from: "/old", to: "/kv/removed" }])).toHaveLength(1)
    expect(docsRedirectProblems(root, [{ from: "/old", to: "/playground" }])).toEqual([])
  })
})
