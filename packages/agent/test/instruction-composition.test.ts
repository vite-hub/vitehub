import { describe, expect, it } from "vitest"
import { composeInstructionDocument } from "../src/instruction-composition.ts"

describe("instruction composition", () => {
  it("preserves import-looking references literally", async () => {
    const content = "Use @./shared.md and @../policy.md and @workspace.policy"
    await expect(composeInstructionDocument(content)).resolves.toContain(content)
  })

  it("renders workspace triple bindings", async () => {
    await expect(composeInstructionDocument("Policy: {{{ workspace.policy }}}", { workspace: { policy: "strict" } }))
      .resolves.toContain("Policy: strict")
  })
})
