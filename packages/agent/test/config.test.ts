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
      routes: {
        chat: false,
        webhooks: false,
      },
      runtime: "auto",
    })
  })

  it("preserves provider options", () => {
    expect(normalizeAgentOptions({
      integrations: { sandbox: false },
      providers: { state: { provider: "sqlite", tablePrefix: "agent_state_", url: "file:agent-state.sqlite" } },
      runtime: "cloudflare-agents",
    })).toMatchObject({
      integrations: { sandbox: false, workflow: "auto" },
      providers: { state: { provider: "sqlite", tablePrefix: "agent_state_", url: "file:agent-state.sqlite" } },
      routes: { chat: false, webhooks: false },
      runtime: "cloudflare-agents",
    })
  })

  it("uses the default routes when routes are true", () => {
    expect(normalizeAgentOptions({ routes: { chat: true, webhooks: true } })).toMatchObject({
      routes: {
        chat: "/api/_vitehub/agents/[agent]/chat",
        webhooks: "/api/_vitehub/agents/[agent]/webhooks/[webhook]",
      },
    })
  })

  it("preserves custom routes", () => {
    expect(normalizeAgentOptions({ routes: { chat: "/chat/[agent]", webhooks: "/hooks/[agent]/[webhook]" } })).toMatchObject({
      routes: {
        chat: "/chat/[agent]",
        webhooks: "/hooks/[agent]/[webhook]",
      },
    })
  })
})
