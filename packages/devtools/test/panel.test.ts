import { existsSync } from "node:fs"

import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  isAbsoluteHttpUrl,
  registerViteHubDevtoolsPanel,
  resolveViteHubDevtoolsUrl,
} from "../src/index.ts"

vi.mock("node:fs", () => ({
  existsSync: vi.fn((path: string) => !path.includes("missing")),
}))

beforeEach(() => {
  vi.clearAllMocks()
})

function createContext() {
  return {
    docks: {
      register: vi.fn(),
    },
    messages: {
      add: vi.fn(),
    },
    views: {
      hostStatic: vi.fn(),
    },
  }
}

describe("resolveViteHubDevtoolsUrl", () => {
  it("uses the default route without an override", () => {
    expect(resolveViteHubDevtoolsUrl("/__vitehub/test/")).toBe("/__vitehub/test/")
  })

  it("trims and uses a non-empty override", () => {
    expect(resolveViteHubDevtoolsUrl("/__vitehub/test/", "  http://localhost:3300  ")).toBe("http://localhost:3300")
  })

  it("falls back to the default route for blank overrides", () => {
    expect(resolveViteHubDevtoolsUrl("/__vitehub/test/", "   ")).toBe("/__vitehub/test/")
  })
})

describe("isAbsoluteHttpUrl", () => {
  it("detects absolute HTTP(S) URLs only", () => {
    expect(isAbsoluteHttpUrl("http://localhost:3300")).toBe(true)
    expect(isAbsoluteHttpUrl("https://example.com/devtools")).toBe(true)
    expect(isAbsoluteHttpUrl("/__vitehub/test/")).toBe(false)
    expect(isAbsoluteHttpUrl("ws://localhost:3300")).toBe(false)
  })
})

describe("registerViteHubDevtoolsPanel", () => {
  it("hosts local static assets and registers an iframe panel", () => {
    const ctx = createContext()

    const result = registerViteHubDevtoolsPanel(ctx as never, {
      distDir: "/tmp/client",
      icon: "i-lucide-message-square",
      id: "@vitehub/test",
      route: "/__vitehub/test/",
      title: "ViteHub Test",
    })

    expect(result).toEqual({ remote: false, url: "/__vitehub/test/" })
    expect(ctx.views.hostStatic).toHaveBeenCalledWith("/__vitehub/test/", "/tmp/client")
    expect(ctx.messages.add).not.toHaveBeenCalled()
    expect(ctx.docks.register).toHaveBeenCalledWith(expect.objectContaining({
      id: "@vitehub/test",
      title: "ViteHub Test",
      type: "iframe",
      url: "/__vitehub/test/",
    }))
  })

  it("marks absolute overrides as remote iframes", () => {
    const ctx = createContext()

    const result = registerViteHubDevtoolsPanel(ctx as never, {
      distDir: "/tmp/missing-client",
      icon: "i-lucide-message-square",
      id: "@vitehub/test",
      route: "/__vitehub/test/",
      title: "ViteHub Test",
      url: "https://devtools.example.test/panel",
    })

    expect(result).toEqual({ remote: true, url: "https://devtools.example.test/panel" })
    expect(existsSync).not.toHaveBeenCalled()
    expect(ctx.views.hostStatic).not.toHaveBeenCalled()
    expect(ctx.messages.add).not.toHaveBeenCalled()
    expect(ctx.docks.register).toHaveBeenCalledWith(expect.objectContaining({
      remote: true,
      url: "https://devtools.example.test/panel",
    }))
  })

  it("skips registration when disabled", () => {
    const ctx = createContext()

    const result = registerViteHubDevtoolsPanel(ctx as never, {
      distDir: "/tmp/client",
      enabled: false,
      icon: "i-lucide-message-square",
      id: "@vitehub/test",
      route: "/__vitehub/test/",
      title: "ViteHub Test",
    })

    expect(result).toBeUndefined()
    expect(ctx.views.hostStatic).not.toHaveBeenCalled()
    expect(ctx.docks.register).not.toHaveBeenCalled()
  })

  it("warns and skips local registration when the client dist is missing", () => {
    const ctx = createContext()

    const result = registerViteHubDevtoolsPanel(ctx as never, {
      distDir: "/tmp/missing-client",
      icon: "i-lucide-message-square",
      id: "@vitehub/test",
      route: "/__vitehub/test/",
      title: "ViteHub Test",
    })

    expect(result).toBeUndefined()
    expect(ctx.views.hostStatic).not.toHaveBeenCalled()
    expect(ctx.docks.register).not.toHaveBeenCalled()
    expect(ctx.messages.add).toHaveBeenCalledWith(expect.objectContaining({
      level: "warn",
      message: expect.stringContaining("ViteHub Test DevTools client is not built"),
    }))
  })
})
