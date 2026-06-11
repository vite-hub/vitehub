import { describe, expect, it } from "vitest"

import { normalizeAgentOptions } from "../src/config.ts"

describe("agent config", () => {
  it("normalizes defaults", () => {
    expect(normalizeAgentOptions(undefined)).toEqual({
      execution: "inline",
      imports: true,
      integrations: {
        sandbox: "auto",
        workflow: "auto",
      },
      providers: {
        sandbox: { provider: "auto" },
        scheduler: { provider: "auto" },
        state: { provider: "auto" },
      },
      route: false,
      runtime: "auto",
      webhooks: false,
    })
  })

  it("preserves route opt out and provider options", () => {
    expect(normalizeAgentOptions({
      integrations: { sandbox: false },
      providers: { state: { provider: "sqlite", tablePrefix: "agent_state_", url: "file:agent-state.sqlite" } },
      route: false,
      runtime: "cloudflare-agents",
    })).toMatchObject({
      integrations: { sandbox: false, workflow: "auto" },
      providers: { state: { provider: "sqlite", tablePrefix: "agent_state_", url: "file:agent-state.sqlite" } },
      route: false,
      runtime: "cloudflare-agents",
      webhooks: false,
    })
  })

  it("uses the default route when route is true", () => {
    expect(normalizeAgentOptions({ route: true })).toMatchObject({
      route: "/agents/[agent]",
    })
  })

  it("uses the default webhook route when webhooks is true", () => {
    expect(normalizeAgentOptions({ webhooks: true })).toMatchObject({
      route: false,
      webhooks: "/api/_vitehub/agents/[agent]/webhooks/[webhook]",
    })
  })

  it("preserves a custom webhook route", () => {
    expect(normalizeAgentOptions({ webhooks: "/hooks/[agent]/[webhook]" })).toMatchObject({
      route: false,
      webhooks: "/hooks/[agent]/[webhook]",
    })
  })
})
