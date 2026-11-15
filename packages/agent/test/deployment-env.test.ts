import { describe, expect, it } from "vitest"

import { normalizeAgentOptions } from "../src/config.ts"
import { agentDeploymentEnv } from "../src/deployment-env.ts"

const owners = ["agent"]
const names = (entries: ReturnType<typeof agentDeploymentEnv>) => entries.map(entry => entry.names[0])

describe("agentDeploymentEnv", () => {
  it("requires VITEHUB_AGENT_STATE_URL on a Node server without a state URL", () => {
    const entries = agentDeploymentEnv(normalizeAgentOptions({ routes: { discordGateway: true } }), { host: "node" }, { processDiscordGateway: true })
    expect(entries[0]).toEqual({ names: ["VITEHUB_AGENT_STATE_URL"], required: true, secret: true, hasDefault: false, owners })
    expect(names(entries)).toEqual([
      "VITEHUB_AGENT_STATE_URL",
      "VITEHUB_AGENT_STATE_AUTH_TOKEN",
      "VITEHUB_AGENT_INVOCATIONS_DATABASE_URL",
      "VITEHUB_AGENT_INVOCATIONS_DATABASE_AUTH_TOKEN",
      "AI_GATEWAY_API_KEY",
      "VITEHUB_DISCORD_GATEWAY_DURATION_MS",
    ])
    expect(entries.filter(entry => entry.required)).toHaveLength(1)
  })

  it("keeps Agent state in Durable Objects on Cloudflare and names the Discord Gateway route secret", () => {
    const entries = agentDeploymentEnv(normalizeAgentOptions({ routes: { discordGateway: true } }), { host: "cloudflare" })
    expect(names(entries)).toEqual([
      "VITEHUB_AGENT_INVOCATIONS_DATABASE_URL",
      "VITEHUB_AGENT_INVOCATIONS_DATABASE_AUTH_TOKEN",
      "AI_GATEWAY_API_KEY",
      "VITEHUB_DISCORD_GATEWAY_SECRET",
      "VITEHUB_DISCORD_GATEWAY_WEBHOOK_URL",
      "VITEHUB_DISCORD_GATEWAY_DURATION_MS",
    ])
    expect(entries.find(entry => entry.names[0] === "VITEHUB_AGENT_INVOCATIONS_DATABASE_AUTH_TOKEN")).toEqual({
      names: ["VITEHUB_AGENT_INVOCATIONS_DATABASE_AUTH_TOKEN"], required: false, secret: true, hasDefault: false, owners,
    })
    expect(entries.every(entry => !entry.required)).toBe(true)
    // The Discord Gateway route is off by default.
    expect(names(agentDeploymentEnv(normalizeAgentOptions({}), { host: "cloudflare" }))).toEqual(["VITEHUB_AGENT_INVOCATIONS_DATABASE_URL", "VITEHUB_AGENT_INVOCATIONS_DATABASE_AUTH_TOKEN", "AI_GATEWAY_API_KEY"])
  })

  it("keeps the state URL optional when the config sets one, and names its token variable, never its value", () => {
    const canary = "canary-token-91fd"
    const options = normalizeAgentOptions({ providers: { state: { driver: "libsql", url: "libsql://agents.example.com", authToken: canary } }, routes: { discordGateway: false } })
    const entries = agentDeploymentEnv(options, { host: "vercel" }, { authTokenEnvName: "TURSO_AUTH_TOKEN" })
    expect(entries.slice(0, 3)).toEqual([
      { names: ["VITEHUB_AGENT_STATE_URL"], required: false, secret: true, hasDefault: true, owners },
      { names: ["TURSO_AUTH_TOKEN"], required: false, secret: true, hasDefault: false, owners },
      { names: ["VITEHUB_AGENT_STATE_AUTH_TOKEN"], required: false, secret: true, hasDefault: false, owners },
    ])
    expect(names(entries)).not.toContain("VITEHUB_DISCORD_GATEWAY_SECRET")
    expect(JSON.stringify(entries)).not.toContain(canary)
    expect(JSON.stringify(entries)).not.toContain("agents.example.com")
  })

  it("names nothing when Agents are off", () => {
    expect(agentDeploymentEnv(normalizeAgentOptions(false), { host: "node" })).toEqual([])
  })
})
