import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it, vi } from "vitest"

import { runWorkspaceDevCli } from "../src/cli.ts"
import { ensureWorkspaceDevToken, workspaceDevHeader, workspaceDevHeaderValue, workspaceDevTokenHeader } from "../src/server.ts"
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
    const stdout = stream()
    const token = await ensureWorkspaceDevToken(rootDir)
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
        stderr: stream(),
        stdout,
      }, { fetch: fetchWorkspaceDev as never })

      expect(exitCode).toBe(0)
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
})
