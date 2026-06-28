import { describe, expect, it, vi } from "vitest"

import { runWorkspaceDevCli } from "../src/cli.ts"
import { workspaceDevHeader, workspaceDevHeaderValue } from "../src/server.ts"
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
    const stdout = stream()
    const fetchWorkspaceDev = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        return Response.json({
          args: ["-lc", "pnpm test"],
          command: "bash",
          exitCode: 0,
          stderr: "",
          stdout: "ok\n",
        })
      }
      return Response.json({
        root: "/repo",
        workspaces: [{ name: "docs" }],
      })
    })

    const exitCode = await runWorkspaceDevCli(["docs", "pnpm test", "--url", "http://127.0.0.1:4321", "--timeout", "10000"], {
      cwd: "/repo",
      env: {},
      rootDir: "/repo",
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
    })
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({
      workspaceCommand: {
        command: "pnpm test",
        timeout: 10000,
        workspace: "docs",
      },
    })
  })
})
