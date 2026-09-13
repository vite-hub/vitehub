import { describe, expect, it } from "vitest"
import { collectStaticInstructionCoverage, composeInstructionDocument, createInstructionCoverage, fillInstructionSlot } from "../src/instruction-composition.ts"

describe("instruction composition", () => {
  it("preserves import-looking references literally", async () => {
    const content = "Use @./shared.md and @../policy.md and @workspace.policy"
    await expect(composeInstructionDocument(content)).resolves.toContain(content)
  })

  it("renders workspace triple bindings", async () => {
    await expect(composeInstructionDocument("Policy: {{{ workspace.policy }}}", { workspace: { policy: "strict" } }))
      .resolves.toContain("Policy: strict")
  })

  it("fills exactly one trusted instruction slot", async () => {
    await expect(fillInstructionSlot("Before\n{{{ instructions }}}\nAfter", "Inserted")).resolves.toBe("Before\nInserted\nAfter")
  })

  it("rejects instruction slots inside code", async () => {
    await expect(fillInstructionSlot("```\n{{{ instructions }}}\n```", "Inserted")).rejects.toThrow(/exactly one/)
  })

  it("records authored coverage directives", async () => {
    const coverage = createInstructionCoverage()
    await composeInstructionDocument(":::capability{key=\"search\"}\nSearch\n:::\n:::skill{path=\"docs\"}\nDocs\n:::", { coverage })
    expect(coverage.capabilities).toEqual(new Set(["search"]))
    expect(coverage.skills).toEqual(new Set(["docs"]))
  })

  it("collects coverage without rendering", async () => {
    const coverage = await collectStaticInstructionCoverage(":::source{key=\"policy\"}\nPolicy\n:::")
    expect(coverage.sources).toEqual(new Set(["policy"]))
  })
})
