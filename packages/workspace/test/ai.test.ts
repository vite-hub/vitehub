import { afterEach, describe, expect, it } from "vitest"

import { createWorkspaceTools, type WorkspaceShellResult } from "../src/ai.ts"
import { useWorkspace } from "../src/index.ts"
import { createWorkspaceAssets } from "../src/runtime/assets.ts"
import { setWorkspaceRuntimeAssetsRegistry } from "../src/runtime/state.ts"
import { createWorkspace } from "../src/workspace.ts"

function createAssets(files: Record<string, string | Uint8Array>) {
  return createWorkspaceAssets(Object.fromEntries(
    Object.entries(files).map(([path, content]) => [path, { load: async () => content }]),
  ))
}

async function runShell(tools: ReturnType<typeof createWorkspaceTools>, command: string): Promise<WorkspaceShellResult> {
  return await tools.shell.execute!({ command }, { toolCallId: "test", messages: [] } as never) as WorkspaceShellResult
}

function createMutableWorkspace() {
  return createWorkspace({
    name: "mutable",
    store: { provider: "memory" },
  })
}

afterEach(() => {
  setWorkspaceRuntimeAssetsRegistry({})
})

describe("createWorkspaceTools", () => {
  it("runs real read-only shell inspection commands", async () => {
    const tools = createWorkspaceTools(createAssets({
      "README.md": "# Docs\n",
      "models/orders.sql": "select * from orders\nwhere id is not null\n",
      "models/customers.sql": "select * from customers\n",
      "docs/customers.md": "Customer docs\nmore\n",
    }))

    await expect(runShell(tools, "pwd")).resolves.toMatchObject({ exitCode: 0, stdout: "/workspace\n" })
    await expect(runShell(tools, "ls models")).resolves.toMatchObject({ exitCode: 0, stdout: "customers.sql\norders.sql\n" })
    await expect(runShell(tools, "find . -name '*.sql'")).resolves.toMatchObject({ exitCode: 0, stdout: "./models/customers.sql\n./models/orders.sql\n" })
    await expect(runShell(tools, "cat README.md")).resolves.toMatchObject({ exitCode: 0, stdout: "# Docs\n" })
    await expect(runShell(tools, "cat models/orders.sql | head -n 1")).resolves.toMatchObject({ exitCode: 0, stdout: "select * from orders\n" })
    await expect(runShell(tools, "cat models/orders.sql | tail -n 1")).resolves.toMatchObject({ exitCode: 0, stdout: "where id is not null\n" })
    await expect(runShell(tools, "head -n 1 models/orders.sql")).resolves.toMatchObject({ exitCode: 0, stdout: "select * from orders\n" })
    await expect(runShell(tools, "tail -n 1 models/orders.sql")).resolves.toMatchObject({ exitCode: 0, stdout: "where id is not null\n" })
    await expect(runShell(tools, "wc -l models/orders.sql")).resolves.toMatchObject({ exitCode: 0, stdout: "2 models/orders.sql\n" })
    await expect(runShell(tools, "rg orders models")).resolves.toMatchObject({ exitCode: 0, stdout: "models/orders.sql:1:select * from orders\n" })
    await expect(runShell(tools, "rg -i \"customer\" . | head -n 2")).resolves.toMatchObject({
      exitCode: 0,
      stdout: "docs/customers.md:1:Customer docs\nmodels/customers.sql:1:select * from customers\n",
    })
    await expect(runShell(tools, "grep -ri \"customer\" . | head -n 1")).resolves.toMatchObject({
      exitCode: 0,
      stdout: "docs/customers.md:Customer docs\n",
    })
    await expect(runShell(tools, "cd /workspace && rg orders models")).resolves.toMatchObject({
      exitCode: 0,
      stdout: "models/orders.sql:1:select * from orders\n",
    })
    await expect(runShell(tools, "pwd && ls models")).resolves.toMatchObject({
      exitCode: 0,
      stdout: "/workspace\ncustomers.sql\norders.sql\n",
    })
  })

  it("describes shell syntax in tool metadata", () => {
    const tools = createWorkspaceTools(createAssets({
      "README.md": "# Docs\n",
    }))
    const description = tools.shell.description || ""
    const commandDescription = (tools.shell.inputSchema as any).jsonSchema.properties.command.description

    expect(description).toContain("real Bash-compatible")
    expect(description).toContain("/workspace")
    expect(description).toContain("Pipes, redirects, chaining")
    expect(description).toContain("rg 'siff|PLC' ingestion forecasting-engine | head -n 20")
    expect(commandDescription).toContain("Bash-compatible")
  })

  it("limits shell commands to the enabled read capabilities", async () => {
    const tools = createWorkspaceTools(createAssets({
      "README.md": "# Docs\n",
      "models/orders.sql": "select * from orders\n",
    }), {
      operations: {
        read: false,
        search: false,
      },
    })

    await expect(runShell(tools, "ls .")).resolves.toMatchObject({ exitCode: 0, stdout: "README.md\nmodels\n" })
    await expect(runShell(tools, "cat README.md")).resolves.toMatchObject({
      exitCode: 127,
      stderr: "bash: cat: command not found\n",
    })
    await expect(runShell(tools, "rg orders models")).resolves.toMatchObject({
      exitCode: 127,
      stderr: "bash: rg: command not found\n",
    })
  })

  it("surfaces shell failures and read-only filesystem errors deterministically", async () => {
    const tools = createWorkspaceTools(createAssets({
      "README.md": "# Docs\n",
    }))

    await expect(runShell(tools, "rm README.md")).resolves.toMatchObject({
      exitCode: 127,
      stderr: "bash: rm: command not found\n",
    })
    await expect(runShell(tools, "cat README.md | wc -l")).resolves.toMatchObject({
      exitCode: 0,
      stdout: "1\n",
    })
    await expect(runShell(tools, "cat README.md | head -n 1 | tail -n 1")).resolves.toMatchObject({
      exitCode: 0,
      stdout: "# Docs\n",
    })
    await expect(runShell(tools, "cat ../README.md")).resolves.toMatchObject({
      exitCode: 1,
      stderr: "cat: ../README.md: No such file or directory\n",
    })
  })

  it("caps shell output", async () => {
    const tools = createWorkspaceTools(createAssets({
      "large.txt": "0123456789",
    }), { maxOutputLength: 4 })

    await expect(runShell(tools, "cat large.txt")).resolves.toMatchObject({
      stdout: "0123\n[output truncated to 4 characters]\n",
    })
  })

  it("throws when no operations are enabled", () => {
    expect(() => createWorkspaceTools(createAssets({
      "README.md": "# Docs\n",
    }), {
      operations: {
        list: false,
        read: false,
        search: false,
      },
    })).toThrow("at least one enabled workspace operation")
  })

  it("rejects write operations for immutable workspace assets", () => {
    expect(() => createWorkspaceTools(createAssets({
      "README.md": "# Docs\n",
    }), {
      operations: {
        write: true,
      },
    })).toThrow("Write operations require a mutable Workspace")
  })

  it("applies structured write operations to mutable workspaces", async () => {
    const workspace = createMutableWorkspace()
    const tools = createWorkspaceTools(workspace, {
      operations: {
        list: false,
        read: false,
        search: false,
        write: true,
      },
    })

    await tools.makeDir.execute!({ path: "docs", recursive: true }, { toolCallId: "test", messages: [] } as never)
    await tools.writeFile.execute!({ path: "docs/readme.md", content: "# Docs\n" }, { toolCallId: "test", messages: [] } as never)
    await tools.appendFile.execute!({ path: "docs/readme.md", content: "more\n" }, { toolCallId: "test", messages: [] } as never)
    await tools.copyPath.execute!({ from: "docs/readme.md", to: "docs/copy.md" }, { toolCallId: "test", messages: [] } as never)
    await tools.movePath.execute!({ from: "docs/copy.md", to: "docs/moved.md" }, { toolCallId: "test", messages: [] } as never)
    await tools.deletePath.execute!({ path: "docs/moved.md" }, { toolCallId: "test", messages: [] } as never)

    await expect(workspace.readFile("docs/readme.md")).resolves.toBe("# Docs\nmore\n")
    await expect(workspace.exists("docs/moved.md")).resolves.toBe(false)
  })
})

describe("useWorkspace facade tools", () => {
  it("creates read-only tools from named runtime workspace assets", async () => {
    setWorkspaceRuntimeAssetsRegistry({
      docs: createAssets({
        "README.md": new TextEncoder().encode("# Docs\n"),
      }),
    })

    const tools = useWorkspace("docs").tools.inspect()

    expect("shell" in tools).toBe(true)
    await expect(runShell(tools, "cat README.md")).resolves.toMatchObject({
      exitCode: 0,
      stdout: "# Docs\n",
    })
  })

  it("exposes explicit read-only tool presets", () => {
    setWorkspaceRuntimeAssetsRegistry({
      docs: createAssets({
        "README.md": new TextEncoder().encode("# Docs\n"),
      }),
    })

    const workspace = useWorkspace("docs")

    expect("shell" in workspace.tools.inspect()).toBe(true)
    expect("shell" in workspace.tools.readonly()).toBe(true)
    expect(workspace.tools.none()).toEqual({})
    expect("shell" in workspace.tools()).toBe(true)
  })
})
