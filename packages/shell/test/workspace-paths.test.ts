import { describe, expect, it } from "vitest"

import { cleanWorkspaceMutationPath, cleanWorkspaceShellPath, createReadonlyWorkspaceFs, runWorkspaceInspectionCommand } from "../src/workspace/index.ts"
import { MemoryWorkspace } from "./workspace-test-utils.ts"

describe("Workspace shell path whitespace", () => {
  it.each([
    { path: "report.md ", command: "cat 'report.md '", cwd: "/workspace" },
    { path: " report.md", command: "cat ' report.md'", cwd: "/workspace" },
    { path: " ", command: "cat ' '", cwd: "/workspace" },
    { path: "folder /report.md", command: "cat report.md", cwd: "/workspace/folder " },
  ])("reads $path through inspection", async ({ path, command, cwd }) => {
    const workspace = new MemoryWorkspace({ [path]: "exact file\n" })
    const result = await runWorkspaceInspectionCommand(workspace, command, {
      cwd,
      fs: createReadonlyWorkspaceFs(workspace),
    })
    expect(result).toMatchObject({ exitCode: 0, stdout: "exact file\n" })
  })

  it.each(["report.md ", " report.md", " "])("preserves the mutation target %j", (path) => {
    expect(cleanWorkspaceMutationPath(path)).toBe(path)
    expect(cleanWorkspaceShellPath(`/workspace/${path}`)).toBe(path)
  })

  it.each(["", ".", "./", "/", "/workspace"])("keeps %j as the root", (path) => {
    expect(cleanWorkspaceShellPath(path)).toBe("")
    expect(() => cleanWorkspaceMutationPath(path)).toThrow("root is not a valid mutation target")
  })
})
