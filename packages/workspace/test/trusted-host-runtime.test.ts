import { readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { afterEach, describe, expect, it, vi } from "vitest"

import { defineWorkspace, fetch as fetchSource } from "../src/index.ts"
import { createWorkspace } from "../src/core/workspace.ts"
import { createTrustedHostWorkspaceSession } from "../src/session/trusted-host.ts"
import { openTrustedHostWorkspaceScope } from "../src/session/trusted-host-scope.ts"

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

  it("inherits the host service account environment", async () => {
    const serviceEnvironment = {
      GH_CONFIG_DIR: "/home/vitehub/.config/gh",
      HOME: "/home/vitehub",
      SSH_AUTH_SOCK: "/run/user/1000/ssh-agent",
      XDG_CONFIG_HOME: "/home/vitehub/.config",
    }
    for (const [key, value] of Object.entries(serviceEnvironment)) vi.stubEnv(key, value)
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
      `process.stdout.write(JSON.stringify({
        GH_CONFIG_DIR: process.env.GH_CONFIG_DIR,
        HOME: process.env.HOME,
        SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK,
        XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      }))`,
    ])

    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual(serviceEnvironment)
    await session.close()
  })

  it("preserves command output and exit codes", async () => {
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
      "process.stdout.write('out'); process.stderr.write('err'); process.exit(7)",
    ])

    expect(result).toEqual({
      args: ["-e", "process.stdout.write('out'); process.stderr.write('err'); process.exit(7)"],
      command: process.execPath,
      exitCode: 7,
      stderr: "err",
      stdout: "out",
    })
    await session.close()
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
    await expect(session.readFile("screenshots/.gitkeep")).rejects.toThrow("does not exist")
    expect((await session.list("", { recursive: true })).map(entry => entry.path)).toEqual([
      "skills",
      "skills/browser",
      "skills/browser/SKILL.md",
    ])
    expect(await session.search({ pattern: "Browser" })).toEqual([
      expect.objectContaining({ path: "skills/browser/SKILL.md" }),
    ])
    await expect(session.writeFile("screenshots/direct.png", "png\n")).rejects.toThrow("outside the session scope")

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
      "const fs = require('node:fs'); process.on('SIGTERM', () => fs.appendFileSync('signals', 'SIGTERM\\n')); setInterval(() => {}, 1000)",
    ], { timeout: 200 })

    expect(result.exitCode).toBe(124)
    expect(result.stderr).toContain("Command timed out")
    await expect(session.readFile("signals")).resolves.toBe("SIGTERM\n")
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(250)
    expect(Date.now() - startedAt).toBeLessThan(2000)
    await session.close()
  })

  it("hard-stops commands that ignore SIGTERM when aborted", async () => {
    const workspace = createWorkspace({
      ...defineWorkspace({
        runtime: "trusted-host",
        store: { provider: "memory" },
      }),
      name: "docs",
    })

    const session = await workspace.startSession()
    const controller = new AbortController()
    const command = session.exec(process.execPath, [
      "-e",
      "const fs = require('node:fs'); process.on('SIGTERM', () => fs.appendFileSync('signals', 'SIGTERM\\n')); fs.writeFileSync('ready', ''); setInterval(() => {}, 1000)",
    ], { abortSignal: controller.signal })
    while (!await session.readFile("ready").then(() => true, () => false))
      await new Promise(resolve => setTimeout(resolve, 5))
    const abortedAt = Date.now()
    controller.abort()
    const result = await command

    expect(result.exitCode).toBe(130)
    expect(result.stderr).toContain("Command aborted")
    await expect(session.readFile("signals")).resolves.toBe("SIGTERM\n")
    expect(Date.now() - abortedAt).toBeGreaterThanOrEqual(80)
    expect(Date.now() - abortedAt).toBeLessThan(2000)
    await session.close()
  })

  it("does not spawn commands for already-aborted signals", async () => {
    const workspace = createWorkspace({
      ...defineWorkspace({
        runtime: "trusted-host",
        store: { provider: "memory" },
      }),
      name: "docs",
    })
    const controller = new AbortController()
    controller.abort()

    const session = await workspace.startSession()
    const result = await session.exec("vitehub-command-that-does-not-exist", [], {
      abortSignal: controller.signal,
    })

    expect(result).toEqual({
      args: [],
      command: "vitehub-command-that-does-not-exist",
      exitCode: 130,
      stderr: "Command aborted",
      stdout: "",
    })
    await session.close()
  })

  it("removes AbortSignal listeners when commands finish", async () => {
    const workspace = createWorkspace({
      ...defineWorkspace({
        runtime: "trusted-host",
        store: { provider: "memory" },
      }),
      name: "docs",
    })
    const controller = new AbortController()
    const addEventListener = vi.spyOn(controller.signal, "addEventListener")
    const removeEventListener = vi.spyOn(controller.signal, "removeEventListener")

    const session = await workspace.startSession()
    const result = await session.exec(process.execPath, ["-e", "process.stdout.write('done')"], {
      abortSignal: controller.signal,
      timeout: 1000,
    })

    expect(result).toMatchObject({ exitCode: 0, stdout: "done" })
    expect(addEventListener).toHaveBeenCalledTimes(1)
    expect(removeEventListener).toHaveBeenCalledWith("abort", addEventListener.mock.calls[0]?.[1])
    controller.abort()
    await session.close()
  })

  it("stops active child processes before releasing the session root", async () => {
    const events: string[] = []
    let finishChild: (() => void) | undefined
    let markChildStarted!: () => void
    const childStarted = new Promise<void>((resolve) => {
      markChildStarted = resolve
    })
    const scope = await openTrustedHostWorkspaceScope(
      async () => "root",
      async () => undefined,
      async () => {
        events.push("root")
      },
    )
    const child = scope.runChild(async (registerFinalizer) => {
      markChildStarted()
      const finished = new Promise<void>((resolve) => {
        finishChild = resolve
      })
      await registerFinalizer(async () => {
        events.push("child")
        finishChild?.()
        await finished
      })
      await finished
    })

    await childStarted
    await scope.close()
    await child

    expect(events).toEqual(["child", "root"])
  })

  it("returns child cleanup failures by identity without exposing FiberFailure", async () => {
    const cleanupError = new Error("child cleanup failed")
    const scope = await openTrustedHostWorkspaceScope(
      async () => "root",
      async () => undefined,
      async () => {},
    )

    const failure = await scope.runChild(async (registerFinalizer) => {
      await registerFinalizer(async () => {
        throw cleanupError
      })
    }).catch(error => error)

    expect(failure).toBe(cleanupError)
    expect((failure as Error).name).not.toBe("FiberFailure")
    await scope.close()
  })

  it("preserves child operation and cleanup failures in order", async () => {
    const operationError = new Error("child operation failed")
    const cleanupError = new Error("child cleanup failed")
    const scope = await openTrustedHostWorkspaceScope(
      async () => "root",
      async () => undefined,
      async () => {},
    )

    const failure = await scope.runChild(async (registerFinalizer) => {
      await registerFinalizer(async () => {
        throw cleanupError
      })
      throw operationError
    }).catch(error => error)

    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toEqual([operationError, cleanupError])
    expect((failure as Error).name).not.toBe("FiberFailure")
    await scope.close()
  })

  it("preserves child and root cleanup failures in order", async () => {
    const childCleanupError = new Error("child cleanup failed")
    const rootCleanupError = new Error("root cleanup failed")
    let finishChild!: () => void
    let markChildRegistered!: () => void
    const childFinished = new Promise<void>((resolve) => {
      finishChild = resolve
    })
    const childRegistered = new Promise<void>((resolve) => {
      markChildRegistered = resolve
    })
    const scope = await openTrustedHostWorkspaceScope(
      async () => "root",
      async () => undefined,
      async () => {
        throw rootCleanupError
      },
    )
    const child = scope.runChild(async (registerFinalizer) => {
      await registerFinalizer(async () => {
        finishChild()
        throw childCleanupError
      })
      markChildRegistered()
      await childFinished
    })

    await childRegistered
    const [closeFailure] = await Promise.all([
      scope.close().catch(error => error),
      child,
    ])

    expect(closeFailure).toBeInstanceOf(AggregateError)
    expect((closeFailure as AggregateError).errors).toEqual([childCleanupError, rootCleanupError])
    expect((closeFailure as Error).name).not.toBe("FiberFailure")
  })

  it("waits for every active command before the session closes", async () => {
    const workspace = createWorkspace({
      ...defineWorkspace({
        runtime: "trusted-host",
        store: { provider: "memory" },
      }),
      name: "docs",
    })
    const session = await workspace.startSession()
    const commands = ["one", "two"].map(name => session.exec(process.execPath, [
      "-e",
      `const fs = require('node:fs'); process.on('SIGTERM', () => {}); fs.writeFileSync('ready-${name}', ''); setInterval(() => {}, 1000)`,
    ]))

    while (!await Promise.all(["one", "two"].map(name => session.readFile(`ready-${name}`).then(() => true, () => false))).then(states => states.every(Boolean)))
      await new Promise(resolve => setTimeout(resolve, 5))
    const closedAt = Date.now()
    await Promise.all([session.close(), session.close(), session.close()])
    const results = await Promise.all(commands)

    expect(results.map(result => result.exitCode)).toEqual([130, 130])
    expect(results.every(result => result.stderr.includes("Command aborted"))).toBe(true)
    expect(Date.now() - closedAt).toBeGreaterThanOrEqual(80)
    expect(Date.now() - closedAt).toBeLessThan(2000)
  })

  it("aborts commands accepted immediately before close", async () => {
    const workspace = createWorkspace({
      ...defineWorkspace({
        runtime: "trusted-host",
        store: { provider: "memory" },
      }),
      name: "docs",
    })
    const session = await workspace.startSession()

    const command = session.exec(process.execPath, ["-e", "setInterval(() => {}, 1000)"])
    await session.close()

    await expect(command).resolves.toMatchObject({
      exitCode: 130,
      stderr: expect.stringContaining("Command aborted"),
    })
  })

  it("releases trusted-host roots exactly once across concurrent closes", async () => {
    const release = vi.fn(async () => {})
    const scope = await openTrustedHostWorkspaceScope(
      async () => "root",
      async () => undefined,
      release,
    )

    await Promise.all([scope.close(), scope.close(), scope.close()])

    expect(release).toHaveBeenCalledTimes(1)
  })

  it("does not start child work after the parent scope closes", async () => {
    const scope = await openTrustedHostWorkspaceScope(
      async () => "root",
      async () => undefined,
      async () => {},
    )
    const use = vi.fn(async () => {})

    await scope.close()

    await expect(scope.runChild(use)).rejects.toThrow("Workspace resource scope is already closed")
    expect(use).not.toHaveBeenCalled()
  })

  it("returns trusted-host cleanup failures by identity without exposing FiberFailure", async () => {
    const cleanupError = new Error("root cleanup failed")
    const scope = await openTrustedHostWorkspaceScope(
      async () => "root",
      async () => undefined,
      async () => {
        throw cleanupError
      },
    )

    const failure = await scope.close().catch(error => error)

    expect(failure).toBe(cleanupError)
    expect((failure as Error).name).not.toBe("FiberFailure")
  })

  it("preserves trusted-host setup and cleanup failures", async () => {
    const setupError = new Error("materialization failed")
    const cleanupError = new Error("root cleanup failed")

    const failure = await openTrustedHostWorkspaceScope(
      async () => "root",
      async () => {
        throw setupError
      },
      async () => {
        throw cleanupError
      },
    ).catch(error => error)

    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toEqual([setupError, cleanupError])
    expect((failure as Error).name).not.toBe("FiberFailure")
  })

  it("returns trusted-host setup failures by identity after successful cleanup", async () => {
    const setupError = new Error("materialization failed")
    const release = vi.fn(async () => {})

    const failure = await openTrustedHostWorkspaceScope(
      async () => "root",
      async () => {
        throw setupError
      },
      release,
    ).catch(error => error)

    expect(failure).toBe(setupError)
    expect((failure as Error).name).not.toBe("FiberFailure")
    expect(release).toHaveBeenCalledTimes(1)
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

  it("materializes GitHub symlink metadata as local symlinks", async () => {
    const workspace = {
      name: "docs",
      async list() {
        return [
          { path: "AGENTS.md", type: "file" as const },
          { metadata: { gitMode: "120000", symlinkTarget: "AGENTS.md" }, path: "CLAUDE.md", type: "file" as const },
        ]
      },
      async readFile(path: string) {
        if (path === "AGENTS.md") return "# Agents\n"
        if (path === "CLAUDE.md") return "# Agents\n"
        throw new Error(`unexpected read: ${path}`)
      },
    } as unknown as Workspace

    const session = await createTrustedHostWorkspaceSession({ name: "docs", runtime: "trusted-host" }, workspace)
    const result = await session.exec(process.execPath, [
      "-e",
      "const fs = require('node:fs'); process.stdout.write(`${fs.lstatSync('CLAUDE.md').isSymbolicLink()}:${fs.readFileSync('CLAUDE.md', 'utf8')}`)",
    ])

    expect(result).toMatchObject({ exitCode: 0, stdout: "true:# Agents\n" })
    await session.close()
  })

  it("materializes unsafe GitHub symlink targets as regular files", async () => {
    const workspace = {
      name: "docs",
      async list() {
        return [
          { metadata: { gitMode: "120000" }, path: "CLAUDE.md", type: "file" as const },
        ]
      },
      async readFile(path: string) {
        if (path === "CLAUDE.md") return "../../secret"
        throw new Error(`unexpected read: ${path}`)
      },
    } as unknown as Workspace

    const session = await createTrustedHostWorkspaceSession({ name: "docs", runtime: "trusted-host" }, workspace)
    const result = await session.exec(process.execPath, [
      "-e",
      "const fs = require('node:fs'); process.stdout.write(`${fs.lstatSync('CLAUDE.md').isSymbolicLink()}:${fs.readFileSync('CLAUDE.md', 'utf8')}`)",
    ])

    expect(result).toMatchObject({ exitCode: 0, stdout: "false:../../secret" })
    await session.close()
  })

  it("materializes and commits GitHub executable modes", async () => {
    const workspace = createWorkspace({
      ...defineWorkspace({
        runtime: "trusted-host",
        store: { provider: "memory" },
      }),
      name: "docs",
    })
    await workspace.writeFile("scripts/setup", "#!/bin/sh\nprintf setup\n", { metadata: { gitMode: "100755" } })

    const session = await workspace.startSession()
    const run = await session.exec("./scripts/setup")
    const update = await session.exec(process.execPath, [
      "-e",
      "require('node:fs').writeFileSync('scripts/setup', '#!/bin/sh\\nprintf next\\n')",
    ])

    expect(run).toMatchObject({ exitCode: 0, stdout: "setup" })
    expect(update.exitCode).toBe(0)
    await session.commit()
    await session.close()

    await expect(workspace.readFile("scripts/setup")).resolves.toBe("#!/bin/sh\nprintf next\n")
    await expect(workspace.stat("scripts/setup")).resolves.toEqual(expect.objectContaining({
      metadata: { gitMode: "100755" },
    }))
  })

  it("commits retargeted host symlinks as GitHub symlink blobs", async () => {
    const writeFile = vi.fn(async () => {})
    const workspace = {
      name: "docs",
      async list() {
        return [
          { path: "AGENTS.md", type: "file" as const },
          { metadata: { gitMode: "120000" }, path: "CLAUDE.md", type: "file" as const },
        ]
      },
      async readFile(path: string) {
        if (path === "AGENTS.md") return "# Agents\n"
        if (path === "CLAUDE.md") return "AGENTS.md"
        throw new Error(`unexpected read: ${path}`)
      },
      async rm() {},
      async mkdir() {},
      async stat(path: string) {
        if (path === "CLAUDE.md") return { metadata: { gitMode: "120000" }, path, type: "file" as const }
        return { path, type: "file" as const }
      },
      writeFile,
      snapshot: vi.fn(async () => ({ createdAt: new Date().toISOString(), entries: {}, id: "snapshot" })),
    } as unknown as Workspace

    const session = await createTrustedHostWorkspaceSession({ name: "docs", runtime: "trusted-host" }, workspace)
    const result = await session.exec(process.execPath, [
      "-e",
      "const fs = require('node:fs'); fs.unlinkSync('CLAUDE.md'); fs.symlinkSync('NEXT.md', 'CLAUDE.md')",
    ])

    expect(result.exitCode).toBe(0)
    await session.commit()
    await session.close()

    expect(writeFile).toHaveBeenCalledWith("CLAUDE.md", "NEXT.md", {
      mediaType: undefined,
      metadata: { gitMode: "120000" },
    })
  })

  it("diffs regular files that replace symlinks with matching bytes", async () => {
    const writeFile = vi.fn(async () => {})
    const workspace = {
      name: "docs",
      async list() {
        return [
          { path: "AGENTS.md", type: "file" as const },
          { metadata: { gitMode: "120000" }, path: "CLAUDE.md", type: "file" as const },
        ]
      },
      async readFile(path: string) {
        if (path === "AGENTS.md") return "# Agents\n"
        if (path === "CLAUDE.md") return "AGENTS.md"
        throw new Error(`unexpected read: ${path}`)
      },
      async rm() {},
      async mkdir() {},
      async stat(path: string) {
        if (path === "CLAUDE.md") return { metadata: { gitMode: "120000" }, path, type: "file" as const }
        return { path, type: "file" as const }
      },
      writeFile,
      snapshot: vi.fn(async () => ({ createdAt: new Date().toISOString(), entries: {}, id: "snapshot" })),
    } as unknown as Workspace

    const session = await createTrustedHostWorkspaceSession({ name: "docs", runtime: "trusted-host" }, workspace)
    const result = await session.exec(process.execPath, [
      "-e",
      "const fs = require('node:fs'); fs.unlinkSync('CLAUDE.md'); fs.writeFileSync('CLAUDE.md', 'AGENTS.md')",
    ])

    expect(result.exitCode).toBe(0)
    expect((await session.diff()).entries).toEqual([
      expect.objectContaining({ path: "CLAUDE.md", type: "modified" }),
    ])
    await session.commit()
    await session.close()

    expect(writeFile).toHaveBeenCalledWith("CLAUDE.md", Buffer.from("AGENTS.md"), {
      mediaType: undefined,
      metadata: undefined,
    })
  })

  it("commits session-written symlinks as GitHub symlink blobs", async () => {
    const workspace = createWorkspace({
      ...defineWorkspace({
        runtime: "trusted-host",
        store: { provider: "memory" },
      }),
      name: "docs",
    })

    const session = await workspace.startSession()
    await session.writeFile("AGENTS.md", "# Agents\n")
    await session.writeFile("CLAUDE.md", "AGENTS.md", { metadata: { gitMode: "120000" } })
    await session.commit()
    await session.close()

    await expect(workspace.stat("CLAUDE.md")).resolves.toEqual(expect.objectContaining({
      metadata: { gitMode: "120000" },
    }))
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
