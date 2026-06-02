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
    })
  })

  it("uses the default route when route is true", () => {
    expect(normalizeAgentOptions({ route: true })).toMatchObject({
      route: "/agents/[agent]",
    })
  })
})
