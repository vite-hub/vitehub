import { gunzipSync } from "node:zlib"
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

function sandboxRun(files: string[] = [], directories: string[] = [], symlinks: string[] = []) {
  return vi.fn(async ({ command }: { command: string }) => {
    if (command.includes("-type d")) return ok(directories.map(path => `./${path}`).join("\n"))
    if (command.includes("-type l")) return ok(symlinks.map(path => `./${path}`).join("\n"))
    if (command.includes("-type f")) return ok(files.map(path => `./${path}`).join("\n"))
    return ok()
  })
}

function expectArchiveWrite(writeBinaryFile: ReturnType<typeof vi.fn>, root = "/work/agent", abortSignal: AbortSignal | undefined = undefined) {
  expect(writeBinaryFile).toHaveBeenCalledWith({
    abortSignal,
    content: expect.any(Uint8Array),
    path: `${root}/.vitehub-workspace.tar.gz`,
  })
}

function expectArchiveExtract(run: ReturnType<typeof vi.fn>, root = "/work/agent") {
  expect(run).toHaveBeenCalledWith({
    abortSignal: undefined,
    command: "tar -xzf '.vitehub-workspace.tar.gz' && rm '.vitehub-workspace.tar.gz'",
    workingDirectory: root,
  })
}

function expectGitBaseline(run: ReturnType<typeof vi.fn>, root = "/work/agent") {
  expect(run).toHaveBeenCalledWith({
    abortSignal: undefined,
    command: "if command -v git >/dev/null 2>&1; then git init -q && git config user.email vitehub@example.invalid && git config user.name ViteHub && git add -A -f && git commit --allow-empty --no-gpg-sign --no-verify -qm workspace-baseline || true; fi",
    workingDirectory: root,
  })
}

function expectWorkDirReset(run: ReturnType<typeof vi.fn>, writeBinaryFile: ReturnType<typeof vi.fn>, root = "/work/agent") {
  const parent = root.replace(/\/[^/]+$/, "") || "/"
  const name = root.split("/").filter(Boolean).at(-1) || root
  expect(writeBinaryFile).toHaveBeenCalledWith({
    abortSignal: undefined,
    content: new Uint8Array(),
    path: `${parent}/.vitehub-reset`,
  })
  expect(run).toHaveBeenCalledWith({
    abortSignal: undefined,
    command: `rm -rf -- '${name}' && mkdir -p -- '${name}' && rm -f -- '.vitehub-reset'`,
    workingDirectory: parent,
  })
}

function archiveEntry(writeBinaryFile: ReturnType<typeof vi.fn>, path: string) {
  const archive = writeBinaryFile.mock.calls.find(([input]) => input.path.endsWith(".vitehub-workspace.tar.gz"))?.[0].content
  if (!archive) throw new Error("missing archive write")
  const tar = gunzipSync(Buffer.from(archive))
  for (let offset = 0; offset < tar.byteLength; offset += 512) {
    const name = tar.subarray(offset, offset + 100).toString().replace(/\0.*$/, "")
    if (!name) break
    const sizeText = tar.subarray(offset + 124, offset + 136).toString().replace(/\0.*$/, "").trim()
    const size = Number.parseInt(sizeText || "0", 8)
    if (name === path) return tar.subarray(offset, offset + 512)
    offset += Math.ceil(size / 512) * 512
  }
  throw new Error(`missing archive entry: ${path}`)
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
    expectWorkDirReset(run, writeBinaryFile)
    expect(readFile).toHaveBeenCalledWith("README.md", { encoding: "binary" })
    expectArchiveWrite(writeBinaryFile)
    expectArchiveExtract(run)
    expectGitBaseline(run)

    await session.close()
  })

  it("refreshes the harness git baseline after support files are written", async () => {
    const run = sandboxRun()
    const writeBinaryFile = vi.fn(async () => {})

    const session = await prepareHarnessWorkspaceSession({
      fs: { list: vi.fn(async () => []), readFile: vi.fn() },
      tools: {},
    } as never, {
      session: { run, writeBinaryFile },
      sessionWorkDir: "/work/agent",
    })

    await session.refreshGitBaseline()

    expect(run).toHaveBeenCalledTimes(3)
    expectGitBaseline(run)

    await session.close()
  })

  it("force-adds materialized files to the harness git baseline", async () => {
    const run = sandboxRun()
    const writeBinaryFile = vi.fn(async () => {})

    const session = await prepareHarnessWorkspaceSession({
      fs: {
        list: vi.fn(async () => [
          { path: ".gitignore", type: "file" },
          { path: "app.log", type: "file" },
        ]),
        readFile: vi.fn(async (path: string) => path === ".gitignore" ? bytes("*.log\n") : bytes("tracked log\n")),
      },
      tools: {},
    } as never, {
      session: { run, writeBinaryFile },
      sessionWorkDir: "/work/agent",
    })

    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      command: expect.stringContaining("git add -A -f"),
    }))

    await session.close()
  })

  it("preserves GitHub symlinks in the harness archive", async () => {
    const list = vi.fn(async () => [
      { path: "AGENTS.md", type: "file" },
      { metadata: { gitMode: "120000" }, path: "CLAUDE.md", type: "file" },
    ])
    const readFile = vi.fn(async (path: string) => path === "CLAUDE.md" ? bytes("AGENTS.md") : bytes("# Agents\n"))
    const run = sandboxRun(["AGENTS.md", "CLAUDE.md"])
    const writeBinaryFile = vi.fn(async () => {})

    const session = await prepareHarnessWorkspaceSession({
      fs: { list, readFile },
      tools: {},
    } as never, {
      session: { readBinaryFile: vi.fn(async () => null), run, writeBinaryFile },
      sessionWorkDir: "/work/agent",
    })

    const header = archiveEntry(writeBinaryFile, "CLAUDE.md")
    expect(String.fromCharCode(header[156]!)).toBe("2")
    expect(header.subarray(157, 257).toString().replace(/\0.*$/, "")).toBe("AGENTS.md")

    await session.close()
  })

  it("uses GitHub symlink target metadata when readFile resolves the target content", async () => {
    const list = vi.fn(async () => [
      { path: "AGENTS.md", type: "file" },
      { metadata: { gitMode: "120000", symlinkTarget: "AGENTS.md" }, path: "CLAUDE.md", type: "file" },
    ])
    const readFile = vi.fn(async () => bytes("# Agents\n"))
    const run = sandboxRun(["AGENTS.md", "CLAUDE.md"])
    const writeBinaryFile = vi.fn(async () => {})

    const session = await prepareHarnessWorkspaceSession({
      fs: { list, readFile },
      tools: {},
    } as never, {
      session: { readBinaryFile: vi.fn(async () => null), run, writeBinaryFile },
      sessionWorkDir: "/work/agent",
    })

    const header = archiveEntry(writeBinaryFile, "CLAUDE.md")
    expect(String.fromCharCode(header[156]!)).toBe("2")
    expect(header.subarray(157, 257).toString().replace(/\0.*$/, "")).toBe("AGENTS.md")

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
    expectArchiveWrite(writeBinaryFile)
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
    const run = sandboxRun()

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
        run,
        writeBinaryFile,
      },
      sessionWorkDir: "/work/agent",
    })

    expect(materializeSources).not.toHaveBeenCalled()
    expect(list).not.toHaveBeenCalled()
    expectWorkDirReset(run, writeBinaryFile)
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
    expectArchiveWrite(writeBinaryFile)

    await session.close()
  })

  it("passes materialization progress and abort signals to source materialization", async () => {
    const abortController = new AbortController()
    const onMaterializeProgress = vi.fn()
    const sourceFile = bytes("Details\n")
    const materializeSources = vi.fn(async (options?: Record<string, unknown>) => {
      await (options?.onProgress as ((event: unknown) => Promise<void> | void) | undefined)?.({
        mountPath: "portal",
        path: options?.path,
        source: "portal",
        status: "started",
      })
      return {
        bytes: sourceFile.byteLength,
        directories: 1,
        durationMs: 1,
        files: 1,
        path: options?.path || "",
        sources: [{ mountPath: "portal", source: "portal", status: "ready" }],
      }
    })
    const stat = vi.fn(async () => ({ path: "portal", type: "directory" }))
    const list = vi.fn(async () => [
      { path: "portal", type: "directory" },
      { mediaType: "text/markdown", path: "portal/details.md", type: "file" },
    ])
    const readFile = vi.fn(async () => sourceFile)
    const writeBinaryFile = vi.fn(async () => {})

    const session = await prepareHarnessWorkspaceSession({
      fs: { list, materializeSources, readFile, stat },
      tools: {},
    } as never, {
      abortSignal: abortController.signal,
      onMaterializeProgress,
      paths: ["portal"],
      session: {
        run: sandboxRun(),
        writeBinaryFile,
      },
      sessionWorkDir: "/work/agent",
    })

    expect(materializeSources).toHaveBeenCalledWith({
      abortSignal: abortController.signal,
      onProgress: onMaterializeProgress,
      path: "portal",
    })
    expect(onMaterializeProgress).toHaveBeenCalledWith(expect.objectContaining({
      mountPath: "portal",
      path: "portal",
      source: "portal",
      status: "started",
    }))
    expect(stat).toHaveBeenCalledWith("portal")
    expect(list).toHaveBeenCalledWith("portal", { recursive: true })
    expectArchiveWrite(writeBinaryFile, "/work/agent", abortController.signal)

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
    expectArchiveWrite(writeBinaryFile)

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

    expectArchiveWrite(writeBinaryFile)
    expectArchiveExtract(run)

    await session.close()
  })

  it("does not recreate synthetic parent directories for unchanged selected file paths", async () => {
    const workspaceSession = {
      close: vi.fn(async () => {}),
      commit: vi.fn(async () => {}),
      diff: vi.fn(async () => ({
        entries: [],
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
        readBinaryFile: vi.fn(async () => bytes("scoped")),
        run: sandboxRun(["docs/README.md"], ["docs"]),
        writeBinaryFile: vi.fn(async () => {}),
      },
      sessionWorkDir: "/work/agent",
    })

    await session.close()

    expect(workspaceSession.rm).not.toHaveBeenCalledWith("docs/README.md", { force: true })
    expect(workspaceSession.rm).not.toHaveBeenCalledWith("docs", { force: true, recursive: true })
    expect(workspaceSession.mkdir).not.toHaveBeenCalledWith("docs", { recursive: true })
    expect(workspaceSession.commit).not.toHaveBeenCalled()
  })

  it("does not remove synthetic parent directories for removed selected file paths", async () => {
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
    const writeBackDiff = {
      entries: [{ path: "README.md", type: "modified" as const }],
      to: "next",
    }
    const order: string[] = []
    const workspaceSession = {
      close: vi.fn(async () => {}),
      commit: vi.fn(async () => { order.push("commit") }),
      diff: vi.fn(async () => writeBackDiff),
      mkdir: vi.fn(async () => {}),
      rm: vi.fn(async () => {}),
      writeFile: vi.fn(async () => {}),
    }
    const onWriteBack = vi.fn(async () => { order.push("write-back") })
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
      definition: {
        name: "docs",
        rules: {
          "**": { commit: "chore: update docs" },
        },
      },
      onWriteBack,
      sessionWorkDir: "/work/agent",
    })

    await session.close()

    expect(startSession).toHaveBeenCalledOnce()
    expect(run).toHaveBeenCalledWith({
      abortSignal: undefined,
      command: "find . -type f -print",
      workingDirectory: "/work/agent",
    })
    expect(run).toHaveBeenCalledWith({
      abortSignal: undefined,
      command: "find . -type l -print",
      workingDirectory: "/work/agent",
    })
    expect(workspaceSession.writeFile).toHaveBeenCalledWith("README.md", updated, { mediaType: "text/markdown" })
    expect(workspaceSession.writeFile).toHaveBeenCalledWith("new.json", added, { mediaType: "application/json" })
    expect(onWriteBack).toHaveBeenCalledWith(writeBackDiff)
    expect(order).toEqual(["commit", "write-back"])
    expect(workspaceSession.commit).toHaveBeenCalledWith({ message: "chore: update docs" })
    expect(workspaceSession.close).toHaveBeenCalledOnce()
  })

  it.each([[false], [null], [undefined]] as const)("skips harness commits when the commit callback returns %s", async (commitPlan) => {
    const updated = bytes("new")
    const diff = {
      entries: [{ path: "README.md", type: "modified" }],
      to: "next",
    }
    const workspaceSession = {
      close: vi.fn(async () => {}),
      commit: vi.fn(async () => {}),
      diff: vi.fn(async () => diff),
      mkdir: vi.fn(async () => {}),
      rm: vi.fn(async () => {}),
      writeFile: vi.fn(async () => {}),
    }
    const commit = vi.fn(() => commitPlan)
    const onWriteBack = vi.fn(async () => {})

    const session = await prepareHarnessWorkspaceSession({
      fs: {
        list: vi.fn(async () => [{ mediaType: "text/markdown", path: "README.md", type: "file" }]),
        readFile: vi.fn(async () => bytes("old")),
      },
      startSession: vi.fn(async () => workspaceSession),
      tools: {},
    } as never, {
      commit,
      onWriteBack,
      session: {
        readBinaryFile: vi.fn(async () => updated),
        run: sandboxRun(["README.md"]),
        writeBinaryFile: vi.fn(async () => {}),
      },
      sessionWorkDir: "/work/agent",
    })

    await session.close()

    expect(workspaceSession.writeFile).toHaveBeenCalledWith("README.md", updated, { mediaType: "text/markdown" })
    expect(commit).toHaveBeenCalledWith(diff)
    expect(workspaceSession.commit).not.toHaveBeenCalled()
    expect(onWriteBack).not.toHaveBeenCalled()
    expect(workspaceSession.close).toHaveBeenCalledOnce()
  })

  it("commits harness symlinks as Git symlink blobs", async () => {
    const workspaceSession = {
      close: vi.fn(async () => {}),
      commit: vi.fn(async () => {}),
      diff: vi.fn(async () => ({
        entries: [{ path: "linked.txt", type: "added" }],
        to: "next",
      })),
      mkdir: vi.fn(async () => {}),
      rm: vi.fn(async () => {}),
      writeFile: vi.fn(async () => {}),
    }
    const readBinaryFile = vi.fn(async ({ path }: { path: string }) =>
      path.endsWith("linked.txt") ? bytes("target bytes") : bytes("result"))
    const run = vi.fn(async ({ command }: { command: string }) => {
      if (command.includes("-type d")) return ok()
      if (command.includes("-type f")) return ok("./result.txt")
      if (command.includes("-type l")) return ok("./CLAUDE.md\n./linked.txt")
      if (command === "readlink -- 'CLAUDE.md'") return ok("NEXT.md\n")
      if (command === "readlink -- 'linked.txt'") return ok("target.txt\n")
      return ok()
    })

    const session = await prepareHarnessWorkspaceSession({
      fs: {
        list: vi.fn(async () => [
          { metadata: { gitMode: "120000" }, path: "CLAUDE.md", type: "file" },
        ]),
        readFile: vi.fn(async () => bytes("AGENTS.md")),
      },
      startSession: vi.fn(async () => workspaceSession),
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

    expect(readBinaryFile).not.toHaveBeenCalledWith({ abortSignal: undefined, path: "/work/agent/linked.txt" })
    expect(workspaceSession.writeFile).toHaveBeenCalledWith("result.txt", bytes("result"), { mediaType: "text/plain" })
    expect(workspaceSession.writeFile).toHaveBeenCalledWith("CLAUDE.md", bytes("NEXT.md"), { metadata: { gitMode: "120000" } })
    expect(workspaceSession.writeFile).toHaveBeenCalledWith("linked.txt", bytes("target.txt"), { metadata: { gitMode: "120000" } })
    expect(workspaceSession.commit).toHaveBeenCalledWith({ message: "harness-workspace-session" })
  })

  it("commits regular files that replace initial harness symlinks", async () => {
    const workspaceSession = {
      close: vi.fn(async () => {}),
      commit: vi.fn(async () => {}),
      diff: vi.fn(async () => ({
        entries: [{ path: "CLAUDE.md", type: "modified" }],
        to: "next",
      })),
      mkdir: vi.fn(async () => {}),
      rm: vi.fn(async () => {}),
      writeFile: vi.fn(async () => {}),
    }
    const replacement = bytes("# Local instructions\n")

    const session = await prepareHarnessWorkspaceSession({
      fs: {
        list: vi.fn(async () => [
          { path: "AGENTS.md", type: "file" },
          { metadata: { gitMode: "120000" }, path: "CLAUDE.md", type: "file" },
        ]),
        readFile: vi.fn(async (path: string) => path === "CLAUDE.md" ? bytes("AGENTS.md") : bytes("# Agents\n")),
      },
      startSession: vi.fn(async () => workspaceSession),
      tools: {},
    } as never, {
      session: {
        readBinaryFile: vi.fn(async ({ path }: { path: string }) =>
          path.endsWith("CLAUDE.md") ? replacement : bytes("# Agents\n")),
        run: sandboxRun(["AGENTS.md", "CLAUDE.md"]),
        writeBinaryFile: vi.fn(async () => {}),
      },
      sessionWorkDir: "/work/agent",
    })

    await session.close()

    expect(workspaceSession.writeFile).toHaveBeenCalledWith("CLAUDE.md", replacement, { mediaType: "text/markdown" })
    expect(workspaceSession.commit).toHaveBeenCalledWith({ message: "harness-workspace-session" })
  })

  it("does not recreate unchanged initial directories during write-back", async () => {
    const initial = bytes("unchanged")
    const summary = bytes("summary")
    const workspaceSession = {
      close: vi.fn(async () => {}),
      commit: vi.fn(async () => {}),
      diff: vi.fn(async () => ({
        entries: [{ path: "summary.md", type: "added" }],
        to: "next",
      })),
      mkdir: vi.fn(async () => {}),
      rm: vi.fn(async () => {}),
      writeFile: vi.fn(async () => {}),
    }

    const session = await prepareHarnessWorkspaceSession({
      fs: {
        list: vi.fn(async () => [
          { path: "airtable-tasks", type: "directory" },
          { mediaType: "text/markdown", path: "airtable-tasks/task.md", type: "file" },
        ]),
        readFile: vi.fn(async () => initial),
      },
      startSession: vi.fn(async () => workspaceSession),
      tools: {},
    } as never, {
      session: {
        readBinaryFile: vi.fn(async ({ path }: { path: string }) =>
          path.endsWith("airtable-tasks/task.md") ? initial : summary),
        run: sandboxRun(["airtable-tasks/task.md", "summary.md"], ["airtable-tasks"]),
        writeBinaryFile: vi.fn(async () => {}),
      },
      sessionWorkDir: "/work/agent",
    })

    await session.close()

    expect(workspaceSession.mkdir).not.toHaveBeenCalledWith("airtable-tasks", expect.anything())
    expect(workspaceSession.writeFile).not.toHaveBeenCalledWith("airtable-tasks/task.md", expect.anything(), expect.anything())
    expect(workspaceSession.writeFile).toHaveBeenCalledWith("summary.md", summary, { mediaType: "text/markdown" })
    expect(workspaceSession.commit).toHaveBeenCalledWith({ message: "harness-workspace-session" })
  })

  it("does not write ignored harness support paths back to Workspace", async () => {
    const workspaceSession = {
      close: vi.fn(async () => {}),
      commit: vi.fn(async () => {}),
      diff: vi.fn(async () => ({
        entries: [{ path: "summary.md", type: "added" }],
        to: "next",
      })),
      mkdir: vi.fn(async () => {}),
      rm: vi.fn(async () => {}),
      writeFile: vi.fn(async () => {}),
    }

    const session = await prepareHarnessWorkspaceSession({
      fs: {
        list: vi.fn(async () => [
          { mediaType: "text/markdown", path: "AGENTS.md", type: "file" },
          { path: "notes", type: "directory" },
          { mediaType: "text/markdown", path: "notes/keep.md", type: "file" },
        ]),
        readFile: vi.fn(async () => bytes("old instructions")),
      },
      startSession: vi.fn(async () => workspaceSession),
      tools: {},
    } as never, {
      ignoreWriteBackPaths: ["AGENTS.md", "CLAUDE.md", "notes"],
      session: {
        readBinaryFile: vi.fn(async ({ path }: { path: string }) => bytes(path)),
        run: sandboxRun(
          [".git/config", "AGENTS.md", "CLAUDE.md", "notes/generated.md", "summary.md"],
          [".git", ".git/refs", "notes"],
        ),
        writeBinaryFile: vi.fn(async () => {}),
      },
      sessionWorkDir: "/work/agent",
    })

    await session.close()

    expect(workspaceSession.writeFile).toHaveBeenCalledWith("summary.md", bytes("/work/agent/summary.md"), { mediaType: "text/markdown" })
    expect(workspaceSession.writeFile).not.toHaveBeenCalledWith("AGENTS.md", expect.anything(), expect.anything())
    expect(workspaceSession.writeFile).not.toHaveBeenCalledWith("CLAUDE.md", expect.anything(), expect.anything())
    expect(workspaceSession.writeFile).not.toHaveBeenCalledWith(".git/config", expect.anything(), expect.anything())
    expect(workspaceSession.writeFile).not.toHaveBeenCalledWith("notes/generated.md", expect.anything(), expect.anything())
    expect(workspaceSession.rm).not.toHaveBeenCalledWith("notes/keep.md", expect.anything())
    expect(workspaceSession.mkdir).not.toHaveBeenCalledWith(".git", expect.anything())
    expect(workspaceSession.mkdir).not.toHaveBeenCalledWith("notes", expect.anything())
    expect(workspaceSession.commit).toHaveBeenCalledWith({ message: "harness-workspace-session" })
  })

  it("does not write new parent directories created only for ignored paths", async () => {
    const workspaceSession = {
      close: vi.fn(async () => {}),
      commit: vi.fn(async () => {}),
      diff: vi.fn(async () => ({ entries: [], to: "next" })),
      mkdir: vi.fn(async () => {}),
      rm: vi.fn(async () => {}),
      writeFile: vi.fn(async () => {}),
    }
    const session = await prepareHarnessWorkspaceSession({
      fs: { list: vi.fn(async () => []), readFile: vi.fn() },
      startSession: vi.fn(async () => workspaceSession),
      tools: {},
    } as never, {
      ignoreWriteBackPaths: ["skills/review"],
      session: {
        readBinaryFile: vi.fn(async ({ path }: { path: string }) => bytes(path)),
        run: sandboxRun(["skills/review/SKILL.md"], ["skills", "skills/review"]),
        writeBinaryFile: vi.fn(async () => {}),
      },
      sessionWorkDir: "/work/agent",
    })

    await session.close()

    expect(workspaceSession.mkdir).not.toHaveBeenCalled()
    expect(workspaceSession.writeFile).not.toHaveBeenCalled()
  })

  it("does not remove parents of ignored paths", async () => {
    const workspaceSession = {
      close: vi.fn(async () => {}),
      commit: vi.fn(async () => {}),
      diff: vi.fn(async () => ({ entries: [], to: "next" })),
      mkdir: vi.fn(async () => {}),
      rm: vi.fn(async () => {}),
      writeFile: vi.fn(async () => {}),
    }
    const session = await prepareHarnessWorkspaceSession({
      fs: {
        list: vi.fn(async () => [
          { path: "skills", type: "directory" },
          { path: "skills/review", type: "directory" },
          { mediaType: "text/markdown", path: "skills/review/SKILL.md", type: "file" },
        ]),
        readFile: vi.fn(async () => bytes("review")),
      },
      startSession: vi.fn(async () => workspaceSession),
      tools: {},
    } as never, {
      ignoreWriteBackPaths: ["skills/review"],
      session: {
        readBinaryFile: vi.fn(),
        run: sandboxRun([], []),
        writeBinaryFile: vi.fn(async () => {}),
      },
      sessionWorkDir: "/work/agent",
    })

    await session.close()

    expect(workspaceSession.rm).not.toHaveBeenCalled()
  })

  it("leaves harness changes uncommitted when the commit callback skips them", async () => {
    const diff = {
      entries: [{ path: "summary.md", type: "added" as const }],
      to: "next",
    }
    const workspaceSession = {
      close: vi.fn(async () => {}),
      commit: vi.fn(async () => {}),
      diff: vi.fn(async () => diff),
      mkdir: vi.fn(async () => {}),
      rm: vi.fn(async () => {}),
      writeFile: vi.fn(async () => {}),
    }
    const commit = vi.fn(() => false as const)

    const session = await prepareHarnessWorkspaceSession({
      fs: {
        list: vi.fn(async () => []),
        readFile: vi.fn(async () => bytes("")),
      },
      startSession: vi.fn(async () => workspaceSession),
      tools: {},
    } as never, {
      commit,
      session: {
        readBinaryFile: vi.fn(async ({ path }: { path: string }) => bytes(path)),
        run: sandboxRun(["summary.md"]),
        writeBinaryFile: vi.fn(async () => {}),
      },
      sessionWorkDir: "/work/agent",
    })

    await session.close()

    expect(commit).toHaveBeenCalledWith(diff)
    expect(workspaceSession.writeFile).toHaveBeenCalledWith("summary.md", bytes("/work/agent/summary.md"), { mediaType: "text/markdown" })
    expect(workspaceSession.commit).not.toHaveBeenCalled()
  })

  it("commits generated files selected by missing Workspace Session paths", async () => {
    const workspace = createWorkspace({
      ...defineWorkspace({
        store: { provider: "memory" },
      }),
      name: "docs",
    })
    await workspace.snapshot({ name: "baseline" })

    const session = await prepareHarnessWorkspaceSession({
      fs: {
        list: workspace.list.bind(workspace),
        materializeSources: workspace.materializeSources,
        readFile: workspace.readFile.bind(workspace),
        stat: workspace.stat.bind(workspace),
      },
      startSession: workspace.startSession,
      tools: {},
    } as never, {
      paths: ["summary.md"],
      session: {
        readBinaryFile: vi.fn(async () => bytes("summary")),
        run: sandboxRun(["summary.md"]),
        writeBinaryFile: vi.fn(async () => {}),
      },
      sessionWorkDir: "/work/agent",
    })

    await session.close()

    await expect(workspace.readFile("summary.md")).resolves.toBe("summary")
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
        list: workspace.list.bind(workspace),
        readFile: workspace.readFile.bind(workspace),
        stat: workspace.stat.bind(workspace),
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
    expect(workspaceSession.mkdir).not.toHaveBeenCalledWith("empty", expect.anything())
    expect(workspaceSession.mkdir).toHaveBeenCalledWith("node", { recursive: true })
    expect(workspaceSession.writeFile).toHaveBeenCalledWith("node/result.txt", bytes("/work/agent/node/result.txt"), { mediaType: "text/plain" })
    expect(workspaceSession.commit).toHaveBeenCalledWith({ message: "harness-workspace-session" })
  })
})
