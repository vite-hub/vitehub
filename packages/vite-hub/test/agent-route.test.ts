import { describe, expect, it } from "vitest"

import {
  decodeAgentRouteParam,
  encodeAgentRouteParam,
  resolveAgentRouteName,
} from "../src/console/runtime/agent-route.ts"

describe("Agent console routes", () => {
  it.each([".", "..", "~", "support/team"])(
    "round-trips the Agent identity %j through a normalized URL",
    (agentName) => {
      const encoded = encodeAgentRouteParam(agentName)
      const url = new URL(`/agents/${encodeURIComponent(encoded)}`, "https://console.vitehub.dev")

      expect(url.pathname).toBe(`/agents/${encodeURIComponent(encoded)}`)
      expect(decodeAgentRouteParam(decodeURIComponent(url.pathname.slice("/agents/".length)))).toBe(agentName)
    },
  )

  it("preserves host-decorated route names across console navigation", () => {
    expect(resolveAgentRouteName("vitehub-console-agent___en", "vitehub-console-invocation"))
      .toBe("vitehub-console-invocation___en")
    expect(resolveAgentRouteName("vitehub-console-invocation___da", "vitehub-console-agent"))
      .toBe("vitehub-console-agent___da")
    expect(resolveAgentRouteName("vitehub-console-agent___en___default", "vitehub-console-invocation"))
      .toBe("vitehub-console-invocation___en___default")
    expect(resolveAgentRouteName("vitehub-console-agent", "vitehub-console-invocation"))
      .toBe("vitehub-console-invocation")
    expect(resolveAgentRouteName(Symbol("vitehub-console-agent"), "vitehub-console-invocation"))
      .toBe("vitehub-console-invocation")
  })
})
