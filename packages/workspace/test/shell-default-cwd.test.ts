import { describe, expect, it } from "vitest"

import { createShellRuntime } from "@vite-hub/shell"
import { createJustBashProvider } from "@vite-hub/shell/providers/just-bash"
import { createReadonlyWorkspaceFs } from "@vite-hub/shell/workspace"
import { defineWorkspace, useWorkspace } from "../src/index.ts"
import { registerWorkspace } from "../src/test.ts"

describe("Workspace Shell working directory", () => {
  it.each([
    { provider: undefined, exec: undefined, cwd: "/workspace", content: "root" },
    { provider: "/workspace/docs", exec: undefined, cwd: "/workspace/docs", content: "nested" },
    { provider: "/workspace/docs", exec: "/workspace", cwd: "/workspace", content: "root" },
  ])("executes and reports cwd $cwd with provider $provider and exec $exec", async ({ provider, exec, cwd, content }) => {
    const name = `shell-default-cwd-${provider}-${exec}`
    registerWorkspace(name, defineWorkspace({ store: { provider: "memory" } }))
    const workspace = useWorkspace(name, { mode: "write" })
    await workspace.fs.writeFile("notes.md", "root")
    await workspace.fs.writeFile("docs/notes.md", "nested")
    const runtime = createShellRuntime({
      provider: createJustBashProvider({
        commands: ["pwd", "cat"],
        cwd: provider,
        fs: createReadonlyWorkspaceFs(workspace.fs),
      }),
    })

    await expect(runtime.exec("pwd", { cwd: exec })).resolves.toMatchObject({ cwd, exitCode: 0, stdout: `${cwd}\n` })
    await expect(runtime.exec("cat notes.md", { cwd: exec })).resolves.toMatchObject({ cwd, exitCode: 0, stdout: content })
    await expect(runtime.exec("cat /workspace/notes.md", { cwd: exec })).resolves.toMatchObject({ cwd, exitCode: 0, stdout: "root" })
  })
})
