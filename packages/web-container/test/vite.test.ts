import { createServer, preview } from "vite"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { hubWebContainer, matchesWebContainerRoute, webContainerHeaders, webContainerRouteRules, webContainerVitePlugin } from "../src/vite.ts"
import type { UserConfig } from "vite"

describe("matchesWebContainerRoute", () => {
  it("matches exact paths and /** prefixes", () => {
    const routes = ["/playground/**", "/tutorial"]
    expect(matchesWebContainerRoute("/playground", routes)).toBe(true)
    expect(matchesWebContainerRoute("/playground/", routes)).toBe(true)
    expect(matchesWebContainerRoute("/playground/agents/first", routes)).toBe(true)
    expect(matchesWebContainerRoute("/playgrounds", routes)).toBe(false)
    expect(matchesWebContainerRoute("/tutorial", routes)).toBe(true)
    expect(matchesWebContainerRoute("/tutorial/step-1", routes)).toBe(false)
    expect(matchesWebContainerRoute("/", routes)).toBe(false)
    expect(matchesWebContainerRoute("/anything", ["/**"])).toBe(true)
  })
})

describe("webContainerRouteRules", () => {
  it("gives a rule for the base path and the paths below it, and keeps the other keys of a rule", () => {
    expect(webContainerRouteRules(["/play/**", "/tutorial/"], { "/play/**": { headers: { "x-frame-options": "DENY" }, prerender: true } })).toEqual({
      "/play": { headers: webContainerHeaders },
      "/play/**": { headers: { "x-frame-options": "DENY", ...webContainerHeaders }, prerender: true },
      "/tutorial": { headers: webContainerHeaders },
    })
    expect(webContainerRouteRules(["/**"])).toEqual({ "/": { headers: webContainerHeaders }, "/**": { headers: webContainerHeaders } })
  })
})

describe("hubWebContainer", () => {
  it("points to vitehub({ webContainer })", () => {
    expect(() => hubWebContainer({ routes: ["/playground/**"] })).toThrow(expect.objectContaining({
      code: "WEB_CONTAINER_PLUGIN_MOVED",
      fix: expect.stringContaining("vitehub({ webContainer: { routes: [\"/playground/**\"] } })"),
    }))
  })
})

describe("webContainerVitePlugin", () => {
  it("rejects missing or relative routes", () => {
    expect(() => webContainerVitePlugin({ routes: [] })).toThrow(/at least one route/)
    expect(() => webContainerVitePlugin({ routes: ["playground"] })).toThrow(/must start with "\/"/)
  })

  it("adds the Nitro route rules, next to the rules of the app", async () => {
    const config: UserConfig & { nitro?: { routeRules?: Record<string, unknown> } } = { nitro: { routeRules: { "/api/**": { cors: true } } } }
    const hook = webContainerVitePlugin({ routes: ["/play/**"] }).config
    await (typeof hook === "function" ? hook : hook!.handler).call({} as never, config, { command: "build", mode: "production" })
    expect(config.nitro?.routeRules).toEqual({
      "/api/**": { cors: true },
      "/play": { headers: webContainerHeaders },
      "/play/**": { headers: webContainerHeaders },
    })
  })

  let root: string
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "vitehub-web-container-"))
    await writeFile(join(root, "index.html"), "<!doctype html><title>home</title>")
    await mkdir(join(root, "playground"))
    await writeFile(join(root, "playground/index.html"), "<!doctype html><title>playground</title>")
  })
  afterAll(async () => {
    await rm(root, { force: true, recursive: true })
  })

  async function headersOf(origin: string, path: string) {
    const response = await fetch(new URL(path, origin))
    await response.arrayBuffer()
    return {
      coep: response.headers.get("cross-origin-embedder-policy"),
      coop: response.headers.get("cross-origin-opener-policy"),
    }
  }

  const isolated = { coep: webContainerHeaders["Cross-Origin-Embedder-Policy"], coop: webContainerHeaders["Cross-Origin-Opener-Policy"] }
  const plain = { coep: null, coop: null }

  it("sets the isolation headers only on configured routes in vite dev", async () => {
    const server = await createServer({
      configFile: false,
      logLevel: "silent",
      plugins: [webContainerVitePlugin({ routes: ["/playground/**"] })],
      root,
      server: { host: "127.0.0.1", port: 0 },
    })
    await server.listen()
    try {
      const origin = server.resolvedUrls!.local[0]!
      expect(await headersOf(origin, "/playground/")).toEqual(isolated)
      expect(await headersOf(origin, "/")).toEqual(plain)
    }
    finally {
      await server.close()
    }
  })

  it("sets the isolation headers only on configured routes in vite preview", async () => {
    await mkdir(join(root, "dist/playground"), { recursive: true })
    await writeFile(join(root, "dist/index.html"), "<!doctype html><title>home</title>")
    await writeFile(join(root, "dist/playground/index.html"), "<!doctype html><title>playground</title>")
    const server = await preview({
      configFile: false,
      logLevel: "silent",
      plugins: [webContainerVitePlugin({ routes: ["/playground/**"] })],
      preview: { host: "127.0.0.1", port: 0 },
      root,
    })
    try {
      const origin = server.resolvedUrls!.local[0]!
      expect(await headersOf(origin, "/playground/")).toEqual(isolated)
      expect(await headersOf(origin, "/")).toEqual(plain)
    }
    finally {
      await server.close()
    }
  })
})
