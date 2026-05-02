import { afterEach, describe, expect, it } from "vitest"

import { createWorkspaceTools, readWorkspaceInstructions, useWorkspaceTools, type WorkspaceShellResult } from "../src/ai.ts"
import { setWorkspaceRuntimeAssetsRegistry } from "../src/runtime/state.ts"
import type { WorkspaceAssets } from "../src/types.ts"

function createAssets(files: Record<string, string | Uint8Array>): WorkspaceAssets {
  return {
    async getKeys() {
      return Object.keys(files)
    },
    async getItem<T>(key: string) {
      return (files[key] ?? null) as T | null
    },
  }
}

async function runBash(tools: ReturnType<typeof createWorkspaceTools>, command: string): Promise<WorkspaceShellResult> {
  return await tools.bash.execute!({ command }, { toolCallId: "test", messages: [] } as never) as WorkspaceShellResult
}

async function readFile(tools: ReturnType<typeof createWorkspaceTools>, path: string): Promise<string> {
  return await tools.readFile.execute!({ path }, { toolCallId: "test", messages: [] } as never) as string
}

afterEach(() => {
  setWorkspaceRuntimeAssetsRegistry({})
})

describe("createWorkspaceTools", () => {
  it("reads text and byte-backed workspace assets", async () => {
    const tools = createWorkspaceTools(createAssets({
      "README.md": "# Docs\n",
      "models/orders.sql": new TextEncoder().encode("select * from orders\n"),
    }))

    await expect(readFile(tools, "README.md")).resolves.toBe("# Docs\n")
    await expect(readFile(tools, "models/orders.sql")).resolves.toBe("select * from orders\n")
  })

  it("emulates read-only shell inspection commands", async () => {
    const tools = createWorkspaceTools(createAssets({
      "README.md": "# Docs\n",
      "models/orders.sql": "select * from orders\nwhere id is not null\n",
      "models/customers.sql": "select * from customers\n",
    }))

    await expect(runBash(tools, "pwd")).resolves.toMatchObject({ exitCode: 0, stdout: "/workspace\n" })
    await expect(runBash(tools, "ls models")).resolves.toMatchObject({ exitCode: 0, stdout: "customers.sql\norders.sql\n" })
    await expect(runBash(tools, "find . -name '*.sql'")).resolves.toMatchObject({ exitCode: 0, stdout: "models/customers.sql\nmodels/orders.sql\n" })
    await expect(runBash(tools, "cat README.md")).resolves.toMatchObject({ exitCode: 0, stdout: "# Docs\n" })
    await expect(runBash(tools, "head -n 1 models/orders.sql")).resolves.toMatchObject({ exitCode: 0, stdout: "select * from orders\n" })
    await expect(runBash(tools, "tail -n 1 models/orders.sql")).resolves.toMatchObject({ exitCode: 0, stdout: "where id is not null\n" })
    await expect(runBash(tools, "wc -l models/orders.sql")).resolves.toMatchObject({ exitCode: 0, stdout: "2 models/orders.sql\n" })
    await expect(runBash(tools, "rg orders models")).resolves.toMatchObject({ exitCode: 0, stdout: "models/orders.sql:1:select * from orders\n" })
  })

  it("rejects traversal, mutation commands, and shell syntax deterministically", async () => {
    const tools = createWorkspaceTools(createAssets({
      "README.md": "# Docs\n",
    }))

    await expect(runBash(tools, "rm README.md")).resolves.toMatchObject({
      exitCode: 126,
      stderr: "Command is not available in the read-only workspace shell: rm\n",
    })
    await expect(runBash(tools, "cat README.md | wc -l")).resolves.toMatchObject({
      exitCode: 126,
      stderr: "Unsupported shell syntax: only a single read-only workspace command is supported.\n",
    })
    await expect(runBash(tools, "cat ../README.md")).resolves.toMatchObject({
      exitCode: 1,
      stderr: "[vitehub] Workspace path escapes the workspace root: \"../README.md\".\n",
    })
  })

  it("caps command and readFile output", async () => {
    const tools = createWorkspaceTools(createAssets({
      "large.txt": "0123456789",
    }), { maxOutputLength: 4 })

    await expect(readFile(tools, "large.txt")).resolves.toBe("0123\n[output truncated to 4 characters]\n")
    await expect(runBash(tools, "cat large.txt")).resolves.toMatchObject({
      stdout: "0123\n[output truncated to 4 characters]\n",
    })
  })
})

describe("readWorkspaceInstructions", () => {
  it("reads AGENTS.md files from workspace assets in path order", async () => {
    const instructions = await readWorkspaceInstructions(createAssets({
      "packages/api/AGENTS.md": "API instructions\n",
      "README.md": "# Docs\n",
      "AGENTS.md": "Root instructions\n",
    }))

    expect(instructions).toBe("Root instructions\n\n\nAPI instructions\n")
  })

  it("returns an empty string when the workspace has no AGENTS.md files", async () => {
    await expect(readWorkspaceInstructions(createAssets({
      "README.md": "# Docs\n",
    }))).resolves.toBe("")
  })
})

describe("useWorkspaceTools", () => {
  it("creates tools from named runtime workspace assets", async () => {
    setWorkspaceRuntimeAssetsRegistry({
      docs: createAssets({
        "README.md": new TextEncoder().encode("# Docs\n"),
      }),
    })

    const tools = useWorkspaceTools("docs")

    await expect(readFile(tools, "README.md")).resolves.toBe("# Docs\n")
    await expect(runBash(tools, "cat README.md")).resolves.toMatchObject({
      exitCode: 0,
      stdout: "# Docs\n",
    })
  })
})
