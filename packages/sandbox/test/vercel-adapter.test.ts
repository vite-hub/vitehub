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

function fileStat(options: { directory?: boolean, file?: boolean, symlink?: boolean, size?: number }) {
  return {
    isDirectory: () => Boolean(options.directory),
    isFile: () => Boolean(options.file),
    isSymbolicLink: () => Boolean(options.symlink),
    mtimeMs: 1710000000000,
    size: options.size ?? 0,
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

  it("uses native lstat when listing Vercel symlinks", async () => {
    const fs = {
      lstat: vi.fn(async (path: string) => {
        if (path === "/workspace/docs") return fileStat({ directory: true })
        if (path === "/workspace/docs/readme.md") return fileStat({ file: true, size: 12 })
        if (path === "/workspace/link") return fileStat({ symlink: true })
        throw new Error(`unexpected lstat: ${path}`)
      }),
      mkdir: vi.fn(),
      readFile: vi.fn(),
      readdir: vi.fn(async (path: string) => {
        if (path === "/workspace") return ["docs", "link"]
        if (path === "/workspace/docs") return ["readme.md"]
        throw new Error(`unexpected readdir: ${path}`)
      }),
      rename: vi.fn(),
      rm: vi.fn(),
      stat: vi.fn(async (path: string) => {
        if (path === "/workspace/link") return fileStat({ directory: true })
        throw new Error(`unexpected stat: ${path}`)
      }),
      writeFile: vi.fn(),
    }
    const adapter = new VercelSandboxAdapter("sandbox-id", {
      domain: port => `https://sandbox-${port}.example.com`,
      fs,
      mkDir: vi.fn(),
      readFile: vi.fn(),
      readFileToBuffer: vi.fn(),
      runCommand: vi.fn(),
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
        mtime: "2024-03-09T16:00:00.000Z",
        name: "readme.md",
        path: "/workspace/docs/readme.md",
        size: 12,
        type: "file",
      },
      {
        mtime: "2024-03-09T16:00:00.000Z",
        name: "link",
        path: "/workspace/link",
        size: undefined,
        type: "symlink",
      },
    ])
    expect(fs.stat).not.toHaveBeenCalled()
    expect(fs.readdir).not.toHaveBeenCalledWith("/workspace/link")
  })
})
