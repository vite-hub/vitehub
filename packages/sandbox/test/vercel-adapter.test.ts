import { describe, expect, it, vi } from "vitest"

import { VercelSandboxAdapter } from "../src/sandbox/adapters/vercel.ts"
import type { VercelSandboxInstance } from "../src/sandbox/types/vercel.ts"

function commandResult(stdout: string, exitCode = 0) {
  return {
    exitCode,
    async *logs() {},
    stderr: vi.fn(async () => ""),
    stdout: vi.fn(async () => stdout),
    wait: vi.fn(async () => ({ exitCode })),
    kill: vi.fn(async () => {}),
  }
}

describe("VercelSandboxAdapter", () => {
  it("falls back to find when native fs listing APIs are unavailable", async () => {
    const runCommandMock = vi.fn(async () => commandResult([
      "d\t0\t1710000000.0000000000\t/workspace/docs",
      "f\t12\t1710000001.0000000000\t/workspace/docs/readme.md",
      "",
    ].join("\0")))
    const runCommand = runCommandMock as unknown as VercelSandboxInstance["runCommand"]
    const adapter = new VercelSandboxAdapter("sandbox-id", {
      domain: port => `https://sandbox-${port}.example.com`,
      mkDir: vi.fn(),
      readFile: vi.fn(),
      readFileToBuffer: vi.fn(),
      runCommand,
      writeFiles: vi.fn(),
    }, { createdAt: "now", runtime: "node24" })

    await expect(adapter.listFiles("/workspace", { recursive: true })).resolves.toEqual([
      {
        mtime: "2024-03-09T16:00:00.000Z",
        name: "docs",
        path: "/workspace/docs",
        size: undefined,
        type: "directory",
      },
      {
        mtime: "2024-03-09T16:00:01.000Z",
        name: "readme.md",
        path: "/workspace/docs/readme.md",
        size: 12,
        type: "file",
      },
    ])
    expect(runCommandMock).toHaveBeenCalledWith({
      args: ["/workspace", "-mindepth", "1", "-printf", "%y\t%s\t%T@\t%p\0"],
      cmd: "find",
      cwd: undefined,
      detached: true,
      env: undefined,
      sudo: undefined,
    })
  })
})
