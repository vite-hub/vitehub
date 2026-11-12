import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import { consoleVitePlugin } from "../src/console/vite.ts"
import { hostManagedAuthorize } from "./support/console-authorize.ts"

describe("Console and the prerender crawler", () => {
  it.each([
    { base: "/" },
    { base: "/docs/" },
    { base: "/docs/", nitroBase: "/docs/" },
  ])("leaves the prerender crawler alone now that apps serve no Console page: %j", async ({ base, nitroBase }) => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-prerender-"))
    try {
      await writeFile(join(root, "package.json"), "{}\n")
      const plugin = consoleVitePlugin({ console: { auth: false, authorize: hostManagedAuthorize }, sections: [] })
      const configHook = plugin.config
      const resolvedHook = plugin.configResolved
      if (!configHook || !resolvedHook) throw new TypeError("Expected Console Vite configuration hooks.")
      const configure = "handler" in configHook ? configHook.handler : configHook
      const resolveConfig = "handler" in resolvedHook ? resolvedHook.handler : resolvedHook
      const ignore = ["/private", /^\/drafts/, (path: string) => path === "/preview"]
      const config = {
        base,
        root,
        nitro: { baseURL: nitroBase, prerender: { crawlLinks: true, ignore: [...ignore] } },
        vitehubCliDiscovery: true,
        logger: { warn: () => undefined },
      }
      await Reflect.apply(configure, {}, [config, { command: "build", mode: "production" }])
      expect(config.nitro.prerender).toEqual({ crawlLinks: true, ignore })

      await Reflect.apply(resolveConfig, {}, [config])
      await Reflect.apply(resolveConfig, {}, [config])
      expect(config.nitro.prerender).toEqual({ crawlLinks: true, ignore })
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("leaves prerendering alone when plain Vite only registers the RPC", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-rpc-prerender-"))
    try {
      await writeFile(join(root, "package.json"), "{}\n")
      const plugin = consoleVitePlugin({ rpcOnly: true, sections: [] })
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
