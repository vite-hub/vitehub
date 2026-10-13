import { runInNewContext } from "node:vm"

import { describe, expect, it, vi } from "vitest"

import { portableAgentWorkflowInput } from "../src/index.ts"
import type { AgentRunInput } from "../src/types.ts"

vi.mock("#vitehub/agent/registry", () => ({ default: {} }))

describe("Workflow attachment portability", () => {
  it.each(["ArrayBuffer", "Uint8Array"] as const)("serializes %s values from another realm", async kind => {
    const value: ArrayBuffer | Uint8Array = runInNewContext(kind === "ArrayBuffer"
      ? "(() => { const value = new ArrayBuffer(3); new Uint8Array(value).set([1, 2, 3]); return value })()"
      : "new Uint8Array([1, 2, 3])")
    const input: AgentRunInput = {
      messages: [{
        id: "message-1",
        parts: [{ data: value, mediaType: "application/octet-stream", type: "file" }],
        role: "user",
      }],
    }

    const portable = await portableAgentWorkflowInput(input)

    expect(portable.messages?.[0]?.parts[0]).toMatchObject({
      data: "data:application/octet-stream;base64,AQID",
      mediaType: "application/octet-stream",
      type: "file",
    })
  })
})
