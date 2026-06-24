import { describe, expect, it, vi } from "vitest"

import { prepareHarnessWorkspaceSession } from "../src/session/harness.ts"
import { defineWorkspace } from "../src/index.ts"
import { createWorkspace } from "../src/core/workspace.ts"

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

  it("materializes only selected Workspace Session paths", async () => {
    const publicReadme = bytes("# Public\n")
    const stat = vi.fn(async (path: string) => {
      if (path === "public") return { path: "public", type: "directory" }
      throw new Error(`unexpected stat ${path}`)
    })
    const list = vi.fn(async (path: string) => {
      if (path === "public") {
        return [
          { path: "public", type: "directory" },
          { mediaType: "text/markdown", path: "public/README.md", type: "file" },
        ]
      }
      throw new Error(`unexpected list ${path}`)
    })
    const readFile = vi.fn(async (path: string) => {
      if (path === "public/README.md") return publicReadme
      throw new Error(`unexpected read ${path}`)
    })
    const startSession = vi.fn(async () => ({
      close: vi.fn(async () => {}),
      commit: vi.fn(async () => {}),
      diff: vi.fn(async () => ({ entries: [], to: "next" })),
      mkdir: vi.fn(async () => {}),
      rm: vi.fn(async () => {}),
      writeFile: vi.fn(async () => {}),
    }))
    const writeBinaryFile = vi.fn(async () => {})

    const session = await prepareHarnessWorkspaceSession({
      fs: { list, readFile, stat },
      startSession,
      tools: {},
    } as never, {
      paths: ["public"],
      session: {
        readBinaryFile: vi.fn(async () => null),
        run: sandboxRun(["public/README.md"], ["public"]),
        writeBinaryFile,
      },
      sessionWorkDir: "/work/agent",
    })

    expect(stat).toHaveBeenCalledWith("public")
    expect(list).toHaveBeenCalledWith("public", { recursive: true })
    expect(list).not.toHaveBeenCalledWith("", { recursive: true })
    expect(readFile).toHaveBeenCalledWith("public/README.md", { encoding: "binary" })
    expect(writeBinaryFile).toHaveBeenCalledWith({
      abortSignal: undefined,
      content: publicReadme,
      path: "/work/agent/public/README.md",
    })
    expect(startSession).toHaveBeenCalledWith({ paths: ["public"] })

    await session.close()
  })

  it("keeps an empty selected Workspace Session scope empty", async () => {
    const list = vi.fn(async () => [
      { path: "README.md", type: "file" },
    ])
    const materializeSources = vi.fn(async () => ({
      bytes: 0,
      directories: 0,
      durationMs: 0,
      files: 0,
      path: "",
      sources: [],
    }))
    const startSession = vi.fn(async () => ({
      close: vi.fn(async () => {}),
      commit: vi.fn(async () => {}),
      diff: vi.fn(async () => ({ entries: [], to: "next" })),
      mkdir: vi.fn(async () => {}),
      rm: vi.fn(async () => {}),
      writeFile: vi.fn(async () => {}),
    }))
    const writeBinaryFile = vi.fn(async () => {})

    const session = await prepareHarnessWorkspaceSession({
      fs: {
        list,
        materializeSources,
        readFile: vi.fn(async () => bytes("root")),
      },
      startSession,
      tools: {},
    } as never, {
      paths: [],
      session: {
        readBinaryFile: vi.fn(async () => null),
        run: sandboxRun(),
        writeBinaryFile,
      },
      sessionWorkDir: "/work/agent",
    })

    expect(materializeSources).not.toHaveBeenCalled()
    expect(list).not.toHaveBeenCalled()
    expect(writeBinaryFile).not.toHaveBeenCalled()
    expect(startSession).not.toHaveBeenCalled()

    await session.close()
  })

  it("materializes lazy source files before copying them into the harness sandbox", async () => {
    const sourceFile = bytes("Months of Stock\n")
    let materialized = false
    const materializeSources = vi.fn(async () => {
      materialized = true
      return {
        bytes: sourceFile.byteLength,
        directories: 2,
        durationMs: 1,
        files: 1,
        path: "",
        sources: [{ source: "portal", status: "ready" }],
      }
    })
    const list = vi.fn(async () => materialized
      ? [
          { path: "portal", type: "directory" },
          { path: "portal/app", type: "directory" },
          { mediaType: "text/vue", path: "portal/app/OrderSuggestion.vue", type: "file" },
        ]
      : [
          { path: "portal", type: "directory" },
        ])
    const readFile = vi.fn(async (path: string) => {
      if (path === "portal/app/OrderSuggestion.vue") return sourceFile
      throw new Error(`unexpected read ${path}`)
    })
    const writeBinaryFile = vi.fn(async () => {})

    const session = await prepareHarnessWorkspaceSession({
      fs: { list, materializeSources, readFile },
      tools: {},
    } as never, {
      session: {
        run: sandboxRun(),
        writeBinaryFile,
      },
      sessionWorkDir: "/work/agent",
    })

    expect(materializeSources).toHaveBeenCalledWith({ path: "" })
    expect(list).toHaveBeenCalledWith("", { recursive: true })
    expect(writeBinaryFile).toHaveBeenCalledWith({
      abortSignal: undefined,
      content: sourceFile,
      path: "/work/agent/portal/app/OrderSuggestion.vue",
    })

    await session.close()
  })

  it("skips missing selected paths during sandbox materialization", async () => {
    const publicReadme = bytes("# Public\n")
    const stat = vi.fn(async (path: string) => {
      if (path === "public") return { path: "public", type: "directory" }
      throw new Error(`missing ${path}`)
    })
    const list = vi.fn(async () => [
      { path: "public/README.md", type: "file" },
    ])
    const writeBinaryFile = vi.fn(async () => {})

    const session = await prepareHarnessWorkspaceSession({
      fs: {
        list,
        readFile: vi.fn(async () => publicReadme),
        stat,
      },
      tools: {},
    } as never, {
      paths: ["public", ".vitehub/sources/public.json"],
      session: {
        run: sandboxRun(),
        writeBinaryFile,
      },
      sessionWorkDir: "/work/agent",
    })

    expect(stat).toHaveBeenCalledWith("public")
    expect(stat).toHaveBeenCalledWith(".vitehub/sources/public.json")
    expect(list).toHaveBeenCalledWith("public", { recursive: true })
    expect(writeBinaryFile).toHaveBeenCalledWith(expect.objectContaining({
      path: "/work/agent/public/README.md",
    }))

    await session.close()
  })

  it("creates parent directories when a selected path is a file", async () => {
    const readme = bytes("scoped")
    const run = sandboxRun()
    const writeBinaryFile = vi.fn(async () => {})

    const session = await prepareHarnessWorkspaceSession({
      fs: {
        list: vi.fn(async () => {
          throw new Error("root list should not run")
        }),
        readFile: vi.fn(async () => readme),
        stat: vi.fn(async () => ({ mediaType: "text/markdown", path: "docs/README.md", type: "file" })),
      },
      tools: {},
    } as never, {
      paths: ["docs/README.md"],
      session: { run, writeBinaryFile },
      sessionWorkDir: "/work/agent",
    })

    expect(run).toHaveBeenCalledWith({
      abortSignal: undefined,
      command: "mkdir -p '/work/agent/docs'",
    })
    expect(writeBinaryFile).toHaveBeenCalledWith({
      abortSignal: undefined,
      content: readme,
      path: "/work/agent/docs/README.md",
    })

    await session.close()
  })

  it("does not remove synthetic parent directories for selected file paths", async () => {
    const workspaceSession = {
      close: vi.fn(async () => {}),
      commit: vi.fn(async () => {}),
      diff: vi.fn(async () => ({
        entries: [{ path: "docs/README.md", type: "removed" }],
        to: "next",
      })),
      mkdir: vi.fn(async () => {}),
      rm: vi.fn(async () => {}),
      writeFile: vi.fn(async () => {}),
    }

    const session = await prepareHarnessWorkspaceSession({
      fs: {
        list: vi.fn(async () => {
          throw new Error("root list should not run")
        }),
        readFile: vi.fn(async () => bytes("scoped")),
        stat: vi.fn(async () => ({ mediaType: "text/markdown", path: "docs/README.md", type: "file" })),
      },
      startSession: vi.fn(async () => workspaceSession),
      tools: {},
    } as never, {
      paths: ["docs/README.md"],
      session: {
        readBinaryFile: vi.fn(async () => null),
        run: sandboxRun(),
        writeBinaryFile: vi.fn(async () => {}),
      },
      sessionWorkDir: "/work/agent",
    })

    await session.close()

    expect(workspaceSession.rm).toHaveBeenCalledWith("docs/README.md", { force: true })
    expect(workspaceSession.rm).not.toHaveBeenCalledWith("docs", { force: true, recursive: true })
    expect(workspaceSession.commit).toHaveBeenCalledWith({ message: "harness-workspace-session" })
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

  it("rejects out-of-scope harness sandbox changes in the basic Workspace Session", async () => {
    const workspace = createWorkspace({
      ...defineWorkspace({ store: { provider: "memory" } }),
      name: "docs",
    })
    await workspace.mkdir("public")
    await workspace.writeFile("public/README.md", "old")

    const session = await prepareHarnessWorkspaceSession({
      fs: {
        list: workspace.list,
        readFile: workspace.readFile,
        stat: workspace.stat,
      },
      startSession: workspace.startSession,
      tools: {},
    } as never, {
      paths: ["public"],
      session: {
        readBinaryFile: vi.fn(async ({ path }: { path: string }) => bytes(path)),
        run: sandboxRun(["private.txt", "public/README.md"], ["public"]),
        writeBinaryFile: vi.fn(async () => {}),
      },
      sessionWorkDir: "/work/agent",
    })

    await expect(session.close()).rejects.toThrow("outside the session scope")
    await expect(workspace.exists("private.txt")).resolves.toBe(false)
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
