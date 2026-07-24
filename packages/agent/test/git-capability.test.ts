import { execFile } from "node:child_process"
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { describe, expect, it, vi } from "vitest"

import { git } from "../src/capabilities.ts"
import { applyAgentToolPolicies } from "../src/tool-runtime.ts"

import type { AgentToolSet } from "../src/types.ts"
import type { WorkspaceSession } from "@vite-hub/workspace"

const pullRequestHeadSha = "a".repeat(40)
const execFileAsync = promisify(execFile)

function gitSession(options: { remotes?: string, status?: string } = {}) {
  const session = {
    close: vi.fn(),
    commit: vi.fn(),
    exec: vi.fn(async (command: string, args: string[] = []) => ({
      args,
      command,
      exitCode: 0,
      stderr: "",
      stdout: args.join(" ") === "status --porcelain"
        ? options.status || ""
        : args[0] === "remote"
          ? options.remotes || "origin\n"
          : "ok\n",
    })),
  } as unknown as WorkspaceSession & {
    close: ReturnType<typeof vi.fn>
    commit: ReturnType<typeof vi.fn>
    exec: ReturnType<typeof vi.fn>
  }
  return session
}

async function capabilityTools(
  capability = git(),
  session = gitSession(),
  contextValues: Record<string, unknown> = {},
): Promise<{ session: ReturnType<typeof gitSession>, startSession: ReturnType<typeof vi.fn>, tools: AgentToolSet }> {
  if (typeof capability.tools !== "function") throw new Error("git capability must expose tool resolver")
  const startSession = vi.fn(async () => session)
  const tools = await capability.tools({
    context: {
      get: vi.fn((key: string) => contextValues[key]),
    },
    workspace: {
      startSession,
    },
  } as never) as AgentToolSet
  return { session, startSession, tools }
}

describe("git capability", () => {
  it("defaults to read mode and records write mode", () => {
    expect(git()).toMatchObject({
      id: "git",
      metadata: { mode: "read" },
      mode: "read",
      requires: [{ workspace: { mode: "write", required: true } }],
    })
    expect(git({ mode: "write" })).toMatchObject({
      metadata: { mode: "write" },
      mode: "write",
      requires: [{ workspace: { mode: "write", required: true } }],
    })
    expect(() => git({ mode: "remote-write" as never })).toThrow("Git mode must be \"read\" or \"write\"")
  })

  it("exposes a controlled read-only shell tool in read mode", async () => {
    const { session, tools } = await capabilityTools()

    expect(Object.keys(tools)).toEqual(["shell"])
    await expect(tools.shell!.execute?.({ command: "git status --short" })).resolves.toMatchObject({
      args: ["status", "--short"],
      cwd: "/workspace",
      stdout: "ok\n",
    })
    await expect(tools.shell!.execute?.({ command: "git switch main" })).rejects.toThrow("requires git({ mode: \"write\" })")
    expect(session.exec).toHaveBeenCalledWith("git", ["status", "--short"], expect.objectContaining({ cwd: "/workspace", timeout: 60_000 }))
  })

  it("does not truncate git output by default", async () => {
    const session = gitSession()
    const output = "x".repeat(40_000)
    session.exec.mockResolvedValueOnce({
      args: ["show"],
      command: "git",
      exitCode: 0,
      stderr: "",
      stdout: output,
    })
    const { tools } = await capabilityTools(git(), session)

    await expect(tools.shell!.execute?.({ command: "git show HEAD" })).resolves.toMatchObject({
      outputTruncated: undefined,
      stdout: output,
    })
  })

  it("exposes a command-only shell input schema", async () => {
    const { session, tools } = await capabilityTools()
    const schema = tools.shell!.inputSchema as { anyOf?: unknown, properties?: Record<string, unknown>, required?: string[] }

    expect(schema).toMatchObject({
      additionalProperties: false,
      properties: {
        command: { type: "string" },
        cwd: { type: "string" },
      },
      required: ["command"],
      type: "object",
    })
    expect(schema.anyOf).toBeUndefined()
    expect(schema.properties).not.toHaveProperty("cmd")
    expect(schema.properties).not.toHaveProperty("args")
    await expect(tools.shell!.execute?.({ command: "status --short" })).resolves.toMatchObject({
      args: ["status", "--short"],
      command: "git status --short",
    })
    await expect(tools.shell!.execute?.({ command: "ls -la" })).rejects.toThrow("must start with `git`")
    await expect(tools.shell!.execute?.({ command: "git diff --stat && git diff" })).rejects.toThrow("without shell composition")

    expect(session.exec).toHaveBeenCalledWith("git", ["status", "--short"], expect.objectContaining({ cwd: "/workspace" }))
  })

  it("keeps workspace sessions scoped to each tool resolution", async () => {
    const capability = git()
    if (typeof capability.tools !== "function") throw new Error("git capability must expose tool resolver")
    const firstSession = gitSession()
    const secondSession = gitSession()
    const firstStartSession = vi.fn(async () => firstSession)
    const secondStartSession = vi.fn(async () => secondSession)
    const firstContext = { workspace: { startSession: firstStartSession } }
    const secondContext = { workspace: { startSession: secondStartSession } }

    const firstTools = await capability.tools(firstContext as never) as AgentToolSet
    const secondTools = await capability.tools(secondContext as never) as AgentToolSet

    await expect(firstTools.shell!.execute?.({ command: "git status --short" })).resolves.toMatchObject({
      stdout: "ok\n",
    })
    await expect(secondTools.shell!.execute?.({ command: "git log --oneline -n 1" })).resolves.toMatchObject({
      stdout: "ok\n",
    })

    expect(firstStartSession).toHaveBeenCalledOnce()
    expect(secondStartSession).toHaveBeenCalledOnce()
    expect(firstSession.exec).toHaveBeenCalledWith("git", ["status", "--short"], expect.objectContaining({ cwd: "/workspace" }))
    expect(secondSession.exec).toHaveBeenCalledWith("git", ["log", "--oneline", "-n", "1"], expect.objectContaining({ cwd: "/workspace" }))

    await capability.close?.(firstContext as never)
    expect(firstSession.close).toHaveBeenCalledOnce()
    expect(secondSession.close).not.toHaveBeenCalled()

    await capability.close?.(secondContext as never)
    expect(secondSession.close).toHaveBeenCalledOnce()
  })

  it("blocks git read options that escape inspection boundaries", async () => {
    const { tools } = await capabilityTools()

    await expect(tools.shell!.execute?.({ command: "git grep -O=sh TODO" })).rejects.toThrow("not available through the controlled git shell")
    await expect(tools.shell!.execute?.({ command: "git grep --open-files-in-pager=sh TODO" })).rejects.toThrow("not available through the controlled git shell")
    await expect(tools.shell!.execute?.({ command: "git diff --no-index /etc/passwd README.md" })).rejects.toThrow("not available through the controlled git shell")
    await expect(tools.shell!.execute?.({ command: "git show /etc/passwd" })).rejects.toThrow("must stay inside the workspace")
  })

  it("runs local write commands only on a clean tree", async () => {
    const session = gitSession()
    const { startSession, tools } = await capabilityTools(git({ mode: "write" }), session)

    expect(Object.keys(tools)).toEqual(["shell"])
    expect(tools.shell!.policy).toBeUndefined()
    await expect(tools.shell!.execute?.({ command: "git switch feature/pr-1", cwd: "portal" })).resolves.toMatchObject({
      args: ["switch", "feature/pr-1"],
      cwd: "/workspace/portal",
    })
    expect(startSession).toHaveBeenCalledWith(undefined)
    expect(session.exec).toHaveBeenNthCalledWith(1, "git", ["status", "--porcelain"], expect.objectContaining({ cwd: "/workspace/portal", timeout: 60_000 }))
    expect(session.exec).toHaveBeenNthCalledWith(2, "git", ["switch", "feature/pr-1"], expect.objectContaining({ cwd: "/workspace/portal", timeout: 60_000 }))
    expect(session.commit).toHaveBeenCalledWith({ message: "git switch" })
  })

  it("allows supported commands by default", async () => {
    const { tools } = await capabilityTools(git({ mode: "write" }))

    expect(tools.shell!.policy).toBeUndefined()
  })

  it("evaluates custom write policies with normalized git inputs", async () => {
    const session = gitSession()
    const policy = vi.fn(({ input }: { input?: unknown }) => {
      if (typeof input === "object" && input !== null && (input as { command?: unknown }).command === "git checkout main") return "deny"
      return "allow"
    })
    const { tools } = await capabilityTools(git({ mode: "write", policy }), session)
    const guardedTools = applyAgentToolPolicies(tools)!

    await expect(guardedTools.shell!.execute?.({ command: "checkout main" })).rejects.toThrow()
    await expect(guardedTools.shell!.execute?.({ command: "git status --short" })).resolves.toMatchObject({
      args: ["status", "--short"],
    })

    expect(policy).toHaveBeenCalledOnce()
    expect(policy).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({ command: "git checkout main" }),
      name: "shell",
    }))
    expect(session.exec).toHaveBeenCalledOnce()
  })

  it("fetches only configured remotes in write mode", async () => {
    const session = gitSession({ remotes: "origin\nupstream\n" })
    const { tools } = await capabilityTools(git({ mode: "write" }), session)

    await expect(tools.shell!.execute?.({ command: "git fetch origin pull/123/head" })).resolves.toMatchObject({
      args: ["fetch", "origin", "pull/123/head"],
    })
    await expect(tools.shell!.execute?.({ command: "git fetch /tmp/repo.git main" })).rejects.toThrow("configured remotes")
    await expect(tools.shell!.execute?.({ command: "git fetch user@example.com:repo main" })).rejects.toThrow("configured remotes")
  })

  it("blocks destructive local git write flags and refspec destinations", async () => {
    const { tools } = await capabilityTools(git({ mode: "write" }))

    await expect(tools.shell!.execute?.({ command: "git switch -C review HEAD" })).rejects.toThrow("not available through the controlled git shell")
    await expect(tools.shell!.execute?.({ command: "git checkout -B review HEAD" })).rejects.toThrow("not available through the controlled git shell")
    await expect(tools.shell!.execute?.({ command: "git fetch origin pull/123/head:review" })).rejects.toThrow("cannot update local ref destinations")
    await expect(tools.shell!.execute?.({ command: "git fetch origin +pull/123/head" })).rejects.toThrow("cannot update local ref destinations")
    await expect(tools.shell!.execute?.({ command: "git fetch --refmap=refs/*:refs/* origin pull/123/head" })).rejects.toThrow("not available through the controlled git shell")
    await expect(tools.shell!.execute?.({ command: "git fetch --upload-pack=\"sh -c whoami\" origin" })).rejects.toThrow("not available through the controlled git shell")
    await expect(tools.shell!.execute?.({ command: "git fetch --upload-pack sh origin" })).rejects.toThrow("not available through the controlled git shell")
    await expect(tools.shell!.execute?.({ command: "git fetch --tags origin" })).rejects.toThrow("not available through the controlled git shell")
    await expect(tools.shell!.execute?.({ command: "git fetch -P origin" })).rejects.toThrow("not available through the controlled git shell")
    await expect(tools.shell!.execute?.({ command: "git fetch -u origin" })).rejects.toThrow("not available through the controlled git shell")
  })

  it("rejects dirty write commands and remote publication commands", async () => {
    const dirty = gitSession({ status: "M README.md\n" })
    const { tools } = await capabilityTools(git({ mode: "write" }), dirty)

    await expect(tools.shell!.execute?.({ command: "git checkout main" })).rejects.toThrow("clean working tree")
    await expect(tools.shell!.execute?.({ command: "git push origin main" })).rejects.toThrow("git push is not available")
    await expect(tools.shell!.execute?.({ command: "git fetch https://example.com/repo.git main" })).rejects.toThrow("configured remotes")
    expect(dirty.commit).not.toHaveBeenCalled()
  })

  it("keeps non-PR cwd commands in a full workspace session", async () => {
    const session = gitSession()
    const { startSession, tools } = await capabilityTools(git(), session)

    await expect(tools.shell!.execute?.({ command: "git status --short", cwd: "packages/agent" })).resolves.toMatchObject({
      cwd: "/workspace/packages/agent",
      stdout: "ok\n",
    })

    expect(startSession).toHaveBeenCalledWith(undefined)
    expect(session.exec).toHaveBeenCalledWith("git", ["status", "--short"], expect.objectContaining({ cwd: "/workspace/packages/agent" }))
  })

  it("prepares pull request checkout and defaults cwd to the source mount", async () => {
    const session = gitSession()
    session.exec.mockImplementation(async (command: string, args: string[] = []) => ({
      args,
      command,
      exitCode: command === "git" && args.join(" ") === "rev-parse --is-inside-work-tree" ? 1 : 0,
      stderr: "",
      stdout: command === "git" && args.join(" ") === "status --short" ? "ok\n" : "",
    }))
    const { startSession, tools } = await capabilityTools(git(), session, {
      pullRequest: {
        pullRequest: {
          base: { ref: "main" },
          head: { ref: "feature", sha: pullRequestHeadSha },
          number: 42,
          source: {
            mount: "vitehub",
            ref: "refs/pull/42/head",
            repo: "vite-hub/vitehub",
          },
        },
        repository: {
          fullName: "vite-hub/vitehub",
          name: "vitehub",
        },
      },
    })

    await expect(tools.shell!.execute?.({ command: "git status --short" })).resolves.toMatchObject({
      cwd: "/workspace/vitehub",
      stdout: "ok\n",
    })

    expect(startSession).toHaveBeenCalledWith({ paths: ["vitehub"] })
    expect(session.exec).toHaveBeenNthCalledWith(1, "git", ["rev-parse", "--is-inside-work-tree"], expect.objectContaining({ cwd: "/workspace/vitehub" }))
    expect(session.exec).toHaveBeenNthCalledWith(2, "sh", ["-lc", expect.stringContaining("git fetch --depth=100 origin 'refs/pull/42/head:refs/vitehub/head' 'refs/heads/main:refs/remotes/origin/main'")], expect.objectContaining({ cwd: "/workspace" }))
    const setupScript = session.exec.mock.calls[1]?.[1]?.[1]
    expect(setupScript).toContain(`test "$(git rev-parse refs/vitehub/head)" = '${pullRequestHeadSha}'`)
    expect(session.exec).toHaveBeenNthCalledWith(3, "git", ["status", "--short"], expect.objectContaining({ cwd: "/workspace/vitehub" }))
  })

  it("prepares explicit root pull request checkouts without deleting Workspace artifacts", async () => {
    const session = gitSession()
    session.exec.mockImplementation(async (command: string, args: string[] = []) => ({
      args,
      command,
      exitCode: command === "git" && args.join(" ") === "rev-parse --is-inside-work-tree" ? 1 : 0,
      stderr: "",
      stdout: command === "git" && args.join(" ") === "status --short" ? "ok\n" : "",
    }))
    const { startSession, tools } = await capabilityTools(git(), session, {
      pullRequest: {
        pullRequest: {
          head: { sha: pullRequestHeadSha },
          number: 42,
          source: {
            mount: "",
            ref: "refs/pull/42/head",
            repo: "vite-hub/vitehub",
          },
        },
        repository: {
          fullName: "vite-hub/vitehub",
          name: "vitehub",
        },
      },
    })

    await expect(tools.shell!.execute?.({ command: "git status --short" })).resolves.toMatchObject({
      cwd: "/workspace",
      stdout: "ok\n",
    })

    expect(startSession).toHaveBeenCalledWith(undefined)
    expect(session.exec).toHaveBeenNthCalledWith(1, "git", ["rev-parse", "--is-inside-work-tree"], expect.objectContaining({ cwd: "/workspace" }))
    const setupScript = session.exec.mock.calls[1]?.[1]?.[1]
    expect(setupScript).toContain("cd -- .")
    expect(setupScript).toContain("git reset -q --hard refs/vitehub/head")
    expect(setupScript).not.toContain("rm -rf")
  })

  it("attaches root Git metadata to an already materialized exact-head tree", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "vitehub-root-pr-"))
    const source = join(fixture, "source")
    const workspace = join(fixture, "workspace")
    try {
      await mkdir(source)
      await mkdir(workspace)
      await execFileAsync("git", ["init", "-q"], { cwd: source })
      await writeFile(join(source, "README.md"), "exact head\n")
      await execFileAsync("git", ["add", "README.md"], { cwd: source })
      await execFileAsync("git", ["-c", "user.name=ViteHub", "-c", "user.email=vitehub@example.com", "commit", "-qm", "fixture"], { cwd: source })
      const { stdout: headSha } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: source })

      await copyFile(join(source, "README.md"), join(workspace, "README.md"))
      await writeFile(join(workspace, "PULL_REQUEST.md"), "workspace artifact\n")
      await execFileAsync("git", ["init", "-q"], { cwd: workspace })
      await execFileAsync("git", ["remote", "add", "origin", source], { cwd: workspace })
      await execFileAsync("git", ["fetch", "-q", "origin", `${headSha.trim()}:refs/vitehub/head`], { cwd: workspace })
      await execFileAsync("git", ["reset", "-q", "--hard", "refs/vitehub/head"], { cwd: workspace })

      expect(await readFile(join(workspace, "README.md"), "utf8")).toBe("exact head\n")
      expect(await readFile(join(workspace, "PULL_REQUEST.md"), "utf8")).toBe("workspace artifact\n")
      const { stdout: status } = await execFileAsync("git", ["status", "--porcelain"], { cwd: workspace })
      expect(status).toBe("?? PULL_REQUEST.md\n")
    }
    finally {
      await rm(fixture, { force: true, recursive: true })
    }
  })

  it("does not prepare a pull request checkout when the channel disables it", async () => {
    const session = gitSession()
    const { startSession, tools } = await capabilityTools(git(), session, {
      pullRequest: {
        pullRequest: {
          head: { ref: "feature", sha: pullRequestHeadSha },
          number: 42,
          source: {
            checkout: false,
            mount: "vitehub",
            ref: "refs/pull/42/head",
            repo: "vite-hub/vitehub",
          },
        },
        repository: {
          fullName: "vite-hub/vitehub",
          name: "vitehub",
        },
      },
    })

    await expect(tools.shell!.execute?.({ command: "git status --short" })).resolves.toMatchObject({
      cwd: "/workspace",
      stdout: "ok\n",
    })

    expect(startSession).toHaveBeenCalledWith(undefined)
    expect(session.exec).toHaveBeenCalledOnce()
    expect(session.exec).toHaveBeenCalledWith("git", ["status", "--short"], expect.objectContaining({ cwd: "/workspace" }))
  })

  it("requires an exact pull request head SHA", async () => {
    await expect(capabilityTools(git(), gitSession(), {
      pullRequest: {
        pullRequest: {
          head: { ref: "feature" },
          number: 42,
          source: {
            mount: "vitehub",
            ref: "refs/pull/42/head",
            repo: "vite-hub/vitehub",
          },
        },
        repository: {
          fullName: "vite-hub/vitehub",
          name: "vitehub",
        },
      },
    })).rejects.toThrow("requires an exact head SHA")
  })

  it("verifies an existing pull request checkout against the exact head SHA", async () => {
    const session = gitSession()
    session.exec.mockImplementation(async (command: string, args: string[] = []) => ({
      args,
      command,
      exitCode: 0,
      stderr: "",
      stdout: command === "git" && args.join(" ") === "rev-parse HEAD" ? `${pullRequestHeadSha}\n` : "",
    }))
    const { tools } = await capabilityTools(git(), session, {
      pullRequest: {
        pullRequest: {
          head: { sha: pullRequestHeadSha },
          number: 42,
          source: {
            mount: "vitehub",
            ref: "refs/pull/42/head",
            repo: "vite-hub/vitehub",
          },
        },
        repository: {
          fullName: "vite-hub/vitehub",
          name: "vitehub",
        },
      },
    })

    await expect(tools.shell!.execute?.({ command: "git status --short" })).resolves.toMatchObject({
      cwd: "/workspace/vitehub",
    })
    expect(session.exec).toHaveBeenNthCalledWith(2, "git", ["rev-parse", "HEAD"], expect.objectContaining({ cwd: "/workspace/vitehub" }))
  })

  it("rejects an existing pull request checkout at a different head", async () => {
    const session = gitSession()
    session.exec.mockImplementation(async (command: string, args: string[] = []) => ({
      args,
      command,
      exitCode: 0,
      stderr: "",
      stdout: command === "git" && args.join(" ") === "rev-parse HEAD" ? `${"b".repeat(40)}\n` : "",
    }))
    const { tools } = await capabilityTools(git(), session, {
      pullRequest: {
        pullRequest: {
          head: { sha: pullRequestHeadSha },
          number: 42,
          source: {
            mount: "vitehub",
            ref: "refs/pull/42/head",
            repo: "vite-hub/vitehub",
          },
        },
        repository: {
          fullName: "vite-hub/vitehub",
          name: "vitehub",
        },
      },
    })

    await expect(tools.shell!.execute?.({ command: "git status --short" })).rejects.toThrow("does not match the expected SHA")
    expect(session.close).toHaveBeenCalledOnce()
  })

  it("closes pull request sessions when checkout preparation fails", async () => {
    const session = gitSession()
    session.exec.mockImplementation(async (command: string, args: string[] = []) => ({
      args,
      command,
      exitCode: command === "sh" || args.join(" ") === "rev-parse --is-inside-work-tree" ? 1 : 0,
      stderr: command === "sh" ? "fetch failed" : "",
      stdout: "",
    }))
    const { tools } = await capabilityTools(git(), session, {
      pullRequest: {
        pullRequest: {
          head: { sha: pullRequestHeadSha },
          number: 42,
          source: {
            mount: "vitehub",
            ref: "refs/pull/42/head",
            repo: "vite-hub/vitehub",
          },
        },
        repository: {
          fullName: "vite-hub/vitehub",
          name: "vitehub",
        },
      },
    })

    await expect(tools.shell!.execute?.({ command: "git status --short" })).rejects.toThrow("fetch failed")
    expect(session.close).toHaveBeenCalledOnce()
  })

  it("does not guess a base branch when preparing pull request checkout", async () => {
    const session = gitSession()
    session.exec.mockImplementation(async (command: string, args: string[] = []) => ({
      args,
      command,
      exitCode: command === "git" && args.join(" ") === "rev-parse --is-inside-work-tree" ? 1 : 0,
      stderr: "",
      stdout: "",
    }))
    const { tools } = await capabilityTools(git(), session, {
      pullRequest: {
        pullRequest: {
          head: { sha: pullRequestHeadSha },
          number: 42,
          source: {
            mount: "vitehub",
            ref: "refs/pull/42/head",
            repo: "vite-hub/vitehub",
          },
        },
        repository: {
          fullName: "vite-hub/vitehub",
          name: "vitehub",
        },
      },
    })

    await expect(tools.shell!.execute?.({ command: "git status --short" })).resolves.toMatchObject({
      cwd: "/workspace/vitehub",
    })

    const setupScript = session.exec.mock.calls.find(([command]) => command === "sh")?.[1]?.[1]
    expect(setupScript).toContain("git fetch --depth=100 origin 'refs/pull/42/head:refs/vitehub/head'")
    expect(setupScript).not.toContain("refs/heads/main")
    expect(setupScript).not.toContain("vitehub-base")
  })

  it("keeps internally prepared pull request checkouts out of write commits", async () => {
    const session = gitSession()
    session.exec.mockImplementation(async (command: string, args: string[] = []) => ({
      args,
      command,
      exitCode: command === "git" && args.join(" ") === "rev-parse --is-inside-work-tree" ? 1 : 0,
      stderr: "",
      stdout: "",
    }))
    const { tools } = await capabilityTools(git({ mode: "write" }), session, {
      pullRequest: {
        pullRequest: {
          base: { ref: "main" },
          head: { sha: pullRequestHeadSha },
          number: 42,
          source: {
            mount: "vitehub",
            ref: "refs/pull/42/head",
            repo: "vite-hub/vitehub",
          },
        },
        repository: {
          fullName: "vite-hub/vitehub",
          name: "vitehub",
        },
      },
    })

    await expect(tools.shell!.execute?.({ command: "git switch vitehub-base" })).resolves.toMatchObject({
      args: ["switch", "vitehub-base"],
      cwd: "/workspace/vitehub",
    })

    expect(session.commit).not.toHaveBeenCalled()
  })

  it("skips pull request checkout for non-GitHub providers", async () => {
    const session = gitSession()
    const { startSession, tools } = await capabilityTools(git(), session, {
      pullRequest: {
        number: 42,
        provider: "gitlab",
        repository: "vite-hub/vitehub",
        source: {
          mount: "vitehub",
          ref: "refs/merge-requests/42/head",
          repo: "vite-hub/vitehub",
        },
      },
    })

    await expect(tools.shell!.execute?.({ command: "git status --short" })).resolves.toMatchObject({
      cwd: "/workspace",
      stdout: "ok\n",
    })

    expect(startSession).toHaveBeenCalledWith(undefined)
    expect(session.exec).toHaveBeenCalledOnce()
  })

  it("ignores unsafe pull request checkout values", async () => {
    const session = gitSession()
    const { startSession, tools } = await capabilityTools(git(), session, {
      pullRequest: {
        pullRequest: {
          number: 42,
          source: {
            mount: "../vitehub",
            ref: "main..evil",
            repo: "vite hub/vitehub",
          },
        },
        repository: {
          fullName: "vite hub/vitehub",
          name: "vitehub",
        },
      },
    })

    await expect(tools.shell!.execute?.({ command: "git status --short" })).resolves.toMatchObject({
      cwd: "/workspace",
      stdout: "ok\n",
    })

    expect(startSession).toHaveBeenCalledWith(undefined)
    expect(session.exec).toHaveBeenCalledOnce()
    expect(session.exec).toHaveBeenCalledWith("git", ["status", "--short"], expect.objectContaining({ cwd: "/workspace" }))
  })
})
