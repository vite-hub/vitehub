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

  // 2026-11-19: vitehub#4857, #4913, #4922 and #4614 reproduced flaky tests on main's code while main's CI
  // passed them, reported them as inherited, and sat unmerged because the host only bypasses failures main's CI shows.
  it("makes a flake that the base tip's CI passed the pass's work", () => {
    expect(babysitterInstructions).toContain("Do not push for a check whose job fails the same way in the base tip's CI run")
    expect(babysitterInstructions).toContain("fix the flake at its root in this PR and never report it as inherited")
  })

  it("names no review service or repository", () => {
    expect(babysitterInstructions).not.toMatch(/pullfrog|codex-connector|vite-hub\/vitehub|repair-main/i)
  })
})
