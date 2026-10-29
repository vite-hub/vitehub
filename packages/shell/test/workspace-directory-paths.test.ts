import { describe, expect, it } from "vitest"

import { createShellRuntime } from "../src/index.ts"
import { createJustBashProvider } from "../src/providers/just-bash.ts"
import { createWritableWorkspaceFs, workspaceMountPoint } from "../src/workspace/index.ts"
import { MemoryWorkspace } from "./workspace-test-utils.ts"

// Workspace stores accept trailing separators and return canonical entry paths.
class DirectoryWorkspace extends MemoryWorkspace {
  override stat(path: string) {
    return super.stat(path.replace(/\/+$/, ""))
  }

  override list(path = "", options: { recursive?: boolean } = {}) {
    return super.list(path.replace(/\/+$/, ""), options)
  }
}

function createWorkspace() {
  return new DirectoryWorkspace({
    "models/orders.sql": "select * from orders\n",
    "models/nested/items.sql": "select * from items\n",
  })
}

describe("Workspace directory paths", () => {
  it.each(["/workspace/models", "/workspace/models/", "/workspace/models//", "/workspace/models/./"])("lists complete child names for %s", async (path) => {
    const fs = createWritableWorkspaceFs(createWorkspace())

    expect(await fs.readdir(path)).toEqual(["nested", "orders.sql"])
  })

  it.each(["/workspace/models", "/workspace/models/", "/workspace/models//", "/workspace/models/./"])("preserves child paths when copying %s", async (path) => {
    const workspace = createWorkspace()
    const fs = createWritableWorkspaceFs(workspace)

    await fs.cp(path, "/workspace/archive", { recursive: true })

    expect(await fs.readdir("/workspace/archive")).toEqual(["nested", "orders.sql"])
    expect(await fs.readFile("/workspace/archive/orders.sql")).toBe("select * from orders\n")
    expect(await fs.readFile("/workspace/archive/nested/items.sql")).toBe("select * from items\n")
    expect(await workspace.readFile("models/orders.sql")).toBe("select * from orders\n")
  })

  it("lists a directory with a trailing slash through Just Bash", async () => {
    const runtime = createShellRuntime({
      provider: createJustBashProvider({
        commands: ["ls"],
        cwd: workspaceMountPoint,
        fs: createWritableWorkspaceFs(createWorkspace()),
      }),
    })

    const result = await runtime.exec("ls models/")

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.stdout).toContain("orders.sql")
    expect(result.stdout).toContain("nested")
  })
})
