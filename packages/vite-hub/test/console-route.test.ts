import { describe, expect, it } from "vitest"

import {
  decodeAgentRouteParam,
  encodeAgentRouteParam,
  resolveConsoleRouteName,
} from "../src/console/runtime/console-route.ts"

describe("Console routes", () => {
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
    expect(resolveConsoleRouteName("vitehub-console-agent___en", "vitehub-console-invocation"))
      .toBe("vitehub-console-invocation___en")
    expect(resolveConsoleRouteName("vitehub-console-invocation___da", "vitehub-console-agent"))
      .toBe("vitehub-console-agent___da")
    expect(resolveConsoleRouteName("vitehub-console-agent___en___default", "vitehub-console-invocation"))
      .toBe("vitehub-console-invocation___en___default")
    expect(resolveConsoleRouteName("vitehub-console-agent", "vitehub-console-invocation"))
      .toBe("vitehub-console-invocation")
    expect(resolveConsoleRouteName(Symbol("vitehub-console-agent"), "vitehub-console-invocation"))
      .toBe("vitehub-console-invocation")
    expect(resolveConsoleRouteName("vitehub-console-kv___en", "vitehub-console"))
      .toBe("vitehub-console___en")
  })
})
