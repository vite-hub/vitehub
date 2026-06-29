import { describe, expect, it, vi } from "vitest"

import { CloudflareSandboxAdapter } from "../src/sandbox/adapters/cloudflare.ts"
import type { CloudflareSandboxStub } from "../src/sandbox/types/common.ts"

describe("CloudflareSandboxAdapter", () => {
  it("parses symlink names from ls fallback listings", async () => {
    const exec = vi.fn(async () => ({
      exitCode: 0,
      stderr: "",
      stdout: [
        "total 0",
        "lrwxrwxrwx 1 root root 9 Jun 29 00:00 CLAUDE.md -> AGENTS.md",
      ].join("\n"),
      success: true,
    }))
    const adapter = new CloudflareSandboxAdapter("sandbox-id", {
      deleteFile: vi.fn(),
      destroy: vi.fn(),
      exec,
      readFile: vi.fn(),
      writeFile: vi.fn(),
    } as unknown as CloudflareSandboxStub)

    await expect(adapter.listFiles("/workspace")).resolves.toEqual([
      {
        name: "CLAUDE.md",
        path: "/workspace/CLAUDE.md",
        type: "symlink",
      },
    ])
  })
})
