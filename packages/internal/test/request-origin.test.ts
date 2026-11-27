import { describe, expect, it } from "vitest"

import { forwardedRequestOrigin, isSecureOrigin, matchesPublicOrigin } from "../src/runtime/request-origin.ts"

function origin(host: string) {
  return forwardedRequestOrigin(new Request("http://internal.local/resource", {
    headers: { "x-forwarded-host": host, "x-forwarded-proto": "https" },
  }))
}

describe("forwarded host authority", () => {
  it.each(["public.example/path", "public.example?query", "public.example#fragment", "user@public.example", "public.example\\path", "pub\tlic.example"])("rejects malformed host %s", (host) => {
    expect(origin(host)).toBe("http://internal.local")
  })

  it.each([0x01, 0x08, 0x0E, 0x1F])("rejects trailing C0 control %i preserved by Headers", (code) => {
    const host = `public.example${String.fromCharCode(code)}`
    expect(new Headers({ "x-forwarded-host": host }).get("x-forwarded-host")).toBe(host)
    expect(origin(host)).toBe("http://internal.local")
  })

  it.each([
    ["public.example", "https://public.example"],
    ["public.example:8443", "https://public.example:8443"],
    ["[2001:db8::1]:8443", "https://[2001:db8::1]:8443"],
    ["public.example, proxy.local", "https://public.example"],
  ])("accepts host %s", (host, expected) => {
    expect(origin(host)).toBe(expected)
  })
})

describe("isSecureOrigin", () => {
  it.each([
    ["https://joyandmaxi.com", true],
    ["http://localhost:3000", true],
    ["http://app.localhost", true],
    ["http://127.0.0.1:8787", true],
    ["http://[::1]:3000", true],
    ["http://joyandmaxi.com", false],
    ["http://localhost.evil.com", false],
    ["http://127.0.0.1.nip.io", false],
    ["http://192.168.1.5:3000", false],
    ["ftp://localhost", false],
    ["not an origin", false],
  ])("%s is %s", (origin, secure) => {
    expect(isSecureOrigin(origin)).toBe(secure)
  })
})

describe("public origin match", () => {
  const origins = ["https://app.example.test"]

  it.each(["https://app.example.test/", "http://app.example.test/", "http://localhost:3000/", "http://127.0.0.1:3000/", "http://127.0.0.2/", "http://[::1]:3000/"])("matches %s", (url) => {
    expect(matchesPublicOrigin(new Request(url), origins)).toBe(true)
  })

  it.each(["https://content.example.test/", "https://127.content.example.test/", "https://127.0.0.1.example.test/", "https://localhost.example.test/"])("rejects %s", (url) => {
    expect(matchesPublicOrigin(new Request(url), origins)).toBe(false)
  })

  it("rejects a DNS name that begins with 127. in X-Forwarded-Host", () => {
    expect(matchesPublicOrigin(new Request("http://127.0.0.1/", { headers: { "x-forwarded-host": "127.content.example.test" } }), origins)).toBe(false)
  })
})
