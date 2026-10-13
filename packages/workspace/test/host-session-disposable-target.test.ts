import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, posix } from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it, vi } from "vitest"
import { unknownExecutionAuthority } from "@vite-hub/runtime"

import { defineWorkspace } from "../src/core/define.ts"
import { createWorkspace } from "../src/core/workspace.ts"

import type { WorkspaceSessionHost, WorkspaceSessionHostFileEntry } from "../src/core/types.ts"

const execFileAsync = promisify(execFile)
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

function localHost(): WorkspaceSessionHost {
  return {
    executionAuthority: unknownExecutionAuthority,
    files: {
      async exists(path) {
        return await stat(path).then(() => true, () => false)
      },
      async list(path, options) {
        const entries: WorkspaceSessionHostFileEntry[] = []
        const excluded = options?.exclude || []
        async function visit(root: string) {
          for (const entry of await readdir(root, { withFileTypes: true })) {
            const path = join(root, entry.name)
            if (excluded.some(item => path === item || path.startsWith(`${item}/`))) continue
            const type = entry.isSymbolicLink() ? "symlink" : entry.isDirectory() ? "directory" : "file"
            const info = type === "file" ? await stat(path) : undefined
            entries.push({ path, ...(info ? { executable: Boolean(info.mode & 0o100), size: info.size } : {}), type })
            if (options?.recursive && type === "directory") await visit(path)
          }
        }
        await visit(path)
        return entries
      },
      async mkdir(path, options) {
        await mkdir(path, { recursive: options?.recursive })
      },
      async read(path) {
        return await readFile(path).then(content => new Uint8Array(content), () => null)
      },
      async remove(path, options) {
        await rm(path, { force: true, recursive: options?.recursive })
      },
      async write(path, content) {
        await mkdir(posix.dirname(path), { recursive: true })
        await writeFile(path, content)
      },
    },
    async exec(command, args = [], options = {}) {
      try {
        const result = await execFileAsync(command, [...args], { cwd: options.cwd, signal: options.signal })
        return { code: 0, stderr: result.stderr, stdout: result.stdout }
      }
      catch (error) {
        const failure = error as Error & { code?: number, stderr?: string, stdout?: string }
        return { code: typeof failure.code === "number" ? failure.code : 1, stderr: failure.stderr || failure.message, stdout: failure.stdout || "" }
      }
    },
  }
}

async function docsWorkspace() {
  const docs = createWorkspace({
    ...defineWorkspace({ store: { provider: "memory" } }),
    name: `disposable-${crypto.randomUUID()}`,
  })
  await docs.writeFile("README.md", "# Docs\n")
  await docs.writeFile("src/index.ts", "export {}\n")
  await docs.writeFile("bin/run", "#!/bin/sh\n", { metadata: { gitMode: "100755" } })
  await docs.snapshot({ name: "baseline" })
  return docs
}

async function target() {
  const root = await mkdtemp(join(tmpdir(), "vitehub-disposable-target-"))
  roots.push(root)
  return join(root, "workspace")
}

describe("hosted Workspace Sessions on a disposable target", () => {
  it.each([
    ["read-only", { writeBack: false as const }],
    ["write", {}],
  ])("does not restore the %s target on close", async (_mode, sessionOptions) => {
    const docs = await docsWorkspace()
    const host = localHost()
    const root = await target()
    const session = await docs.startSession({ ...sessionOptions, disposableTarget: true, host, target: root })
    await writeFile(join(root, "README.md"), "agent edit\n")
    await writeFile(join(root, "scratch.txt"), "agent file\n")
    const workspaceRead = vi.spyOn(docs, "readFile")
    const hostCalls = [
      vi.spyOn(host.files, "list"),
      vi.spyOn(host.files, "read"),
      vi.spyOn(host.files, "remove"),
      vi.spyOn(host.files, "write"),
    ]

    await session.close()

    expect(workspaceRead).not.toHaveBeenCalled()
    for (const call of hostCalls) expect(call).not.toHaveBeenCalled()
    await expect(readFile(join(root, "README.md"), "utf8")).resolves.toBe("agent edit\n")
    await expect(docs.readFile("README.md", { encoding: "utf8" })).resolves.toBe("# Docs\n")
    await expect(docs.exists("scratch.txt")).resolves.toBe(false)
    await expect(session.readFile("README.md")).rejects.toThrow("already closed")
  })

  it("keeps restoring a target that the caller does not mark as disposable", async () => {
    const docs = await docsWorkspace()
    const root = await target()
    const session = await docs.startSession({ host: localHost(), target: root, writeBack: false })
    await writeFile(join(root, "README.md"), "agent edit\n")

    await session.close()

    await expect(readFile(join(root, "README.md"), "utf8")).resolves.toBe("# Docs\n")
  })

  it("still publishes commits from a disposable target", async () => {
    const docs = await docsWorkspace()
    const root = await target()
    const session = await docs.startSession({ disposableTarget: true, host: localHost(), target: root })
    await writeFile(join(root, "README.md"), "committed\n")

    await expect(session.diff()).resolves.toMatchObject({ entries: [{ path: "README.md", type: "modified" }] })
    await session.commit({ message: "agent" })
    await session.close()

    await expect(docs.readFile("README.md", { encoding: "utf8" })).resolves.toBe("committed\n")
  })

  it("does not restore a disposable target after failed setup", async () => {
    const docs = await docsWorkspace()
    const host = localHost()
    const root = await target()
    const write = host.files.write.bind(host.files)
    let writes = 0
    host.files.write = async (path, content, options) => {
      if (++writes === 2) throw new Error("host write failed")
      await write(path, content, options)
    }
    const workspaceRead = vi.spyOn(docs, "readFile")

    await expect(docs.startSession({ disposableTarget: true, host, target: root })).rejects.toThrow("host write failed")

    expect(writes).toBe(2)
    expect(workspaceRead).toHaveBeenCalledTimes(2)
  })

  it("rejects a disposable target for an attached Session", async () => {
    const docs = await docsWorkspace()
    await expect(docs.startSession({ attach: true, disposableTarget: true, host: localHost(), target: await target() }))
      .rejects.toThrow("attach and disposableTarget cannot be combined")
  })
})

describe("hosted Workspace Session baselines", () => {
  it.each([
    { omitSize: false, content: "# Edit\n" },
    { omitSize: true, content: "# Edit\n" },
    { omitSize: true, content: "# Longer setup edit\n" },
  ])("captures setup edits before opening (omitSize=$omitSize, content=$content)", async ({ omitSize, content }) => {
    const docs = await docsWorkspace()
    const host = localHost()
    const root = await target()
    if (omitSize) {
      const list = host.files.list
      host.files.list = async (path, options) => (await list(path, options)).map(entry => {
        const { size: _size, ...withoutSize } = entry
        return withoutSize
      })
    }

    const session = await docs.startSession({
      host,
      target: root,
      async onProgress(event) {
        if (event.id === "workspace.prepare.read-files" && event.status === "completed")
          await writeFile(join(root, "README.md"), content)
      },
    })

    await expect(session.diff()).resolves.toMatchObject({ entries: [] })
    await session.commit()
    await expect(docs.readFile("README.md")).resolves.toBe("# Docs\n")
    await writeFile(join(root, "README.md"), "# Session edit\n")
    await expect(session.diff()).resolves.toMatchObject({ entries: [{ path: "README.md", type: "modified" }] })
    await session.commit()
    await expect(docs.readFile("README.md")).resolves.toBe("# Session edit\n")
    await session.close()
  })

  it("captures copied files and detects later Session edits", async () => {
    const docs = await docsWorkspace()
    const host = localHost()
    const read = vi.spyOn(host.files, "read")
    const root = await target()

    const session = await docs.startSession({ host, target: root })

    expect(read).toHaveBeenCalledTimes(3)
    await expect(session.diff()).resolves.toMatchObject({ entries: [] })
    await writeFile(join(root, "src/index.ts"), "export const changed = true\n")
    await expect(session.diff()).resolves.toMatchObject({ entries: [{ path: "src/index.ts", type: "modified" }] })
    await session.close()
    await expect(readFile(join(root, "src/index.ts"), "utf8")).resolves.toBe("export {}\n")
  })
})
