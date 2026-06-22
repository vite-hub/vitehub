import { afterEach, describe, expect, it, vi } from "vitest"

import { defineWorkspace, fetch as fetchSource } from "../src/index.ts"
import { createWorkspace } from "../src/core/workspace.ts"

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
      "process.stdout.write(require('node:fs').readFileSync('.vitehub/sources/inventory.json', 'utf8'))",
    ])

    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      sourceKey: "inventory",
      url: "https://api.example.com/inventory",
    })
    await expect(session.writeFile(".vitehub/sources/inventory.json", "{}")).rejects.toThrow()
    await session.close()
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
})
