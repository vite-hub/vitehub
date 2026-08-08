import { describe, expect, it } from "vitest"

import { getToolInvocations } from "../src/messages.ts"

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
