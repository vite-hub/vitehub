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
})
