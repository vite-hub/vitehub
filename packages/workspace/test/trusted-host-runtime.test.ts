import { readdir } from "node:fs/promises"
import { tmpdir } from "node:os"

import { afterEach, describe, expect, it, vi } from "vitest"

import { defineWorkspace, fetch as fetchSource } from "../src/index.ts"
import { createWorkspace } from "../src/core/workspace.ts"
import { createTrustedHostWorkspaceSession } from "../src/session/trusted-host.ts"

import type { Workspace } from "../src/core/types.ts"

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("trusted host workspace runtime", () => {
  it("runs commands in a trusted local workspace session and commits changes", async () => {
    const workspace = createWorkspace({
      ...defineWorkspace({
        runtime: "trusted-host",
        store: { provider: "memory" },
      }),
      name: "docs",
    })
    await workspace.writeFile("README.md", "# Docs\n")

    const session = await workspace.startSession()
    const result = await session.exec(process.execPath, [
      "-e",
      "require('node:fs').mkdirSync('generated', { recursive: true }); require('node:fs').writeFileSync('generated/result.txt', 'done\\n')",
    ])

    expect(result.exitCode).toBe(0)
    expect((await session.diff()).entries).toEqual([
      expect.objectContaining({ path: "generated", type: "added" }),
      expect.objectContaining({ path: "generated/result.txt", type: "added" }),
    ])

    await session.commit()
    await session.close()

    await expect(workspace.readFile("generated/result.txt")).resolves.toBe("done\n")
  })

  it("rejects changes outside scoped session paths", async () => {
    const workspace = createWorkspace({
      ...defineWorkspace({
        runtime: "trusted-host",
        rules: {
          "screenshots/**": { write: true },
          "skills/**": { write: true },
          "**": { write: false },
        },
        store: { provider: "memory" },
      }),
      name: "review",
    })
    await workspace.writeFile("skills/browser/SKILL.md", "# Browser\n")
    await workspace.writeFile("screenshots/.gitkeep", "")

    const session = await workspace.startSession({ paths: ["skills/browser"] })
    const result = await session.exec(process.execPath, [
      "-e",
      "const fs = require('node:fs'); fs.mkdirSync('screenshots', { recursive: true }); fs.writeFileSync('screenshots/login-version-badge-desktop.png', 'png\\n')",
    ])

    expect(result.exitCode).toBe(0)
    await expect(session.commit()).rejects.toThrow("outside the session scope")
    await session.close()

    await expect(workspace.exists("screenshots/login-version-badge-desktop.png")).resolves.toBe(false)
  })

  it("scopes command cwd inside the materialized workspace", async () => {
    const workspace = createWorkspace({
      ...defineWorkspace({
        runtime: "trusted-host",
        store: { provider: "memory" },
      }),
      name: "docs",
    })
    await workspace.writeFile("docs/input.txt", "scoped\n")

    const session = await workspace.startSession()
    const result = await session.exec(process.execPath, [
      "-e",
      "process.stdout.write(require('node:fs').readFileSync('input.txt', 'utf8'))",
    ], { cwd: "./docs/" })

    expect(result).toMatchObject({ exitCode: 0, stdout: "scoped\n" })
    await session.close()
  })

  it("accepts sandbox-style workspace cwd paths", async () => {
    const workspace = createWorkspace({
      ...defineWorkspace({
        runtime: "trusted-host",
        store: { provider: "memory" },
      }),
      name: "docs",
    })
    await workspace.writeFile("docs/input.txt", "scoped\n")

    const session = await workspace.startSession()
    const result = await session.exec(process.execPath, [
      "-e",
      "process.stdout.write(require('node:fs').readFileSync('input.txt', 'utf8'))",
    ], { cwd: "/workspace/docs" })

    expect(result).toMatchObject({ exitCode: 0, stdout: "scoped\n" })
    await session.close()
  })

  it("hard-stops commands that ignore SIGTERM after timeout", async () => {
    const workspace = createWorkspace({
      ...defineWorkspace({
        runtime: "trusted-host",
        store: { provider: "memory" },
      }),
      name: "docs",
    })

    const session = await workspace.startSession()
    const startedAt = Date.now()
    const result = await session.exec(process.execPath, [
      "-e",
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
    ], { timeout: 20 })

    expect(result.exitCode).toBe(124)
    expect(result.stderr).toContain("Command timed out")
    expect(Date.now() - startedAt).toBeLessThan(2000)
    await session.close()
  })

  it("materializes generated source descriptors for shell inspection", async () => {
    const workspace = createWorkspace({
      ...defineWorkspace({
        runtime: "trusted-host",
        sources: {
          inventory: fetchSource({ url: "https://api.example.com/inventory" }),
        },
        store: { provider: "memory" },
      }),
      name: "docs",
    })

    const session = await workspace.startSession()
    const result = await session.exec(process.execPath, [
      "-e",
      "process.stdout.write(require('node:fs').readFileSync('inventory.json', 'utf8'))",
    ], { cwd: "/workspace/.vitehub/sources" })

    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      sourceKey: "inventory",
      url: "https://api.example.com/inventory",
    })
    await expect(session.writeFile(".vitehub/sources/inventory.json", "{}")).rejects.toThrow()
    await session.close()
  })

  it("can materialize only selected paths in a local session", async () => {
    const workspace = {
      name: "review",
      async stat(path: string) {
        if (path === "skills/agent-browser") return { path, type: "directory" as const }
        if (path === "skills/agent-browser/SKILL.md") return { path, size: 10, type: "file" as const }
        throw new Error(`unexpected stat: ${path}`)
      },
      async list(path: string) {
        if (path === "") throw new Error("root list should not be used")
        if (path === "skills/agent-browser") return [{ path: "skills/agent-browser/SKILL.md", size: 10, type: "file" as const }]
        return []
      },
      async readFile(path: string) {
        if (path === "skills/agent-browser/SKILL.md") return "# Browser\n"
        throw new Error(`unexpected read: ${path}`)
      },
    } as unknown as Workspace

    const session = await createTrustedHostWorkspaceSession({ name: "review", runtime: "trusted-host" }, workspace, {
      paths: ["skills/agent-browser"],
    })
    const result = await session.exec(process.execPath, [
      "-e",
      "process.stdout.write(require('node:fs').readFileSync('skills/agent-browser/SKILL.md', 'utf8'))",
    ])

    expect(result).toMatchObject({ exitCode: 0, stdout: "# Browser\n" })
    await session.close()
  })

  it("ignores git metadata when committing host session changes", async () => {
    const workspace = createWorkspace({
      ...defineWorkspace({
        runtime: "trusted-host",
        store: { provider: "memory" },
      }),
      name: "docs",
    })

    const session = await workspace.startSession()
    const result = await session.exec(process.execPath, [
      "-e",
      "const fs = require('node:fs'); fs.mkdirSync('.git', { recursive: true }); fs.writeFileSync('.git/config', 'ignored\\n'); fs.writeFileSync('tracked.txt', 'kept\\n')",
    ])

    expect(result.exitCode).toBe(0)
    expect((await session.diff()).entries).toEqual([
      expect.objectContaining({ path: "tracked.txt", type: "added" }),
    ])
    await session.commit()
    await session.close()

    await expect(workspace.readFile("tracked.txt")).resolves.toBe("kept\n")
  })

  it("removes the temporary root when materialization fails", async () => {
    const name = `cleanup-${Date.now()}`
    const before = new Set(await readdir(tmpdir()))
    const workspace = {
      name,
      async list() {
        return [{ path: "seed.txt", type: "file" as const }]
      },
      async readFile() {
        throw new Error("source failed")
      },
    } as unknown as Workspace

    await expect(createTrustedHostWorkspaceSession({ name } as never, workspace)).rejects.toThrow("source failed")
    const leaked = (await readdir(tmpdir()))
      .filter(entry => entry.startsWith(`vitehub-workspace-${name}-`) && !before.has(entry))
    expect(leaked).toEqual([])
  })

  it("sanitizes nested workspace names in temporary directory prefixes", async () => {
    const workspace = createWorkspace({
      ...defineWorkspace({
        runtime: "trusted-host",
        store: { provider: "memory" },
      }),
      name: "emails/welcome",
    })
    await workspace.writeFile("README.md", "# Welcome\n")

    const session = await workspace.startSession()
    const result = await session.exec(process.execPath, [
      "-e",
      "process.stdout.write(require('node:fs').readFileSync('README.md', 'utf8'))",
    ])

    expect(result).toMatchObject({ exitCode: 0, stdout: "# Welcome\n" })
    await session.close()
  })

  it("rejects local workspace sessions in production", async () => {
    vi.stubEnv("NODE_ENV", "production")
    const workspace = createWorkspace({
      ...defineWorkspace({
        runtime: "trusted-host",
        store: { provider: "memory" },
      }),
      name: "docs",
    })

    await expect(workspace.startSession()).rejects.toThrow("only available outside production")
  })

  it("allows trusted host sessions in production when explicitly opted in", async () => {
    vi.stubEnv("NODE_ENV", "production")
    const workspace = createWorkspace({
      ...defineWorkspace({
        runtime: { type: "trusted-host", allowProduction: true },
        store: { provider: "memory" },
      }),
      name: "docs",
    })
    await workspace.writeFile("README.md", "# Docs\n")

    const session = await workspace.startSession()
    const result = await session.exec(process.execPath, [
      "-e",
      "process.stdout.write(require('node:fs').readFileSync('README.md', 'utf8'))",
    ])

    expect(result).toMatchObject({ exitCode: 0, stdout: "# Docs\n" })
    await session.close()
  })
})
