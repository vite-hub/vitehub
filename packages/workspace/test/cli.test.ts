import { describe, expect, it, vi } from "vitest"

import { runWorkspaceDevCli } from "../src/cli.ts"
import { workspaceDevHeader, workspaceDevHeaderValue } from "../src/server.ts"

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

    const exitCode = await runWorkspaceDevCli(["docs", "pnpm", "test"], {
      cwd: "/repo",
      env: {},
      rootDir: "/repo",
      stderr: stream(),
      stdout,
    }, { fetch: fetchWorkspaceDev as never })

    expect(exitCode).toBe(0)
    expect(stdout.output()).toBe("ok\n")
    const [get, post] = fetchWorkspaceDev.mock.calls
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
        workspace: "docs",
      },
    })
  })
})
