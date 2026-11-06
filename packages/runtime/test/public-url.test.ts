import { afterEach, describe, expect, it, vi } from "vitest"

import { consoleInvocationUrl, registerPublicUrlAgentName, resetPublicUrlAgentNames, resolvePublicUrl } from "../src/index.ts"

describe("public URL", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    resetPublicUrlAgentNames()
  })

  it("falls back to the request origin when no public URL is configured", () => {
    expect(resolvePublicUrl({ agentName: "bot" })).toBeUndefined()
    expect(resolvePublicUrl({ agentName: "bot", request: { url: "http://localhost:3000/api" } })).toBe("http://localhost:3000")
  })

  it("prefers the Agent origin, then the deployment origin, then a configured origin for the request host", () => {
    vi.stubGlobal("__VITEHUB_PUBLIC_URL__", { agents: { bot: "https://agent.example.com", "bot-dev": "https://agent-dev.example.com" } })
    expect(resolvePublicUrl({ agentName: "bot" })).toBe("https://agent.example.com")
    expect(resolvePublicUrl({ agentName: "other" })).toBeUndefined()
    expect(resolvePublicUrl({ request: { url: "http://agent-dev.example.com/api/auth" } })).toBe("https://agent-dev.example.com")
    expect(resolvePublicUrl({ request: { url: "http://10.0.0.1:3000/api/auth" } })).toBe("http://10.0.0.1:3000")

    vi.stubGlobal("__VITEHUB_PUBLIC_URL__", { url: "https://agents.example.com" })
    expect(resolvePublicUrl({ agentName: "bot", request: { url: "http://10.0.0.1:3000/" } })).toBe("https://agents.example.com")
  })

  it("keeps an alternate public host for a per-Agent URL", () => {
    vi.stubGlobal("__VITEHUB_PUBLIC_URL__", { agents: { bot: "https://agent.example.com" } })
    expect(resolvePublicUrl({ agentName: "bot", request: { url: "https://alternate.example.com/api" } })).toBe("https://alternate.example.com")
    expect(resolvePublicUrl({ agentName: "bot", request: { url: "https://agent.example.com/api" } })).toBe("https://agent.example.com")
  })

  it("resolves explicit names without overriding exact configured names", () => {
    vi.stubGlobal("__VITEHUB_PUBLIC_URL__", { agents: { discovered: "https://discovered.example.com", exact: "https://exact.example.com" } })
    registerPublicUrlAgentName("declared", "discovered")
    expect(resolvePublicUrl({ agentName: "declared" })).toBe("https://discovered.example.com")
    registerPublicUrlAgentName("exact", "discovered")
    expect(resolvePublicUrl({ agentName: "exact" })).toBe("https://exact.example.com")
    registerPublicUrlAgentName("ambiguous", "discovered")
    registerPublicUrlAgentName("ambiguous", "exact")
    expect(resolvePublicUrl({ agentName: "ambiguous" })).toBeUndefined()
  })

  it.each(["constructor", "toString", "__proto__"])("ignores inherited URL entries for Agent %s", (agentName) => {
    vi.stubGlobal("__VITEHUB_PUBLIC_URL__", { agents: { discovered: "https://discovered.example.com" } })
    expect(resolvePublicUrl({ agentName })).toBeUndefined()
    expect(resolvePublicUrl({ agentName, request: { url: "http://localhost:3000/api" } })).toBe("http://localhost:3000")

    registerPublicUrlAgentName(agentName, "discovered")
    expect(resolvePublicUrl({ agentName })).toBe("https://discovered.example.com")

    vi.stubGlobal("__VITEHUB_PUBLIC_URL__", { agents: { [agentName]: "https://exact.example.com", discovered: "https://discovered.example.com" } })
    expect(resolvePublicUrl({ agentName })).toBe("https://exact.example.com")
  })

  it.each(["constructor", "toString", "__proto__"])("ignores inherited discovered URL entries for %s", (discoveredName) => {
    vi.stubGlobal("__VITEHUB_PUBLIC_URL__", { agents: {}, url: "https://agents.example.com" })
    registerPublicUrlAgentName("declared", discoveredName)
    expect(resolvePublicUrl({ agentName: "declared" })).toBe("https://agents.example.com")
  })

  it("replaces aliases when another generated registry is installed", () => {
    vi.stubGlobal("__VITEHUB_PUBLIC_URL__", { agents: { first: "https://first.example.com", second: "https://second.example.com" } })
    registerPublicUrlAgentName("declared", "first")
    expect(resolvePublicUrl({ agentName: "declared" })).toBe("https://first.example.com")
    resetPublicUrlAgentNames()
    registerPublicUrlAgentName("declared", "second")
    expect(resolvePublicUrl({ agentName: "declared" })).toBe("https://second.example.com")
    registerPublicUrlAgentName("declared", "first")
    expect(resolvePublicUrl({ agentName: "declared" })).toBeUndefined()
    resetPublicUrlAgentNames()
    registerPublicUrlAgentName("declared", "first")
    expect(resolvePublicUrl({ agentName: "declared" })).toBe("https://first.example.com")
  })

  it("builds one Console invocation URL with the application base path", () => {
    expect(consoleInvocationUrl("https://agents.example.com", "team/support", "a/b")).toBe(
      "https://agents.example.com/_vitehub/agents/~007400650061006d002f0073007500700070006f00720074/invocations/a%2Fb",
    )
    vi.stubGlobal("__VITEHUB_APP_BASE_URL__", "/portal/")
    expect(consoleInvocationUrl("https://agents.example.com", "bot", "id")).toBe("https://agents.example.com/portal/_vitehub/agents/bot/invocations/id")
  })

  describe("without the Console embed", () => {
    const hosted = Symbol.for("vitehub.console.hosted")
    afterEach(() => {
      Reflect.deleteProperty(globalThis, hosted)
    })

    it("links the hosted Console with the project origin and base", () => {
      Reflect.set(globalThis, hosted, true)
      vi.stubGlobal("__VITEHUB_APP_BASE_URL__", "/portal/")
      const url = new URL(consoleInvocationUrl("https://agents.example.com", "team/support", "a/b"))
      expect(url.origin).toBe("https://console.vitehub.dev")
      expect(url.pathname).toBe("/open")
      expect(Object.fromEntries(url.searchParams)).toEqual({
        path: "/agents/~007400650061006d002f0073007500700070006f00720074/invocations/a%2Fb",
        project: "https://agents.example.com/portal",
      })
    })

    it("links the hosted Console for a loopback http origin", () => {
      Reflect.set(globalThis, hosted, true)
      expect(consoleInvocationUrl("http://localhost:3000", "bot", "id")).toBe("https://console.vitehub.dev/open?project=http%3A%2F%2Flocalhost%3A3000&path=%2Fagents%2Fbot%2Finvocations%2Fid")
    })

    it("keeps the app URL for an http origin on the network", () => {
      Reflect.set(globalThis, hosted, true)
      expect(consoleInvocationUrl("http://192.168.1.20:3000", "bot", "id")).toBe("http://192.168.1.20:3000/_vitehub/agents/bot/invocations/id")
    })

    it("keeps the app URL when the generated Console plugin did not set the flag", () => {
      expect(consoleInvocationUrl("https://agents.example.com", "bot", "id")).toBe("https://agents.example.com/_vitehub/agents/bot/invocations/id")
    })
  })
})
