import { posix } from "node:path"
import { describe, expect, it } from "vitest"

import { defineWorkspace } from "../src/core/define.ts"
import { createWorkspace } from "../src/core/workspace.ts"

import type { WorkspaceSessionHost, WorkspaceSessionHostFileEntry } from "../src/core/types.ts"

function memoryHost(): WorkspaceSessionHost & { isExecutable(path: string): boolean, readText(path: string): string | undefined } {
  const files = new Map<string, Uint8Array>()
  const directories = new Set<string>(["/"])
  const executables = new Set<string>()
  const symlinks = new Map<string, string>()
  const normalize = (path: string) => posix.resolve("/", path)
  const parentDirectories = (path: string) => {
    let parent = posix.dirname(normalize(path))
    while (!directories.has(parent)) {
      directories.add(parent)
      parent = posix.dirname(parent)
    }
  }

  return {
    isExecutable(path) {
      return executables.has(normalize(path))
    },
    readText(path) {
      const content = files.get(normalize(path))
      return content && new TextDecoder().decode(content)
    },
    files: {
      async exists(path) {
        const target = normalize(path)
        return files.has(target) || directories.has(target) || symlinks.has(target)
      },
      async list(path, options) {
        const root = normalize(path)
        const prefix = root === "/" ? "/" : `${root}/`
        const entries: WorkspaceSessionHostFileEntry[] = []
        for (const directory of directories) {
          if (directory === root || !directory.startsWith(prefix)) continue
          const relative = directory.slice(prefix.length)
          if (!options?.recursive && relative.includes("/")) continue
          entries.push({ path: directory, type: "directory" })
        }
        for (const [file, content] of files) {
          if (!file.startsWith(prefix)) continue
          const relative = file.slice(prefix.length)
          if (!options?.recursive && relative.includes("/")) continue
          entries.push({ path: file, size: content.byteLength, type: "file" })
        }
        for (const file of symlinks.keys()) {
          if (!file.startsWith(prefix)) continue
          const relative = file.slice(prefix.length)
          if (!options?.recursive && relative.includes("/")) continue
          entries.push({ path: file, type: "symlink" })
        }
        return entries.sort((left, right) => left.path.localeCompare(right.path))
      },
      async mkdir(path) {
        const target = normalize(path)
        parentDirectories(target)
        directories.add(target)
      },
      async read(path) {
        const content = files.get(normalize(path))
        if (!content) throw new Error(`Missing host file: ${path}`)
        return content
      },
      async remove(path) {
        const target = normalize(path)
        files.delete(target)
        executables.delete(target)
        symlinks.delete(target)
        for (const file of [...files.keys()]) {
          if (file.startsWith(`${target}/`)) files.delete(file)
        }
        for (const directory of [...directories]) {
          if (directory === target || directory.startsWith(`${target}/`)) directories.delete(directory)
        }
        for (const link of [...symlinks.keys()]) {
          if (link.startsWith(`${target}/`)) symlinks.delete(link)
        }
      },
      async write(path, content) {
        const target = normalize(path)
        parentDirectories(target)
        symlinks.delete(target)
        files.set(target, content)
      },
    },
    async exec(command, args = [], options = {}) {
      const commandPath = (path: string) => path.startsWith("/") ? path : `${options.cwd || "/"}/${path}`
      if (command === "readlink") {
        const target = symlinks.get(normalize(commandPath(args[0] || "")))
        return target === undefined
          ? { code: 1, stderr: "not a symlink", stdout: "" }
          : { code: 0, stderr: "", stdout: `${target}\n` }
      }
      if (command === "ln" && args[0] === "-s") {
        const target = normalize(commandPath(args[2] || ""))
        symlinks.set(target, args[1] || "")
        files.delete(target)
        return { code: 0, stderr: "", stdout: "" }
      }
      if (command === "test" && args[0] === "-x")
        return { code: executables.has(normalize(commandPath(args[1] || ""))) ? 0 : 1, stderr: "", stdout: "" }
      if (command === "chmod" && args[0] === "+x") {
        executables.add(normalize(commandPath(args[1] || "")))
        return { code: 0, stderr: "", stdout: "" }
      }
      if (command !== "write") return { code: 127, stderr: `Unsupported command: ${command}`, stdout: "" }
      const cwd = options.cwd || "/"
      const target = normalize(posix.join(cwd, args[0] || ""))
      parentDirectories(target)
      files.set(target, new TextEncoder().encode(args[1] || ""))
      return { code: 0, stderr: "", stdout: "" }
    },
  }
}

function workspace() {
  return createWorkspace({
    ...defineWorkspace({ store: { provider: "memory" } }),
    name: "docs",
  })
}

describe("workspace host sessions", () => {
  it("discards an uncommitted basic session overlay", async () => {
    const docs = workspace()
    await docs.writeFile("README.md", "before")
    await docs.snapshot({ name: "baseline" })

    const session = await docs.startSession()
    await session.writeFile("README.md", "discarded")
    await session.writeFile("partial.txt", "discarded")
    await session.close()

    await expect(docs.readFile("README.md")).resolves.toBe("before")
    await expect(docs.exists("partial.txt")).resolves.toBe(false)
  })

  it("persists an explicitly committed basic session overlay", async () => {
    const docs = workspace()
    await docs.writeFile("README.md", "before")
    await docs.snapshot({ name: "baseline" })

    const session = await docs.startSession()
    await session.writeFile("README.md", "after")
    await session.commit({ message: "accepted" })
    await session.close()

    await expect(docs.readFile("README.md")).resolves.toBe("after")
  })

  it("materializes into a caller-supplied host and commits successful changes", async () => {
    const docs = workspace()
    await docs.writeFile("README.md", "before")
    await docs.snapshot({ name: "baseline" })

    const session = await docs.startSession({ host: memoryHost() })
    await expect(session.readFile("README.md")).resolves.toBe("before")
    expect(await session.exec("write", ["result.txt", "done"])).toMatchObject({ exitCode: 0 })
    await session.commit({ message: "success" })
    await session.close()

    await expect(docs.readFile("result.txt")).resolves.toBe("done")
  })

  it("leaves authoritative files unchanged when a failed run closes without commit", async () => {
    const docs = workspace()
    const host = memoryHost()
    await docs.writeFile("README.md", "before")
    await docs.snapshot({ name: "baseline" })

    const session = await docs.startSession({ host })
    await session.writeFile("README.md", "failed mutation")
    await session.writeFile("partial.txt", "discard me")
    await session.close()

    await expect(docs.readFile("README.md")).resolves.toBe("before")
    await expect(docs.exists("partial.txt")).resolves.toBe(false)
    expect(host.readText("/workspace/README.md")).toBe("before")
    expect(host.readText("/workspace/partial.txt")).toBeUndefined()
  })

  it("keeps unsafe symlinks inert and rejects writes through symlink parents", async () => {
    const docs = workspace()
    const host = memoryHost()
    await docs.writeFile("escape", "../../outside", { metadata: { gitMode: "120000" } })
    await docs.mkdir("target")
    await docs.snapshot({ name: "baseline" })

    const session = await docs.startSession({ host })
    expect(host.readText("/workspace/escape")).toBe("../../outside")
    await expect(session.readFile("escape")).resolves.toBe("../../outside")
    await session.writeFile("link", "target", { metadata: { gitMode: "120000" } })
    await expect(session.writeFile("link/escaped.txt", "blocked")).rejects.toThrow("symlink parent")
    await session.close()
  })

  it("preserves executable mode through materialization and commit", async () => {
    const docs = workspace()
    const host = memoryHost()
    await docs.writeFile("scripts/run.sh", "#!/bin/sh\n", { metadata: { gitMode: "100755" } })
    await docs.snapshot({ name: "baseline" })

    const session = await docs.startSession({ host })
    expect(host.isExecutable("/workspace/scripts/run.sh")).toBe(true)
    await session.writeFile("scripts/run.sh", "#!/bin/sh\necho ready\n")
    expect(host.isExecutable("/workspace/scripts/run.sh")).toBe(true)
    await session.commit({ message: "update executable" })
    await session.close()

    await expect(docs.stat("scripts/run.sh")).resolves.toMatchObject({ metadata: { gitMode: "100755" } })
  })

  it("attaches to a live host tree without resetting or owning its lifecycle", async () => {
    const docs = workspace()
    const host = memoryHost()
    await docs.writeFile("README.md", "authoritative")
    await docs.snapshot({ name: "baseline" })
    await host.files.mkdir("/workspace", { recursive: true })
    await host.files.write("/workspace/README.md", new TextEncoder().encode("live harness edit"))

    const session = await docs.startSession({ attach: true, host })
    await expect(session.readFile("README.md")).resolves.toBe("live harness edit")
    expect(await session.exec("write", ["result.txt", "done"])).toMatchObject({ exitCode: 0 })
    await session.commit({ message: "command result" })
    await session.close()

    expect(host.readText("/workspace/README.md")).toBe("live harness edit")
    expect(host.readText("/workspace/result.txt")).toBe("done")
    await expect(docs.readFile("README.md")).resolves.toBe("authoritative")
    await expect(docs.readFile("result.txt")).resolves.toBe("done")
  })

  it("rolls back only uncommitted changes from an attached session", async () => {
    const docs = workspace()
    const host = memoryHost()
    await host.files.mkdir("/workspace", { recursive: true })
    await host.files.write("/workspace/live.txt", new TextEncoder().encode("harness edit"))

    const session = await docs.startSession({ attach: true, host })
    await session.writeFile("live.txt", "command mutation")
    await session.writeFile("partial.txt", "discarded")
    await session.close()

    expect(host.readText("/workspace/live.txt")).toBe("harness edit")
    expect(host.readText("/workspace/partial.txt")).toBeUndefined()
  })

  it("keeps concurrent host changes outside an attached session scope", async () => {
    const docs = workspace()
    const host = memoryHost()
    await host.files.mkdir("/workspace/src", { recursive: true })
    await host.files.write("/workspace/README.md", new TextEncoder().encode("before"))
    await host.files.write("/workspace/src/index.ts", new TextEncoder().encode("before"))

    const session = await docs.startSession({ attach: true, host, paths: ["src"] })
    await session.writeFile("src/index.ts", "discarded")
    await host.files.write("/workspace/README.md", new TextEncoder().encode("concurrent edit"))
    await session.close()

    expect(host.readText("/workspace/README.md")).toBe("concurrent edit")
    expect(host.readText("/workspace/src/index.ts")).toBe("before")
  })

  it("resolves relative execution directories under the Workspace target", async () => {
    const docs = workspace()
    const host = memoryHost()
    const session = await docs.startSession({ host })
    await session.mkdir("src", { recursive: true })

    expect(await session.exec("write", ["result.txt", "done"], { cwd: "src" })).toMatchObject({ exitCode: 0 })
    expect(host.readText("/workspace/src/result.txt")).toBe("done")
    expect(host.readText("/src/result.txt")).toBeUndefined()
    await session.close()
  })

  it("rejects execution directories outside the Workspace target", async () => {
    const session = await workspace().startSession({ host: memoryHost() })

    await expect(session.exec("write", ["result.txt", "nope"], { cwd: "/tmp" }))
      .rejects.toThrow("Workspace exec cwd must stay inside /workspace")
    await session.close()
  })

  it("maps the portable /workspace cwd alias to a custom target", async () => {
    const host = memoryHost()
    const session = await workspace().startSession({ host, target: "/boxes/live" })

    await session.exec("write", ["result.txt", "done"], { cwd: "/workspace" })
    expect(host.readText("/boxes/live/result.txt")).toBe("done")
    await session.close()
  })

  it("resolves glob patterns from the requested working directory", async () => {
    const docs = workspace()
    await docs.writeFile("src/index.ts", "export {}")
    await docs.writeFile("src/nested/ignored.ts", "export {}")
    await docs.writeFile("outside.ts", "export {}")
    await docs.snapshot({ name: "baseline" })

    const session = await docs.startSession({ host: memoryHost() })
    await expect(session.glob("*.ts", { cwd: "src" })).resolves.toMatchObject([
      { path: "src/index.ts" },
    ])
    await session.close()
  })

  it("rejects execution runtime options on Workspace Definitions", () => {
    expect(() => defineWorkspace({ runtime: "sandbox" } as never)).toThrow("does not support option: runtime")
  })
})
