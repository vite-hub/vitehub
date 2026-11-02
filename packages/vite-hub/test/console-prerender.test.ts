import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import { addConsolePageHandlers } from "../src/console/nitro.ts"
import { consoleVitePlugin } from "../src/console/vite.ts"
import { hostManagedAuthorize } from "./support/console-authorize.ts"

describe("Console pages and the prerender crawler", () => {
  it("keeps the crawler away from the Console pages, which need a signed-in request", () => {
    const nitro: Parameters<typeof addConsolePageHandlers>[0] = { prerender: { ignore: ["/private"] } }
    addConsolePageHandlers(nitro, "/runtime")
    addConsolePageHandlers(nitro, "/runtime")
    expect(nitro.prerender?.ignore).toEqual(["/private", "/_vitehub"])
  })

  it("ignores the Console below the application base", () => {
    const nitro: Parameters<typeof addConsolePageHandlers>[0] = {}
    addConsolePageHandlers(nitro, "/runtime", "/docs/")
    expect(nitro.prerender?.ignore).toEqual(["/docs/_vitehub"])
  })

  it.each([
    { base: "/", consolePaths: ["/_vitehub"] },
    { base: "/docs/", consolePaths: ["/docs/_vitehub"] },
    { base: "/docs/", nitroBase: "/docs/", consolePaths: ["/docs/_vitehub", "/_vitehub"] },
    { base: "/docs/guide/", nitroBase: "/docs/", consolePaths: ["/docs/guide/_vitehub", "/guide/_vitehub"] },
  ])("excludes plain Vite Console pages from prerendering: %j", async ({ base, nitroBase, consolePaths }) => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-prerender-"))
    try {
      await writeFile(join(root, "package.json"), "{}\n")
      const plugin = consoleVitePlugin({ console: { auth: false, authorize: hostManagedAuthorize }, preset: "node", sections: [] })
      const configHook = plugin.config
      const resolvedHook = plugin.configResolved
      if (!configHook || !resolvedHook) throw new TypeError("Expected Console Vite configuration hooks.")
      const configure = "handler" in configHook ? configHook.handler : configHook
      const resolveConfig = "handler" in resolvedHook ? resolvedHook.handler : resolvedHook
      const ignore = ["/private", /^\/drafts/, (path: string) => path === "/preview"]
      const config = {
        base,
        root,
        nitro: { baseURL: nitroBase, prerender: { crawlLinks: true, ignore } },
        vitehubCliDiscovery: true,
        logger: { warn: () => undefined },
      }
      await Reflect.apply(configure, {}, [config, { command: "build", mode: "production" }])
      expect(config.nitro.prerender).toEqual({ crawlLinks: true, ignore: [...ignore, ...consolePaths] })

      await Reflect.apply(resolveConfig, {}, [config])
      await Reflect.apply(resolveConfig, {}, [config])
      expect(config.nitro.prerender).toEqual({ crawlLinks: true, ignore: [...ignore, ...consolePaths] })
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("leaves prerendering alone when plain Vite only registers the RPC", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-rpc-prerender-"))
    try {
      await writeFile(join(root, "package.json"), "{}\n")
      const plugin = consoleVitePlugin({ preset: "node", rpcOnly: true, sections: [] })
      const hook = plugin.config
      if (!hook) throw new TypeError("Expected a Console Vite configuration hook.")
      const configure = "handler" in hook ? hook.handler : hook
      const config: { root: string, nitro?: { prerender?: unknown }, vitehubCliDiscovery: true } = { root, vitehubCliDiscovery: true }
      await Reflect.apply(configure, {}, [config, { command: "serve", mode: "development" }])
      expect(config.nitro?.prerender).toBeUndefined()
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})
