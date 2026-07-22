import { execFile } from "node:child_process"
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { afterEach, describe, expect, it, vi } from "vitest"

const harnessSettings = vi.hoisted(() => [] as Record<string, any>[])
const harnessObservation = vi.hoisted(() => ({ before: undefined as string | undefined, command: false, exitCode: undefined as number | undefined, live: undefined as string | undefined }))

vi.mock("@ai-sdk/harness/agent", () => ({
  HarnessAgent: class {
    settings: Record<string, any>

    constructor(settings: Record<string, any>) {
      this.settings = settings
      harnessSettings.push(settings)
    }

    async createSession() {
      const session = await this.settings.sandbox.createSession()
      const sessionWorkDir = this.settings.sandboxConfig.workDir
        ? join(session.defaultWorkingDirectory, this.settings.sandboxConfig.workDir)
        : session.defaultWorkingDirectory
      await this.settings.sandboxConfig.onSession({
        session,
        sessionWorkDir,
      })
      return {
        destroy: () => session.destroy(),
        host: session,
        sessionWorkDir,
      }
    }

    async generate({ session }: Record<string, any>) {
      if (this.settings.tools?.workspace_exec) {
        await session.host.writeTextFile({ content: "live harness edit", path: join(session.sessionWorkDir, "live.txt") })
        harnessObservation.before = await session.host.readTextFile({ path: join(session.sessionWorkDir, "live.txt") })
        const execution = await this.settings.tools.workspace_exec.execute({ args: ["-c", "test -f live.txt && touch command.txt"], command: "sh" })
        const live = await session.host.readTextFile({ path: join(session.sessionWorkDir, "live.txt") })
        const command = await session.host.readTextFile({ path: join(session.sessionWorkDir, "command.txt") })
        harnessObservation.live = live
        harnessObservation.command = command !== null
        harnessObservation.exitCode = execution.exitCode
        return { text: live }
      }
      const result = await session.host.run({
        command:
          'codex_home="${CODEX_HOME:-$HOME/.codex}"; pwd; printf \'%s\\n\' "$HOME" "$codex_home"; test -f AGENTS.md; test -f "$codex_home/skills/global/SKILL.md"; grep -q configured-model "$codex_home/config.toml"; grep -q box "$codex_home/auth.json"; printf changed > changed.txt',
        workingDirectory: session.sessionWorkDir,
      })
      if (result.exitCode) throw new Error(result.stderr)
      return { text: result.stdout }
    }
  },
}))

const roots: string[] = []
const exec = promisify(execFile)

afterEach(async () => {
  harnessSettings.length = 0
  harnessObservation.command = false
  harnessObservation.before = undefined
  harnessObservation.exitCode = undefined
  harnessObservation.live = undefined
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

describe("Agent Box", () => {
  it("runs workspace commands without rematerializing the live Harness tree", { timeout: 20_000 }, async () => {
    const root = await temporaryRoot()
    const stateRoot = join(root, "state")
    const bin = join(root, "bin")
    await mkdir(bin)
    await executable(bin, "codex", "exit 0")
    const originalPath = process.env.PATH
    process.env.PATH = [bin, originalPath].filter(Boolean).join(":")
    try {
      const { trustedHost } = await import("@vite-hub/box")
      const { defineAgent, runAgent } = await import("../src/index.ts")
      const { workspaceShell } = await import("../src/capabilities.ts")
      const { codexDriver } = await import("../src/harness/codex.ts")
      const workspaceName = `box-live-${Date.now()}`
      const agent = defineAgent({
        name: workspaceName,
        box: { runtime: trustedHost({ stateRoot }) },
        capabilities: [workspaceShell({ commands: ["sh"], mode: "write" })],
        driver: codexDriver(),
        workspace: {
          commit: "chore: save harness changes",
          mode: "write",
          store: { provider: "memory" },
        },
      })

      await runAgent(agent, {
        memo: vi.fn((_key, create) => create()),
        runtime: "vite",
        waitUntil: vi.fn(),
      }, { prompt: "Edit the workspace." })

      expect(harnessObservation.before).toBe("live harness edit")
      expect(harnessObservation.exitCode).toBe(0)
      expect(harnessObservation.command).toBe(true)
      expect(harnessObservation.live).toBe("live harness edit")
    }
    finally {
      if (originalPath === undefined) delete process.env.PATH
      else process.env.PATH = originalPath
    }
  })

  it("runs Codex in the authoritative trusted-host workspace with the selected Home", async () => {
    const root = await temporaryRoot()
    const worktree = join(root, "worktree")
    const stateRoot = join(root, "state")
    const bin = join(root, "bin")
    await Promise.all([
      mkdir(worktree),
      mkdir(bin),
    ])
    await Promise.all([
      writeFile(join(worktree, "AGENTS.md"), "Repository instructions.\n"),
      executable(bin, "codex", "exit 0"),
      executable(bin, "gh", "exit 0"),
      executable(bin, "pnpm", "exit 0"),
    ])

    const originalPath = process.env.PATH
    process.env.PATH = [bin, originalPath].filter(Boolean).join(":")
    try {
      const { trustedHost } = await import("@vite-hub/box")
      const { custom } = await import("@vite-hub/workspace")
      const { defineAgent, runAgent } = await import("../src/index.ts")
      const { skills } = await import("../src/capabilities.ts")
      const { codexDriver } = await import("../src/harness/codex.ts")
      const agent = defineAgent<any, { worktreePath: string }>({
        box: {
          cwd: ({ input }) => input.options?.worktreePath,
          env: { GH_TOKEN: "box-token" },
          home: {
            files: {
              ".codex/config.toml": {
                contents: 'model = "configured-model"\ncli_auth_credentials_store = "file"\n',
              },
            },
            state: {
              ".codex": {
                key: "agent-box-test/codex",
                seed: { "auth.json": { contents: '{"token":"box"}\n' } },
              },
            },
          },
          requires: [{ command: "gh", args: ["auth", "status"] }, "pnpm"],
          runtime: trustedHost({ stateRoot }),
        },
        capabilities: [
          skills({
            path: "skills/global",
            scope: "global",
            source: custom({ files: [{ content: "Global skill.\n", path: "SKILL.md" }] }),
          }),
        ],
        driver: codexDriver(),
      })

      const result = await runAgent(agent, {
        memo: vi.fn((_key, create) => create()),
        runtime: "vite",
        waitUntil: vi.fn(),
      }, {
        options: { worktreePath: worktree },
        prompt: "Repair the project.",
      }) as { text: string }
      const [reportedWorktree, reportedHome, codexHome] = result.text.trim().split("\n")

      expect(reportedWorktree).toBe(await realpath(worktree))
      expect(reportedHome).toMatch(/\/vitehub-box-[^/]+\/home$/)
      expect(codexHome).toBe(join(reportedHome, ".codex"))

      await expect(readFile(join(worktree, "changed.txt"), "utf8")).resolves.toBe("changed")
      expect(harnessSettings.at(-1)?.sandbox).toMatchObject({ providerId: "trusted-host" })
      expect(harnessSettings.at(-1)?.sandboxConfig).toMatchObject({ workDir: "workspace" })
    }
    finally {
      if (originalPath === undefined) delete process.env.PATH
      else process.env.PATH = originalPath
    }
  })

  it("runs Codex in a Box-owned disposable Git checkout", async () => {
    const root = await temporaryRoot()
    const repository = join(root, "repository")
    const stateRoot = join(root, "state")
    const bin = join(root, "bin")
    await Promise.all([mkdir(repository), mkdir(bin)])
    await exec("git", ["init", "--quiet", "--initial-branch=main", repository])
    await writeFile(join(repository, "AGENTS.md"), "Repository instructions.\n")
    await exec("git", ["-C", repository, "add", "AGENTS.md"])
    await exec("git", [
      "-C", repository,
      "-c", "user.name=Fixture",
      "-c", "user.email=fixture@example.com",
      "commit", "--quiet", "-m", "initial",
    ])
    const sha = (await exec("git", ["-C", repository, "rev-parse", "HEAD"])).stdout.trim()
    await Promise.all([
      executable(bin, "codex", "exit 0"),
      executable(bin, "gh", "exit 0"),
      executable(bin, "pnpm", "exit 0"),
    ])

    const originalPath = process.env.PATH
    process.env.PATH = [bin, originalPath].filter(Boolean).join(":")
    try {
      const { trustedHost } = await import("@vite-hub/box")
      const { custom } = await import("@vite-hub/workspace")
      const { defineAgent, runAgent } = await import("../src/index.ts")
      const { skills } = await import("../src/capabilities.ts")
      const { codexDriver } = await import("../src/harness/codex.ts")
      const agent = defineAgent({
        box: {
          checkout: { ref: "refs/heads/main", remote: repository, sha },
          home: {
            files: {
              ".codex/config.toml": {
                contents: 'model = "configured-model"\ncli_auth_credentials_store = "file"\n',
              },
            },
            state: {
              ".codex": {
                key: "agent-box-test/checkout-codex",
                seed: { "auth.json": { contents: '{"token":"box"}\n' } },
              },
            },
          },
          requires: [{ command: "gh", args: ["auth", "status"] }, "pnpm"],
          runtime: trustedHost({ stateRoot }),
        },
        capabilities: [
          skills({
            path: "skills/global",
            scope: "global",
            source: custom({ files: [{ content: "Global skill.\n", path: "SKILL.md" }] }),
          }),
        ],
        driver: codexDriver(),
      })

      const result = await runAgent(agent, {
        memo: vi.fn((_key, create) => create()),
        runtime: "vite",
        waitUntil: vi.fn(),
      }, { prompt: "Repair the project." }) as { text: string }
      const [reportedCheckout] = result.text.trim().split("\n")

      expect(reportedCheckout).toMatch(/\/vitehub-box-[^/]+\/workspace$/)
      await expect(stat(join(reportedCheckout, ".."))).rejects.toMatchObject({ code: "ENOENT" })
      expect(harnessSettings.at(-1)?.sandboxConfig).toMatchObject({ workDir: "workspace" })
    }
    finally {
      if (originalPath === undefined) delete process.env.PATH
      else process.env.PATH = originalPath
    }
  })

  it("rejects overlapping Box and harness execution configuration", async () => {
    const { trustedHost } = await import("@vite-hub/box")
    const { defineAgent } = await import("../src/index.ts")

    expect(() => defineAgent({
      box: { runtime: trustedHost() },
      driver: { harness: {}, sandbox: {} },
    })).toThrow("defineAgent({ box }) owns harness execution")
    expect(() => defineAgent({
      box: { runtime: trustedHost() },
      driver: { harness: {}, workDir: "repository" },
    })).toThrow("defineAgent({ box }) owns harness execution")
  })

  it("preserves the harness work directory for custom runtimes with an authoritative path", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const { codexDriver } = await import("../src/harness/codex.ts")
    const agent = defineAgent({
      box: {
        cwd: "/workspace",
        runtime: {
          name: "path-only",
          async prepare({ identity }: { identity: string }) {
            return {
              cache: { state: "disposable" as const },
              environment: { env: {} },
              identity,
              isolation: "none" as const,
              requirements: [],
              runtime: "path-only",
              workspace: { path: "/workspace", state: "authoritative" as const, workDir: "workspace" as const },
            }
          },
          async open() {
            throw new Error("stop after harness configuration")
          },
        },
      },
      driver: codexDriver(),
    })

    await expect(runAgent(agent, {
      memo: vi.fn(),
      runtime: "unknown",
      waitUntil: vi.fn(),
    }, { prompt: "Repair the project." })).rejects.toThrow("stop after harness configuration")
    expect(harnessSettings.at(-1)?.sandboxConfig).toMatchObject({ workDir: "workspace" })
  })

  it("rejects Agent Workspace materialization over a Box-owned cwd", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const { codexDriver } = await import("../src/harness/codex.ts")
    const agent = defineAgent({
      box: {
        cwd: "/workspace",
        runtime: {
          name: "workspace-host",
          async prepare({ identity }: { identity: string }) {
            return {
              cache: { state: "disposable" as const },
              environment: { env: {} },
              identity,
              isolation: "none" as const,
              requirements: [],
              runtime: "workspace-host",
              workspace: { path: "/workspace", state: "authoritative" as const, workDir: "workspace" as const },
            }
          },
          async open() {
            throw new Error("Box opened for Agent Workspace")
          },
        },
      },
      driver: codexDriver(),
      workspace: { mode: "write", store: { provider: "memory" } },
    })

    await expect(runAgent(agent, {
      memo: vi.fn(),
      runtime: "unknown",
      waitUntil: vi.fn(),
    }, { prompt: "Repair the project." })).rejects.toThrow("both own the same working tree")
  })

  it("materializes an Agent Workspace into an empty Box working tree", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const { codexDriver } = await import("../src/harness/codex.ts")
    const agent = defineAgent({
      box: {
        runtime: {
          name: "workspace-host",
          async prepare({ identity }: { identity: string }) {
            return {
              cache: { state: "disposable" as const },
              environment: { env: {} },
              identity,
              isolation: "microvm" as const,
              requirements: [],
              runtime: "workspace-host",
              workspace: { state: "disposable" as const, workDir: "." as const },
            }
          },
          async open() {
            throw new Error("Box opened for Agent Workspace")
          },
        },
      },
      driver: codexDriver(),
      workspace: { mode: "write", store: { provider: "memory" } },
    })

    await expect(runAgent(agent, {
      memo: vi.fn(),
      runtime: "unknown",
      waitUntil: vi.fn(),
    }, { prompt: "Repair the project." })).rejects.toThrow("Box opened for Agent Workspace")
  })
})

async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), "vitehub-agent-box-test-"))
  roots.push(root)
  return root
}

async function executable(bin: string, name: string, body: string) {
  const path = join(bin, name)
  await writeFile(path, `#!/bin/sh\n${body}\n`)
  await chmod(path, 0o755)
}
