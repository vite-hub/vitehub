import { link, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { createClient } from "@libsql/client"
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/libsql"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createOperationRegistry, runOperation } from "@vite-hub/internal/operations"

import { createBlobStorage } from "../../blob/src/storage.ts"
import { createDriver } from "../../blob/src/drivers/fs.ts"

import { createBlobDatabaseWorkspaceStore, workspaceHistorySchema } from "../src/blob-database.ts"
import { formatWorkspaceStatus, localCheckoutStatus, mergeText } from "../src/checkout.ts"
import { workspaceCheckoutFeatures } from "../src/checkout-cli.ts"
import { registerWorkspace, resetWorkspaceRegistry } from "../src/core/registry.ts"
import { registerWorkspacePlugin, useWorkspace } from "../src/index.ts"
import { lineageDigest } from "../src/lineage.ts"
import { workspaceOperations } from "../src/operations.ts"
import { workspaceCommitRequestBytes } from "../src/results.ts"
import { createGitHubWorkspaceStore } from "../src/providers/github/store.ts"
import { createFakeGitHub } from "./fake-github.ts"
import { operationRpcBody, operationRpcRequest, operationRpcResponse } from "../../internal/test-utils/operation-rpc.ts"

import type { OperationUser } from "@vite-hub/internal/operations"
import type { WorkspaceDefinition, WorkspaceWriteCommit } from "../src/core/types.ts"

const cleanup: Array<() => Promise<void> | void> = []
const migration = await readFile(new URL("fixtures/history.sql", import.meta.url), "utf8")
const registry = createOperationRegistry([{ operations: workspaceOperations }])
const remote = "https://docs.example.test"
const pausedLockWrites = new Map<string, { entered: () => void, resume: Promise<void> }>()

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      const paused = pausedLockWrites.get(String(args[1]))
      if (paused) {
        pausedLockWrites.delete(String(args[1]))
        paused.entered()
        await paused.resume
      }
      return await actual.rename(...args)
    },
  }
})

afterEach(async () => {
  resetWorkspaceRegistry()
  vi.unstubAllGlobals()
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

async function tempDir(name: string) {
  const root = await mkdtemp(join(tmpdir(), `vitehub-checkout-${name}-`))
  cleanup.push(() => rm(root, { force: true, recursive: true }))
  return root
}

/** A deployed app with one Blob + Database Workspace, reached through the operation RPC as `user`. */
async function app(user: OperationUser | null = null, rules?: WorkspaceDefinition["rules"], workspace = "content") {
  const root = await tempDir("app")
  const client = createClient({ url: `file:${join(root, "history.sqlite")}` })
  cleanup.push(() => client.close())
  const database = drizzle({ client: client })
  for (const statement of migration.split(";").filter(statement => statement.trim())) await database.run(sql.raw(statement))
  const blob = createBlobStorage(createDriver({ driver: "fs", base: join(root, "objects") }))
  const definition: WorkspaceDefinition = { name: workspace, store: createBlobDatabaseWorkspaceStore({ blob, database, workspace }), rules }
  registerWorkspace(workspace, { store: definition.store, rules })
  const { history } = useWorkspace(workspace, { definition, mode: "write" })
  // A second Workspace of the same app.
  const notesDefinition: WorkspaceDefinition = { name: "notes", store: createBlobDatabaseWorkspaceStore({ blob, database, workspace: "notes" }) }
  registerWorkspace("notes", { store: notesDefinition.store })
  const notes = useWorkspace("notes", { definition: notesDefinition, mode: "write" }).history
  const calls: string[] = []
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url)).toBe(`${remote}/_vitehub/rpc`)
    const { input, operation } = operationRpcRequest(init!.body)
    calls.push(operation)
    // The operation RPC rejects a body over the request limit of the operation, 64 KiB by default.
    if (Buffer.byteLength(String(init!.body)) > (registry.get(operation)?.maxRequestBytes ?? 64 * 1_024)) {
      return operationRpcResponse(init!.body, { ok: false, code: "OPERATION_REQUEST_TOO_LARGE", message: "Operation request exceeds the byte limit.", status: 413 })
    }
    const result = await runOperation(registry, operation, input, { access: { mode: "local", sections: "all" }, surface: "cli", user })
    return operationRpcResponse(init!.body, result)
  }
  /** An edit in the Console: one commit on `draft`. */
  const edit = async (changes: { put?: Record<string, string | Uint8Array>, delete?: string[] }) => {
    const head = await history.head({ ref: "draft" })
    return await history.commit({ ref: "draft", ifHead: head?.id ?? null, changes, message: "Console edit" })
  }
  const read = async (path: string) => {
    const head = await history.head({ ref: "draft" })
    return await (await history.open(head!.id)).readFile(path, { encoding: "utf8" })
  }
  return { calls, edit, fetch: fetch as typeof globalThis.fetch, history, notes, read }
}

/** Runs `work` as if Node ran on `platform`. */
async function onPlatform<T>(platform: NodeJS.Platform, work: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!
  Object.defineProperty(process, "platform", { ...original, value: platform })
  try {
    return await work()
  }
  finally {
    Object.defineProperty(process, "platform", original)
  }
}

/** A project with the CLI commands, as `vitehub workspace <command>` runs them. */
async function project(fetch: typeof globalThis.fetch, name: string) {
  const rootDir = await tempDir(name)
  const features = workspaceCheckoutFeatures()
  const run = async (command: string, ...args: string[]) => {
    let stdout = ""
    let stderr = ""
    const code = await features.find(feature => feature.name === command)!.run(args, {
      cwd: rootDir,
      env: {},
      fetch,
      rootDir,
      stderr: { write: (chunk) => { stderr += String(chunk) } },
      stdout: { write: (chunk) => { stdout += String(chunk) } },
    })
    return { code, stderr, stdout }
  }
  const file = (path: string) => join(rootDir, "content", ...path.split("/"))
  return {
    rootDir,
    run,
    json: async (command: string, ...args: string[]) => {
      const result = await run(command, ...args, "--json")
      return { ...result, value: JSON.parse(result.stdout) }
    },
    read: async (path: string) => await readFile(file(path), "utf8"),
    write: async (path: string, content: string | Uint8Array) => {
      await mkdir(dirname(file(path)), { recursive: true })
      await writeFile(file(path), content)
    },
    remove: async (path: string) => await rm(file(path)),
    exists: async (path: string) => await readFile(file(path)).then(() => true, () => false),
    lock: async () => JSON.parse(await readFile(join(rootDir, "vitehub.lock"), "utf8")),
    /** What `vitehub status` shows for the checkouts: local only. */
    status: async () => (await localCheckoutStatus(rootDir))!,
  }
}

const post = (title: string, body: string) => `---\ntitle: ${title}\n---\n\n${body}\n`

describe("mergeText", () => {
  it("takes the side that changed a region and marks regions that both changed", () => {
    expect(mergeText("a\nb\nc\n", "A\nb\nc\n", "a\nb\nC\n")).toEqual({ conflicts: 0, text: "A\nb\nC\n" })
    expect(mergeText("a\nb\nc\n", "a\nB\nc\n", "a\nB\nc\n")).toEqual({ conflicts: 0, text: "a\nB\nc\n" })
    expect(mergeText("a\nb\nc\n", "a\nX\nc\n", "a\nY\nc\n")).toEqual({ conflicts: 1, text: "a\n<<<<<<< local\nX\n=======\nY\n>>>>>>> remote\nc\n" })
    expect(mergeText("", "local\n", "remote\n").conflicts).toBe(1)
    expect(mergeText("a\nb", "a\nb\nlocal", "z\na\nb")).toEqual({ conflicts: 0, text: "z\na\nb\nlocal" })
  })

  it("merges edits to adjacent lines and marks only the lines that both sides changed", () => {
    expect(mergeText("a\nb\n", "A\nb\n", "a\nB\n")).toEqual({ conflicts: 0, text: "A\nB\n" })
    expect(mergeText("a\nb\nc\n", "A\nX\nc\n", "a\nY\nC\n")).toEqual({ conflicts: 1, text: "A\n<<<<<<< local\nX\n=======\nY\n>>>>>>> remote\nC\n" })
    // An insertion next to the other side's edit has no single order, as in Git.
    expect(mergeText("a\nb\n", "a\nnew\nb\n", "a\nB\n").conflicts).toBe(1)
  })

  it("merges large files without a full line table", () => {
    const base = Array.from({ length: 20_000 }, (_, index) => `line ${index}\n`).join("")
    const local = base.replace("line 10\n", "local 10\n")
    const remote = base.replace("line 19990\n", "remote 19990\n")
    expect(mergeText(base, local, remote)).toEqual({ conflicts: 0, text: local.replace("line 19990\n", "remote 19990\n") })
    const shuffled = Array.from({ length: 5_000 }, (_, index) => `other ${index}\n`).join("")
    expect(mergeText(base, shuffled, `${base}end\n`).conflicts).toBe(1)
  })
})

describe("workspace checkout", { timeout: 60_000 }, () => {
  it.each([
    ["README", "readme"],
    ["Docs/a.md", "docs/b.md"],
    ["foo", "foo."],
    ["folder/a.md", "folder /b.md"],
    ["caf\u00e9/a.md", "cafe\u0301/b.md"],
    ["\u03a3/a.md", "\u03c2/b.md"],
  ])("rejects remote aliases %s and %s before writing any file", async (first, second) => {
    const remoteApp = await app()
    await remoteApp.edit({ put: { "0-safe.md": "safe\n", [first]: "first\n", [second]: "second\n" } })
    const local = await project(remoteApp.fetch, "aliases")

    const result = await local.run("pull", "content", "--dir", "content", "--ref", "draft", "--url", remote)

    expect(result.code).toBe(1)
    expect(result.stderr).toContain("WORKSPACE_CHECKOUT_PATH")
    expect(await local.exists("0-safe.md")).toBe(false)
    expect(await readFile(join(local.rootDir, "vitehub.lock")).then(() => true, () => false)).toBe(false)
  })

  it("rejects incoming aliases of unchanged remote paths and local directories without advancing the lock", async () => {
    const remoteApp = await app()
    await remoteApp.edit({ put: { "Docs/a.md": "base\n" } })
    const local = await project(remoteApp.fetch, "incremental-alias")
    await local.run("pull", "content", "--dir", "content", "--ref", "draft", "--url", remote)
    const before = await local.lock()
    await remoteApp.edit({ put: { "0-safe.md": "new\n", "docs/b.md": "remote\n" } })
    expect((await local.run("pull")).stderr).toContain("WORKSPACE_CHECKOUT_PATH")
    expect(await local.lock()).toEqual(before)
    expect(await local.read("Docs/a.md")).toBe("base\n")
    expect(await local.exists("0-safe.md")).toBe(false)

    await remoteApp.edit({ delete: ["docs/b.md"], put: { "drafts/remote.md": "remote\n" } })
    await local.write("Drafts/local.md", "local\n")
    expect((await local.run("push")).stderr).toContain("WORKSPACE_CHECKOUT_PATH")
    expect(await local.lock()).toEqual(before)
    expect(await local.read("Drafts/local.md")).toBe("local\n")
    expect(remoteApp.calls).not.toContain("workspace.commit")
  })

  it("checks empty local directories and --theirs paths for aliases", async () => {
    const remoteApp = await app()
    await remoteApp.edit({ put: { "docs/a.md": "base\n" } })
    const local = await project(remoteApp.fetch, "empty-directory-alias")
    await local.run("pull", "content", "--dir", "content", "--ref", "draft", "--url", remote)
    const before = await local.lock()
    const calls = remoteApp.calls.length
    expect((await local.run("pull", "--theirs", "Docs/a.md")).stderr).toContain("WORKSPACE_CHECKOUT_PATH")
    expect(remoteApp.calls.slice(calls)).toEqual(["workspace.changes"])
    await mkdir(join(local.rootDir, "content", "Drafts"))
    await remoteApp.edit({ put: { "drafts/new.md": "remote\n" } })
    expect((await local.run("pull")).stderr).toContain("WORKSPACE_CHECKOUT_PATH")
    expect(await local.exists("drafts/new.md")).toBe(false)
    expect(await local.lock()).toEqual(before)
  })

  it.each(["aux.txt", "file:stream", "file?", "trailing ", "__proto__", "constructor", "prototype"])("rejects unsupported remote path %s before writing", async (path) => {
    const remoteApp = await app()
    await remoteApp.edit({ put: { "0-safe.md": "safe\n", [path]: "remote\n" } })
    const local = await project(remoteApp.fetch, "nonportable")
    expect((await local.run("pull", "content", "--dir", "content", "--ref", "draft", "--url", remote)).stderr).toContain("WORKSPACE_CHECKOUT_PATH")
    expect(await local.exists("0-safe.md")).toBe(false)
  })

  it("refuses a directory-to-file replacement before deleting files or advancing the lock", async () => {
    const remoteApp = await app()
    await remoteApp.edit({ put: { "docs/a.md": "base\n" } })
    const local = await project(remoteApp.fetch, "directory-replacement")
    await local.run("pull", "content", "--dir", "content", "--ref", "draft", "--url", remote)
    const before = await local.lock()
    await remoteApp.edit({ delete: ["docs/a.md"], put: { docs: "new file\n" } })

    expect((await local.run("pull")).stderr).toContain("WORKSPACE_CHECKOUT_PATH")
    expect(await local.read("docs/a.md")).toBe("base\n")
    expect(await local.lock()).toEqual(before)
  })

  it.each(["__proto__", "constructor", "toString"])("pulls, pushes, and reloads a Workspace named %s", async (name) => {
    const remoteApp = await app(null, undefined, name)
    await remoteApp.edit({ put: { "hello.md": "base\n" } })
    const local = await project(remoteApp.fetch, "own-workspace-name")
    expect((await local.run("pull", name, "--dir", "content", "--ref", "draft", "--url", remote)).code).toBe(0)
    expect(Object.keys((await local.lock()).workspaces)).toEqual([name])
    await local.write("hello.md", "local\n")
    expect((await local.run("push", name)).code).toBe(0)
    expect(await remoteApp.read("hello.md")).toBe("local\n")
    expect((await local.status())[0]).toMatchObject({ workspace: name, local: { added: [], modified: [], deleted: [] } })
    expect((await local.run("resolve", name)).code).toBe(0)
  })

  it("tracks file names that match Object properties when another file is normalized", async () => {
    const remoteApp = await app(null, { "note.txt": { write: true, validate: input => ({ ...input, content: String(input.content).toUpperCase() }) } })
    const paths = ["toString", "note.txt"]
    await remoteApp.edit({ put: Object.fromEntries(paths.map(path => [path, "BASE\n"])) })
    const local = await project(remoteApp.fetch, "own-file-name")
    expect((await local.run("pull", "content", "--dir", "content", "--ref", "draft", "--url", remote)).code).toBe(0)
    for (const path of paths) await local.write(path, "local\n")
    expect((await local.run("push")).code).toBe(0)
    expect(Object.keys((await local.lock()).workspaces.content.files).sort()).toEqual(paths.toSorted())
    expect(await remoteApp.read("toString")).toBe("local\n")
    expect(await local.read("note.txt")).toBe("LOCAL\n")
    expect((await local.status())[0]!.local).toEqual({ added: [], modified: [], deleted: [], conflicted: [] })
  })

  it("clones a ref into a folder and records the remote revision in vitehub.lock", async () => {
    const remoteApp = await app()
    const first = await remoteApp.edit({ put: { "posts/hello.md": post("Hello", "First post."), "media/logo.bin": new Uint8Array([0, 255, 1]) } })
    const local = await project(remoteApp.fetch, "clone")

    const pulled = await local.run("pull", "content", "--dir", "content", "--ref", "draft", "--url", remote)

    expect(pulled.code).toBe(0)
    expect(pulled.stdout).toContain("added    posts/hello.md")
    expect(await local.read("posts/hello.md")).toBe(post("Hello", "First post."))
    expect(new Uint8Array(await readFile(join(local.rootDir, "content/media/logo.bin")))).toEqual(new Uint8Array([0, 255, 1]))
    expect(await local.lock()).toEqual({
      version: 1,
      workspaces: {
        content: {
          dir: "content",
          ref: "draft",
          remote,
          head: first.id,
          files: { "media/logo.bin": expect.stringMatching(/^sha256-/), "posts/hello.md": expect.stringMatching(/^sha256-/) },
        },
      },
    })
    expect((await local.run("pull")).stdout).toBe(`content: up to date with draft (${first.id}).\n`)
  })

  it("pushes local edits, additions, and deletions in one revision", async () => {
    const remoteApp = await app()
    await remoteApp.edit({ put: { "posts/hello.md": post("Hello", "First post."), "posts/old.md": post("Old", "Remove me.") } })
    const local = await project(remoteApp.fetch, "push")
    await local.run("pull", "content", "--dir", "content", "--ref", "draft", "--url", remote)

    await local.write("posts/hello.md", post("Hello", "Edited locally."))
    await local.write("posts/new.md", post("New", "Added locally."))
    await local.remove("posts/old.md")
    const status = await local.status()
    expect(status[0]!.local).toEqual({ added: ["posts/new.md"], conflicted: [], deleted: ["posts/old.md"], modified: ["posts/hello.md"] })

    const pushed = await local.json("push", "--message", "Write locally")

    expect(pushed.code).toBe(0)
    expect(pushed.value[0]).toMatchObject({ pushed: ["posts/hello.md", "posts/new.md", "posts/old.md"], ref: "draft" })
    const head = await remoteApp.history.head({ ref: "draft" })
    expect(head).toMatchObject({ id: pushed.value[0].revision, message: "Write locally" })
    expect(await remoteApp.read("posts/hello.md")).toBe(post("Hello", "Edited locally."))
    expect(await remoteApp.read("posts/new.md")).toBe(post("New", "Added locally."))
    await expect(remoteApp.read("posts/old.md")).rejects.toThrow()
    expect((await local.lock()).workspaces.content.head).toBe(head!.id)
    expect((await local.status())[0]!.local).toEqual({ added: [], conflicted: [], deleted: [], modified: [] })
    expect((await local.run("push")).stdout).toBe("content: nothing to push.\n")
  })

  it("merges Console edits of other files and other lines before it pushes", async () => {
    const remoteApp = await app()
    await remoteApp.edit({ put: { "posts/hello.md": post("Hello", "One.\n\nTwo.\n\nThree."), "posts/other.md": post("Other", "Text.") } })
    const local = await project(remoteApp.fetch, "merge")
    await local.run("pull", "content", "--dir", "content", "--ref", "draft", "--url", remote)

    await remoteApp.edit({ put: { "posts/hello.md": post("Hello", "One, edited in the Console.\n\nTwo.\n\nThree."), "posts/other.md": post("Other", "Console text.") } })
    await local.write("posts/hello.md", post("Hello", "One.\n\nTwo.\n\nThree, edited locally."))
    const dryRun = await local.json("pull", "--dry-run")
    expect(dryRun.value[0].local.modified).toEqual(["posts/hello.md"])
    expect(dryRun.value[0].remoteChanges).toEqual([
      { change: "changed", path: "posts/hello.md" },
      { change: "changed", path: "posts/other.md" },
    ])

    const pushed = await local.run("push")

    expect(pushed.code).toBe(0)
    expect(pushed.stdout).toContain("merged   posts/hello.md")
    expect(pushed.stdout).toContain("updated  posts/other.md")
    const merged = post("Hello", "One, edited in the Console.\n\nTwo.\n\nThree, edited locally.")
    expect(await local.read("posts/hello.md")).toBe(merged)
    expect(await local.read("posts/other.md")).toBe(post("Other", "Console text."))
    expect(await remoteApp.read("posts/hello.md")).toBe(merged)
  })

  it("writes conflict markers when both sides change the same line, and refuses to push until they are gone", async () => {
    const remoteApp = await app()
    await remoteApp.edit({ put: { "posts/hello.md": post("Hello", "Same line.") } })
    const local = await project(remoteApp.fetch, "conflict")
    await local.run("pull", "content", "--dir", "content", "--ref", "draft", "--url", remote)
    const consoleEdit = await remoteApp.edit({ put: { "posts/hello.md": post("Hello", "Console line.") } })
    await local.write("posts/hello.md", post("Hello", "Local line."))

    const pulled = await local.run("pull")

    expect(pulled.code).toBe(1)
    expect(pulled.stdout).toContain("conflict posts/hello.md")
    expect(await local.read("posts/hello.md")).toBe(`---\ntitle: Hello\n---\n\n<<<<<<< local\nLocal line.\n=======\nConsole line.\n>>>>>>> draft ${consoleEdit.id}\n`)
    expect((await local.status())[0]!.local.conflicted).toEqual(["posts/hello.md"])
    expect(formatWorkspaceStatus((await local.status())[0]!)).toContain("  conflict  posts/hello.md")
    const refused = await local.run("push")
    expect(refused).toMatchObject({ code: 1, stderr: expect.stringContaining("WORKSPACE_CHECKOUT_CONFLICT") })
    expect((await remoteApp.history.head({ ref: "draft" }))!.id).toBe(consoleEdit.id)

    await local.write("posts/hello.md", post("Hello", "Local and Console line."))
    expect((await local.status())[0]!.local.conflicted).toEqual([])
    expect((await local.run("push")).code).toBe(0)
    expect(await remoteApp.read("posts/hello.md")).toBe(post("Hello", "Local and Console line."))
  })

  it("keeps a local file for a binary conflict until resolve, and takes the remote file with --theirs", async () => {
    const remoteApp = await app()
    await remoteApp.edit({ put: { "media/a.bin": new Uint8Array([0, 255, 1]), "media/b.bin": new Uint8Array([0, 255, 2]) } })
    const local = await project(remoteApp.fetch, "binary")
    await local.run("pull", "content", "--dir", "content", "--ref", "draft", "--url", remote)
    await remoteApp.edit({ put: { "media/a.bin": new Uint8Array([0, 255, 9]), "media/b.bin": new Uint8Array([0, 255, 9]) } })
    await local.write("media/a.bin", new Uint8Array([0, 255, 7]))
    await local.write("media/b.bin", new Uint8Array([0, 255, 7]))

    expect((await local.run("pull")).code).toBe(1)
    expect((await local.lock()).workspaces.content.conflicts).toEqual(["media/a.bin", "media/b.bin"])
    expect((await local.run("push")).code).toBe(1)

    expect((await local.run("pull", "--theirs", "media/b.bin")).code).toBe(0)
    expect(new Uint8Array(await readFile(join(local.rootDir, "content/media/b.bin")))).toEqual(new Uint8Array([0, 255, 9]))
    expect((await local.run("resolve", "content", "media/a.bin")).stdout).toBe("Resolved: media/a.bin\n")
    expect((await local.run("push")).code).toBe(0)
    const head = await remoteApp.history.head({ ref: "draft" })
    const view = await remoteApp.history.open(head!.id)
    expect(await view.readFile("media/a.bin", { encoding: "binary" })).toEqual(new Uint8Array([0, 255, 7]))
    expect(await view.readFile("media/b.bin", { encoding: "binary" })).toEqual(new Uint8Array([0, 255, 9]))
  })

  it("keeps a local edit of a file that the remote deleted, and restores a remote edit of a file deleted locally", async () => {
    const remoteApp = await app()
    await remoteApp.edit({ put: { "posts/kept.md": post("Kept", "One."), "posts/back.md": post("Back", "One.") } })
    const local = await project(remoteApp.fetch, "deletes")
    await local.run("pull", "content", "--dir", "content", "--ref", "draft", "--url", remote)
    await remoteApp.edit({ delete: ["posts/kept.md"], put: { "posts/back.md": post("Back", "Two.") } })
    await local.write("posts/kept.md", post("Kept", "Edited."))
    await local.remove("posts/back.md")

    const pulled = await local.json("pull")

    expect(pulled.value[0].files).toEqual([
      { action: "updated", note: expect.stringContaining("You deleted this file"), path: "posts/back.md" },
      { action: "kept", note: expect.stringContaining("The remote deleted this file"), path: "posts/kept.md" },
    ])
    expect(await local.read("posts/back.md")).toBe(post("Back", "Two."))
    expect((await local.status())[0]!.local.added).toEqual(["posts/kept.md"])
  })

  it("brings one clone's push to a second clone", async () => {
    const remoteApp = await app()
    await remoteApp.edit({ put: { "posts/hello.md": post("Hello", "One.") } })
    const alice = await project(remoteApp.fetch, "alice")
    const bob = await project(remoteApp.fetch, "bob")
    await alice.run("pull", "content", "--dir", "content", "--ref", "draft", "--url", remote)
    await bob.run("pull", "content", "--dir", "content", "--ref", "draft", "--url", remote)

    await alice.write("posts/alice.md", post("Alice", "Hi."))
    await bob.write("posts/bob.md", post("Bob", "Hi."))
    expect((await alice.run("push")).code).toBe(0)
    // Bob's push pulls Alice's file first: his base moved, but no path collides.
    expect((await bob.run("push")).code).toBe(0)
    expect(await bob.exists("posts/alice.md")).toBe(true)
    await alice.run("pull")
    expect(await alice.read("posts/bob.md")).toBe(post("Bob", "Hi."))
    expect((await alice.lock()).workspaces.content.head).toBe((await bob.lock()).workspaces.content.head)
  })

  it("pulls again and retries when another push lands between its pull and its commit", async () => {
    const remoteApp = await app()
    await remoteApp.edit({ put: { "posts/hello.md": post("Hello", "One.") } })
    const local = await project(async (url, init) => {
      const body = operationRpcRequest(init!.body)
      // The first commit races a Console save of another file.
      if (body.operation === "workspace.commit" && !raced) {
        raced = true
        await remoteApp.edit({ put: { "posts/race.md": post("Race", "Console.") } })
      }
      return await remoteApp.fetch(url, init)
    }, "race")
    let raced = false
    await local.run("pull", "content", "--dir", "content", "--ref", "draft", "--url", remote)
    await local.write("posts/hello.md", post("Hello", "Local."))

    const pushed = await local.json("push")

    expect(pushed.code).toBe(0)
    expect(await local.read("posts/race.md")).toBe(post("Race", "Console."))
    expect(await remoteApp.read("posts/hello.md")).toBe(post("Hello", "Local."))
    expect(await remoteApp.read("posts/race.md")).toBe(post("Race", "Console."))
  })

  it("pulls the files that the Store copied into a new ref on its first push", async () => {
    const remoteApp = await app()
    // As the GitHub Store does, the first commit to a ref that does not exist starts it from the files of another ref.
    const local = await project(async (url, init) => {
      const body = operationRpcRequest(init!.body) as { operation: string, input: { ifHead: string | null } }
      if (body.operation === "workspace.commit" && body.input.ifHead === null) {
        const base = await remoteApp.edit({ put: { "posts/base.md": post("Base", "Published.") } })
        body.input.ifHead = base.id
        return await remoteApp.fetch(url, { ...init, body: operationRpcBody(body.operation, body.input, String(JSON.parse(String(init!.body)).i)) })
      }
      return await remoteApp.fetch(url, init)
    }, "new-ref")
    await local.run("pull", "content", "--dir", "content", "--ref", "draft", "--url", remote)
    await local.write("posts/local.md", post("Local", "New."))

    const pushed = await local.json("push")

    expect(pushed.code).toBe(0)
    expect(pushed.value[0].pushed).toEqual(["posts/local.md"])
    expect(pushed.value[0].after.files).toEqual([{ path: "posts/base.md", action: "added" }])
    expect(await local.read("posts/base.md")).toBe(post("Base", "Published."))
    const entry = (await local.lock()).workspaces.content
    expect(entry.head).toBe(pushed.value[0].revision)
    expect(Object.keys(entry.files).sort()).toEqual(["posts/base.md", "posts/local.md"])
    expect((await local.status())[0]!.local).toEqual({ added: [], modified: [], deleted: [], conflicted: [] })
  })

  it("refuses to write through a symbolic link, and to push while the folder has one", async () => {
    const remoteApp = await app()
    await remoteApp.edit({ put: { "posts/hello.md": post("Hello", "One.") } })
    const local = await project(remoteApp.fetch, "symlink")
    await local.run("pull", "content", "--dir", "content", "--ref", "draft", "--url", remote)
    const outside = await tempDir("outside")
    await writeFile(join(outside, "secret.md"), "keep\n")
    await symlink(outside, join(local.rootDir, "content", "linked"))
    await remoteApp.edit({ put: { "linked/secret.md": "overwritten\n" } })

    const pulled = await local.run("pull")

    expect(pulled).toMatchObject({ code: 1, stderr: expect.stringContaining("WORKSPACE_CHECKOUT_SYMLINK") })
    expect(await readFile(join(outside, "secret.md"), "utf8")).toBe("keep\n")
    expect((await local.run("push")).stderr).toContain("WORKSPACE_CHECKOUT_SYMLINK")

    // The checkout folder itself is a link.
    const other = await project(remoteApp.fetch, "symlink-folder")
    await symlink(outside, join(other.rootDir, "content"))
    expect((await other.run("pull", "content", "--dir", "content", "--ref", "draft", "--url", remote)).stderr).toContain("content is a symbolic link")
    expect(await readFile(join(outside, "secret.md"), "utf8")).toBe("keep\n")
    await expect(readFile(join(outside, "posts/hello.md"))).rejects.toThrow()
  })

  it("lists stale translations in status and in workspace.stale after the English source changes", async () => {
    const remoteApp = await app()
    const english = post("Guide", "Install it.")
    const spanish = (digest: string) => `---\ntitle: Guía\nderivedFrom:\n  path: docs/en/guide.md\n  digest: ${digest}\n---\n\nInstálalo.\n`
    const translated = lineageDigest(new TextEncoder().encode(english))
    await remoteApp.edit({ put: { "docs/en/guide.md": english, "docs/es/guide.md": spanish(translated) } })
    const local = await project(remoteApp.fetch, "lineage")
    await local.run("pull", "content", "--dir", "content", "--ref", "draft", "--url", remote)
    expect((await local.status())[0]!.stale).toEqual([])

    const written: string[] = []
    cleanup.push(registerWorkspacePlugin("content", { hooks: { "write:after": ({ path, ref }) => { written.push(`${ref} ${path}`) } }, id: "translate" }))
    const edited = post("Guide", "Install it with pnpm.")
    await local.write("docs/en/guide.md", edited)
    expect(formatWorkspaceStatus((await local.status())[0]!)).toContain("Stale derived files (their source changed):\n  changed   docs/es/guide.md <- docs/en/guide.md")
    expect((await local.run("push")).code).toBe(0)
    // A translator starts from this hook.
    expect(written).toEqual(["draft docs/en/guide.md"])

    const listed = await runOperation(registry, "workspace.stale", { ref: "draft", workspace: "content" }, { access: { mode: "local", sections: "all" }, surface: "cli", user: null })
    const sourceDigest = lineageDigest(new TextEncoder().encode(edited))
    expect(listed).toMatchObject({ ok: true, value: { ref: "draft", stale: [{ derivedFrom: { digest: translated, path: "docs/en/guide.md" }, path: "docs/es/guide.md", reason: "changed", sourceDigest }] } })

    // The translator updates the file and records the digest that workspace.stale reported.
    await local.write("docs/es/guide.md", spanish(sourceDigest))
    expect((await local.status())[0]!.stale).toEqual([])
  })

  it.each([
    { dir: "content", linked: "content", target: "" },
    { dir: "parent/content", linked: "parent", target: "content" },
  ])("refuses a linked $linked with an unchanged remote head", async ({ dir, linked, target }) => {
    const remoteApp = await app()
    const head = await remoteApp.edit({ put: { "posts/hello.md": post("Hello", "One.") } })
    const local = await project(remoteApp.fetch, "linked-root")
    expect((await local.run("pull", "content", "--dir", dir, "--ref", "draft", "--url", remote)).code).toBe(0)
    const outside = await tempDir("outside-root")
    await mkdir(join(outside, target), { recursive: true })
    await writeFile(join(outside, target, "secret.md"), "keep\n")
    await rm(join(local.rootDir, linked), { recursive: true })
    await symlink(outside, join(local.rootDir, linked))

    expect((await local.run("push")).stderr).toContain("WORKSPACE_CHECKOUT_SYMLINK")
    expect((await local.run("pull")).stderr).toContain("WORKSPACE_CHECKOUT_SYMLINK")
    await expect(local.status()).rejects.toMatchObject({ code: "WORKSPACE_CHECKOUT_SYMLINK" })
    expect(remoteApp.calls).not.toContain("workspace.commit")
    expect((await remoteApp.history.head({ ref: "draft" }))?.id).toBe(head.id)
    expect(await readFile(join(outside, target, "secret.md"), "utf8")).toBe("keep\n")
  })

  it("leaves ignored paths out of pulls, status, and pushes, including older lock entries", async () => {
    const remoteApp = await app()
    const ignored = ["node_modules/pkg/index.js", "nested/node_modules/pkg/index.js", ".DS_Store", "nested/.DS_Store"]
    await remoteApp.edit({ put: { "posts/hello.md": post("Hello", "One."), ...Object.fromEntries(ignored.map(path => [path, "remote\n"])) } })
    const local = await project(remoteApp.fetch, "ignored")
    await local.write(ignored[0]!, "local dependency\n")

    const pulled = await local.json("pull", "content", "--dir", "content", "--ref", "draft", "--url", remote)

    expect(pulled.code).toBe(0)
    expect(pulled.value[0].files).toEqual([{ action: "added", path: "posts/hello.md" }])
    expect(Object.keys((await local.lock()).workspaces.content.files)).toEqual(["posts/hello.md"])
    expect(await local.read(ignored[0]!)).toBe("local dependency\n")
    for (const path of ignored.slice(1)) expect(await local.exists(path)).toBe(false)

    const head = await remoteApp.edit({ put: Object.fromEntries(ignored.map(path => [path, "updated remote\n"])) })
    const lockBefore = await readFile(join(local.rootDir, "vitehub.lock"), "utf8")
    const dry = await local.json("pull", "--dry-run")
    expect(dry.value[0].remoteChanges).toEqual([])
    expect(await readFile(join(local.rootDir, "vitehub.lock"), "utf8")).toBe(lockBefore)
    expect((await local.run("push")).stdout).toContain("nothing to push")
    expect((await remoteApp.history.head({ ref: "draft" }))?.id).toBe(head.id)
    expect((await local.run("pull", "--theirs", ignored[0]!)).stderr).toContain("WORKSPACE_CHECKOUT_PATH")
    expect(await local.read(ignored[0]!)).toBe("local dependency\n")

    // Locks written before ignored remote paths were excluded must not turn them into deletions.
    const lock = await local.lock()
    for (const path of ignored) lock.workspaces.content.files[path] = "sha256-previous"
    lock.workspaces.content.conflicts = ignored
    await writeFile(join(local.rootDir, "vitehub.lock"), JSON.stringify(lock))
    expect((await local.status())[0]!.local).toEqual({ added: [], conflicted: [], deleted: [], modified: [] })
    await local.write("posts/hello.md", post("Hello", "Local."))
    const pushed = await local.json("push")
    expect(pushed.code).toBe(0)
    expect(pushed.value[0].pushed).toEqual(["posts/hello.md"])
    for (const path of ignored) expect(await remoteApp.read(path)).toBe("updated remote\n")
  })

  it.each([
    { first: "content", second: "content" },
    { first: "content", second: "content/../content" },
    { first: "content", second: "content/nested" },
    { first: "content/nested", second: "content" },
  ])("rejects overlapping checkout folders $first and $second", async ({ first, second }) => {
    const remoteApp = await app()
    await remoteApp.edit({ put: { "hello.md": "Hello\n" } })
    const local = await project(remoteApp.fetch, "overlap")
    expect((await local.run("pull", "content", "--dir", first, "--ref", "draft", "--url", remote)).code).toBe(0)
    const calls = remoteApp.calls.length
    const lockBefore = await readFile(join(local.rootDir, "vitehub.lock"), "utf8")

    expect((await local.run("pull", "other", "--dir", second, "--url", remote)).stderr).toContain("WORKSPACE_CHECKOUT_OVERLAP")
    expect(remoteApp.calls).toHaveLength(calls)
    expect(await readFile(join(local.rootDir, "vitehub.lock"), "utf8")).toBe(lockBefore)

    // Loading an edited lock must reject the same overlap before scanning or contacting either Workspace.
    const lock = await local.lock()
    lock.workspaces.other = { ...lock.workspaces.content, dir: second }
    await writeFile(join(local.rootDir, "vitehub.lock"), JSON.stringify(lock))
    await expect(local.status()).rejects.toMatchObject({ code: "WORKSPACE_CHECKOUT_OVERLAP" })
    expect((await local.run("push")).stderr).toContain("WORKSPACE_CHECKOUT_OVERLAP")
    expect((await local.run("pull")).stderr).toContain("WORKSPACE_CHECKOUT_OVERLAP")
    expect(remoteApp.calls).toHaveLength(calls)
  })

  it("keeps inherited file attributes on the first push to a fork", async () => {
    const github = createFakeGitHub()
    vi.stubGlobal("fetch", github.fetch)
    github.commit("main", { "run.sh": { content: "echo published\n", mode: "100755" } })
    const store = createGitHubWorkspaceStore({ provider: "github", repository: "onmax/repo", token: "token", root: "", refs: { published: "main", draft: "vitehub/content" } }, "content")
    const attributes: unknown[] = []
    registerWorkspace("content", { store, rules: { "**": { write: true, validate: (input) => {
      attributes.push(input.metadata)
      return input
    } } } })
    const local = await project(async (_url, init) => {
      const { operation, input } = operationRpcRequest(init!.body)
      const result = await runOperation(registry, operation, input, { access: { mode: "local", sections: "all" }, surface: "cli", user: null })
      return operationRpcResponse(init!.body, result, { status: 200 })
    }, "fork-attributes")
    expect((await local.run("pull", "content", "--dir", "content", "--ref", "draft", "--url", remote)).code).toBe(0)
    await local.write("run.sh", "echo local\n")

    expect(await local.run("push")).toMatchObject({ code: 0, stderr: "" })
    expect(attributes).toEqual([{ gitMode: "100755" }])
    expect(github.tree("vitehub/content").find(file => file.path === "run.sh")).toMatchObject({ mode: "100755" })
    expect(await local.read("run.sh")).toBe("echo local\n")
  })

  it.each([false, true])("reconciles validator output with the checkout baseline (restore base: %s)", async (restoreBase) => {
    const remoteApp = await app(null, { "**": { write: true, validate: input => ({ ...input, content: restoreBase ? "BASE\n" : String(input.content).toUpperCase() }) } })
    await remoteApp.edit({ put: { "note.txt": "BASE\n" } })
    const local = await project(remoteApp.fetch, "normalized")
    await local.run("pull", "content", "--dir", "content", "--ref", "draft", "--url", remote)
    await local.write("note.txt", "edited\n")

    expect(await local.run("push")).toMatchObject({ code: 0, stderr: "" })
    expect(await local.read("note.txt")).toBe(await remoteApp.read("note.txt"))
    expect((await local.status())[0]!.local).toEqual({ added: [], modified: [], deleted: [], conflicted: [] })
    expect((await local.run("pull")).code).toBe(0)
    expect(await local.read("note.txt")).toBe(restoreBase ? "BASE\n" : "EDITED\n")
    expect((await local.run("push")).stdout).toBe("content: nothing to push.\n")
  })

  it("keeps edits made during a push as local changes against the validator output", async () => {
    const remoteApp = await app(null, { "**": { write: true, validate: input => ({ ...input, content: String(input.content).toUpperCase() }) } })
    await remoteApp.edit({ put: { "note.txt": "BASE\n" } })
    const local = await project(async (url, init) => {
      const response = await remoteApp.fetch(url, init)
      if (operationRpcRequest(init!.body).operation === "workspace.commit") await local.write("note.txt", "edited again\n")
      return response
    }, "edit-during-push")
    await local.run("pull", "content", "--dir", "content", "--ref", "draft", "--url", remote)
    await local.write("note.txt", "edited\n")

    expect(await local.run("push")).toMatchObject({ code: 0, stderr: "" })
    expect(await remoteApp.read("note.txt")).toBe("EDITED\n")
    expect(await local.read("note.txt")).toBe("edited again\n")
    expect((await local.status())[0]!.local.modified).toEqual(["note.txt"])
    expect((await local.run("pull")).code).toBe(0)
    expect(await local.read("note.txt")).toBe("edited again\n")
  })

  it.each([
    { command: "pull", args: ["content"] },
    { command: "push", args: ["content"] },
    { command: "pull", args: ["--dry-run"] },
    { command: "push", args: [] },
  ])("rejects a changed --url on $command $args before calling another remote", async ({ command, args }) => {
    const remoteApp = await app()
    await remoteApp.edit({ put: { "note.txt": "base\n" } })
    const local = await project(remoteApp.fetch, "remote-mismatch")
    await local.run("pull", "content", "--dir", "content", "--ref", "draft", "--url", remote)
    await local.write("note.txt", "local\n")
    const before = await local.lock()
    const calls = remoteApp.calls.length

    expect(await local.run(command, ...args, "--url", "https://other.example.test")).toMatchObject({ code: 1, stderr: expect.stringContaining("WORKSPACE_CHECKOUT_OPTIONS") })
    expect(remoteApp.calls).toHaveLength(calls)
    expect(await local.lock()).toEqual(before)
    expect(await local.read("note.txt")).toBe("local\n")
  })

  it("keeps the media type and metadata of a file that a push replaces", async () => {
    const remoteApp = await app()
    const head = await remoteApp.history.head({ ref: "draft" })
    await remoteApp.history.commit({
      ref: "draft",
      ifHead: head?.id ?? null,
      changes: { put: { "posts/hello.md": { content: post("Hello", "One."), mediaType: "text/x-post", metadata: { locale: "en", tags: ["intro"] } } } },
    })
    const local = await project(remoteApp.fetch, "metadata")
    await local.run("pull", "content", "--dir", "content", "--ref", "draft", "--url", remote)

    await local.write("posts/hello.md", post("Hello", "Edited locally."))
    await local.write("posts/new.md", post("New", "Added locally."))
    expect((await local.run("push")).code).toBe(0)

    const view = await remoteApp.history.open((await remoteApp.history.head({ ref: "draft" }))!.id)
    expect(await view.readFile("posts/hello.md", { encoding: "utf8" })).toBe(post("Hello", "Edited locally."))
    expect(await view.stat("posts/hello.md")).toMatchObject({ mediaType: "text/x-post", metadata: { locale: "en", tags: ["intro"] } })
    expect(await view.stat("posts/new.md")).toMatchObject({ mediaType: "text/markdown" })
  })

  it("records the caller as the author of a pushed revision, and no author without a signed-in user", async () => {
    const remoteApp = await app({ id: "user-1", name: "Ana", email: "ana@example.com", image: "https://example.com/ana.png" })
    await remoteApp.edit({ put: { "posts/hello.md": post("Hello", "One.") } })
    const local = await project(remoteApp.fetch, "author")
    await local.run("pull", "content", "--dir", "content", "--ref", "draft", "--url", remote)
    await local.write("posts/hello.md", post("Hello", "Two."))

    const pushed = await local.json("push")

    expect(pushed.value[0].revision).toBeTruthy()
    const revision = await remoteApp.history.head({ ref: "draft" })
    expect(revision!.metadata).toEqual({ author: { email: "ana@example.com", id: "user-1", name: "Ana" }, source: "cli" })
    const listed = await runOperation(registry, "workspace.history", { workspace: "content", ref: "draft", limit: 1 }, { access: { mode: "local", sections: "all" }, surface: "cli", user: null })
    expect(listed).toMatchObject({ ok: true, value: { revisions: [{ author: "Ana", id: revision!.id }] } })

    resetWorkspaceRegistry()
    const anonymous = await app()
    await anonymous.edit({ put: { "posts/hello.md": post("Hello", "One.") } })
    const other = await project(anonymous.fetch, "anonymous")
    await other.run("pull", "content", "--dir", "content", "--ref", "draft", "--url", remote)
    await other.write("posts/hello.md", post("Hello", "Two."))
    expect((await other.run("push")).code).toBe(0)
    expect((await anonymous.history.head({ ref: "draft" }))!.metadata).toEqual({ source: "cli" })
  })

  it("fails a push that a plugin refuses for a held lease without a retry, and pushes with --override-lease", async () => {
    const remoteApp = await app()
    await remoteApp.edit({ put: { "posts/held.md": post("Held", "One."), "posts/free.md": post("Free", "One.") } })
    const local = await project(remoteApp.fetch, "lease")
    await local.run("pull", "content", "--dir", "content", "--ref", "draft", "--url", remote)
    // A plugin like Content: someone edits posts/held*.md, and the lease holds unless the revision metadata overrides it.
    const commits: WorkspaceWriteCommit[] = []
    cleanup.push(registerWorkspacePlugin("content", {
      id: "test.leases",
      hooks: {
        "write:validate": (input) => {
          if (input.ref !== "draft" || !input.commit) return
          commits.push(input.commit)
          const held = input.commit.paths.filter(path => path.startsWith("posts/held"))
          if (!held.length || input.commit.metadata.lease === "override") return
          throw Object.assign(new Error(`Ana is editing ${held.join(", ")}. Nothing was saved.`), { code: "TEST_LEASE_HELD", status: 409, fix: "Wait for Ana, or pass --override-lease.", details: { paths: held } })
        },
      },
    }))
    await local.write("posts/held.md", post("Held", "Local."))
    await local.write("posts/held-2.md", post("Held 2", "Local."))
    await local.write("posts/free.md", post("Free", "Local."))
    const head = await remoteApp.history.head({ ref: "draft" })

    const refused = await local.run("push")

    expect(refused.code).toBe(1)
    expect(refused.stderr).toBe("TEST_LEASE_HELD: Ana is editing posts/held-2.md, posts/held.md. Nothing was saved.\nWait for Ana, or pass --override-lease.\n")
    expect(remoteApp.calls.filter(call => call === "workspace.commit")).toHaveLength(1)
    expect((await remoteApp.history.head({ ref: "draft" }))!.id).toBe(head!.id)
    expect(commits[0]).toEqual({ message: "Push 3 files", metadata: { source: "cli" }, paths: ["posts/free.md", "posts/held-2.md", "posts/held.md"] })
    expect(Object.isFrozen(commits[0]!.metadata) && Object.isFrozen(commits[0]!.paths)).toBe(true)
    const failure = await runOperation(registry, "workspace.commit", { workspace: "content", ref: "draft", ifHead: head!.id, put: { "posts/held.md": { content: "x", encoding: "utf8" } } }, { access: { mode: "local", sections: "all" }, surface: "cli", user: null })
    expect(failure).toEqual({ ok: false, code: "TEST_LEASE_HELD", message: "Ana is editing posts/held.md. Nothing was saved.", fix: "Wait for Ana, or pass --override-lease.", details: { paths: ["posts/held.md"] }, status: 409 })

    const pushed = await local.json("push", "--override-lease")

    expect(pushed.code).toBe(0)
    expect(await remoteApp.read("posts/held.md")).toBe(post("Held", "Local."))
    expect((await remoteApp.history.head({ ref: "draft" }))!.metadata).toEqual({ lease: "override", source: "cli" })
  })

  it("lets an Agent or an MCP client override a lease only when the developer allows it", async () => {
    const remoteApp = await app()
    const head = await remoteApp.edit({ put: { "posts/hello.md": post("Hello", "One.") } })
    const input = { workspace: "content", ref: "draft", ifHead: head.id, lease: "override", put: { "posts/hello.md": { content: post("Hello", "Agent."), encoding: "utf8" } } }
    const context = { access: { mode: "local", sections: "all" }, surface: "agent", user: null } as const

    for (const surface of ["agent", "mcp"] as const) {
      expect(await runOperation(registry, "workspace.commit", input, { ...context, surface })).toMatchObject({ ok: false, code: "WORKSPACE_FORBIDDEN", fix: expect.stringContaining("operations({ overrideLeases: true })"), status: 403 })
    }
    expect((await remoteApp.history.head({ ref: "draft" }))!.id).toBe(head.id)
    expect(await runOperation(registry, "workspace.commit", input, { ...context, overrideLeases: true })).toMatchObject({ ok: true })
    expect((await remoteApp.history.head({ ref: "draft" }))!.metadata).toEqual({ lease: "override", source: "agent" })
  })

  it.each([
    { command: "push", error: "push accepts at most one Workspace name.", args: ["content", "accidental-extra"] },
    { command: "pull", error: "pull accepts at most one Workspace name.", args: ["content", "accidental-extra"] },
    { command: "pull", error: "pull accepts at most one Workspace name.", args: ["content", "accidental-extra", "--dry-run"] },
    { command: "push", error: "Unknown flag --dry-run.", args: ["--dry-run"] },
    { command: "push", error: "Unknown flag --mesage.", args: ["--mesage", "Typo"] },
    { command: "pull", error: "Unknown flag --theirs-all.", args: ["--theirs-all"] },
    { command: "resolve", error: "Unknown flag --dir.", args: ["content", "--dir", "content"] },
    // A value flag does not take the next flag as its value, so the push does not run without --dry-run.
    { command: "push", error: "--message needs a value.", args: ["--message", "--dry-run"] },
    { command: "pull", error: "--theirs needs a value.", args: ["--theirs", "--dry-run"] },
  ])("fails on $args of $command before it calls the app", async ({ command, error, args }) => {
    const remoteApp = await app()
    await remoteApp.edit({ put: { "posts/hello.md": post("Hello", "One.") } })
    const local = await project(remoteApp.fetch, "flags")
    await local.run("pull", "content", "--dir", "content", "--ref", "draft", "--url", remote)
    await local.write("posts/hello.md", post("Hello", "Local."))
    const head = await remoteApp.history.head({ ref: "draft" })
    const calls = remoteApp.calls.length

    const result = await local.run(command, ...args)

    expect(result.code).toBe(1)
    expect(result.stderr.split("\n").slice(0, 2)).toEqual([error, expect.stringMatching(`^Usage: vitehub ${command} `)])
    expect(remoteApp.calls).toHaveLength(calls)
    expect((await remoteApp.history.head({ ref: "draft" }))?.id).toBe(head!.id)
  })

  it("excludes .git, .vitehub, node_modules, and .DS_Store in any case", async () => {
    const remoteApp = await app()
    const ignored = ["NODE_MODULES/pkg/index.js", "nested/Node_Modules/pkg/index.js", ".DS_STORE", "nested/.Vitehub/state.json"]
    await remoteApp.edit({ put: { "posts/hello.md": post("Hello", "One."), ...Object.fromEntries(ignored.map(path => [path, "remote\n"])) } })
    const local = await project(remoteApp.fetch, "ignored-case")

    const pulled = await local.json("pull", "content", "--dir", "content", "--ref", "draft", "--url", remote)

    expect(pulled.value[0].files).toEqual([{ action: "added", path: "posts/hello.md" }])
    for (const path of ignored) expect(await local.exists(path)).toBe(false)
    await local.write("NODE_MODULES/pkg/index.js", "local dependency\n")
    await local.write(".GIT/config", "[core]\n")
    await local.write("posts/.hello.md.0a1b2c3d4e5f.vitehub-tmp", "left by a stopped pull\n")
    expect((await local.status())[0]!.local).toEqual({ added: [], conflicted: [], deleted: [], modified: [] })
    expect((await local.run("push")).stdout).toBe("content: nothing to push.\n")
    expect((await local.run("pull", "--theirs", ignored[0]!)).stderr).toContain("WORKSPACE_CHECKOUT_PATH")
  })

  it.each(["darwin", "win32"] as const)("treats folders that differ only in case as one folder on %s", async (platform) => {
    const remoteApp = await app()
    await remoteApp.edit({ put: { "hello.md": "Hello\n" } })
    const local = await project(remoteApp.fetch, "overlap-case")
    expect((await local.run("pull", "content", "--dir", "content", "--ref", "draft", "--url", remote)).code).toBe(0)
    const calls = remoteApp.calls.length

    await onPlatform(platform, async () => {
      expect((await local.run("pull", "other", "--dir", "CONTENT", "--url", remote)).stderr).toContain("WORKSPACE_CHECKOUT_OVERLAP")
      expect((await local.run("pull", "other", "--dir", "Content/nested", "--url", remote)).stderr).toContain("WORKSPACE_CHECKOUT_OVERLAP")
    })
    expect(remoteApp.calls).toHaveLength(calls)
  })

  it("keeps folders that differ only in case apart on Linux", async () => {
    const remoteApp = await app()
    await remoteApp.edit({ put: { "hello.md": "Hello\n" } })
    const local = await project(remoteApp.fetch, "case-linux")
    expect((await local.run("pull", "content", "--dir", "content", "--ref", "draft", "--url", remote)).code).toBe(0)

    const pulled = await onPlatform("linux", async () => await local.run("pull", "other", "--dir", "CONTENT", "--ref", "draft", "--url", remote))

    expect(pulled.stderr).not.toContain("WORKSPACE_CHECKOUT_OVERLAP")
  })

  it("asks for --dir on the first pull and refuses a folder outside the project", async () => {
    const remoteApp = await app()
    const local = await project(remoteApp.fetch, "options")

    expect((await local.run("pull", "content", "--url", remote)).stderr).toContain("Pass --dir <folder> on the first pull")
    expect((await local.run("pull", "content", "--dir", "..", "--url", remote)).stderr).toContain("must be a folder inside the project")
    expect((await local.run("pull", "content", "--dir", ".", "--url", remote)).stderr).toContain("must be a folder inside the project")
    expect((await local.run("push")).stderr).toContain("has no checked-out Workspace")
    expect(await localCheckoutStatus(local.rootDir)).toBeUndefined()
  })

  it("keeps no lock entry when a first pull fails, and keeps the lock of a later failed pull", async () => {
    const remoteApp = await app()
    const denied = (async () => new Response(JSON.stringify({ code: "UNAUTHORIZED", message: "Sign in." }), { status: 401, headers: { "content-type": "application/json" } })) as typeof globalThis.fetch
    const failing = await project(denied, "first-pull-fails")
    expect((await failing.run("pull", "content", "--dir", "content", "--url", remote)).code).toBe(1)
    expect(await readFile(join(failing.rootDir, "vitehub.lock"), "utf8").catch(() => undefined)).toBeUndefined()

    let deny = false
    const local = await project((async (input, init) => await (deny ? denied : remoteApp.fetch)(input, init)) as typeof globalThis.fetch, "later-pull-fails")
    expect((await local.run("pull", "content", "--dir", "content", "--url", remote)).code).toBe(0)
    const before = await local.lock()
    deny = true
    expect((await local.run("pull")).code).toBe(1)
    expect(await local.lock()).toEqual(before)
  })

  it("pushes files up to the request limit of workspace.commit in one revision, and refuses a larger push before the call", async () => {
    const remoteApp = await app()
    await remoteApp.edit({ put: { "posts/hello.md": post("Hello", "One.") } })
    const local = await project(remoteApp.fetch, "push-size")
    await local.run("pull", "content", "--dir", "content", "--ref", "draft", "--url", remote)

    // The request also holds the operation name, the Workspace, the ref, the head, and the file path.
    await local.write("large/under.txt", "x".repeat(workspaceCommitRequestBytes - 512))
    expect(await local.run("push")).toMatchObject({ code: 0, stderr: "" })
    expect((await remoteApp.read("large/under.txt")).length).toBe(workspaceCommitRequestBytes - 512)

    const head = await remoteApp.history.head({ ref: "draft" })
    const commits = remoteApp.calls.filter(call => call === "workspace.commit").length
    await local.write("large/a.txt", "a".repeat(workspaceCommitRequestBytes / 2))
    await local.write("large/b.txt", "b".repeat(workspaceCommitRequestBytes / 2 + 1_024))
    await local.write("posts/small.md", post("Small", "Text."))
    const refused = await local.run("push")

    expect(refused.code).toBe(1)
    expect(refused.stderr).toContain("WORKSPACE_CHECKOUT_TOO_LARGE")
    expect(refused.stderr).toContain("4 MiB")
    expect(refused.stderr).toMatch(/large\/b\.txt.*large\/a\.txt/s)
    expect(remoteApp.calls.filter(call => call === "workspace.commit")).toHaveLength(commits)
    expect((await remoteApp.history.head({ ref: "draft" }))!.id).toBe(head!.id)
  })

  it("replaces a pulled file instead of writing into a file that it shares through a hard link", async (context) => {
    const remoteApp = await app()
    await remoteApp.edit({ put: { "posts/hello.md": post("Hello", "One.") } })
    const local = await project(remoteApp.fetch, "hard-link")
    await local.run("pull", "content", "--dir", "content", "--ref", "draft", "--url", remote)
    const outside = join(await tempDir("hard-link-outside"), "hello.md")
    await writeFile(outside, post("Hello", "One."))
    await rm(join(local.rootDir, "content/posts/hello.md"))
    try {
      await link(outside, join(local.rootDir, "content/posts/hello.md"))
    }
    catch {
      context.skip()
    }
    await remoteApp.edit({ put: { "posts/hello.md": post("Hello", "Two.") } })

    expect((await local.run("pull")).code).toBe(0)

    expect(await local.read("posts/hello.md")).toBe(post("Hello", "Two."))
    expect(await readFile(outside, "utf8")).toBe(post("Hello", "One."))
    expect((await stat(outside)).nlink).toBe(1)
  })

  it("refuses a vitehub.lock that is a symbolic link, and writes the lock without a temporary file left", async () => {
    const remoteApp = await app()
    await remoteApp.edit({ put: { "posts/hello.md": post("Hello", "One.") } })
    const local = await project(remoteApp.fetch, "lock-link")
    const outside = join(await tempDir("lock-outside"), "lock.json")
    const empty = `${JSON.stringify({ version: 1, workspaces: {} })}\n`
    await writeFile(outside, empty)
    await symlink(outside, join(local.rootDir, "vitehub.lock"))

    const pulled = await local.run("pull", "content", "--dir", "content", "--ref", "draft", "--url", remote)

    expect(pulled).toMatchObject({ code: 1, stderr: expect.stringContaining("WORKSPACE_CHECKOUT_SYMLINK") })
    expect(await readFile(outside, "utf8")).toBe(empty)
    expect(remoteApp.calls).toEqual([])

    await rm(join(local.rootDir, "vitehub.lock"))
    expect((await local.run("pull", "content", "--dir", "content", "--ref", "draft", "--url", remote)).code).toBe(0)
    expect((await readdir(local.rootDir)).sort()).toEqual(["content", "vitehub.lock"])
  })

  it("excludes names that Windows reads as an excluded folder, with trailing dots or spaces", async () => {
    const remoteApp = await app()
    const ignored = ["node_modules./pkg/index.js", "node_modules /pkg/index.js", "nested/.vitehub ./state.json", ".DS_Store.."]
    await remoteApp.edit({ put: { "posts/hello.md": post("Hello", "One."), ...Object.fromEntries(ignored.map(path => [path, "remote\n"])) } })
    const local = await project(remoteApp.fetch, "ignored-trailing")

    const pulled = await local.json("pull", "content", "--dir", "content", "--ref", "draft", "--url", remote)

    expect(pulled.value[0].files).toEqual([{ action: "added", path: "posts/hello.md" }])
    for (const path of ignored) expect(await local.exists(path)).toBe(false)
    await local.write("node_modules./pkg/index.js", "local dependency\n")
    await local.write(".git./config", "[core]\n")
    expect((await local.status())[0]!.local).toEqual({ added: [], conflicted: [], deleted: [], modified: [] })
    expect((await local.run("push")).stdout).toBe("content: nothing to push.\n")
    expect((await local.run("pull", "--theirs", "node_modules /pkg/index.js")).stderr).toContain("WORKSPACE_CHECKOUT_PATH")
  })

  it("keeps the lock entries of concurrent first pulls of two Workspaces", async () => {
    const remoteApp = await app()
    await remoteApp.edit({ put: { "posts/hello.md": post("Hello", "One.") } })
    const notes = await remoteApp.notes.head({ ref: "draft" })
    await remoteApp.notes.commit({ ref: "draft", ifHead: notes?.id ?? null, changes: { put: { "todo.md": "Write.\n" } } })
    const local = await project(remoteApp.fetch, "concurrent")

    const results = await Promise.all([
      local.run("pull", "content", "--dir", "content", "--ref", "draft", "--url", remote),
      local.run("pull", "notes", "--dir", "notes", "--ref", "draft", "--url", remote),
    ])

    expect(results.map(result => result.code)).toEqual([0, 0])
    expect(Object.keys((await local.lock()).workspaces)).toEqual(["content", "notes"])
    expect((await readdir(local.rootDir)).sort()).toEqual(["content", "notes", "vitehub.lock"])
  })

  it("keeps a live lock when it ages, so waiting commands preserve every Workspace entry", async () => {
    const remoteApp = await app()
    const local = await project(remoteApp.fetch, "aged-lock")
    let entered!: () => void, resume!: () => void
    const reached = new Promise<void>((resolve) => { entered = resolve })
    const resumed = new Promise<void>((resolve) => { resume = resolve })
    pausedLockWrites.set(join(local.rootDir, "vitehub.lock"), { entered, resume: resumed })
    const first = local.run("pull", "content", "--dir", "content", "--ref", "draft", "--url", remote)
    await reached
    const mutex = join(local.rootDir, "vitehub.lock.lock")
    await utimes(mutex, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
    const owner = await readFile(mutex, "utf8")
    let completed = 0
    const waiting = [1, 2].map(async () => {
      const result = await local.run("pull", "notes", "--dir", "notes", "--ref", "draft", "--url", remote)
      completed++
      return result
    })
    try {
      await new Promise(resolve => setTimeout(resolve, 150))
      expect(completed).toBe(0)
      expect(await readFile(mutex, "utf8")).toBe(owner)
    }
    finally {
      resume()
      await Promise.all([first, ...waiting])
    }
    expect((await first).code).toBe(0)
    expect((await Promise.all(waiting)).map(result => result.code)).toEqual([0, 0])
    expect(Object.keys((await local.lock()).workspaces)).toEqual(["content", "notes"])
    expect((await readdir(local.rootDir)).sort()).toEqual(["vitehub.lock"])
  })

  it("does not remove a replacement lock when the original acquisition finishes", async () => {
    const remoteApp = await app()
    const local = await project(remoteApp.fetch, "replaced-lock")
    let entered!: () => void, resume!: () => void
    const reached = new Promise<void>((resolve) => { entered = resolve })
    const resumed = new Promise<void>((resolve) => { resume = resolve })
    pausedLockWrites.set(join(local.rootDir, "vitehub.lock"), { entered, resume: resumed })
    const first = local.run("pull", "content", "--dir", "content", "--url", remote)
    await reached
    const mutex = join(local.rootDir, "vitehub.lock.lock")
    try {
      await rm(mutex)
      await writeFile(mutex, "replacement-owner\n", { flag: "wx" })
    }
    finally {
      resume()
      await first
    }
    expect((await first).code).toBe(0)
    expect(await readFile(mutex, "utf8")).toBe("replacement-owner\n")
  })
})
