import { describe, expect, expectTypeOf, it } from "vitest"

import { createAgentChatData, getToolInvocations } from "../src/messages.ts"

describe("createAgentChatData", () => {
  it("derives the latest values from native data parts", () => {
    const data = createAgentChatData([
      { data: { title: "Provisional" }, id: "title", type: "data-title" },
      { data: { summary: "Checking inventory" }, type: "data-progress-summary" },
      { data: { title: "Inventory health" }, id: "title", type: "data-title" },
      { data: { internal: true }, type: "data" },
    ])

    expect(data.get("title")).toEqual({ title: "Inventory health" })
    expect(data.get("title", "title")).toBe("Inventory health")
    expectTypeOf(data.get("title")).toEqualTypeOf<{ title: string, type: "title" } | undefined>()
    expectTypeOf(data.get("title", "title")).toEqualTypeOf<string | undefined>()
    expectTypeOf(data.get("unregistered")).toEqualTypeOf<unknown>()
    expectTypeOf(data.get("unregistered", "field")).toEqualTypeOf<unknown>()
    expect(data.entries()).toEqual([
      ["title", { title: "Inventory health" }],
      ["progress-summary", { summary: "Checking inventory" }],
    ])
  })
})

describe("getToolInvocations", () => {
  it("associates approval requests with their tool calls", () => {
    expect(getToolInvocations({
      id: "message-1",
      parts: [
        { id: "call-1", input: { path: "README.md" }, name: "write", state: "proposed", type: "tool-call" },
        { id: "approval-1", name: "write", toolCallId: "call-1", type: "approval-request" },
      ],
      role: "assistant",
    })).toEqual([{
      id: "call-1",
      input: { path: "README.md" },
      name: "write",
      state: "approval-required",
    }])
  })
})
