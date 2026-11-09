import { describe, expect, it } from "vitest"

import { splitShellCommandSegments } from "../src/command/parse.ts"
import { createReadonlyWorkspaceFs, runWorkspaceInspectionCommand } from "../src/workspace/index.ts"
import { MemoryWorkspace } from "./workspace-test-utils.ts"

describe("single-quoted backslashes in command segments", () => {
  it.each([";", "&&", "||", "|", "\n"] as const)("finds the %j separator after a literal backslash", async (separator) => {
    await expect(splitShellCommandSegments(`printf '%s' '\\' ${separator} cat docs/readme.md`)).resolves.toMatchObject([
      { command: "printf '%s' '\\' ", followsPipe: false, separatorAfter: separator },
      { command: " cat docs/readme.md", followsPipe: separator === "|" },
    ])
  })

  it("preserves a backslash and newline inside single quotes", async () => {
    const command = "printf '%s' 'a\\\nb'"
    await expect(splitShellCommandSegments(command)).resolves.toMatchObject([{ command, followsPipe: false }])
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

describe("non-ASCII and pipe-all command segments", () => {
  it("uses UTF-16 indexes for UTF-8 AST offsets", async () => {
    await expect(splitShellCommandSegments("echo 😀; rg needle .")).resolves.toMatchObject([
      { command: "echo 😀", followsPipe: false, separatorAfter: ";" },
      { command: " rg needle .", followsPipe: false },
    ])
  })

  it("preserves the complete |& operator", async () => {
    await expect(splitShellCommandSegments("echo ok |& rg needle .")).resolves.toMatchObject([
      { command: "echo ok ", followsPipe: false, separatorAfter: "|" },
      { command: " rg needle .", followsPipe: true },
    ])
  })

  it("applies the broad-search guardrail after |&", async () => {
    const workspace = new MemoryWorkspace({ "docs/readme.md": "needle\n" })
    const result = await runWorkspaceInspectionCommand(workspace, "echo ok |& rg needle .", {
      commands: ["echo", "rg"],
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
  it.each([";", "&&", "||", "|", "\n"] as const)("finds the %j separator after an escaped quote", async (separator) => {
    const command = String.raw`printf '%s' $'it\'s'`
    await expect(splitShellCommandSegments(`${command} ${separator} rg needle .`)).resolves.toMatchObject([
      { command: `${command} `, followsPipe: false, separatorAfter: separator },
      { command: " rg needle .", followsPipe: separator === "|" },
    ])
  })

  it("preserves backslash-newline inside ANSI-C quotes", async () => {
    const command = "printf '%s' $'a\\\nb'"
    await expect(splitShellCommandSegments(command)).resolves.toMatchObject([{ command, followsPipe: false }])
  })

  it("keeps a quote after an escaped dollar sign ordinary", async () => {
    const command = String.raw`printf '%s' \$'\'`
    await expect(splitShellCommandSegments(`${command}; rg needle .`)).resolves.toMatchObject([
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

  it("reads segment words from the statement that owns a heredoc", async () => {
    await expect(splitShellCommandSegments("cat <<EOF | rg needle\nhi\nEOF")).resolves.toEqual([
      { command: "cat <<EOF ", followsPipe: false, separatorAfter: "|", words: ["cat", "<<EOF"] },
      { command: " rg needle", followsPipe: true, words: ["rg", "needle"] },
    ])
  })
})
