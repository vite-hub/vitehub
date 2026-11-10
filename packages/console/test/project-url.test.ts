import { describe, expect, it } from "vitest"

import { isPrivateHost, parseProjectUrl } from "../src/project-url.ts"

describe("project URLs", () => {
  it.each([
    ["https://app.example.com", "https://app.example.com"],
    ["app.example.com", "https://app.example.com"],
    ["https://app.example.com/portal/_vitehub/kv", "https://app.example.com/portal"],
    ["https://app.example.com/", "https://app.example.com"],
  ])("reads %s", (input, url) => {
    expect(parseProjectUrl(input, { allowPrivate: false })).toEqual({ url })
  })

  it.each([
    "http://app.example.com",
    "https://user:pass@app.example.com",
    "ftp://app.example.com",
    "not a url",
  ])("refuses %s", (input) => {
    expect(parseProjectUrl(input, { allowPrivate: false })).toEqual({ error: expect.stringContaining("is not a project URL") })
  })

  it.each([
    "localhost", "app.localhost", "printer.local", "db.internal", "nas.home.arpa",
    "127.0.0.1", "10.0.0.8", "172.16.0.1", "172.31.255.255", "192.168.1.10", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1",
    "[::1]", "[::]", "[fd00::1]", "[fe80::1]", "[::ffff:7f00:1]", "[::ffff:a9fe:a9fe]",
  ])("treats %s as private", (host) => {
    expect(isPrivateHost(host)).toBe(true)
  })

  it.each(["app.example.com", "8.8.8.8", "172.32.0.1", "100.128.0.1", "[2606:4700::1111]", "[::ffff:808:808]"])("treats %s as public", (host) => {
    expect(isPrivateHost(host)).toBe(false)
  })

  it("refuses a private address unless the Console allows them", () => {
    expect(parseProjectUrl("https://10.0.0.8", { allowPrivate: false })).toEqual({ error: expect.stringContaining("VITEHUB_CONSOLE_ALLOW_PRIVATE=true") })
    expect(parseProjectUrl("https://10.0.0.8", { allowPrivate: true })).toEqual({ url: "https://10.0.0.8" })
    expect(parseProjectUrl("http://localhost:3000", { allowPrivate: true })).toEqual({ url: "http://localhost:3000" })
    expect(parseProjectUrl("http://localhost:3000", { allowPrivate: false })).toEqual({ error: expect.stringContaining("private address") })
  })
})
