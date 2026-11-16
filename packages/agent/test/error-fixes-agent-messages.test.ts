import { expect, it } from "vitest"

import { invocationDiagnostics } from "../src/invocation-diagnostics.ts"
import { messageDiagnostics } from "../src/message-diagnostics.ts"
import { deserializeMessages, validateMessage } from "../src/messages.ts"

it("gives each message and Agent Invocation client code a fix and its own docs page", () => {
  const catalogs = [messageDiagnostics, invocationDiagnostics] as const
  for (const catalog of catalogs) {
    for (const [code, create] of Object.entries(catalog)) {
      const error = create({ message: "m" })
      expect(error.fix, code).toMatch(/\S/)
      expect(error.docs, code).toBe(`https://vitehub.dev/docs/agents/diagnostics/${code.toLowerCase()}`)
    }
  }
})

it("reports an unsupported serialized messages payload with a code and a fix", () => {
  expect(() => deserializeMessages("{}")).toThrow(expect.objectContaining({
    code: "AGENT_R0667",
    fix: expect.stringContaining("serializeMessages()"),
  }))
})

it("reports a message with an unknown role with a code and a fix", () => {
  // SAFETY: The test passes an invalid value to check the runtime error.
  expect(() => validateMessage({ id: "m1", role: "robot", parts: [] } as never)).toThrow(expect.objectContaining({
    code: "AGENT_R0652",
    fix: expect.stringContaining("\"tool\""),
  }))
})

it("reports an image part without an image media type with a code and a fix", () => {
  // SAFETY: The test passes an invalid value to check the runtime error.
  expect(() => validateMessage({ id: "m1", role: "user", parts: [{ type: "image", mediaType: "text/plain", data: "x" }] } as never)).toThrow(expect.objectContaining({
    code: "AGENT_R0661",
    fix: expect.stringContaining("image/*"),
  }))
})
