import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it, vi } from "vitest"

import { runWorkspaceDevCli } from "../src/cli.ts"
import { readWorkspaceDevToken, refreshWorkspaceDevToken, runWorkspaceDevCommand, workspaceDevHeader, workspaceDevHeaderValue, workspaceDevTokenHeader } from "../src/server.ts"
import { hubWorkspace } from "../src/vite.ts"

function stream() {
  let value = ""
  return {
    output: () => value,
    write(chunk: string | Uint8Array) {
      value += String(chunk)
      return true
    },
  }
}

function ndjsonResponse(lines: unknown[]) {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`))
      controller.close()
    },
  }), {
    headers: { "content-type": "application/x-ndjson; charset=utf-8" },
  })
}

describe("workspace CLI", () => {
  it("keeps the private Workspace Dev token outside the Vite root", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-workspace-token-"))
    try {
      const legacyFile = join(rootDir, ".vitehub", "dev-token")
      await mkdir(join(rootDir, ".vitehub"), { recursive: true })
      await writeFile(legacyFile, "stale\n", "utf8")

      const token = await refreshWorkspaceDevToken(rootDir)

      await expect(readWorkspaceDevToken(rootDir)).resolves.toBe(token)
      await expect(readFile(legacyFile, "utf8")).rejects.toThrow()
    }
    finally {
      await rm(rootDir, { force: true, recursive: true })
    }
  })

  it("keeps private Workspace Dev tokens server-specific for one project root", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-workspace-token-server-"))
    try {
      const first = await refreshWorkspaceDevToken(rootDir, { serverId: "pid-1:5173" })
      const second = await refreshWorkspaceDevToken(rootDir, { serverId: "pid-2:5174" })

      expect(first).not.toBe(second)
      await expect(readWorkspaceDevToken(rootDir, { serverId: "pid-1:5173" })).resolves.toBe(first)
      await expect(readWorkspaceDevToken(rootDir, { serverId: "pid-2:5174" })).resolves.toBe(second)
    }
    finally {
      await rm(rootDir, { force: true, recursive: true })
    }
  })

  it("contributes the Workspace CLI namespace from plain hubWorkspace", async () => {
    await expect(hubWorkspace().vitehub?.cli?.()).resolves.toEqual({
      namespaces: [{
        description: "Workspace development workflows.",
        features: [expect.objectContaining({
          name: "dev",
          usage: "vitehub workspace dev <workspace> [exec <command...>]",
        })],
        name: "workspace",
      }],
    })
  })

  it("prints Workspace Dev exec usage", async () => {
    const stderr = stream()
    const stdout = stream()

    const exitCode = await runWorkspaceDevCli(["--help"], {
      cwd: process.cwd(),
      env: {},
      rootDir: process.cwd(),
      stderr,
      stdout,
    })

    expect(exitCode).toBe(0)
    expect(stderr.output()).toBe("")
    expect(stdout.output()).toContain("Usage: vitehub workspace dev <workspace> [exec <command...>]")
    expect(stdout.output()).toContain("Omit exec to open the interactive command loop.")
  })

  it("opens the Workspace Dev command loop when no command is provided", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-workspace-cli-loop-"))
    const stderr = stream()
    const stdout = stream()
    const close = vi.fn()
    const question = vi.fn(async () => ".exit")
    const originalIsTTY = process.stdin.isTTY
    vi.doMock("node:readline/promises", () => ({
      createInterface: vi.fn(() => ({ close, question })),
    }))
    process.stdin.isTTY = true
    try {
      const fetchWorkspaceDev = vi.fn(async () => Response.json({
        root: rootDir,
        workspaces: [{ name: "docs" }],
      }))

      const exitCode = await runWorkspaceDevCli([
        "--url",
        "http://127.0.0.1:4321",
        "docs",
      ], {
        cwd: rootDir,
        env: {},
        rootDir,
        stderr,
        stdout,
      }, { fetch: fetchWorkspaceDev as never })

      expect(exitCode).toBe(0)
      expect(stderr.output()).toBe("")
      expect(stdout.output()).toContain("Connected to docs at http://127.0.0.1:4321\n")
      expect(question).toHaveBeenCalledWith("> ")
      expect(close).toHaveBeenCalledOnce()
      expect(fetchWorkspaceDev).toHaveBeenCalledOnce()
    }
    finally {
      process.stdin.isTTY = originalIsTTY
      vi.doUnmock("node:readline/promises")
      await rm(rootDir, { force: true, recursive: true })
    }
  })

  it("runs Workspace Dev commands through the Workspace dev endpoint", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-workspace-cli-"))
    const stderr = stream()
    const stdout = stream()
    const tokenServerId = "pid-1:4321"
    const token = await refreshWorkspaceDevToken(rootDir, { serverId: tokenServerId })
    try {
      const fetchWorkspaceDev = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") {
          return ndjsonResponse([
            {
              event: {
                id: "workspace.dev.materialize",
                label: "Materializing workspace sources",
                status: "started",
              },
              type: "progress",
            },
            {
              event: {
                data: { bytes: 12, files: 1 },
                id: "workspace.dev.materialize.docs",
                label: "Materializing source docs",
                status: "updating",
              },
              type: "progress",
            },
            {
              result: {
                args: ["README.md"],
                command: "cat",
                exitCode: 0,
                stderr: "",
                stdout: "ok\n",
              },
              type: "result",
            },
          ])
        }
        return Response.json({
          root: rootDir,
          workspaceDevTokenServerId: tokenServerId,
          workspaces: [{ name: "docs" }],
        })
      })

      const exitCode = await runWorkspaceDevCli([
        "--url",
        "http://127.0.0.1:4321",
        "--timeout",
        "10000",
        "--path",
        "AGENTS.md",
        "--path=backlog",
        "docs",
        "exec",
        "cat",
        "README.md",
      ], {
        cwd: rootDir,
        env: {},
        rootDir,
        stderr,
        stdout,
      }, { fetch: fetchWorkspaceDev as never })

      expect(exitCode).toBe(0)
      expect(stderr.output()).toContain("[workspace] command started; first run may materialize sources.\n")
      expect(stderr.output()).toContain("[workspace] Materializing workspace sources...\n")
      expect(stderr.output()).toContain("[workspace] Materializing source docs: 1 file, 12 bytes\n")
      expect(stderr.output()).toContain("[workspace] command completed")
      expect(stdout.output()).toBe("ok\n")
      const [get, post] = fetchWorkspaceDev.mock.calls
      expect(String(get?.[0])).toBe("http://127.0.0.1:4321/__vitehub/workspace/dev")
      expect(get?.[1]?.headers).toMatchObject({
        accept: "application/json",
        [workspaceDevHeader]: workspaceDevHeaderValue,
      })
      expect(post?.[1]?.headers).toMatchObject({
        accept: "application/x-ndjson, application/json",
        "content-type": "application/json",
        [workspaceDevHeader]: workspaceDevHeaderValue,
        [workspaceDevTokenHeader]: token,
      })
      expect(JSON.parse(String(post?.[1]?.body))).toEqual({
        workspaceCommand: {
          args: ["README.md"],
          command: "cat",
          paths: ["AGENTS.md", "backlog"],
          timeout: 10000,
          workspace: "docs",
        },
      })
    }
    finally {
      await rm(rootDir, { force: true, recursive: true })
    }
  })

  it("rejects bare Workspace Dev command args with exec guidance", async () => {
    const stderr = stream()
    const stdout = stream()
    const fetchWorkspaceDev = vi.fn()

    const exitCode = await runWorkspaceDevCli(["docs", "cat", "README.md"], {
      cwd: process.cwd(),
      env: {},
      rootDir: process.cwd(),
      stderr,
      stdout,
    }, { fetch: fetchWorkspaceDev as never })

    expect(exitCode).toBe(1)
    expect(fetchWorkspaceDev).not.toHaveBeenCalled()
    expect(stderr.output()).toContain("Unexpected argument: cat. Use exec <command...> for one-shot commands.")
    expect(stdout.output()).toContain("Usage: vitehub workspace dev <workspace> [exec <command...>]")
  })

  it("reports Workspace Dev preparation progress while starting sessions", async () => {
    const progress: unknown[] = []
    const exec = vi.fn(async () => ({
      exitCode: 0,
      stderr: "",
      stdout: "ok\n",
    }))
    const diff = vi.fn(async () => ({ entries: [] }))
    const close = vi.fn(async () => {})
    const materializeSources = vi.fn(async (options?: { onProgress?: (event: unknown) => void | Promise<void>, path?: string }) => {
      await options?.onProgress?.({
        bytes: 3,
        files: 1,
        mountPath: "docs",
        path: options.path || "",
        source: "docs",
        status: "updating",
      })
      return { bytes: 3, directories: 1, durationMs: 1, files: 1, path: options?.path || "", sources: [] }
    })
    const workspace = {
      materializeSources,
      startSession: vi.fn(async () => ({ close, diff, exec })),
    }

    await expect(runWorkspaceDevCommand({
      command: "echo ok",
      onProgress: (event) => {
        progress.push(event)
      },
      paths: ["docs/README.md"],
      workspace: workspace as never,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "ok\n",
    })

    expect(materializeSources).toHaveBeenCalledWith(expect.objectContaining({
      path: "docs/README.md",
    }))
    expect(workspace.startSession).toHaveBeenCalledWith({ paths: ["docs/README.md"] })
    expect(progress).toEqual([
      expect.objectContaining({ id: "workspace.dev.materialize", status: "started" }),
      expect.objectContaining({ data: expect.objectContaining({ source: "docs" }), id: "workspace.dev.materialize.docs", status: "updating" }),
      expect.objectContaining({ id: "workspace.dev.materialize", status: "completed" }),
      expect.objectContaining({ id: "workspace.dev.start-session", status: "started" }),
      expect.objectContaining({ id: "workspace.dev.start-session", status: "completed" }),
    ])
  })

  it("uses the portable Workspace shell for string Workspace Dev commands", async () => {
    const exec = vi.fn(async () => ({
      exitCode: 0,
      stderr: "",
      stdout: "ok\n",
    }))
    const diff = vi.fn(async () => ({ entries: [] }))
    const commit = vi.fn(async () => {})
    const close = vi.fn(async () => {})
    const workspace = {
      startSession: vi.fn(async () => ({ close, commit, diff, exec })),
    }

    await expect(runWorkspaceDevCommand({
      command: "echo ok",
      workspace: workspace as never,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "ok\n",
    })

    expect(exec).toHaveBeenCalledWith("sh", ["-lc", "echo ok"], {
      abortSignal: undefined,
      timeout: undefined,
    })
    expect(diff).toHaveBeenCalledOnce()
    expect(commit).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce()
  })

  it("commits changed Workspace Dev command sessions", async () => {
    const exec = vi.fn(async () => ({
      exitCode: 0,
      stderr: "",
      stdout: "ok\n",
    }))
    const diff = vi.fn(async () => ({ entries: [{ path: "README.md" }] }))
    const commit = vi.fn(async () => {})
    const close = vi.fn(async () => {})
    const workspace = {
      startSession: vi.fn(async () => ({ close, commit, diff, exec })),
    }

    await expect(runWorkspaceDevCommand({
      command: "echo ok > README.md",
      workspace: workspace as never,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "ok\n",
    })

    expect(diff).toHaveBeenCalledOnce()
    expect(commit).toHaveBeenCalledWith({ message: "workspace dev command" })
    expect(close).toHaveBeenCalledOnce()
  })

  it("commits changed Workspace Dev command sessions for definitions without commit rules", async () => {
    const exec = vi.fn(async () => ({
      exitCode: 0,
      stderr: "",
      stdout: "ok\n",
    }))
    const diff = vi.fn(async () => ({ entries: [{ path: "README.md" }] }))
    const commit = vi.fn(async () => {})
    const close = vi.fn(async () => {})
    const workspace = {
      startSession: vi.fn(async () => ({ close, commit, diff, exec })),
    }

    await expect(runWorkspaceDevCommand({
      command: "echo ok > README.md",
      definition: {
        name: "docs",
        rules: {
          "**": { write: true },
        },
      },
      workspace: workspace as never,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "ok\n",
    })

    expect(diff).toHaveBeenCalledOnce()
    expect(commit).toHaveBeenCalledWith({ message: "workspace dev command" })
    expect(close).toHaveBeenCalledOnce()
  })

  it("uses Workspace rules for changed Workspace Dev command commits", async () => {
    const exec = vi.fn(async () => ({
      exitCode: 0,
      stderr: "",
      stdout: "ok\n",
    }))
    const diff = vi.fn(async () => ({ entries: [{ path: "trazas/note.md" }] }))
    const commit = vi.fn(async () => {})
    const close = vi.fn(async () => {})
    const workspace = {
      startSession: vi.fn(async () => ({ close, commit, diff, exec })),
    }

    await expect(runWorkspaceDevCommand({
      command: "echo ok > trazas/note.md",
      definition: {
        name: "bitacora",
        rules: {
          "trazas/**": { commit: "chore(bitacora): update traces" },
        },
      },
      workspace: workspace as never,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "ok\n",
    })

    expect(diff).toHaveBeenCalledOnce()
    expect(commit).toHaveBeenCalledWith({ message: "chore(bitacora): update traces" })
    expect(close).toHaveBeenCalledOnce()
  })

  it("requires an explicit Box session host for Workspace Dev commands", async () => {
    const workspace = `workspace-dev-${Math.random().toString(36).slice(2)}`

    await expect(runWorkspaceDevCommand({
      command: "printf ok > README.md",
      definition: {
        name: workspace,
        rules: {
          "**": { commit: "chore: update workspace" },
        },
        store: { provider: "memory" },
      },
      workspace,
    })).rejects.toThrow("requires a Box session host")
  })
})
