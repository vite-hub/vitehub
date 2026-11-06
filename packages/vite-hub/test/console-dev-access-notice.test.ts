import { EventEmitter } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"

import { consoleDevAccessNotice } from "../src/console/dev-access-notice.ts"
import { consoleVitePlugin } from "../src/console/vite.ts"

describe("the startup line of a development Console without sign-in", () => {
  it("says that a tunnel needs console.auth when the server listens on loopback", () => {
    for (const address of ["127.0.0.1", "::1"]) {
      const notice = consoleDevAccessNotice("local", { address })
      expect(notice?.level, address).toBe("info")
      expect(notice?.message).toContain("console.auth")
      expect(notice?.message).toContain("tunnel")
    }
  })

  it("warns when the server listens on more than loopback", () => {
    for (const address of ["0.0.0.0", "::", "192.168.0.38", "100.88.128.32"]) {
      const notice = consoleDevAccessNotice("open", { address })
      expect(notice?.level, address).toBe("warn")
      expect(notice?.message).toContain(address)
      expect(notice?.message).toContain("console.auth")
    }
  })

  it("says nothing for a Console with sign-in or a server without a TCP address", () => {
    expect(consoleDevAccessNotice("auth", { address: "0.0.0.0" })).toBeUndefined()
    expect(consoleDevAccessNotice("cloudflare-access", { address: "0.0.0.0" })).toBeUndefined()
    expect(consoleDevAccessNotice(undefined, { address: "0.0.0.0" })).toBeUndefined()
    expect(consoleDevAccessNotice("local", "/tmp/dev.sock")).toBeUndefined()
    expect(consoleDevAccessNotice("local", null)).toBeUndefined()
  })

  it.each([
    { address: "127.0.0.1", level: "info" },
    { address: "0.0.0.0", level: "warn" },
  ] as const)("reports the effective open access of Cloudflare Access in development on $address", async ({ address, level }) => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-access-notice-"))
    const http = Object.assign(new EventEmitter(), { address: () => ({ address, port: 3000, family: "IPv4" }) })
    try {
      const plugin = consoleVitePlugin({ console: { auth: { provider: "cloudflare-access" } }, preset: "cloudflare" })
      const config = plugin.config
      const configure = plugin.configureServer
      if (!config || !configure) throw new Error("Missing Console hooks")
      await Reflect.apply(typeof config === "function" ? config : config.handler, {}, [{ root }, { command: "serve", mode: "development" }])
      const logger = { info: vi.fn(), warn: vi.fn() }
      await Reflect.apply(typeof configure === "function" ? configure : configure.handler, {}, [{
        httpServer: http, config: { root, server: {}, logger }, watcher: new EventEmitter(),
      }])
      http.emit("listening")
      expect(logger[level]).toHaveBeenCalledWith(expect.stringContaining("Console has no sign-in"))
      expect(logger[level]).toHaveBeenCalledWith(expect.stringContaining("console.auth"))
    }
    finally {
      http.emit("close")
      await rm(root, { recursive: true, force: true })
    }
  })
})
