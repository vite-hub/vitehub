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

describe("ANSI-C quoted command segments", () => {
  it.each([";", "&&", "||", "|", "\n"] as const)("finds the %j separator after an escaped quote", (separator) => {
    const command = String.raw`printf '%s' $'it\'s'`
    expect(splitShellCommandSegments(`${command} ${separator} rg needle .`)).toEqual([
      { command: `${command} `, followsPipe: false, separatorAfter: separator },
      { command: " rg needle .", followsPipe: separator === "|" },
    ])
  })

  it("preserves backslash-newline inside ANSI-C quotes", () => {
    const command = "printf '%s' $'a\\\nb'"
    expect(splitShellCommandSegments(command)).toEqual([{ command, followsPipe: false }])
  })

  it("keeps a quote after an escaped dollar sign ordinary", () => {
    const command = String.raw`printf '%s' \$'\'`
    expect(splitShellCommandSegments(`${command}; rg needle .`)).toEqual([
      { command, followsPipe: false, separatorAfter: ";" },
      { command: " rg needle .", followsPipe: false },
    ])
  })

  it("checks the root search after an ANSI-C escaped quote", async () => {
    const workspace = new MemoryWorkspace({ "docs/readme.md": "needle\n" })
    const result = await runWorkspaceInspectionCommand(workspace, String.raw`printf '%s' $'it\'s'; rg needle .`, {
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
