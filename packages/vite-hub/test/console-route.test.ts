import { describe, expect, it } from "vitest"

import {
  consoleDatabasesSchemaPath,
  consoleDatabasesTablePath,
  consoleMountBase,
  consoleMountPath,
  decodeAgentRouteParam,
  encodeAgentRouteParam,
  resolveConsoleRouteName,
  resolveUsageSessionsAgent,
} from "../src/console/runtime/console-route.ts"

describe("Console routes", () => {
  it("opens sessions for the Agent in a direct filtered Usage URL", () => {
    expect(resolveUsageSessionsAgent({ agent: "support" })).toBe("support")
    expect(resolveUsageSessionsAgent({ agent: "support", returnAgent: "writer" }, "writer")).toBe("support")
    expect(resolveUsageSessionsAgent({ agent: "team/support" })).toBe("team/support")
  })

  it("returns to the originating Agent when Usage has no valid Agent filter", () => {
    expect(resolveUsageSessionsAgent({}, "writer")).toBe("writer")
    expect(resolveUsageSessionsAgent({ returnAgent: "writer" })).toBe("writer")
    expect(resolveUsageSessionsAgent({})).toBeUndefined()
    for (const agent of [null, ["support", "writer"], "", " ", "x".repeat(513)]) {
      expect(resolveUsageSessionsAgent({ agent, returnAgent: "writer" })).toBe("writer")
    }
    expect(resolveUsageSessionsAgent({ agent: " support " })).toBe("support")
  })

  it.each([
    ["/_vitehub", ""],
    ["/portal/_vitehub", "/portal"],
    ["/portal/nested/_vitehub/agents", "/portal/nested"],
    ["/foo/_vitehub/_vitehub", "/foo/_vitehub"],
  ])("derives the application mount prefix from %j", (pathname, expected) => {
    expect(consoleMountBase(pathname)).toBe(expected)
    expect(consoleMountPath(expected, "/api/_vitehub/console/status")).toBe(`${expected}/api/_vitehub/console/status`)
  })

  it("keeps the schema view outside the table route namespace", () => {
    expect(
      consoleDatabasesTablePath.replace(":database?", "default").replace(":table?", "schema"),
    ).toBe("/databases/default/schema")
    expect(consoleDatabasesSchemaPath).toBe("/databases/:database/schema/diagram")
  })

  it.each(["chat", "support-bot", "bot2"])(
    "uses the Agent identity %j directly in the URL",
    (agentName) => {
      const encoded = encodeAgentRouteParam(agentName)
      const url = new URL(`/agents/${encodeURIComponent(encoded)}`, "https://console.vitehub.dev")

      expect(encoded).toBe(agentName)
      expect(url.pathname).toBe(`/agents/${agentName}`)
      expect(decodeAgentRouteParam(decodeURIComponent(url.pathname.slice("/agents/".length)))).toBe(agentName)
    },
  )

  it.each(["Reviewer", "team/support", "計画", ".", "..", "~chat", "chat_bot", "-chat", "chat--bot", "\uD800", "�"])(
    "round-trips the Agent identity %j through one route segment",
    (agentName) => {
      const encoded = encodeAgentRouteParam(agentName)
      const url = new URL(`/agents/${encodeURIComponent(encoded)}`, "https://console.vitehub.dev")
      expect(url.pathname).toBe(`/agents/${encoded}`)
      expect(decodeAgentRouteParam(decodeURIComponent(url.pathname.slice("/agents/".length)))).toBe(agentName)
    },
  )

  it.each(["", " chat", "chat ", "a".repeat(513)])("rejects the invalid Agent identity %j", (agentName) => {
    expect(() => encodeAgentRouteParam(agentName)).toThrowError(expect.objectContaining({ code: "VITE_HUB_R0045" }))
  })

  it("keeps lone surrogates distinct from replacement characters", () => {
    expect(encodeAgentRouteParam("\uD800")).toBe("~d800")
    expect(encodeAgentRouteParam("�")).toBe("~fffd")
  })

  it.each(["~", "~!", "~0061", "team/support"])("rejects the invalid route segment %j", (segment) => {
    expect(decodeAgentRouteParam(segment)).toBeUndefined()
  })

  it("decodes the first route segment", () => {
    expect(decodeAgentRouteParam(["chat", "ignored"])).toBe("chat")
  })

  it("preserves host-decorated route names across console navigation", () => {
    expect(resolveConsoleRouteName("vitehub-console-agent___en", "vitehub-console-invocation"))
      .toBe("vitehub-console-invocation___en")
    expect(resolveConsoleRouteName("vitehub-console-invocation___da", "vitehub-console-agent"))
      .toBe("vitehub-console-agent___da")
    expect(resolveConsoleRouteName("vitehub-console-agent___en___default", "vitehub-console-invocation"))
      .toBe("vitehub-console-invocation___en___default")
    expect(resolveConsoleRouteName("vitehub-console-usage___en", "vitehub-console-agent"))
      .toBe("vitehub-console-agent___en")
    expect(resolveConsoleRouteName("vitehub-console-agent", "vitehub-console-invocation"))
      .toBe("vitehub-console-invocation")
    expect(resolveConsoleRouteName(Symbol("vitehub-console-agent"), "vitehub-console-invocation"))
      .toBe("vitehub-console-invocation")
    expect(resolveConsoleRouteName("vitehub-console-kv___en", "vitehub-console"))
      .toBe("vitehub-console___en")
    expect(resolveConsoleRouteName("vitehub-console-workflows___en", "vitehub-console-agents"))
      .toBe("vitehub-console-agents___en")
    expect(resolveConsoleRouteName("vitehub-console-blob", "vitehub-console"))
      .toBe("vitehub-console")
    expect(resolveConsoleRouteName("vitehub-console-future-primitive___en", "vitehub-console-kv"))
      .toBe("vitehub-console-kv___en")
    expect(resolveConsoleRouteName("vitehub-console-kv___en", "vitehub-console-future-primitive"))
      .toBe("vitehub-console-future-primitive___en")
    expect(resolveConsoleRouteName("vitehub-console-rate-limits___en", "vitehub-console-databases"))
      .toBe("vitehub-console-databases___en")
    expect(resolveConsoleRouteName("vitehub-console-queues___en", "vitehub-console-databases"))
      .toBe("vitehub-console-databases___en")
    expect(resolveConsoleRouteName("vitehub-console-queues___en", "vitehub-console-kv"))
      .toBe("vitehub-console-kv___en")
    expect(resolveConsoleRouteName("vitehub-console-databases-schema___en", "vitehub-console-databases"))
      .toBe("vitehub-console-databases___en")
    expect(resolveConsoleRouteName("vitehub-console-databases___en", "vitehub-console-databases-schema"))
      .toBe("vitehub-console-databases-schema___en")
  })
})
