import { EventEmitter } from "node:events"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { consoleVitePlugin } from "../src/console/vite.ts"

describe("Console dev-server discovery", () => {
  it("publishes the listening address before Vite assigns resolvedUrls and removes it on close", async () => {
    const root = await mkdtemp(join(import.meta.dirname, ".dev-discovery-"))
    const http = Object.assign(new EventEmitter(), { listening: false, address: () => ({ address: "127.0.0.1", port: 5179, family: "IPv4" }) })
    const plugin = consoleVitePlugin({ rpcOnly: true })
    const hook = plugin.configureServer
    const configure = typeof hook === "function" ? hook : hook?.handler
    if (!configure) throw new Error("Missing configureServer hook")
    try {
      // The hook only registers listeners and reads the listening socket and resolved config.
      await configure.call({} as never, { httpServer: http, resolvedUrls: null, config: { root, base: "/app/", server: {} }, watcher: new EventEmitter() } as never)
      http.emit("listening")
      expect(JSON.parse(await readFile(join(root, ".vitehub/dev-server.json"), "utf8"))).toMatchObject({ root, url: "http://127.0.0.1:5179/app/" })
      http.emit("close")
      await expect(readFile(join(root, ".vitehub/dev-server.json"))).rejects.toMatchObject({ code: "ENOENT" })
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
