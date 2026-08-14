import { exec } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { promisify } from "node:util"
import { describe, expect, it, vi } from "vitest"

import { defineWorkspace } from "../src/index.ts"
import { createWorkspace } from "../src/core/workspace.ts"
import { prepareHarnessWorkspaceSession } from "../src/session/harness.ts"

import type { Workspace, WorkspaceMaterializeSourcesOptions } from "../src/core/types.ts"
import type { HarnessSandboxSession } from "../src/session/harness.ts"

const execAsync = promisify(exec)

function workspace() {
  return createWorkspace({
    ...defineWorkspace({ store: { provider: "memory" } }),
    name: `docs-${crypto.randomUUID()}`,
  })
}

function facade(docs: Workspace, materializeSources = docs.materializeSources?.bind(docs)) {
  return {
    fs: {
      exists: docs.exists.bind(docs),
      glob: docs.glob.bind(docs),
      list: docs.list.bind(docs),
      readFile: docs.readFile.bind(docs),
      search: docs.search.bind(docs),
      stat: docs.stat.bind(docs),
    },
    materializeSources,
    startSession: docs.startSession.bind(docs),
    tools: {},
  }
}

function localSandbox(): { root: Promise<string>, session: HarnessSandboxSession } {
  const root = mkdtemp(join(tmpdir(), "vitehub-harness-session-"))
  return {
    root,
    session: {
      async readBinaryFile(options) {
        return await readFile(options.path).catch(() => null)
      },
      async run(options) {
        try {
          const result = await execAsync(options.command, {
            cwd: options.workingDirectory,
            env: options.env ? { ...process.env, ...options.env } : process.env,
            signal: options.abortSignal,
          })
          return { exitCode: 0, stderr: result.stderr, stdout: result.stdout }
        }
        catch (error) {
          const failure = error as Error & { code?: number, stderr?: string, stdout?: string }
          return { exitCode: typeof failure.code === "number" ? failure.code : 1, stderr: failure.stderr || failure.message, stdout: failure.stdout || "" }
        }
      },
      async writeBinaryFile(options) {
        await mkdir(dirname(options.path), { recursive: true })
        await writeFile(options.path, options.content)
      },
    },
  }
}

describe("Harness Workspace Session", () => {
  it("materializes and writes back through the Workspace-hosted Session boundary", async () => {
    const docs = workspace()
    await docs.writeFile("README.md", "before")
    await docs.snapshot({ name: "baseline" })
    const sandbox = localSandbox()
    const root = await sandbox.root
    const target = join(root, "workspace")
    const progress: Array<{ id: string, status: string }> = []

    try {
      const session = await prepareHarnessWorkspaceSession(facade(docs) as never, {
        onProgress: (event) => { progress.push(event) },
        session: sandbox.session,
        sessionWorkDir: target,
      })
      await expect(readFile(join(target, "README.md"), "utf8")).resolves.toBe("before")
      await writeFile(join(target, "README.md"), "after")
      await writeFile(join(target, "result.txt"), "done")
      await session.close()

      await expect(docs.readFile("README.md")).resolves.toBe("after")
      await expect(docs.readFile("result.txt")).resolves.toBe("done")
      expect(progress).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "workspace.prepare.start-session", status: "completed" }),
        expect.objectContaining({ id: "workspace.prepare.read-files", status: "completed" }),
        expect.objectContaining({ id: "workspace.prepare.git-status", status: "completed" }),
      ]))
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("materializes through a Harness sandbox without binary reads", async () => {
    const docs = workspace()
    await docs.writeFile("README.md", "from workspace")
    await docs.snapshot({ name: "baseline" })
    const sandbox = localSandbox()
    delete sandbox.session.readBinaryFile
    const root = await sandbox.root
    const target = join(root, "workspace")

    try {
      const session = await prepareHarnessWorkspaceSession(facade(docs) as never, {
        session: sandbox.session,
        sessionWorkDir: target,
      })
      await expect(readFile(join(target, "README.md"), "utf8")).resolves.toBe("from workspace")
      await session.close()
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("keeps concurrent invocation trees isolated and discards a failed invocation", async () => {
    const docs = workspace()
    await docs.writeFile("README.md", "authoritative")
    await docs.snapshot({ name: "baseline" })
    const left = localSandbox()
    const right = localSandbox()
    const leftRoot = await left.root
    const rightRoot = await right.root
    const leftTarget = join(leftRoot, "workspace")
    const rightTarget = join(rightRoot, "workspace")

    try {
      const [leftSession, rightSession] = await Promise.all([
        prepareHarnessWorkspaceSession(facade(docs) as never, { session: left.session, sessionWorkDir: leftTarget }),
        prepareHarnessWorkspaceSession(facade(docs) as never, { session: right.session, sessionWorkDir: rightTarget }),
      ])
      await writeFile(join(leftTarget, "README.md"), "left")
      await writeFile(join(rightTarget, "README.md"), "right")
      await leftSession.close(new Error("failed invocation"))

      await expect(readFile(join(leftTarget, "README.md"), "utf8")).resolves.toBe("authoritative")
      await expect(readFile(join(rightTarget, "README.md"), "utf8")).resolves.toBe("right")
      await expect(docs.readFile("README.md")).resolves.toBe("authoritative")
      await rightSession.close()
      await expect(docs.readFile("README.md")).resolves.toBe("right")
    }
    finally {
      await rm(leftRoot, { force: true, recursive: true })
      await rm(rightRoot, { force: true, recursive: true })
    }
  })

  it("restores a failed invocation after its operation signal aborts", async () => {
    const docs = workspace()
    await docs.writeFile("README.md", "authoritative")
    await docs.snapshot({ name: "baseline" })
    const sandbox = localSandbox()
    const root = await sandbox.root
    const target = join(root, "workspace")
    const controller = new AbortController()

    try {
      const session = await prepareHarnessWorkspaceSession(facade(docs) as never, {
        abortSignal: controller.signal,
        session: sandbox.session,
        sessionWorkDir: target,
      })
      await writeFile(join(target, "README.md"), "invocation")
      controller.abort(new Error("invocation canceled"))

      await expect(session.close(new Error("invocation canceled"))).resolves.toBeUndefined()
      await expect(readFile(join(target, "README.md"), "utf8")).resolves.toBe("authoritative")
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("closes and restores a Session when Git baseline initialization fails", async () => {
    const docs = workspace()
    await docs.writeFile("README.md", "authoritative")
    await docs.snapshot({ name: "baseline" })
    const sandbox = localSandbox()
    const root = await sandbox.root
    const target = join(root, "workspace")
    const run = sandbox.session.run
    sandbox.session.run = async (options) => {
      if (options.command.includes("git init")) throw new Error("git unavailable")
      return await run(options)
    }

    try {
      await expect(prepareHarnessWorkspaceSession(facade(docs) as never, {
        session: sandbox.session,
        sessionWorkDir: target,
      })).rejects.toThrow("git unavailable")
      await expect(readFile(join(target, "README.md"), "utf8")).resolves.toBe("authoritative")
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("keeps an explicitly empty Session scope empty", async () => {
    const docs = workspace()
    await docs.writeFile("README.md", "hidden")
    await docs.snapshot({ name: "baseline" })
    const sandbox = localSandbox()
    const root = await sandbox.root
    const target = join(root, "workspace")

    try {
      const session = await prepareHarnessWorkspaceSession(facade(docs) as never, {
        paths: [],
        session: sandbox.session,
        sessionWorkDir: target,
      })
      await expect(readFile(join(target, "README.md"), "utf8")).rejects.toThrow()
      await session.close()
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("excludes runtime and Harness support paths from write-back", async () => {
    const docs = workspace()
    const sandbox = localSandbox()
    const root = await sandbox.root
    const target = join(root, "workspace")

    try {
      const session = await prepareHarnessWorkspaceSession(facade(docs) as never, {
        ignoreWriteBackPaths: ["AGENTS.md"],
        session: sandbox.session,
        sessionWorkDir: target,
      })
      await mkdir(join(target, ".agent-runs"), { recursive: true })
      await mkdir(join(target, ".vitehub"), { recursive: true })
      await writeFile(join(target, ".agent-runs", "trace.json"), "trace")
      await writeFile(join(target, ".vitehub", "runtime.json"), "runtime")
      await writeFile(join(target, "AGENTS.md"), "generated")
      await writeFile(join(target, "result.txt"), "done")
      await session.close()

      await expect(docs.readFile("result.txt")).resolves.toBe("done")
      await expect(docs.exists(".agent-runs/trace.json")).resolves.toBe(false)
      await expect(docs.list("", { recursive: true })).resolves.not.toEqual(expect.arrayContaining([
        expect.objectContaining({ path: ".vitehub/runtime.json" }),
      ]))
      await expect(docs.exists("AGENTS.md")).resolves.toBe(false)
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("materializes lazy Sources before opening the hosted Session", async () => {
    const docs = workspace()
    const onMaterializeProgress = vi.fn()
    const materializeSources = vi.fn(async (options?: WorkspaceMaterializeSourcesOptions) => {
      await options?.onProgress?.({ mountPath: "portal", path: options.path || "", source: "portal", status: "started" })
      await docs.writeFile("portal/details.md", "ready")
      await docs.snapshot({ name: "source" })
      return {
        bytes: 5,
        directories: 1,
        durationMs: 0,
        files: 1,
        path: options?.path || "",
        sources: [],
      }
    })
    const sandbox = localSandbox()
    const root = await sandbox.root
    const target = join(root, "workspace")

    try {
      const session = await prepareHarnessWorkspaceSession(facade(docs, materializeSources) as never, {
        onMaterializeProgress,
        paths: ["portal"],
        session: sandbox.session,
        sessionWorkDir: target,
      })
      await expect(readFile(join(target, "portal", "details.md"), "utf8")).resolves.toBe("ready")
      expect(materializeSources).toHaveBeenCalledWith(expect.objectContaining({ path: "portal" }))
      expect(onMaterializeProgress).toHaveBeenCalledOnce()
      await session.close()
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("refreshes the synthetic Git baseline after support files are added", async () => {
    const docs = workspace()
    const sandbox = localSandbox()
    const root = await sandbox.root
    const target = join(root, "workspace")

    try {
      const session = await prepareHarnessWorkspaceSession(facade(docs) as never, {
        session: sandbox.session,
        sessionWorkDir: target,
      })
      await writeFile(join(target, "AGENTS.md"), "instructions")
      await session.refreshGitBaseline()
      await expect(execAsync("git status --porcelain", { cwd: target })).resolves.toMatchObject({ stdout: "" })
      await session.close(new Error("support files are framework-owned"))
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})
