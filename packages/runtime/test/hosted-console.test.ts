import { describe, expect, it } from "vitest"

import { hostedConsoleUrl, normalizeConsolePath, normalizeConsoleProjectUrl } from "../src/index.ts"

describe("hosted Console links", () => {
  it("builds an /open URL with the project and the Console path", () => {
    const url = hostedConsoleUrl("https://app.example.com", "/agents/bot/invocations/abc")
    expect(url).toBe("https://console.vitehub.dev/open?project=https%3A%2F%2Fapp.example.com&path=%2Fagents%2Fbot%2Finvocations%2Fabc")
    const params = new URL(url).searchParams
    expect(params.get("project")).toBe("https://app.example.com")
    expect(params.get("path")).toBe("/agents/bot/invocations/abc")
  })

  it("keeps the application mount, and drops a trailing slash and a pasted Console path", () => {
    expect(new URL(hostedConsoleUrl("https://app.example.com/portal/", "/kv")).searchParams.get("project")).toBe("https://app.example.com/portal")
    expect(new URL(hostedConsoleUrl("https://app.example.com/portal/_vitehub/kv", "/kv")).searchParams.get("project")).toBe("https://app.example.com/portal")
    expect(normalizeConsoleProjectUrl("https://app.example.com/portal/_vitehub")).toBe("https://app.example.com/portal")
  })

  it("keeps an application base that only starts with _vitehub", () => {
    expect(normalizeConsoleProjectUrl("https://app.example.com/_vitehub-app")).toBe("https://app.example.com/_vitehub-app")
    expect(normalizeConsoleProjectUrl("https://app.example.com/portal/_vitehub-assets")).toBe("https://app.example.com/portal/_vitehub-assets")
    expect(normalizeConsoleProjectUrl("https://app.example.com/_vitehub-app/_vitehub/kv")).toBe("https://app.example.com/_vitehub-app")
  })

  it("uses another Console origin", () => {
    expect(hostedConsoleUrl("http://localhost:3000", "/kv", "http://127.0.0.1:4871")).toBe("http://127.0.0.1:4871/open?project=http%3A%2F%2Flocalhost%3A3000&path=%2Fkv")
  })

  it("keeps the query and the fragment of the Console path", () => {
    expect(normalizeConsolePath("/kv?key=a b#value")).toBe("/kv?key=a%20b#value")
    expect(normalizeConsolePath("/agents/~0062/invocations/a%2Fb")).toBe("/agents/~0062/invocations/a%2Fb")
  })

  it("removes the /_vitehub prefix of an app Console path", () => {
    expect(normalizeConsolePath("/_vitehub/agents/bot")).toBe("/agents/bot")
    expect(normalizeConsolePath("/_vitehub")).toBe("/")
    expect(normalizeConsolePath("/_vitehubs")).toBe("/_vitehubs")
  })

  it("rejects paths that leave the Console", () => {
    for (const path of [
      "",
      "kv",
      "https://example.com/kv",
      "javascript:alert(1)",
      "//example.com",
      "/\\example.com",
      "/\t/example.com",
      "/\n/example.com",
      "/.//example.com",
      "/_vitehub//example.com",
    ]) {
      expect(normalizeConsolePath(path), path).toBeUndefined()
      expect(() => hostedConsoleUrl("https://app.example.com", path), path).toThrow(TypeError)
    }
    // A dot segment stays inside the Console.
    expect(normalizeConsolePath("/../../kv")).toBe("/kv")
  })

  it("accepts https projects and http projects on loopback hosts only", () => {
    expect(normalizeConsoleProjectUrl("http://127.0.0.1:4872")).toBe("http://127.0.0.1:4872")
    expect(normalizeConsoleProjectUrl("http://[::1]:3000/app")).toBe("http://[::1]:3000/app")
    for (const project of ["http://app.example.com", "ftp://app.example.com", "javascript:alert(1)", "app.example.com", "https://user:secret@app.example.com"]) {
      expect(normalizeConsoleProjectUrl(project), project).toBeUndefined()
      expect(() => hostedConsoleUrl(project, "/kv"), project).toThrow(TypeError)
    }
  })
})
