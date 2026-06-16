import { afterEach, describe, expect, it, vi } from "vitest"

import { createWorkspaceTools, type WorkspaceShellResult } from "../src/ai.ts"
import { source, useWorkspace } from "../src/index.ts"
import { createWorkspaceAssets } from "../src/runtime/assets.ts"
import { setWorkspaceRuntimeAssetsRegistry } from "../src/runtime/state.ts"
import { createWorkspace } from "../src/core/workspace.ts"

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
  vi.restoreAllMocks()
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
    await expect(runShell(tools, "find . -name '*.sql'")).resolves.toMatchObject({
      event: "policy_denied",
      exitCode: 126,
      stdout: expect.stringContaining("Workspace search is too broad"),
    })
    await expect(runShell(tools, "cat README.md")).resolves.toMatchObject({ exitCode: 0, stdout: "# Docs\n" })
    await expect(runShell(tools, "cat models/orders.sql | head -n 1")).resolves.toMatchObject({ exitCode: 0, stdout: "select * from orders\n" })
    await expect(runShell(tools, "cat models/orders.sql | tail -n 1")).resolves.toMatchObject({ exitCode: 0, stdout: "where id is not null\n" })
    await expect(runShell(tools, "head -n 1 models/orders.sql")).resolves.toMatchObject({ exitCode: 0, stdout: "select * from orders\n" })
    await expect(runShell(tools, "tail -n 1 models/orders.sql")).resolves.toMatchObject({ exitCode: 0, stdout: "where id is not null\n" })
    await expect(runShell(tools, "wc -l models/orders.sql")).resolves.toMatchObject({ exitCode: 0, stdout: "2 models/orders.sql\n" })
    await expect(runShell(tools, "rg orders models")).resolves.toMatchObject({ exitCode: 0, stdout: "models/orders.sql:1:select * from orders\n" })
    await expect(runShell(tools, "rg -i \"customer\" docs models | head -n 2")).resolves.toMatchObject({
      exitCode: 0,
      stdout: "docs/customers.md:1:Customer docs\nmodels/customers.sql:1:select * from customers\n",
    })
    await expect(runShell(tools, "grep -ri \"customer\" . | head -n 1")).resolves.toMatchObject({
      event: "policy_denied",
      exitCode: 126,
      stdout: expect.stringContaining("Workspace search is too broad"),
    })
    await expect(runShell(tools, "cd /workspace && rg orders models")).resolves.toMatchObject({
      exitCode: 0,
      stdout: "models/orders.sql:1:select * from orders\n",
    })
    await expect(runShell(tools, "pwd && ls models")).resolves.toMatchObject({
      exitCode: 0,
      stdout: "/workspace\ncustomers.sql\norders.sql\n",
    })
    expect(tools.shell.description).toContain("Use these commands")
    expect(tools.shell.description).toContain("Skip unsupported helpers such as `xargs`")
    expect(tools.shell.description).not.toContain("controlled `curl`")
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
    expect(tools.shell.description).toContain("`find ingestion -type f -name '*.sql'`")
    expect(tools.shell.description).not.toContain("`rg")
    expect(tools.shell.description).not.toContain("cat forecasting-engine")
    await expect(runShell(tools, "cat README.md")).resolves.toMatchObject({
      event: "policy_denied",
      exitCode: 126,
      stderr: expect.stringContaining("Unsupported workspace shell command: cat"),
      stdout: expect.stringContaining("Use only the available workspace commands"),
    })
    await expect(runShell(tools, "rg orders models")).resolves.toMatchObject({
      event: "policy_denied",
      exitCode: 126,
      stderr: expect.stringContaining("Unsupported workspace shell command: rg"),
      stdout: expect.stringContaining("Use only the available workspace commands"),
    })
  })

  it("surfaces shell failures and read-only filesystem errors deterministically", async () => {
    const tools = createWorkspaceTools(createAssets({
      "README.md": "# Docs\n",
    }))

    await expect(runShell(tools, "rm README.md")).resolves.toMatchObject({
      event: "policy_denied",
      exitCode: 126,
      stderr: expect.stringContaining("Unsupported workspace shell command: rm"),
      stdout: expect.stringContaining("Use only the available workspace commands"),
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

  it("accepts shell timeout through workspace tools", async () => {
    const tools = createWorkspaceTools(createAssets({
      "README.md": "# Docs\n",
    }), { timeout: 5 })

    await expect(runShell(tools, "cat README.md")).resolves.toMatchObject({
      exitCode: 0,
      stdout: "# Docs\n",
    })
  })

  it("returns model-readable feedback when shell call budget is exhausted", async () => {
    const tools = createWorkspaceTools(createAssets({
      "README.md": "# Docs\n",
    }), { maxShellCalls: 1 })

    await expect(runShell(tools, "cat README.md")).resolves.toMatchObject({ exitCode: 0 })
    await expect(runShell(tools, "pwd")).resolves.toMatchObject({
      event: "policy_denied",
      exitCode: 126,
      stderr: expect.stringContaining("command budget exhausted"),
    })
  })

  it("uses broad search path hints in workspace shell feedback", async () => {
    const tools = createWorkspaceTools(createAssets({
      "models/orders.sql": "select * from orders\n",
    }), { broadSearchPaths: ["models"] })

    await expect(runShell(tools, "rg orders .")).resolves.toMatchObject({
      event: "policy_denied",
      exitCode: 126,
      stderr: expect.stringContaining("Workspace root search is too broad"),
    })
  })

  it("runs controlled curl through visible source.fetch request descriptors", async () => {
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ status: "ok" }), {
      headers: { "content-type": "application/json" },
      status: 200,
    }))
    const querySchema = {
      "~standard": {
        jsonSchema: { input: () => ({ properties: { region: { type: "string" } }, type: "object" }) },
        validate(input: unknown) {
          return { value: input as Record<string, unknown> }
        },
      },
    } as const
    const workspace = createWorkspace({
      name: "curl-source",
      sources: {
        inventoryHealthSummary: source.fetch({
          cookies: { auth_token: "secret" },
          querySchema,
          url: "https://portal.example.com/runtime/inventory-health",
        }),
      },
      store: { provider: "memory" },
    })
    const tools = createWorkspaceTools(workspace)

    expect(tools.shell.description).toContain("controlled `curl`")
    expect(tools.shell.description).toContain(".vitehub/sources/*.json")
    expect(tools.shell.description).toContain("Source Request Shape")

    await expect(runShell(tools, "curl -sS 'https://portal.example.com/runtime/inventory-health?region=eu'")).resolves.toMatchObject({
      event: "command_finished",
      exitCode: 0,
      stdout: JSON.stringify({ status: "ok" }, null, 2),
    })
    const init = request.mock.calls[0]?.[1] as RequestInit
    expect((init.headers as Headers).get("cookie")).toBe("auth_token=secret")

    await expect(runShell(tools, "curl -d '{\"region\":\"eu\"}' https://portal.example.com/runtime/inventory-health")).resolves.toMatchObject({
      event: "policy_denied",
      exitCode: 126,
      stderr: expect.stringContaining("does not allow -d"),
    })
  })

  it("matches controlled curl by concrete query shape", async () => {
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ status: "ok" }), {
      headers: { "content-type": "application/json" },
      status: 200,
    }))
    const workspace = createWorkspace({
      name: "curl-source-query-shape",
      sources: {
        pageTwo: source.fetch({ query: { page: 2 }, url: "https://portal.example.com/runtime/items" }),
        pageThree: source.fetch({ query: { page: 3 }, url: "https://portal.example.com/runtime/items" }),
      },
      store: { provider: "memory" },
    })

    await expect(runShell(createWorkspaceTools(workspace), "curl 'https://portal.example.com/runtime/items?page=2'")).resolves.toMatchObject({
      event: "command_finished",
      exitCode: 0,
    })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it("does not intercept workspace searches that mention curl", async () => {
    const tools = createWorkspaceTools(createAssets({
      "docs/commands.md": "Use curl for API checks.\n",
    }))

    await expect(runShell(tools, "rg curl docs")).resolves.toMatchObject({
      event: "command_finished",
      exitCode: 0,
      stdout: expect.stringContaining("Use curl for API checks."),
    })
  })

  it("exposes source materialization as an opt-in tool", async () => {
    const tools = createWorkspaceTools(createAssets({
      "README.md": "# Docs\n",
      "docs/a.md": "A\n",
      "docs/b.md": "B\n",
    }), {
      operations: {
        materialize: true,
      },
    })

    expect("materialize_sources" in tools).toBe(true)
    await expect(tools.materialize_sources.execute!({ path: "docs" }, { toolCallId: "test", messages: [] } as never)).resolves.toMatchObject({
      directories: 0,
      files: 2,
      path: "docs",
      sources: [],
    })
  })

  it("materializes all matching source files without a default cap", async () => {
    const tools = createWorkspaceTools(createAssets(Object.fromEntries(
      Array.from({ length: 30 }, (_, index) => [`docs/${index}.md`, `${index}\n`]),
    )), {
      operations: {
        materialize: true,
      },
    })

    await expect(tools.materialize_sources.execute!({}, { toolCallId: "test", messages: [] } as never)).resolves.toMatchObject({
      files: 30,
      sources: [],
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
    expect(workspace.tools.none()).toEqual({})
    expect("shell" in workspace.tools).toBe(true)
  })
})
