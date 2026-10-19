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
})
