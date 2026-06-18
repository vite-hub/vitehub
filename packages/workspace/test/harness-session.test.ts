import { describe, expect, it, vi } from "vitest"

import { prepareHarnessWorkspaceSession } from "../src/session/harness.ts"

function bytes(content: string): Uint8Array {
  return new TextEncoder().encode(content)
}

function ok(stdout = "") {
  return { exitCode: 0, stderr: "", stdout }
}

function sandboxRun(files: string[] = [], directories: string[] = []) {
  return vi.fn(async ({ command }: { command: string }) => {
    if (command.includes("-type d")) return ok(directories.map(path => `./${path}`).join("\n"))
    if (command.includes("-type f")) return ok(files.map(path => `./${path}`).join("\n"))
    return ok()
  })
}

describe("Harness Workspace Session", () => {
  it("resets and materializes selected Workspace files into the harness sandbox", async () => {
    const readme = bytes("# Docs\n")
    const list = vi.fn(async () => [
      { path: "README.md", type: "file" },
      { path: "notes", type: "directory" },
    ])
    const readFile = vi.fn(async () => readme)
    const run = sandboxRun()
    const writeBinaryFile = vi.fn(async () => {})

    const session = await prepareHarnessWorkspaceSession({
      fs: { list, readFile },
      tools: {},
    } as never, {
      session: { run, writeBinaryFile },
      sessionWorkDir: "/work/agent",
    })

    expect(list).toHaveBeenCalledWith("", { recursive: true })
    expect(run).toHaveBeenCalledWith({
      abortSignal: undefined,
      command: "rm -rf '/work/agent' && mkdir -p '/work/agent'",
    })
    expect(run).toHaveBeenCalledWith({
      abortSignal: undefined,
      command: "mkdir -p '/work/agent/notes'",
    })
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
      mkdir: vi.fn(async () => {}),
      rm: vi.fn(async () => {}),
      writeFile: vi.fn(async () => {}),
    }
    const startSession = vi.fn(async () => workspaceSession)
    const run = sandboxRun(["README.md", "new.json"])
    const readBinaryFile = vi.fn(async ({ path }: { path: string }) => path.endsWith("README.md") ? updated : added)

    const session = await prepareHarnessWorkspaceSession({
      fs: {
        list: vi.fn(async () => [{ mediaType: "text/markdown", path: "README.md", type: "file" }]),
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
    expect(workspaceSession.writeFile).toHaveBeenCalledWith("README.md", updated, { mediaType: "text/markdown" })
    expect(workspaceSession.writeFile).toHaveBeenCalledWith("new.json", added, { mediaType: "application/json" })
    expect(workspaceSession.commit).toHaveBeenCalledWith({ message: "harness-workspace-session" })
    expect(workspaceSession.close).toHaveBeenCalledOnce()
  })

  it("commits harness sandbox deletions through write-mode Workspace rules", async () => {
    const workspaceSession = {
      close: vi.fn(async () => {}),
      commit: vi.fn(async () => {}),
      diff: vi.fn(async () => ({
        entries: [{ path: "old.txt", type: "removed" }],
        to: "next",
      })),
      mkdir: vi.fn(async () => {}),
      rm: vi.fn(async () => {}),
      writeFile: vi.fn(async () => {}),
    }

    const session = await prepareHarnessWorkspaceSession({
      fs: {
        list: vi.fn(async () => [
          { path: "README.md", type: "file" },
          { path: "old.txt", type: "file" },
        ]),
        readFile: vi.fn(async (path: string) => bytes(path)),
      },
      startSession: vi.fn(async () => workspaceSession),
      tools: {},
    } as never, {
      session: {
        readBinaryFile: vi.fn(async ({ path }: { path: string }) => bytes(path)),
        run: sandboxRun(["README.md"]),
        writeBinaryFile: vi.fn(async () => {}),
      },
      sessionWorkDir: "/work/agent",
    })

    await session.close()

    expect(workspaceSession.rm).toHaveBeenCalledWith("old.txt", { force: true })
    expect(workspaceSession.commit).toHaveBeenCalledWith({ message: "harness-workspace-session" })
  })

  it("commits harness sandbox directory and file transitions through Workspace rules", async () => {
    const workspaceSession = {
      close: vi.fn(async () => {}),
      commit: vi.fn(async () => {}),
      diff: vi.fn(async () => ({
        entries: [{ path: "node/result.txt", type: "added" }],
        to: "next",
      })),
      mkdir: vi.fn(async () => {}),
      rm: vi.fn(async () => {}),
      writeFile: vi.fn(async () => {}),
    }

    const session = await prepareHarnessWorkspaceSession({
      fs: {
        list: vi.fn(async () => [
          { path: "empty", type: "directory" },
          { path: "node", type: "file" },
        ]),
        readFile: vi.fn(async (path: string) => bytes(path)),
      },
      startSession: vi.fn(async () => workspaceSession),
      tools: {},
    } as never, {
      session: {
        readBinaryFile: vi.fn(async ({ path }: { path: string }) => bytes(path)),
        run: sandboxRun(["node/result.txt"], ["empty", "node"]),
        writeBinaryFile: vi.fn(async () => {}),
      },
      sessionWorkDir: "/work/agent",
    })

    await session.close()

    expect(workspaceSession.rm).toHaveBeenCalledWith("node", { force: true })
    expect(workspaceSession.mkdir).toHaveBeenCalledWith("empty", { recursive: true })
    expect(workspaceSession.mkdir).toHaveBeenCalledWith("node", { recursive: true })
    expect(workspaceSession.writeFile).toHaveBeenCalledWith("node/result.txt", bytes("/work/agent/node/result.txt"), { mediaType: "text/plain" })
    expect(workspaceSession.commit).toHaveBeenCalledWith({ message: "harness-workspace-session" })
  })
})
