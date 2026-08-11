import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { afterEach, describe, expect, it, vi } from "vitest"
import { unknownExecutionAuthority } from "@vite-hub/runtime"

const harnessSettings = vi.hoisted(() => [] as Record<string, any>[])
const harnessObservation = vi.hoisted(() => ({
  absentGlobalSkills: [] as string[],
  before: undefined as string | undefined,
  command: false,
  detach: false,
  expectPreviousCodexState: false,
  exitCode: undefined as number | undefined,
  firstGenerateBlock: undefined as Promise<void> | undefined,
  firstGenerateStarted: undefined as (() => void) | undefined,
  generateCount: 0,
  globalSkills: ["global"] as string[],
  live: undefined as string | undefined,
  sessionOptions: [] as Array<Record<string, unknown> | undefined>,
}))

vi.mock("@ai-sdk/harness/agent", () => ({
  HarnessAgent: class {
    settings: Record<string, any>

    constructor(settings: Record<string, any>) {
      this.settings = settings
      harnessSettings.push(settings)
    }

    async createSession(options?: Record<string, unknown>) {
      harnessObservation.sessionOptions.push(options)
      const session = await this.settings.sandbox.createSession()
      const sessionWorkDir = this.settings.sandboxConfig.workDir
        ? join(session.defaultWorkingDirectory, this.settings.sandboxConfig.workDir)
        : session.defaultWorkingDirectory
      try {
        await this.settings.sandboxConfig.onSession({
          session,
          sessionWorkDir,
        })
      }
      catch (error) {
        await session.destroy().catch(() => {})
        throw error
      }
      return {
        ...(harnessObservation.detach
          ? {
              detach: async () => {
                await session.destroy()
                return { token: "resume" }
              },
            }
          : {}),
        destroy: () => session.destroy(),
        host: session,
        sessionWorkDir,
      }
    }

    async generate({ session }: Record<string, any>) {
      harnessObservation.generateCount++
      const codexState = `session-state-${harnessObservation.generateCount}`
      if (harnessObservation.generateCount === 1 && harnessObservation.firstGenerateBlock) {
        harnessObservation.firstGenerateStarted?.()
        await harnessObservation.firstGenerateBlock
      }
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
        command: `codex_home="\${CODEX_HOME:-$HOME/.codex}"; pwd; printf '%s\\n' "$HOME" "$codex_home"; test -f AGENTS.md; ${harnessObservation.globalSkills.map(skill => `test -f "$codex_home/skills/${skill}/SKILL.md"; `).join("")}${harnessObservation.absentGlobalSkills.map(skill => `test ! -e "$codex_home/skills/${skill}"; `).join("")}${harnessObservation.expectPreviousCodexState && harnessObservation.generateCount > 1 ? `test -f "$codex_home/session-state-${harnessObservation.generateCount - 1}"; ` : ""}grep -q configured-model "$codex_home/config.toml"; grep -q box "$codex_home/auth.json"; printf durable > "$codex_home/${codexState}"; printf changed > changed.txt`,
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
  harnessObservation.absentGlobalSkills = []
  harnessObservation.command = false
  harnessObservation.detach = false
  harnessObservation.before = undefined
  harnessObservation.expectPreviousCodexState = false
  harnessObservation.exitCode = undefined
  harnessObservation.firstGenerateBlock = undefined
  harnessObservation.firstGenerateStarted = undefined
  harnessObservation.generateCount = 0
  harnessObservation.globalSkills = ["global"]
  harnessObservation.live = undefined
  harnessObservation.sessionOptions = []
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
      const { defineAgent, runAgent } = await import("../src/index.ts")
      const { workspaceShell } = await import("../src/capabilities.ts")
      const workspaceName = `box-live-${Date.now()}`
      const agent = defineAgent({
        name: workspaceName,
        box: { runtime: { kind: "trusted-host", stateRoot } },
        capabilities: [workspaceShell({ commands: ["sh"], mode: "write" })],
        driver: "codex",
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
    const continuedWorktree = join(root, "continued-worktree")
    const removedSkillWorktree = join(root, "removed-skill-worktree")
    const stateRoot = join(root, "state")
    const bin = join(root, "bin")
    await Promise.all([
      mkdir(worktree),
      mkdir(continuedWorktree),
      mkdir(removedSkillWorktree),
      mkdir(bin),
    ])
    await Promise.all([
      writeFile(join(worktree, "AGENTS.md"), "Repository instructions.\n"),
      writeFile(join(continuedWorktree, "AGENTS.md"), "Repository instructions.\n"),
      writeFile(join(removedSkillWorktree, "AGENTS.md"), "Repository instructions.\n"),
      executable(bin, "codex", "exit 0"),
      executable(bin, "gh", "exit 0"),
      executable(bin, "pnpm", "exit 0"),
    ])

    const originalPath = process.env.PATH
    process.env.PATH = [bin, originalPath].filter(Boolean).join(":")
    try {
      const { custom } = await import("@vite-hub/workspace")
      const { defineAgent, runAgent } = await import("../src/index.ts")
      const { createCodexDriver } = await import("../src/harness/codex.ts")
      const { skills } = await import("../src/capabilities.ts")
      const colocatedSkills = Symbol.for("vitehub.agent.colocatedSkills")
      const globalSkills = [
        skills({
          path: "skills/global",
          scope: "global",
          source: custom({ files: [{ content: "Global skill.\n", path: "SKILL.md" }] }),
        }),
        skills({
          path: "skills/bundles/review",
          scope: "global",
          source: custom({ files: [{ content: "Nested review skill.\n", path: "SKILL.md" }] }),
        }),
        skills({
          path: "skills/global-trailing\n",
          scope: "global",
          source: custom({ files: [{ content: "Trailing global skill.\n", path: "SKILL.md" }] }),
        }),
      ]
      const agent = Object.assign(defineAgent<any, { worktreePath: string }>({
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
                seed: {
                  "auth.json": { contents: '{"token":"box"}\n' },
                  "skills/global/SKILL.md": { contents: "Unmanaged global skill.\n" },
                  "skills/.vitehub-colocated": { contents: "legacy\nlocal\n" },
                  "skills/legacy/SKILL.md": { contents: "Legacy managed skill.\n" },
                  "skills/local/SKILL.md": { contents: "Local skill.\n" },
                },
              },
            },
          },
          requires: [{ command: "gh", args: ["auth", "status"] }, "pnpm"],
          runtime: { kind: "trusted-host", stateRoot },
        },
        capabilities: globalSkills,
        driver: { ...createCodexDriver(), sessionKey: "thread-1" },
      }), {
        [colocatedSkills]: {
          local: {
            content: new TextEncoder().encode("Colocated local skill.\n"),
            materialize: "build",
            mount: "",
            workspacePath: "skills/local/SKILL.md",
          },
          localExtra: {
            content: new TextEncoder().encode("Must not merge.\n"),
            materialize: "build",
            mount: "",
            workspacePath: "skills/local/colocated-only.md",
          },
          newline: {
            content: new TextEncoder().encode("# Newline\n"),
            materialize: "build",
            mount: "",
            workspacePath: "skills/line\nbreak/SKILL.md",
          },
          review: {
            content: new TextEncoder().encode("# Review\n"),
            materialize: "build",
            mount: "",
            workspacePath: "skills/review/SKILL.md",
          },
          trailingNewline: {
            content: new TextEncoder().encode("# Trailing newline\n"),
            materialize: "build",
            mount: "",
            workspacePath: "skills/trailing\n/SKILL.md",
          },
        },
      })
      harnessObservation.detach = true
      harnessObservation.globalSkills = ["bundles/review", "global", "global-trailing\n", "legacy", "line\nbreak", "local", "review", "trailing\n"]
      harnessObservation.expectPreviousCodexState = true

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
      const persistentCodexHome = join(
        stateRoot,
        createHash("sha256").update("agent-box-test/codex").digest("hex"),
      )
      await expect(readFile(join(persistentCodexHome, "skills/global/SKILL.md"), "utf8"))
        .resolves.toBe("Unmanaged global skill.\n")
      await mkdir(join(persistentCodexHome, "skills/.git"))
      await writeFile(
        join(persistentCodexHome, "skills/.git/config"),
        "[core]\n\trepositoryformatversion = 0\n",
      )
      globalSkills.splice(1, 1, skills({
        path: "skills/bundles",
        scope: "global",
        source: custom({ files: [{ content: "Ancestor bundle skill.\n", path: "SKILL.md" }] }),
      }))
      Object.assign(agent, { capabilities: globalSkills })
      harnessObservation.globalSkills = ["bundles", "global", "global-trailing\n", "legacy", "line\nbreak", "local", "review", "trailing\n"]
      const continued = await runAgent(agent, {
        memo: vi.fn((_key, create) => create()),
        runtime: "vite",
        waitUntil: vi.fn(),
      }, {
        options: { worktreePath: continuedWorktree },
        prompt: "Continue repairing the project.",
      }) as { text: string }
      const [, continuedHome, continuedCodexHome] = continued.text.trim().split("\n")
      expect(continuedCodexHome).toBe(join(continuedHome, ".codex"))
      await expect(readFile(join(persistentCodexHome, "skills/.git/config"), "utf8"))
        .resolves.toContain("repositoryformatversion")
      await expect(readFile(join(persistentCodexHome, "skills/bundles/SKILL.md"), "utf8"))
        .resolves.toBe("Ancestor bundle skill.\n")
      expect(harnessObservation.sessionOptions).toHaveLength(2)
      expect(harnessObservation.sessionOptions[0]).not.toHaveProperty("resumeFrom")
      expect(harnessObservation.sessionOptions[1]).toMatchObject({
        resumeFrom: { token: "resume" },
        sessionId: harnessObservation.sessionOptions[0]?.sessionId,
      })

      await expect(readFile(join(persistentCodexHome, "skills/local/colocated-only.md"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" })
      const externalReview = join(root, "external-review")
      await mkdir(externalReview)
      await writeFile(join(externalReview, "SKILL.md"), "External review skill.\n")
      await rm(join(persistentCodexHome, "skills/review"), { recursive: true })
      await symlink(externalReview, join(persistentCodexHome, "skills/review"))
      await chmod(join(externalReview, "SKILL.md"), 0o400)
      await chmod(externalReview, 0o500)
      Reflect.deleteProperty(agent, colocatedSkills)
      globalSkills.splice(2, 1)
      Object.assign(agent, { capabilities: globalSkills })
      harnessObservation.globalSkills = ["bundles", "global", "legacy", "local"]
      harnessObservation.absentGlobalSkills = ["global-trailing\n", "line\nbreak", "review", "trailing\n"]
      await runAgent(agent, {
        memo: vi.fn((_key, create) => create()),
        runtime: "vite",
        waitUntil: vi.fn(),
      }, {
        options: { worktreePath: removedSkillWorktree },
        prompt: "Continue without the removed Skill.",
      })
      expect(harnessObservation.sessionOptions).toHaveLength(3)
      expect(harnessObservation.sessionOptions[2]).toMatchObject({
        resumeFrom: { token: "resume" },
        sessionId: harnessObservation.sessionOptions[0]?.sessionId,
      })
      await expect(readFile(join(persistentCodexHome, "skills/local/SKILL.md"), "utf8"))
        .resolves.toBe("Local skill.\n")
      expect((await stat(externalReview)).mode & 0o777).toBe(0o500)
      expect((await stat(join(externalReview, "SKILL.md"))).mode & 0o777).toBe(0o400)
      await chmod(externalReview, 0o700)
      await chmod(join(externalReview, "SKILL.md"), 0o600)
      const externalSkills = join(root, "external-skills")
      await mkdir(join(externalSkills, "managed"), { recursive: true })
      await writeFile(join(externalSkills, "untouched"), "external\n")
      await writeFile(join(externalSkills, "managed/owned"), "managed\n")
      await rm(join(persistentCodexHome, "skills"), { recursive: true })
      await mkdir(join(persistentCodexHome, "skills"))
      await writeFile(
        join(persistentCodexHome, "skills.vitehub-managed"),
        `${Buffer.from("bundles/managed").toString("base64")}\n`,
      )
      await symlink(externalSkills, join(persistentCodexHome, "skills/bundles"))
      await expect(runAgent(agent, {
        memo: vi.fn((_key, create) => create()),
        runtime: "vite",
        waitUntil: vi.fn(),
      }, {
        options: { worktreePath: removedSkillWorktree },
        prompt: "Do not follow managed Skill parents.",
      })).rejects.toThrow("ViteHub-managed Skill path cannot traverse a symlink")
      await expect(stat(`${persistentCodexHome}.lock`)).rejects.toMatchObject({ code: "ENOENT" })
      await expect(readFile(join(externalSkills, "untouched"), "utf8")).resolves.toBe("external\n")
      await expect(readFile(join(externalSkills, "managed/owned"), "utf8")).resolves.toBe("managed\n")
      await writeFile(join(externalSkills, ".vitehub-colocated-v2"), `${Buffer.from("managed").toString("base64")}\n`)
      await rm(join(persistentCodexHome, "skills"), { recursive: true })
      await symlink(externalSkills, join(persistentCodexHome, "skills"))
      await expect(runAgent(agent, {
        memo: vi.fn((_key, create) => create()),
        runtime: "vite",
        waitUntil: vi.fn(),
      }, {
        options: { worktreePath: removedSkillWorktree },
        prompt: "Do not follow the replaced Skills root.",
      })).rejects.toThrow("Persisted Skill directory cannot be a symlink")
      await expect(readFile(join(externalSkills, "managed/owned"), "utf8")).resolves.toBe("managed\n")
      expect(harnessSettings.at(-1)?.sandbox).toMatchObject({ providerId: "trusted-host" })
      expect(harnessSettings.at(-1)?.sandboxConfig.workDir).toBeUndefined()
    }
    finally {
      if (originalPath === undefined) delete process.env.PATH
      else process.env.PATH = originalPath
    }
  })

  it("keeps a shared Box global Skill profile stable for the full invocation", async () => {
    const home = "/home/shared"
    const codexHomes = new Set<string>()
    const runtime = {
      name: "shared-home-test",
      async prepare({ identity }: { identity: string }) {
        return {
          cache: { state: "disposable" as const },
          environment: { env: {} },
          executionAuthority: unknownExecutionAuthority,
          identity,
          requirements: [],
          runtime: "shared-home-test",
          workspace: { path: "/workspace", state: "authoritative" as const },
        }
      },
      async open(_input: unknown, options: { initialize?: (session: any, context: { signal?: AbortSignal }) => Promise<void>, signal?: AbortSignal }) {
        const session = {
          close: vi.fn(async () => {}),
          cwd: "/workspace",
          executionAuthority: unknownExecutionAuthority,
          files: {
            exists: vi.fn(async () => true),
            list: vi.fn(async () => []),
            mkdir: vi.fn(async () => {}),
            read: vi.fn(async () => null),
            remove: vi.fn(async () => {}),
            write: vi.fn(async () => {}),
          },
          id: globalThis.crypto.randomUUID(),
          async exec(_command: string, args?: readonly string[]) {
            const script = args?.[1] || ""
            const codexHome = script.match(/export CODEX_HOME="\$HOME\/([^"]+)"/)?.[1]
            if (codexHome) codexHomes.add(codexHome)
            return {
              code: 0,
              ok: true,
              stderr: "",
              stdout: script === `printf '%s' "$HOME"`
                ? home
                : `/workspace\n${home}\n${home}/.codex\n`,
            }
          },
          spawn: vi.fn(),
        }
        await options.initialize?.(session, { signal: options.signal })
        return session
      },
    }
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const agent = Object.assign(defineAgent({
      box: { runtime },
      driver: "codex",
    }), {
      [Symbol.for("vitehub.agent.colocatedSkills")]: {
        review: {
          content: new TextEncoder().encode("# Review\n"),
          materialize: "build",
          mount: "",
          workspacePath: "skills/review/SKILL.md",
        },
      },
    })
    let releaseFirstGenerate!: () => void
    harnessObservation.firstGenerateBlock = new Promise<void>((resolve) => {
      releaseFirstGenerate = resolve
    })
    const firstGenerateStarted = new Promise<void>((resolve) => {
      harnessObservation.firstGenerateStarted = resolve
    })
    const run = () => runAgent(agent, {
      memo: vi.fn((_key, create) => create()),
      runtime: "vite",
      waitUntil: vi.fn(),
    }, { prompt: "Review." })

    const first = run()
    await firstGenerateStarted
    const second = run()
    await vi.waitFor(() => expect(harnessObservation.generateCount).toBe(2))
    expect(codexHomes.size).toBe(2)
    expect(Array.from(codexHomes).every(path => /^\.vitehub\/codex-home-[^/]+$/.test(path))).toBe(true)
    releaseFirstGenerate()
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
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
      const { custom } = await import("@vite-hub/workspace")
      const { defineAgent, runAgent } = await import("../src/index.ts")
      const { skills } = await import("../src/capabilities.ts")
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
          runtime: { kind: "trusted-host", stateRoot },
        },
        capabilities: [
          skills({
            path: "skills/global",
            scope: "global",
            source: custom({ files: [{ content: "Global skill.\n", path: "SKILL.md" }] }),
          }),
        ],
        driver: "codex",
      })

      const result = await runAgent(agent, {
        memo: vi.fn((_key, create) => create()),
        runtime: "vite",
        waitUntil: vi.fn(),
      }, { prompt: "Repair the project." }) as { text: string }
      const [reportedCheckout] = result.text.trim().split("\n")

      expect(reportedCheckout).toMatch(/\/vitehub-box-[^/]+\/workspace$/)
      await expect(stat(join(reportedCheckout, ".."))).rejects.toMatchObject({ code: "ENOENT" })
      expect(harnessSettings.at(-1)?.sandboxConfig.workDir).toBeUndefined()
    }
    finally {
      if (originalPath === undefined) delete process.env.PATH
      else process.env.PATH = originalPath
    }
  })

  it("rejects overlapping Box and harness execution configuration", async () => {
    const { defineAgent } = await import("../src/index.ts")

    expect(() => defineAgent({
      box: { runtime: "trusted-host" },
      driver: { harness: {}, sandbox: {} },
    })).toThrow("defineAgent({ box }) owns harness execution")
    expect(() => defineAgent({
      box: { runtime: "trusted-host" },
      driver: { harness: {}, workDir: "repository" },
    })).toThrow("defineAgent({ box }) owns harness execution")
  })

  it("accepts and inspects Box-only Capabilities without a Workspace", async () => {
    const { defineAgent, defineCapability, resolveAgentInspectionMetadata } = await import("../src/index.ts")
    const agent = defineAgent({
      box: { runtime: "trusted-host" },
      capabilities: [defineCapability({
        id: "box-only",
        requires: [{ primitive: "box" }],
      })],
      driver: "codex",
    })

    await expect(resolveAgentInspectionMetadata(agent)).resolves.toMatchObject({ tools: [] })
  })

  it("preserves the harness work directory for custom runtimes with an authoritative path", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const agent = defineAgent({
      box: {
        cwd: "/workspace",
        runtime: {
          name: "path-only",
          async prepare({ identity }: { identity: string }) {
            return {
              cache: { state: "disposable" as const },
              environment: { env: {} },
              executionAuthority: unknownExecutionAuthority,
              identity,
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
      driver: "codex",
    })

    await expect(runAgent(agent, {
      memo: vi.fn(),
      runtime: "unknown",
      waitUntil: vi.fn(),
    }, { prompt: "Repair the project." })).rejects.toThrow("stop after harness configuration")
    expect(harnessSettings.at(-1)?.sandboxConfig.workDir).toBeUndefined()
  })

  it("rejects Agent Workspace materialization over a Box-owned cwd", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const agent = defineAgent({
      box: {
        cwd: "/workspace",
        runtime: {
          name: "workspace-host",
          async prepare({ identity }: { identity: string }) {
            return {
              cache: { state: "disposable" as const },
              environment: { env: {} },
              executionAuthority: unknownExecutionAuthority,
              identity,
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
      driver: "codex",
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
    const agent = defineAgent({
      box: {
        runtime: {
          name: "workspace-host",
          async prepare({ identity }: { identity: string }) {
            return {
              cache: { state: "disposable" as const },
              environment: { env: {} },
              executionAuthority: unknownExecutionAuthority,
              identity,
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
      driver: "codex",
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
