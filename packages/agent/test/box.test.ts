import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

const harnessSettings = vi.hoisted(() => [] as Record<string, any>[])

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
      const result = await session.host.run({
        command: "pwd; printf '%s\\n' \"$HOME\" \"$CODEX_HOME\"; test -f AGENTS.md; test -f \"$HOME/.agents/skills/global/SKILL.md\"; test -f \"$CODEX_HOME/config.toml\"; test ! -s \"$CODEX_HOME/config.toml\"; test \"$(readlink \"$CODEX_HOME/auth.json\")\" = \"$HOME/.codex/auth.json\"; printf changed > changed.txt",
        workingDirectory: session.sessionWorkDir,
      })
      if (result.exitCode) throw new Error(result.stderr)
      return { text: result.stdout }
    }
  },
}))

const roots: string[] = []

afterEach(async () => {
  harnessSettings.length = 0
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

describe("Agent Box", () => {
  it("runs Codex in the authoritative trusted-host workspace with the selected Home", async () => {
    const root = await temporaryRoot()
    const worktree = join(root, "worktree")
    const home = join(root, "home")
    const bin = join(root, "bin")
    await Promise.all([
      mkdir(worktree),
      mkdir(join(home, ".agents", "skills", "global"), { recursive: true }),
      mkdir(join(home, ".codex"), { recursive: true }),
      mkdir(bin),
    ])
    await Promise.all([
      writeFile(join(worktree, "AGENTS.md"), "Repository instructions.\n"),
      writeFile(join(home, ".agents", "skills", "global", "SKILL.md"), "Global skill.\n"),
      writeFile(join(home, ".codex", "auth.json"), "{\"token\":\"box\"}\n"),
      writeFile(join(home, ".codex", "config.toml"), "model = \"configured-model\"\n"),
      executable(bin, "codex", "exit 0"),
      executable(bin, "gh", "exit 0"),
      executable(bin, "pnpm", "exit 0"),
    ])

    const originalPath = process.env.PATH
    process.env.PATH = [bin, originalPath].filter(Boolean).join(":")
    try {
      const { trustedHost } = await import("@vite-hub/box")
      const { defineAgent, runAgent } = await import("../src/index.ts")
      const { codexDriver } = await import("../src/harness/codex.ts")
      const agent = defineAgent<any, { worktreePath: string }>({
        box: {
          cwd: ({ input }) => input.options?.worktreePath,
          home,
          requires: ["github", "pnpm"],
          runtime: trustedHost(),
        },
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
      expect(reportedHome).toBe(home)
      expect(codexHome).toMatch(/\/tmp\/harness\/codex-home$/)

      await expect(readFile(join(worktree, "changed.txt"), "utf8")).resolves.toBe("changed")
      expect(harnessSettings.at(-1)?.sandbox).toMatchObject({ providerId: "local" })
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
