import { existsSync } from "node:fs"

import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  hubDevtools,
  isAbsoluteHttpUrl,
  listViteHubDevtoolsFeatures,
  registerViteHubDevtoolsFeature,
  registerViteHubDevtoolsPanel,
  resolveViteHubDevtoolsUrl,
  viteHubDevtoolsDefaultUrl,
  viteHubDevtoolsGetFeaturesRpc,
  viteHubDevtoolsPanelId,
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
    rpc: {
      register: vi.fn(),
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

  it("returns the existing registration for duplicate panels in the same context", () => {
    const ctx = createContext()
    const options = {
      distDir: "/tmp/client",
      icon: "i-lucide-message-square",
      id: "@vitehub/test",
      route: "/__vitehub/test/",
      title: "ViteHub Test",
    } as const

    const first = registerViteHubDevtoolsPanel(ctx as never, options)
    const second = registerViteHubDevtoolsPanel(ctx as never, options)

    expect(second).toEqual(first)
    expect(ctx.views.hostStatic).toHaveBeenCalledTimes(1)
    expect(ctx.docks.register).toHaveBeenCalledTimes(1)
  })

  it("hosts local static assets at a non-HTTP URL override", () => {
    const ctx = createContext()

    const result = registerViteHubDevtoolsPanel(ctx as never, {
      distDir: "/tmp/client",
      icon: "i-lucide-message-square",
      id: "@vitehub/test",
      route: "/__vitehub/test/",
      title: "ViteHub Test",
      url: "/custom-panel/",
    })

    expect(result).toEqual({ remote: false, url: "/custom-panel/" })
    expect(ctx.views.hostStatic).toHaveBeenCalledWith("/custom-panel/", "/tmp/client")
    expect(ctx.docks.register).toHaveBeenCalledWith(expect.objectContaining({
      url: "/custom-panel/",
    }))
  })

  it("marks absolute overrides as remote iframes", () => {
    const ctx = createContext()

    const result = registerViteHubDevtoolsPanel(ctx as never, {
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

  it("requires distDir for local URLs", () => {
    const ctx = createContext()

    const result = registerViteHubDevtoolsPanel(ctx as never, {
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
      message: expect.stringContaining("requires a local distDir"),
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

describe("hubDevtools", () => {
  it("registers the hosted ViteHub DevTools shell", () => {
    const ctx = createContext()

    hubDevtools().devtools?.setup?.(ctx as never)

    expect(existsSync).not.toHaveBeenCalled()
    expect(ctx.views.hostStatic).not.toHaveBeenCalled()
    expect(ctx.docks.register).toHaveBeenCalledWith(expect.objectContaining({
      id: viteHubDevtoolsPanelId,
      remote: true,
      title: "ViteHub",
      type: "iframe",
      url: viteHubDevtoolsDefaultUrl,
    }))
    expect(ctx.rpc.register).toHaveBeenCalledWith(expect.objectContaining({
      name: viteHubDevtoolsGetFeaturesRpc,
      type: "query",
    }))
  })

  it("returns registered feature metadata through the discovery registry", () => {
    const ctx = createContext()
    const feature = {
      bridge: "/__vitehub/test/devtools",
      icon: "i-lucide-message-square",
      id: "test.feature",
      packageName: "@vitehub/test",
      title: "Test",
    }

    registerViteHubDevtoolsFeature(ctx as never, feature)

    expect(listViteHubDevtoolsFeatures(ctx as never)).toEqual([feature])
  })

  it("keeps duplicate feature registration idempotent", () => {
    const ctx = createContext()
    const feature = {
      bridge: "/__vitehub/test/devtools",
      id: "test.feature",
      packageName: "@vitehub/test",
      title: "Test",
    }

    const first = registerViteHubDevtoolsFeature(ctx as never, feature)
    const second = registerViteHubDevtoolsFeature(ctx as never, {
      ...feature,
      title: "Changed",
    })

    expect(second).toBe(first)
    expect(listViteHubDevtoolsFeatures(ctx as never)).toEqual([feature])
  })

  it("warns when a feature is enabled without the ViteHub DevTools Integration", async () => {
    const ctx = createContext()

    registerViteHubDevtoolsFeature(ctx as never, {
      bridge: "/__vitehub/test/devtools",
      id: "test.feature",
      packageName: "@vitehub/test",
      title: "Test",
    })
    await Promise.resolve()

    expect(ctx.messages.add).toHaveBeenCalledWith(expect.objectContaining({
      level: "warn",
      message: expect.stringContaining("hubDevtools()"),
    }))
  })
})
