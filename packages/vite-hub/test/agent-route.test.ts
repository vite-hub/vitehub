import { describe, expect, it } from "vitest"

import {
  decodeAgentRouteParam,
  encodeAgentRouteParam,
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
})
