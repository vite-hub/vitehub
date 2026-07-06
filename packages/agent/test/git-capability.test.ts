import { describe, expect, it, vi } from "vitest"

import { git } from "../src/capabilities.ts"

import type { AgentToolSet } from "../src/types.ts"
import type { WorkspaceSession } from "@vite-hub/workspace"

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

  it("exposes only read git commands in read mode", async () => {
    const { session, tools } = await capabilityTools()

    expect(Object.keys(tools)).toEqual(["git_read"])
    await expect(tools.git_read!.execute?.({ command: "git status --short" })).resolves.toMatchObject({
      args: ["status", "--short"],
      cwd: "/workspace",
      stdout: "ok\n",
    })
    await expect(tools.git_read!.execute?.({ command: "git switch main" })).rejects.toThrow("requires git({ mode: \"write\" })")
    expect(session.exec).toHaveBeenCalledWith("git", ["status", "--short"], expect.objectContaining({ cwd: "/workspace", timeout: undefined }))
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

    await expect(firstTools.git_read!.execute?.({ command: "git status --short" })).resolves.toMatchObject({
      stdout: "ok\n",
    })
    await expect(secondTools.git_read!.execute?.({ command: "git log --oneline -n 1" })).resolves.toMatchObject({
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

    await expect(tools.git_read!.execute?.({ command: "git grep -O=sh TODO" })).rejects.toThrow("not available through git_read")
    await expect(tools.git_read!.execute?.({ command: "git grep --open-files-in-pager=sh TODO" })).rejects.toThrow("not available through git_read")
    await expect(tools.git_read!.execute?.({ command: "git diff --no-index /etc/passwd README.md" })).rejects.toThrow("not available through git_read")
    await expect(tools.git_read!.execute?.({ command: "git show /etc/passwd" })).rejects.toThrow("must stay inside the workspace")
  })

  it("runs local write commands only on a clean tree", async () => {
    const session = gitSession()
    const { tools } = await capabilityTools(git({ mode: "write", policy: "allow" }), session)

    expect(Object.keys(tools)).toEqual(["git_read", "git_write"])
    expect(tools.git_write!.policy).toBe("allow")
    await expect(tools.git_write!.execute?.({ command: "git switch feature/pr-1", cwd: "portal" })).resolves.toMatchObject({
      args: ["switch", "feature/pr-1"],
      cwd: "/workspace/portal",
    })
    expect(session.exec).toHaveBeenNthCalledWith(1, "git", ["status", "--porcelain"], expect.objectContaining({ cwd: "/workspace/portal", timeout: undefined }))
    expect(session.exec).toHaveBeenNthCalledWith(2, "git", ["switch", "feature/pr-1"], expect.objectContaining({ cwd: "/workspace/portal", timeout: undefined }))
    expect(session.commit).toHaveBeenCalledWith({ message: "git switch" })
  })

  it("fetches only configured remotes in write mode", async () => {
    const session = gitSession({ remotes: "origin\nupstream\n" })
    const { tools } = await capabilityTools(git({ mode: "write" }), session)

    await expect(tools.git_write!.execute?.({ command: "git fetch origin pull/123/head" })).resolves.toMatchObject({
      args: ["fetch", "origin", "pull/123/head"],
    })
    await expect(tools.git_write!.execute?.({ command: "git fetch /tmp/repo.git main" })).rejects.toThrow("configured remotes")
    await expect(tools.git_write!.execute?.({ command: "git fetch user@example.com:repo main" })).rejects.toThrow("configured remotes")
  })

  it("blocks destructive local git write flags and refspec destinations", async () => {
    const { tools } = await capabilityTools(git({ mode: "write" }))

    await expect(tools.git_write!.execute?.({ command: "git switch -C review HEAD" })).rejects.toThrow("not available through git_write")
    await expect(tools.git_write!.execute?.({ command: "git checkout -B review HEAD" })).rejects.toThrow("not available through git_write")
    await expect(tools.git_write!.execute?.({ command: "git fetch origin pull/123/head:review" })).rejects.toThrow("cannot update local ref destinations")
    await expect(tools.git_write!.execute?.({ command: "git fetch origin +pull/123/head" })).rejects.toThrow("cannot update local ref destinations")
    await expect(tools.git_write!.execute?.({ command: "git fetch --refmap=refs/*:refs/* origin pull/123/head" })).rejects.toThrow("not available through git_write")
    await expect(tools.git_write!.execute?.({ command: "git fetch --upload-pack=\"sh -c whoami\" origin" })).rejects.toThrow("not available through git_write")
    await expect(tools.git_write!.execute?.({ command: "git fetch --upload-pack sh origin" })).rejects.toThrow("not available through git_write")
    await expect(tools.git_write!.execute?.({ command: "git fetch --tags origin" })).rejects.toThrow("not available through git_write")
    await expect(tools.git_write!.execute?.({ command: "git fetch -P origin" })).rejects.toThrow("not available through git_write")
    await expect(tools.git_write!.execute?.({ command: "git fetch -u origin" })).rejects.toThrow("not available through git_write")
  })

  it("rejects dirty write commands and remote publication commands", async () => {
    const dirty = gitSession({ status: "M README.md\n" })
    const { tools } = await capabilityTools(git({ mode: "write" }), dirty)

    await expect(tools.git_write!.execute?.({ command: "git checkout main" })).rejects.toThrow("clean working tree")
    await expect(tools.git_write!.execute?.({ command: "git push origin main" })).rejects.toThrow("git push is not available")
    await expect(tools.git_write!.execute?.({ command: "git fetch https://example.com/repo.git main" })).rejects.toThrow("configured remotes")
    expect(dirty.commit).not.toHaveBeenCalled()
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
    })

    await expect(tools.git_read!.execute?.({ command: "git status --short" })).resolves.toMatchObject({
      cwd: "/workspace/vitehub",
      stdout: "ok\n",
    })

    expect(startSession).toHaveBeenCalledWith({ paths: ["vitehub"] })
    expect(session.exec).toHaveBeenNthCalledWith(1, "git", ["rev-parse", "--is-inside-work-tree"], expect.objectContaining({ cwd: "/workspace/vitehub" }))
    expect(session.exec).toHaveBeenNthCalledWith(2, "sh", ["-lc", expect.stringContaining("git fetch --depth=100 origin 'refs/pull/42/head:refs/vitehub/head' 'refs/heads/main:refs/remotes/origin/main'")], expect.objectContaining({ cwd: "/workspace" }))
    expect(session.exec).toHaveBeenNthCalledWith(3, "git", ["status", "--short"], expect.objectContaining({ cwd: "/workspace/vitehub" }))
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

    await expect(tools.git_read!.execute?.({ command: "git status --short" })).resolves.toMatchObject({
      cwd: "/workspace",
      stdout: "ok\n",
    })

    expect(startSession).toHaveBeenCalledWith(undefined)
    expect(session.exec).toHaveBeenCalledOnce()
    expect(session.exec).toHaveBeenCalledWith("git", ["status", "--short"], expect.objectContaining({ cwd: "/workspace" }))
  })
})
