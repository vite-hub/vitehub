import { runInNewContext } from "node:vm"

import { describe, expect, it } from "vitest"

import { addViteHubPageToolRoutes, viteHubPageToolsBase, viteHubPageToolsIndexHtml } from "../src/build/page-tools.ts"
import { createNitroServerKit } from "../src/nitro-kit.ts"
import { VITEHUB_APP_BASE_URL } from "../src/build/vite.ts"

describe("addViteHubPageToolRoutes", () => {
  it.each([
    { mount: "" },
    { mount: "/portal" },
    { mount: "" },
  ])("adds the session route and the loader asset once, for the first owner package: %j", ({ mount }) => {
    const kit = createNitroServerKit({ publicAssets: [{ baseURL: "/assets", dir: "/app/public" }] })
    addViteHubPageToolRoutes(kit, { handler: "/a/page-session.mjs", loader: "/a/dist/page", mount })
    addViteHubPageToolRoutes(kit, { handler: "/b/page-session.mjs", loader: "/b/dist/page", mount })
    expect(kit.config.handlers).toEqual([{ handler: "/a/page-session.mjs", route: `${mount}/_vitehub/page/session` }])
    expect(kit.config.publicAssets).toEqual([
      { baseURL: "/assets", dir: "/app/public" },
      { baseURL: `${mount}/_vitehub/page/assets`, dir: "/a/dist/page", maxAge: 300 },
    ])
  })
})

describe("viteHubPageToolsBase", () => {
  it("mounts the routes below the Vite base, less the part that Nitro adds", () => {
    expect(viteHubPageToolsBase({}, {})).toEqual({ base: "", mount: "" })
    expect(viteHubPageToolsBase({ base: "./" }, {})).toEqual({ base: "", mount: "" })
    expect(viteHubPageToolsBase({ base: "/portal/" }, {})).toEqual({ base: "/portal", mount: "/portal" })
    expect(viteHubPageToolsBase({ base: "/portal/", nitro: { baseURL: "/portal/" } }, {})).toEqual({ base: "/portal", mount: "" })
    expect(viteHubPageToolsBase({ base: "/portal/" }, { NITRO_APP_BASE_URL: "/portal/" })).toEqual({ base: "/portal", mount: "" })
    expect(viteHubPageToolsBase({ base: "/a/b/", nitro: { baseURL: "/a/" } }, {})).toEqual({ base: "/a/b", mount: "/b" })
    // Nuxt: the module sets ViteHub's app base constant, and Nitro serves below `app.baseURL`.
    expect(viteHubPageToolsBase({ define: { __VITEHUB_APP_BASE_URL__: "\"/docs/\"" }, nitro: { baseURL: "/docs/" } }, {})).toEqual({ base: "/docs", mount: "" })
    expect(viteHubPageToolsBase({ base: "/_nuxt/", [VITEHUB_APP_BASE_URL]: "/docs/", nitro: { baseURL: "/docs/" } }, {})).toEqual({ base: "/docs", mount: "" })
  })

  it.each(["https://cdn.test/assets/", "http://cdn.test/assets/", "//cdn.test/assets/"])("keeps the Vite asset base %s separate from the application base", (base) => {
    expect(viteHubPageToolsBase({ base }, {})).toEqual({ base: "", mount: "" })
    expect(viteHubPageToolsBase({ base, define: { __VITEHUB_APP_BASE_URL__: JSON.stringify("/docs/") } }, {})).toEqual({ base: "/docs", mount: "/docs" })
    expect(viteHubPageToolsBase({ base, [VITEHUB_APP_BASE_URL]: "/portal/", define: { __VITEHUB_APP_BASE_URL__: JSON.stringify("/assets/") }, nitro: { baseURL: "/portal/" } }, {})).toEqual({ base: "/portal", mount: "" })
  })

  it("adds the routes below the mount", () => {
    const kit = createNitroServerKit({})
    addViteHubPageToolRoutes(kit, { handler: "/a/page-session.mjs", loader: "/a/dist/page", mount: "/portal" })
    addViteHubPageToolRoutes(kit, { handler: "/b/page-session.mjs", loader: "/b/dist/page", mount: "/portal" })
    expect(kit.config.handlers).toEqual([{ handler: "/a/page-session.mjs", route: "/portal/_vitehub/page/session" }])
    expect(kit.config.publicAssets).toEqual([{ baseURL: "/portal/_vitehub/page/assets", dir: "/a/dist/page", maxAge: 300 }])
  })
})

describe("viteHubPageToolsIndexHtml", () => {
  const html = "<!doctype html><html><body><main id=\"app\"></main></body></html>"

  /** Runs the added script with a page URL and cookie, and returns the URLs that it imports. */
  function run(page: string, path: string, cookie = ""): string[] {
    const script = /<script type="module" data-vitehub-page-tools>(.*?)<\/script>/.exec(page)?.[1]
    if (!script) return []
    const imported: string[] = []
    const url = new URL(path, "http://site.test")
    runInNewContext(script.replace("import(", "load("), { URLSearchParams, document: { cookie }, load: (specifier: string) => imported.push(specifier), location: url })
    return imported
  }

  it("adds one hint check for any number of owner packages", () => {
    // Comments, then the Console: Vite passes the HTML of one hook to the next.
    const first = viteHubPageToolsIndexHtml(html, "/")
    expect(first).toBeDefined()
    expect(viteHubPageToolsIndexHtml(first!, "/")).toBeUndefined()
    expect(first!.match(/data-vitehub-page-tools/g)).toHaveLength(1)
    expect(first).toMatch(/<\/script><\/body>/)
  })

  it("imports the loader only with the hint", () => {
    const page = viteHubPageToolsIndexHtml(html, "/")!
    expect(run(page, "/")).toEqual([])
    expect(run(page, "/", "theme=dark")).toEqual([])
    expect(run(page, "/?vitehub")).toEqual(["/_vitehub/page/assets/loader.js?v=6"])
    expect(run(page, "/pricing", "theme=dark; vitehub-tools=1")).toEqual(["/_vitehub/page/assets/loader.js?v=6"])
  })

  it("imports the loader below the Vite base", () => {
    expect(run(viteHubPageToolsIndexHtml(html, "/portal/")!, "/portal/?vitehub")).toEqual(["/portal/_vitehub/page/assets/loader.js?v=6"])
    expect(run(viteHubPageToolsIndexHtml("<p>No body</p>", "./")!, "/?vitehub")).toEqual(["/_vitehub/page/assets/loader.js?v=6"])
  })
})
