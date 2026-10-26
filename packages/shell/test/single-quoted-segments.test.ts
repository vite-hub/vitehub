import { describe, expect, it } from "vitest"

import { splitShellCommandSegments } from "../src/command/parse.ts"
import { createReadonlyWorkspaceFs, runWorkspaceInspectionCommand } from "../src/workspace/index.ts"
import { MemoryWorkspace } from "./workspace-test-utils.ts"

describe("single-quoted backslashes in command segments", () => {
  it.each([";", "&&", "||", "|", "\n"] as const)("finds the %j separator after a literal backslash", (separator) => {
    expect(splitShellCommandSegments(`printf '%s' '\\' ${separator} cat docs/readme.md`)).toEqual([
      { command: "printf '%s' '\\' ", followsPipe: false, separatorAfter: separator },
      { command: " cat docs/readme.md", followsPipe: separator === "|" },
    ])
  })

  it("preserves a backslash and newline inside single quotes", () => {
    const command = "printf '%s' 'a\\\nb'"
    expect(splitShellCommandSegments(command)).toEqual([{ command, followsPipe: false }])
  })

  it("checks the root search after a single-quoted backslash", async () => {
    const workspace = new MemoryWorkspace({ "docs/readme.md": "needle\n" })
    const result = await runWorkspaceInspectionCommand(workspace, "printf '%s' '\\'; rg needle .", {
      commands: ["printf", "rg"],
      fs: createReadonlyWorkspaceFs(workspace),
    })
    expect(result).toMatchObject({
      event: "policy_denied",
      exitCode: 126,
      workspaceGuardrail: { kind: "broad_search" },
    })
  })
})
