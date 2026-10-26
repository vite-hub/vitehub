import { describe, expect, it } from "vitest"

import { splitShellCommandSegments } from "../src/command/parse.ts"
import { createReadonlyWorkspaceFs, runWorkspaceInspectionCommand } from "../src/workspace/index.ts"
import { MemoryWorkspace } from "./workspace-test-utils.ts"

describe("Workspace inspection line continuations", () => {
  it.each([
    { command: 'cat "docs/re\\\nadme.md"', joined: 'cat "docs/readme.md"' },
    { command: "cat \\\n'docs/readme.md'", joined: "cat 'docs/readme.md'" },
  ])("removes the full continuation in $command", ({ command, joined }) => {
    expect(splitShellCommandSegments(command)).toEqual([{ command: joined, followsPipe: false }])
  })

  it.each(['cat "docs/re\\\nadme.md"', "cat \\\n'docs/readme.md'"])("reads the existing file with %j", async (command) => {
    const workspace = new MemoryWorkspace({ "docs/readme.md": "mounted content\n" })
    const result = await runWorkspaceInspectionCommand(workspace, command, {
      commands: ["cat"],
      fs: createReadonlyWorkspaceFs(workspace),
    })
    expect(result).toMatchObject({ event: "command_finished", exitCode: 0, stdout: "mounted content\n" })
    expect(result.workspaceGuardrail).toBeUndefined()
  })
})
