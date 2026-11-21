import { EventEmitter } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"

import { consoleDevAccessNotice } from "../src/console/dev-access-notice.ts"
import { consoleVitePlugin } from "../src/console/vite.ts"

describe("the startup warning of a development Console without signed calls", () => {
  it("says nothing when the server listens on loopback only, as a plain vite dev", () => {
    for (const address of ["127.0.0.1", "::1"]) {
      for (const mode of ["local", "open", "token"] as const) expect(consoleDevAccessNotice(mode, { address }, {}), `${mode} ${address}`).toBeUndefined()
    }
  })

  it("warns when the server listens on more than loopback", () => {
    for (const address of ["0.0.0.0", "::", "192.168.0.38", "100.88.128.32"]) {
      const notice = consoleDevAccessNotice("open", { address })
      expect(notice).toContain(address)
      expect(notice).toContain("Remove console.auth and set a VITEHUB_CONSOLE_KEY_<NAME>")
    }
    expect(consoleDevAccessNotice("local", { address: "0.0.0.0" })).toContain("Set console: true and a VITEHUB_CONSOLE_KEY_<NAME>")
  })

  it("says that sharing needs a key when console: true has none yet", () => {
    const notice = consoleDevAccessNotice("token", { address: "0.0.0.0" }, { VITEHUB_CONSOLE_KEY_CI: "" })
    expect(notice).toContain("without a signature")
    expect(notice).toContain("Set a VITEHUB_CONSOLE_KEY_<NAME>")
  })

  it("says nothing for signed calls or a server without a TCP address", () => {
    expect(consoleDevAccessNotice("token", { address: "0.0.0.0" }, { VITEHUB_CONSOLE_KEY_CI: "a".repeat(43) })).toBeUndefined()
    expect(consoleDevAccessNotice(undefined, { address: "0.0.0.0" })).toBeUndefined()
    expect(consoleDevAccessNotice("local", "/tmp/dev.sock")).toBeUndefined()
    expect(consoleDevAccessNotice("local", null)).toBeUndefined()
  })

  it.each([
    { address: "127.0.0.1", warns: false },
    { address: "0.0.0.0", warns: true },
  ])("warns about the open access of console: { auth: false } on $address only beyond loopback", async ({ address, warns }) => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-access-notice-"))
    const http = Object.assign(new EventEmitter(), { address: () => ({ address, port: 3000, family: "IPv4" }) })
    try {
      const plugin = consoleVitePlugin({ console: { auth: false } })
      const config = plugin.config
      const configure = plugin.configureServer
      if (!config || !configure) throw new Error("Missing Console hooks")
      await Reflect.apply(typeof config === "function" ? config : config.handler, {}, [{ root }, { command: "serve", mode: "development" }])
      const logger = { info: vi.fn(), warn: vi.fn() }
      await Reflect.apply(typeof configure === "function" ? configure : configure.handler, {}, [{
        httpServer: http, config: { root, server: {}, logger }, watcher: new EventEmitter(),
      }])
      http.emit("listening")
      expect(logger.info).not.toHaveBeenCalled()
      if (warns) expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Remove console.auth"))
      else expect(logger.warn).not.toHaveBeenCalled()
    }
    finally {
      http.emit("close")
      await rm(root, { recursive: true, force: true })
    }
  })
})
