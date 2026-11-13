import { describe, expect, it } from "vitest"

import { composeInstructionDocument } from "../../agent/src/instruction-composition.ts"
import { babysitterInstructions } from "../src/babysitter/instructions.ts"

describe("Babysitter instructions", () => {
  it("renders the Babysitter wait contract without unsupported tool or JSON examples", async () => {
    const rendered = await composeInstructionDocument(babysitterInstructions.replace("{{{ instructions }}}", "Agent instructions."))
    expect(rendered).toContain('set wait.kind to "checks" and wait.headSha to the current HEAD SHA')
    expect(rendered).toContain('set wait.kind to "external" and wait.reason to the reproduced blocker and action needed')
    expect(rendered).toContain('set wait.wake.kind to "checks", wait.wake.repository to that owner/name and wait.wake.headSha to the dependent SHA')
    expect(rendered).toContain('set wait.wake.kind to "pull-request", wait.wake.repository to its owner/name and wait.wake.number to the parent PR number')
    expect(rendered).toContain("omit wait.wake")
    expect(rendered).toContain("set reviewedHead to the current HEAD SHA")
    expect(rendered).toContain("Dependency installation is optional")
    expect(rendered).toContain("rely on hosted CI, and name the install failure in your result")
    expect(rendered).not.toContain("update_plan")
    expect(rendered).not.toContain('include wait: { kind: "checks"')
    expect(rendered).not.toContain("use wake:")
  })

  it("renders the generic repair rules every Babysitter gets", async () => {
    const rendered = await composeInstructionDocument(babysitterInstructions.replace("{{{ instructions }}}", "Agent instructions."))
    for (const rule of [
      "P0 (security hole, data loss or a broken main path)",
      "deliberately forged or hostile runtime objects",
      "Do not push for P2 or P3 findings alone",
      "fix the class once at its root",
      "do not set reviewedHead while it is unfixed",
      "Never park a PR to ask a maintainer to choose between requirements",
      "Failing required checks come before review findings",
      "Do not push for a check that fails the same way on the base",
      "`git diff HEAD...origin/<base> -- <file>`",
      "Make at most one repair commit per pass",
      "Never search outside the checkout",
      "Set reviewedHead only for the exact commit you assessed",
      "Do not create direction-validation markers",
    ]) expect(rendered).toContain(rule)
  })

  it("names no review service or repository", () => {
    expect(babysitterInstructions).not.toMatch(/pullfrog|codex-connector|vite-hub\/vitehub|repair-main/i)
  })
})
