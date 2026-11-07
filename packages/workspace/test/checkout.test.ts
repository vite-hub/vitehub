import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { createClient } from "@libsql/client"
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/libsql"
import { afterEach, describe, expect, it } from "vitest"

import { createOperationRegistry, runOperation } from "@vite-hub/internal/operations"

import { createBlobStorage } from "../../blob/src/storage.ts"
import { createDriver } from "../../blob/src/drivers/fs.ts"

import { createBlobDatabaseWorkspaceStore, workspaceHistorySchema } from "../src/blob-database.ts"
import { mergeText } from "../src/checkout.ts"
import { lineageDigest } from "../src/lineage.ts"
import { workspaceCheckoutFeatures } from "../src/checkout-cli.ts"
import { registerWorkspace, resetWorkspaceRegistry } from "../src/core/registry.ts"
import { registerWorkspacePlugin, useWorkspace } from "../src/index.ts"
import { workspaceOperations } from "../src/operations.ts"

import type { WorkspaceDefinition } from "../src/core/types.ts"

const cleanup: Array<() => Promise<void> | void> = []
const migration = await readFile(new URL("fixtures/history.sql", import.meta.url), "utf8")
const registry = createOperationRegistry([{ operations: workspaceOperations }])
const remote = "https://docs.example.test"

afterEach(async () => {
  resetWorkspaceRegistry()
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

async function tempDir(name: string) {
  const root = await mkdtemp(join(tmpdir(), `vitehub-checkout-${name}-`))
  cleanup.push(() => rm(root, { force: true, recursive: true }))
  return root
}

/** A deployed app with one Blob + Database Workspace, reached through the operation RPC. */
async function app() {
  const root = await tempDir("app")
  const client = createClient({ url: `file:${join(root, "history.sqlite")}` })
  cleanup.push(() => client.close())
  const database = drizzle(client, { schema: workspaceHistorySchema })
  for (const statement of migration.split(";").filter(statement => statement.trim())) await database.run(sql.raw(statement))
  const blob = createBlobStorage(createDriver({ driver: "fs", base: join(root, "objects") }))
  const definition: WorkspaceDefinition = { name: "content", store: createBlobDatabaseWorkspaceStore({ blob, database, workspace: "content" }) }
  registerWorkspace("content", { store: definition.store })
  const { history } = useWorkspace("content", { definition, mode: "write" })
  const calls: string[] = []
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url)).toBe(`${remote}/_vitehub/rpc/__call`)
    const { input, operation } = JSON.parse(String(init!.body)) as { input: unknown, operation: string }
    calls.push(operation)
    const result = await runOperation(registry, operation, input, { access: { mode: "local", sections: "all" }, surface: "cli", user: null })
    return Response.json(result, { status: result.ok ? 200 : result.status ?? 500 })
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
  return { calls, edit, fetch: fetch as typeof globalThis.fetch, history, read }
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
    const status = await local.json("status")
    expect(status.value[0].local).toEqual({ added: ["posts/new.md"], conflicted: [], deleted: ["posts/old.md"], modified: ["posts/hello.md"] })

    const pushed = await local.json("push", "--message", "Write locally")

    expect(pushed.code).toBe(0)
    expect(pushed.value[0]).toMatchObject({ pushed: ["posts/hello.md", "posts/new.md", "posts/old.md"], ref: "draft" })
    const head = await remoteApp.history.head({ ref: "draft" })
    expect(head).toMatchObject({ id: pushed.value[0].revision, message: "Write locally" })
    expect(await remoteApp.read("posts/hello.md")).toBe(post("Hello", "Edited locally."))
    expect(await remoteApp.read("posts/new.md")).toBe(post("New", "Added locally."))
    await expect(remoteApp.read("posts/old.md")).rejects.toThrow()
    expect((await local.lock()).workspaces.content.head).toBe(head!.id)
    expect((await local.json("status")).value[0].local).toEqual({ added: [], conflicted: [], deleted: [], modified: [] })
    expect((await local.run("push")).stdout).toBe("content: nothing to push.\n")
  })

  it("merges Console edits of other files and other lines before it pushes", async () => {
    const remoteApp = await app()
    await remoteApp.edit({ put: { "posts/hello.md": post("Hello", "One.\n\nTwo.\n\nThree."), "posts/other.md": post("Other", "Text.") } })
    const local = await project(remoteApp.fetch, "merge")
    await local.run("pull", "content", "--dir", "content", "--ref", "draft", "--url", remote)

    await remoteApp.edit({ put: { "posts/hello.md": post("Hello", "One, edited in the Console.\n\nTwo.\n\nThree."), "posts/other.md": post("Other", "Console text.") } })
    await local.write("posts/hello.md", post("Hello", "One.\n\nTwo.\n\nThree, edited locally."))
    expect((await local.json("status", "--remote")).value[0].remoteChanges).toEqual([
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
    expect((await local.run("status", "--check")).code).toBe(1)
    const refused = await local.run("push")
    expect(refused).toMatchObject({ code: 1, stderr: expect.stringContaining("WORKSPACE_CHECKOUT_CONFLICT") })
    expect((await remoteApp.history.head({ ref: "draft" }))!.id).toBe(consoleEdit.id)

    await local.write("posts/hello.md", post("Hello", "Local and Console line."))
    expect((await local.run("status", "--check")).code).toBe(0)
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
    expect((await local.json("status")).value[0].local.added).toEqual(["posts/kept.md"])
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
      const body = JSON.parse(String(init!.body)) as { operation: string }
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
    expect((await local.json("status")).value[0].stale).toEqual([])

    const written: string[] = []
    cleanup.push(registerWorkspacePlugin("content", { hooks: { "write:after": ({ path, ref }) => { written.push(`${ref} ${path}`) } }, id: "translate" }))
    const edited = post("Guide", "Install it with pnpm.")
    await local.write("docs/en/guide.md", edited)
    const status = await local.run("status")
    expect(status.stdout).toContain("Stale derived files (their source changed):\n  changed   docs/es/guide.md <- docs/en/guide.md")
    expect((await local.run("push")).code).toBe(0)
    // A translator starts from this hook.
    expect(written).toEqual(["draft docs/en/guide.md"])

    const listed = await runOperation(registry, "workspace.stale", { ref: "draft", workspace: "content" }, { access: { mode: "local", sections: "all" }, surface: "cli", user: null })
    const sourceDigest = lineageDigest(new TextEncoder().encode(edited))
    expect(listed).toMatchObject({ ok: true, value: { ref: "draft", stale: [{ derivedFrom: { digest: translated, path: "docs/en/guide.md" }, path: "docs/es/guide.md", reason: "changed", sourceDigest }] } })

    // The translator updates the file and records the digest that workspace.stale reported.
    await local.write("docs/es/guide.md", spanish(sourceDigest))
    expect((await local.json("status")).value[0].stale).toEqual([])
  })

  it("asks for --dir on the first pull and refuses a folder outside the project", async () => {
    const remoteApp = await app()
    const local = await project(remoteApp.fetch, "options")

    expect((await local.run("pull", "content", "--url", remote)).stderr).toContain("Pass --dir <folder> on the first pull")
    expect((await local.run("pull", "content", "--dir", "..", "--url", remote)).stderr).toContain("must be a folder inside the project")
    expect((await local.run("pull", "content", "--dir", ".", "--url", remote)).stderr).toContain("must be a folder inside the project")
    expect((await local.run("status")).stderr).toContain("has no checked-out Workspace")
  })
})
