import { describe, expect, it } from "vitest"

import { consoleDevAccessNotice } from "../src/console/dev-access-notice.ts"

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
})
