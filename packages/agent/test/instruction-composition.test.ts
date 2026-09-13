import { describe, expect, it } from "vitest"
import { collectStaticInstructionCoverage, composeInstructionDocument, createInstructionCoverage, fillInstructionSlot } from "../src/instruction-composition.ts"
import { resolveAgentInstructions } from "../src/agent-instructions.ts"

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
    const rendered = await composeInstructionDocument(":::capability{key=\"search\"}\nSearch\n:::\n:::skill{path=\"docs\"}\nDocs\n:::", { coverage })
    expect(rendered).toContain("Search")
    expect(rendered).not.toContain(":::capability")
    expect(rendered).not.toContain(":::skill")
    expect(coverage.capabilities).toEqual(new Set(["search"]))
    expect(coverage.skills).toEqual(new Set(["docs"]))
  })

  it("collects coverage without rendering", async () => {
    const coverage = await collectStaticInstructionCoverage(":::source{key=\"policy\"}\nPolicy\n:::")
    expect(coverage.sources).toEqual(new Set(["policy"]))
  })

  it("renders scalar bindings and conditions", async () => {
    await expect(composeInstructionDocument("{{ context.mode }}\n:::if{if=\"context.enabled\"}\nShown\n:::", { context: { mode: "safe", enabled: true } }))
      .resolves.toContain("safe")
    await expect(composeInstructionDocument(":::if{if=\"context.enabled\"}\nShown\n:::", { context: { enabled: false } }))
      .resolves.not.toContain("Shown")
  })

  it("maps invalid bindings and conditions to diagnostics", async () => {
    await expect(composeInstructionDocument("{{{ secret.value }}}"))
      .rejects.toMatchObject({ code: "AGENT_R0445" })
    await expect(composeInstructionDocument(":::if{if=\"secret.enabled\"}\nNope\n:::", { context: {} }))
      .rejects.toMatchObject({ code: "AGENT_R0446" })
  })

  it("tracks selected and unselected coverage branches", async () => {
    const coverage = createInstructionCoverage()
    await composeInstructionDocument(":::capability{key=\"on\"}\nOn\n:::\n:::if{if=\"context.enabled\"}\n:::skill{path=\"chosen\"}\nChosen\n:::\n:::", { context: { enabled: false }, coverage })
    expect(coverage.capabilities).toEqual(new Set(["on"]))
    expect(coverage.skills).toEqual(new Set())
  })

  it("resolves dynamic and replacement instructions", async () => {
    const context = {} as never
    await expect(resolveAgentInstructions({ mode: "replace", value: () => "dynamic" } as never, context)).resolves.toBe("dynamic")
    await expect(resolveAgentInstructions({ template: "Before\n{{{ instructions }}}", content: () => "dynamic" } as never, context)).resolves.toContain("dynamic")
  })
})
