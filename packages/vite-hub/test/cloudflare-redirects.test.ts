import { describe, expect, it } from "vitest"

import { addRedirectsToFile, routeRuleRedirects } from "../src/cloudflare-redirects-vite.ts"

const moved = (to: string, status = 301) => ({ redirect: { to, status } })

describe("routeRuleRedirects", () => {
  it("writes exact paths, placeholders, and a trailing splat with their status, in each form that Nitro matches", () => {
    expect(routeRuleRedirects({
      "/getting-started": moved("/guide/installation"),
      "/blog/**": moved("/posts/**", 308),
      "/docs/:version/intro": moved("https://docs.example.com/intro", 302),
      "/old/*": moved("/new"),
      "/api/health": { redirect: undefined },
    }, "/")).toEqual({
      lines: [
        "/getting-started /guide/installation 301",
        "/getting-started/ /guide/installation 301",
        "/old/:segment1 /new 301",
        "/old/:segment1/ /new 301",
        "/docs/:version/intro https://docs.example.com/intro 302",
        "/docs/:version/intro/ https://docs.example.com/intro 302",
        "/blog /posts 308",
        "/blog/ /posts 308",
        "/blog/* /posts/:splat 308",
      ],
      skipped: [],
    })
  })

  it("puts the most specific rule first, because Cloudflare uses the first match", () => {
    expect(routeRuleRedirects({
      "/blog/**": moved("/posts/**"),
      "/blog/:slug": moved("/posts"),
      "/blog/hello": moved("/posts/hello"),
    }, "/").lines).toEqual([
      "/blog/hello /posts/hello 301",
      "/blog/hello/ /posts/hello 301",
      "/blog/:slug /posts 301",
      "/blog/:slug/ /posts 301",
      "/blog /posts 301",
      "/blog/ /posts 301",
      "/blog/* /posts/:splat 301",
    ])
  })

  it("adds the base URL to the source only, as Nitro does", () => {
    expect(routeRuleRedirects({ "/old": moved("/docs/new") }, "/docs/").lines).toEqual(["/docs/old /docs/new 301", "/docs/old/ /docs/new 301"])
  })

  it("skips rules that Cloudflare cannot match like Nitro, and the wider rules that would match their paths first", () => {
    const { lines, skipped } = routeRuleRedirects({
      "GET /login": moved("/sign-in"),
      "/files/*.pdf": moved("/documents"),
      "/team/**": moved("/about/**"),
      "/team/jobs": { redirect: false },
      "/legacy": moved("/new", 418),
      "/**": moved("/en/**"),
      "/shop": moved("/store/**"),
      "/promo": moved("/sale?from=promo"),
      "/docs/**": moved("/v2/**/index"),
      "/kept": moved("/still-here"),
    }, "/")
    expect(lines).toEqual(["/kept /still-here 301", "/kept/ /still-here 301"])
    expect(skipped.map(({ route }) => route).sort()).toEqual(["/**", "/docs/**", "/files/*.pdf", "/legacy", "/promo", "/shop", "/team/**", "/team/jobs", "GET /login"])
    // Nitro adds the query of the request to the target's query. Cloudflare would drop it.
    expect(skipped.find(({ route }) => route === "/promo")?.reason).toContain("query")
    expect(skipped.find(({ route }) => route === "/team/**")?.reason).toContain("`/team/jobs`")
  })

  it("skips a target that names a placeholder of its route, which Nitro keeps as text", () => {
    expect(routeRuleRedirects({ "/u/:name": moved("/users/:name") }, "/").skipped).toEqual([
      { route: "/u/:name", reason: "its target holds a `:name` that Cloudflare would replace and Nitro keeps" },
    ])
  })
})

describe("addRedirectsToFile", () => {
  it("keeps the app's rules first", () => {
    expect(addRedirectsToFile("# moved by hand\n/home / 301\n", ["/old /new 301"])).toBe("# moved by hand\n/home / 301\n/old /new 301\n")
    expect(addRedirectsToFile("", ["/old /new 301"])).toBe("/old /new 301\n")
    expect(addRedirectsToFile("/old /new 301\n", ["/old /new 301"])).toBe("/old /new 301\n")
  })

  it("adds nothing when the file would pass Cloudflare's limits", () => {
    const dynamic = Array.from({ length: 100 }, (_, index) => `/s${index}/* /t${index}/:splat 301`)
    expect(addRedirectsToFile(`${dynamic.join("\n")}\n`, ["/a/:id /b 301"])).toBeUndefined()
    expect(addRedirectsToFile(`${dynamic.join("\n")}\n`, ["/a /b 301"])).toContain("/a /b 301")
  })
})
