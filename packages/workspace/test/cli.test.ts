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
        features: [expect.objectContaining({ name: "dev" })],
        name: "workspace",
      }],
    })
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
          return Response.json({
            args: ["-e", "console.log(process.argv[1])", "hello world", "--timeout=30000"],
            command: "node",
            exitCode: 0,
            stderr: "",
            stdout: "ok\n",
          })
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
        "docs",
        "node",
        "-e",
        "console.log(process.argv[1])",
        "hello world",
        "--timeout=30000",
      ], {
        cwd: rootDir,
        env: {},
        rootDir,
        stderr,
        stdout,
      }, { fetch: fetchWorkspaceDev as never })

      expect(exitCode).toBe(0)
      expect(stderr.output()).toBe("[vitehub] Workspace command started; first run may materialize sources.\n")
      expect(stdout.output()).toBe("ok\n")
      const [get, post] = fetchWorkspaceDev.mock.calls
      expect(String(get?.[0])).toBe("http://127.0.0.1:4321/__vitehub/workspace/dev")
      expect(get?.[1]?.headers).toMatchObject({
        accept: "application/json",
        [workspaceDevHeader]: workspaceDevHeaderValue,
      })
      expect(post?.[1]?.headers).toMatchObject({
        "content-type": "application/json",
        [workspaceDevHeader]: workspaceDevHeaderValue,
        [workspaceDevTokenHeader]: token,
      })
      expect(JSON.parse(String(post?.[1]?.body))).toEqual({
        workspaceCommand: {
          args: ["-e", "console.log(process.argv[1])", "hello world", "--timeout=30000"],
          command: "node",
          timeout: 10000,
          workspace: "docs",
        },
      })
    }
    finally {
      await rm(rootDir, { force: true, recursive: true })
    }
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
})
