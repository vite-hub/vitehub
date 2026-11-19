import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { describe, expect, it } from "vitest"

import { createDocsManifest } from "../src/manifest.ts"
import { docsRedirectProblems, docsRedirects, docsServerRoutes } from "../src/redirects.ts"

const manifest = await createDocsManifest({ dir: resolve(import.meta.dirname, "fixtures/content"), base: "/docs" })

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

  it("checks targets inside sections on a site whose docs base is /", async () => {
    const root = await createDocsManifest({ dir: resolve(import.meta.dirname, "fixtures/content/docs"), base: "/" })
    expect(docsRedirectProblems(root, [{ from: "/old", to: "/kv/removed" }])).toHaveLength(1)
    expect(docsRedirectProblems(root, [{ from: "/old", to: "/playground" }])).toEqual([])
  })

  it("passes a target that a server route of the app answers, also inside a section", async () => {
    const dir = await mkdtemp(join(tmpdir(), "docs-redirects-"))
    try {
      await mkdir(join(dir, "api"))
      await writeFile(join(dir, "api/index.md"), "---\ntitle: API\n---\n\nThe API.\n")
      await writeFile(join(dir, "api/.navigation.yml"), "title: API\n")
      const site = await createDocsManifest({ dir, base: "/" })
      const routes = [
        { route: "/api/auth/**", handler: "/app/.vitehub/auth/route.ts" },
        { route: "/api/files/:id", method: "get", handler: "/app/server/api/files/[id].get.ts" },
        { route: "/api/feed.xml", handler: "/app/server/api/feed.xml.ts" },
        { route: "/api/export", handler: "/app/server/api/export/index.ts" },
        { route: "/api/form", method: "post", handler: "/app/server/api/form.post.ts" },
      ]
      expect(docsRedirectProblems(site, [
        { from: "/sign-in", to: "/api/auth/sign-in?redirect=/api" },
        { from: "/sign-out", to: "/api/auth" },
        { from: "/file", to: "/api/files/1" },
        { from: "/feed", to: "/api/feed.xml" },
        { from: "/export", to: "/api/export#csv" },
      ], routes)).toEqual([])
      // A route does not answer a path it does not match, a POST route does not answer a navigation, Nitro serves no
      // `/index` path, and a query does not hide a missing page.
      expect(docsRedirectProblems(site, [
        { from: "/files", to: "/api/files/1/raw" },
        { from: "/form", to: "/api/form" },
        { from: "/export-index", to: "/api/export/index" },
        { from: "/old", to: "/api/removed?tab=1" },
      ], routes)).toEqual([
        "The redirect from /files goes to /api/files/1/raw, which is not a docs page. Point it to a page, or remove the route rule.",
        "The redirect from /form goes to /api/form, which is not a docs page. Point it to a page, or remove the route rule.",
        "The redirect from /export-index goes to /api/export/index, which is not a docs page. Point it to a page, or remove the route rule.",
        "The redirect from /old goes to /api/removed?tab=1, which is not a docs page. Point it to a page, or remove the route rule.",
      ])
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("docsServerRoutes", () => {
  it("keeps the routes that answer a GET, but not root catch-alls or the handlers of the docs", () => {
    expect(docsServerRoutes([
      { route: "/api/auth/**", handler: "/app/.vitehub/auth/route.ts" },
      { route: "/api/feed.xml", method: "GET", handler: "/app/server/routes/api/feed.xml.get.ts" },
      { route: "/**/feed.xml", method: "get", handler: "/app/server/routes/[...]/feed.xml.get.ts" },
      { route: "/api/form", method: "post", handler: "/app/server/routes/api/form.post.ts" },
      { route: "/**", handler: "/nuxt/dist/runtime/handlers/renderer.js" },
      { route: "/**:slug", handler: "/app/server/routes/[...slug].ts" },
      { route: "/:slug(.*)", handler: "/app/server/routes/[...slug].ts" },
      { route: "/raw/**", method: "get", handler: "/docs/dist/runtime/server/raw.js" },
    ], "/docs/dist/runtime").map(route => route.route)).toEqual(["/api/auth/**", "/api/feed.xml", "/**/feed.xml"])
  })
})
