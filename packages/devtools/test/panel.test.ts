import { describe, expect, it, vi } from "vitest"

import { registerViteHubDevtoolsPanel } from "../src/index.ts"

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
    expect(ctx.docks.register).toHaveBeenCalledWith(expect.objectContaining({
      id: "@vitehub/test",
      title: "ViteHub Test",
      type: "iframe",
      url: "/__vitehub/test/",
    }))
  })

  it("marks absolute overrides as remote", () => {
    const ctx = createContext()

    const result = registerViteHubDevtoolsPanel(ctx as never, {
      distDir: "/tmp/client",
      icon: "i-lucide-message-square",
      id: "@vitehub/test",
      route: "/__vitehub/test/",
      title: "ViteHub Test",
      url: "http://localhost:3300",
    })

    expect(result).toEqual({ remote: true, url: "http://localhost:3300" })
    expect(ctx.views.hostStatic).not.toHaveBeenCalled()
    expect(ctx.docks.register).toHaveBeenCalledWith(expect.objectContaining({
      remote: true,
      url: "http://localhost:3300",
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

  it("hosts local static assets without checking the filesystem", () => {
    const ctx = createContext()

    const result = registerViteHubDevtoolsPanel(ctx as never, {
      distDir: "/tmp/missing-client",
      icon: "i-lucide-message-square",
      id: "@vitehub/test",
      route: "/__vitehub/test/",
      title: "ViteHub Test",
    })

    expect(result).toEqual({ remote: false, url: "/__vitehub/test/" })
    expect(ctx.views.hostStatic).toHaveBeenCalledWith("/__vitehub/test/", "/tmp/missing-client")
    expect(ctx.docks.register).toHaveBeenCalled()
  })
})
