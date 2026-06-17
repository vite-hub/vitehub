import { describe, expect, it, vi } from "vitest"

import { prepareHarnessWorkspaceSession } from "../src/session/harness.ts"

function bytes(content: string): Uint8Array {
  return new TextEncoder().encode(content)
}

describe("Harness Workspace Session", () => {
  it("materializes selected Workspace files into the harness sandbox", async () => {
    const readme = bytes("# Docs\n")
    const list = vi.fn(async () => [
      { path: "README.md", type: "file" },
      { path: "notes", type: "directory" },
    ])
    const readFile = vi.fn(async () => readme)
    const writeBinaryFile = vi.fn(async () => {})

    const session = await prepareHarnessWorkspaceSession({
      fs: { list, readFile },
      tools: {},
    } as never, {
      session: { writeBinaryFile },
      sessionWorkDir: "/work/agent",
    })

    expect(list).toHaveBeenCalledWith("", { recursive: true })
    expect(readFile).toHaveBeenCalledWith("README.md", { encoding: "binary" })
    expect(writeBinaryFile).toHaveBeenCalledWith({
      abortSignal: undefined,
      content: readme,
      path: "/work/agent/README.md",
    })

    await session.close()
  })

  it("commits harness sandbox additions and updates through write-mode Workspace rules", async () => {
    const initial = bytes("old")
    const updated = bytes("new")
    const added = bytes("added")
    const workspaceSession = {
      close: vi.fn(async () => {}),
      commit: vi.fn(async () => {}),
      diff: vi.fn(async () => ({
        entries: [{ path: "README.md", type: "modified" }],
        to: "next",
      })),
      writeFile: vi.fn(async () => {}),
    }
    const startSession = vi.fn(async () => workspaceSession)
    const run = vi.fn(async () => ({
      exitCode: 0,
      stderr: "",
      stdout: "./README.md\n./new.txt\n",
    }))
    const readBinaryFile = vi.fn(async ({ path }: { path: string }) => path.endsWith("README.md") ? updated : added)

    const session = await prepareHarnessWorkspaceSession({
      fs: {
        list: vi.fn(async () => [{ path: "README.md", type: "file" }]),
        readFile: vi.fn(async () => initial),
      },
      startSession,
      tools: {},
    } as never, {
      session: {
        readBinaryFile,
        run,
        writeBinaryFile: vi.fn(async () => {}),
      },
      sessionWorkDir: "/work/agent",
    })

    await session.close()

    expect(startSession).toHaveBeenCalledOnce()
    expect(run).toHaveBeenCalledWith({
      abortSignal: undefined,
      command: "find . -type f -print",
      workingDirectory: "/work/agent",
    })
    expect(workspaceSession.writeFile).toHaveBeenCalledWith("README.md", updated)
    expect(workspaceSession.writeFile).toHaveBeenCalledWith("new.txt", added)
    expect(workspaceSession.commit).toHaveBeenCalledWith({ message: "harness-workspace-session" })
    expect(workspaceSession.close).toHaveBeenCalledOnce()
  })
})
