import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  hubDevtools,
  listViteHubDevtoolsFeatures,
  registerViteHubDevtoolsFeature,
  viteHubDevtoolsDefaultUrl,
  viteHubDevtoolsGetFeaturesRpc,
  viteHubDevtoolsPanelId,
} from "../src/index.ts"

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

describe("hubDevtools", () => {
  it("registers the hosted ViteHub DevTools shell", () => {
    const ctx = createContext()

    hubDevtools().devtools?.setup?.(ctx as never)

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

  it("keeps hosted shell registration idempotent in one context", () => {
    const ctx = createContext()
    const plugin = hubDevtools()

    plugin.devtools?.setup?.(ctx as never)
    plugin.devtools?.setup?.(ctx as never)

    expect(ctx.views.hostStatic).not.toHaveBeenCalled()
    expect(ctx.docks.register).toHaveBeenCalledTimes(1)
  })

  it("returns registered feature metadata through the Discovery RPC", () => {
    const ctx = createContext()
    const feature = {
      bridge: "/__vitehub/test/devtools",
      icon: "i-lucide-message-square",
      id: "test.feature",
      packageName: "@vitehub/test",
      title: "Test",
    }

    registerViteHubDevtoolsFeature(ctx as never, feature)
    hubDevtools().devtools?.setup?.(ctx as never)

    const rpcDefinition = ctx.rpc.register.mock.calls[0]?.[0] as { setup: () => { handler: () => unknown } }
    expect(rpcDefinition.setup().handler()).toEqual([feature])
  })

  it("shares discovery state across duplicated module instances", async () => {
    const shellPath = "../src/index.ts?hub-devtools-shell"
    const featurePath = "../src/index.ts?hub-devtools-feature"
    const shellModule = await import(shellPath)
    const featureModule = await import(featurePath)
    const ctx = createContext()
    const feature = {
      bridge: "/__vitehub/test/devtools",
      icon: "i-lucide-message-square",
      id: "test.feature",
      packageName: "@vitehub/test",
      title: "Test",
    }

    shellModule.hubDevtools().devtools?.setup?.(ctx as never)
    featureModule.registerViteHubDevtoolsFeature(ctx as never, feature)
    await Promise.resolve()

    const rpcDefinition = ctx.rpc.register.mock.calls[0]?.[0] as { setup: () => { handler: () => unknown } }
    expect(rpcDefinition.setup().handler()).toEqual([feature])
    expect(ctx.messages.add).not.toHaveBeenCalled()
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
