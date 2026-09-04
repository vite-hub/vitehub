import { describe, expect, it } from "vitest"

import {
  consoleDatabaseSchemaPath,
  consoleDatabaseTablePath,
  consoleDatabasesSchemaPath,
  consoleDatabasesTablePath,
  decodeAgentRouteParam,
  encodeAgentRouteParam,
  resolveConsoleRouteName,
} from "../src/console/runtime/console-route.ts"

describe("Console routes", () => {
  it("keeps the schema view outside the table route namespace", () => {
    expect(consoleDatabaseTablePath.replace(":table?", "schema")).toBe("/database/schema")
    expect(consoleDatabaseSchemaPath).toBe("/database/schema/diagram")
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

  it.each(["", ".", "..", "~", "~chat", "support/team", "Chat", "chat_bot", "-chat", "chat-", "chat--bot"])(
    "rejects the invalid Agent identity %j",
    (agentName) => {
      expect(() => encodeAgentRouteParam(agentName)).toThrow(TypeError)
      expect(decodeAgentRouteParam(agentName)).toBeUndefined()
    },
  )

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
    expect(resolveConsoleRouteName("vitehub-console-rate-limits___en", "vitehub-console-databases"))
      .toBe("vitehub-console-databases___en")
    expect(resolveConsoleRouteName("vitehub-console-queues___en", "vitehub-console-databases"))
      .toBe("vitehub-console-databases___en")
    expect(resolveConsoleRouteName("vitehub-console-queues___en", "vitehub-console-kv"))
      .toBe("vitehub-console-kv___en")
    expect(resolveConsoleRouteName("vitehub-console-database-schema___en", "vitehub-console-database"))
      .toBe("vitehub-console-database___en")
    expect(resolveConsoleRouteName("vitehub-console-databases___en", "vitehub-console-database"))
      .toBe("vitehub-console-database___en")
  })
})
