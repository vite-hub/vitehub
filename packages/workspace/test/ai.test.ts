import { afterEach, describe, expect, it } from "vitest"

import { createWorkspaceTools } from "../src/ai.ts"
import { useWorkspace } from "../src/index.ts"
import { createWorkspaceAssets } from "../src/runtime/assets.ts"
import { setWorkspaceRuntimeAssetsRegistry } from "../src/runtime/state.ts"
import { createWorkspace } from "../src/workspace.ts"

function createAssets(files: Record<string, string | Uint8Array>) {
  return createWorkspaceAssets(Object.fromEntries(
    Object.entries(files).map(([path, content]) => [path, { load: async () => content }]),
  ))
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
  it("creates structured read tools for immutable workspace assets", async () => {
    const tools = createWorkspaceTools(createAssets({
      "README.md": "# Docs\n",
      "guide/setup.md": "Setup\n",
    }))

    await expect(tools.exists.execute!({ path: "README.md" }, { toolCallId: "test", messages: [] } as never)).resolves.toEqual({
      exists: true,
      path: "README.md",
    })
    await expect(tools.list.execute!({ path: "", recursive: true }, { toolCallId: "test", messages: [] } as never)).resolves.toMatchObject({
      entries: expect.arrayContaining([
        expect.objectContaining({ path: "README.md", type: "file" }),
        expect.objectContaining({ path: "guide/setup.md", type: "file" }),
      ]),
    })
    await expect(tools.readFile.execute!({ path: "README.md" }, { toolCallId: "test", messages: [] } as never)).resolves.toEqual({
      content: "# Docs\n",
      path: "README.md",
    })
    await expect(tools.search.execute!({ pattern: "Setup" }, { toolCallId: "test", messages: [] } as never)).resolves.toMatchObject({
      hits: [expect.objectContaining({ path: "guide/setup.md" })],
    })
    await expect(tools.stat.execute!({ path: "README.md" }, { toolCallId: "test", messages: [] } as never)).resolves.toMatchObject({
      path: "README.md",
      type: "file",
    })
  })

  it("throws when no operations are enabled", () => {
    expect(() => createWorkspaceTools(createMutableWorkspace(), {
      operations: {
        read: {
          exists: false,
          list: false,
          readFile: false,
          search: false,
          stat: false,
        },
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

    const tools = await useWorkspace("docs").tools()

    await expect(tools.readFile.execute!({ path: "README.md" }, { toolCallId: "test", messages: [] } as never)).resolves.toEqual({
      content: "# Docs\n",
      path: "README.md",
    })
  })
})
