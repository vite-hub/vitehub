import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createOperationRegistry, runOperation } from "@vite-hub/internal/operations"

import { additionText, createFakeGitHub, gitBlobSha, textSha } from "./fake-github.ts"
import { localCheckoutStatus } from "../src/checkout.ts"
import { workspaceCheckoutFeatures } from "../src/checkout-cli.ts"
import { registerWorkspace, resetWorkspaceRegistry } from "../src/core/registry.ts"
import { useWorkspace } from "../src/index.ts"
import { workspaceOperations } from "../src/operations.ts"
import { githubHeadCacheMs } from "../src/providers/github/history.ts"
import { createGitHubWorkspaceStore } from "../src/providers/github/store.ts"
import { operationRpcRequest, operationRpcResponse } from "../../internal/test-utils/operation-rpc.ts"

import type { OperationUser } from "@vite-hub/internal/operations"
import type { GitHubWorkspaceRefs, WorkspaceDefinition } from "../src/core/types.ts"
import type { FakeGitHub } from "./fake-github.ts"

const cleanup: Array<() => Promise<void> | void> = []
const registry = createOperationRegistry([{ operations: workspaceOperations }])
const remote = "https://docs.example.test"
const post = (title: string, body: string) => `---\ntitle: ${title}\n---\n\n${body}\n`
let fake: FakeGitHub

beforeEach(() => {
  fake = createFakeGitHub()
  vi.stubGlobal("fetch", vi.fn(fake.fetch))
  vi.stubEnv("VITEHUB_GITHUB_TOKEN", "")
  vi.stubEnv("FORGES_GITHUB_TOKEN", "")
})

afterEach(async () => {
  resetWorkspaceRegistry()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

async function tempDir(name: string) {
  const root = await mkdtemp(join(tmpdir(), `vitehub-checkout-github-${name}-`))
  cleanup.push(() => rm(root, { force: true, recursive: true }))
  return root
}

/**
 * A deployed app with one Workspace on the GitHub Store, under `content/` of the fake repository `onmax/repo`.
 * Each call is a new server instance, with empty caches, on the same repository.
 */
function app(options: { refs?: GitHubWorkspaceRefs, user?: OperationUser | null } = {}) {
  resetWorkspaceRegistry()
  const store = createGitHubWorkspaceStore({ provider: "github", repository: "onmax/repo", token: "token", root: "content", ...(options.refs ? { refs: options.refs } : {}) }, "content")
  const definition: WorkspaceDefinition = { name: "content", store }
  registerWorkspace("content", { store })
  const { history } = useWorkspace("content", { definition, mode: "write" })
  const calls: string[] = []
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url)).toBe(`${remote}/_vitehub/rpc`)
    const { input, operation } = operationRpcRequest(init!.body)
    calls.push(operation)
    const result = await runOperation(registry, operation, input, { access: { mode: "local", sections: "all" }, surface: "cli", user: options.user ?? null })
    return operationRpcResponse(init!.body, result)
  }
  /** An edit in the Console of this instance: one commit on `ref`. */
  const edit = async (changes: { put?: Record<string, string | Uint8Array>, delete?: string[] }, ref = "main") => {
    const head = await history.head({ ref })
    return await history.commit({ ref, ifHead: head?.id ?? null, changes, message: "Console edit" })
  }
  return { calls, edit, fetch: fetch as typeof globalThis.fetch, history }
}

/** The text of `path` at the head of `branch` in the fake repository. */
function remoteText(path: string, branch = "main"): string | undefined {
  const entry = fake.tree(branch).find(item => item.path === path)
  return entry ? new TextDecoder().decode(fake.blobs.get(entry.sha)) : undefined
}

/** A project with the CLI commands, as `vitehub <command>` runs them. */
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
    bytes: async (path: string) => new Uint8Array(await readFile(file(path))),
    write: async (path: string, content: string | Uint8Array) => {
      await mkdir(dirname(file(path)), { recursive: true })
      await writeFile(file(path), content)
    },
    remove: async (path: string) => await rm(file(path)),
    exists: async (path: string) => await readFile(file(path)).then(() => true, () => false),
    lock: async () => JSON.parse(await readFile(join(rootDir, "vitehub.lock"), "utf8")),
    writeLock: async (lock: unknown) => await writeFile(join(rootDir, "vitehub.lock"), JSON.stringify(lock)),
    status: async () => (await localCheckoutStatus(rootDir))!,
  }
}

const clean = { added: [], conflicted: [], deleted: [], modified: [] }

describe("workspace checkout on the GitHub Store", { timeout: 60_000 }, () => {
  it("pulls, pushes edits, additions, deletions, and binary files as one commit, and pulls again", async () => {
    const seeded = fake.commit("main", {
      "README.md": "# Repo\n",
      "content/posts/hello.md": post("Hello", "First post."),
      "content/posts/old.md": post("Old", "Remove me."),
      "content/media/logo.bin": new Uint8Array([0, 255, 1]),
    })
    const server = app()
    const local = await project(server.fetch, "round-trip")

    const pulled = await local.json("pull", "content", "--dir", "content", "--url", remote)

    expect(pulled.code).toBe(0)
    expect(pulled.value[0].files.map((file: { path: string }) => file.path)).toEqual(["media/logo.bin", "posts/hello.md", "posts/old.md"])
    expect(await local.bytes("media/logo.bin")).toEqual(new Uint8Array([0, 255, 1]))
    // The revision id is the commit sha. Files outside the Workspace root stay out of the checkout.
    expect((await local.lock()).workspaces.content).toMatchObject({ ref: "main", head: seeded })
    expect(await local.exists("README.md")).toBe(false)

    await local.write("posts/hello.md", post("Hello", "Edited locally."))
    await local.write("posts/new.md", post("New", "Added locally."))
    await local.write("media/new.bin", new Uint8Array([0, 128, 255]))
    await local.remove("posts/old.md")
    const pushed = await local.json("push", "--message", "Write locally")

    expect(pushed.code).toBe(0)
    expect(pushed.value[0].pushed).toEqual(["media/new.bin", "posts/hello.md", "posts/new.md", "posts/old.md"])
    const head = fake.head("main")!
    expect(pushed.value[0].revision).toBe(head)
    expect(fake.commits.get(head)!.parents).toEqual([seeded])
    expect(fake.commits.get(head)!.message).toMatch(/^Write locally\n\nVitehub-Metadata: /)
    expect(fake.tree("main").map(entry => entry.path).sort()).toEqual(["README.md", "content/media/logo.bin", "content/media/new.bin", "content/posts/hello.md", "content/posts/new.md"])
    expect(remoteText("content/posts/hello.md")).toBe(post("Hello", "Edited locally."))
    expect(fake.blobs.get(fake.tree("main").find(entry => entry.path === "content/media/new.bin")!.sha)).toEqual(new Uint8Array([0, 128, 255]))
    // The digest of a file is its Git blob sha.
    const view = await server.history.open(head)
    expect(await view.stat("media/new.bin")).toMatchObject({ digest: gitBlobSha(new Uint8Array([0, 128, 255])), mediaType: "application/octet-stream" })
    expect(await view.stat("posts/hello.md")).toMatchObject({ digest: textSha(post("Hello", "Edited locally.")), mediaType: "text/markdown" })
    expect((await local.lock()).workspaces.content.head).toBe(head)
    expect((await local.status())[0]!.local).toEqual(clean)
    expect((await local.run("pull")).stdout).toBe(`content: up to date with main (${head}).\n`)
    expect((await local.run("push")).stdout).toBe("content: nothing to push.\n")
  })

  it("pulls a commit made on GitHub once the head cache of the instance expires", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    fake.commit("main", { "content/posts/hello.md": post("Hello", "One.\n\nTwo.\n\nThree.") })
    const server = app()
    const local = await project(server.fetch, "github-edit")
    await local.run("pull", "content", "--dir", "content", "--url", remote)
    const external = fake.commit("main", { "content/posts/hello.md": post("Hello", "One, edited on GitHub.\n\nTwo.\n\nThree.") })
    await local.write("posts/hello.md", post("Hello", "One.\n\nTwo.\n\nThree, edited locally."))

    // The instance read the head less than `githubHeadCacheMs` ago, so it does not see the new commit yet.
    expect((await local.json("pull", "--dry-run")).value[0].remoteChanges).toEqual([])
    vi.setSystemTime(Date.now() + githubHeadCacheMs + 1)
    expect((await local.json("pull", "--dry-run")).value[0].remoteChanges).toEqual([{ change: "changed", path: "posts/hello.md" }])

    const pushed = await local.run("push")

    expect(pushed.code).toBe(0)
    expect(pushed.stdout).toContain("merged   posts/hello.md")
    const merged = post("Hello", "One, edited on GitHub.\n\nTwo.\n\nThree, edited locally.")
    expect(await local.read("posts/hello.md")).toBe(merged)
    expect(remoteText("content/posts/hello.md")).toBe(merged)
    expect(fake.commits.get(fake.head("main")!)!.parents).toEqual([external])
  })

  it("writes conflict markers for a both-sides edit and pushes once they are gone", async () => {
    fake.commit("main", { "content/posts/hello.md": post("Hello", "Same line.") })
    const server = app()
    const local = await project(server.fetch, "conflict")
    await local.run("pull", "content", "--dir", "content", "--url", remote)
    const consoleEdit = await server.edit({ put: { "posts/hello.md": post("Hello", "Console line.") } })
    expect(consoleEdit.id).toBe(fake.head("main"))
    await local.write("posts/hello.md", post("Hello", "Local line."))

    const pulled = await local.run("pull")

    expect(pulled.code).toBe(1)
    expect(await local.read("posts/hello.md")).toBe(`---\ntitle: Hello\n---\n\n<<<<<<< local\nLocal line.\n=======\nConsole line.\n>>>>>>> main ${consoleEdit.id}\n`)
    expect((await local.run("push")).stderr).toContain("WORKSPACE_CHECKOUT_CONFLICT")
    expect(fake.head("main")).toBe(consoleEdit.id)

    await local.write("posts/hello.md", post("Hello", "Local and Console line."))
    expect((await local.run("push")).code).toBe(0)
    expect(remoteText("content/posts/hello.md")).toBe(post("Hello", "Local and Console line."))
  })

  it("keeps a local binary file on a conflict until resolve, and takes the remote file with --theirs", async () => {
    fake.commit("main", { "content/media/a.bin": new Uint8Array([0, 255, 1]), "content/media/b.bin": new Uint8Array([0, 255, 2]) })
    const server = app()
    const local = await project(server.fetch, "binary")
    await local.run("pull", "content", "--dir", "content", "--url", remote)
    await server.edit({ put: { "media/a.bin": new Uint8Array([0, 255, 9]), "media/b.bin": new Uint8Array([0, 255, 9]) } })
    await local.write("media/a.bin", new Uint8Array([0, 255, 7]))
    await local.write("media/b.bin", new Uint8Array([0, 255, 7]))

    expect((await local.run("pull")).code).toBe(1)
    expect((await local.lock()).workspaces.content.conflicts).toEqual(["media/a.bin", "media/b.bin"])
    expect((await local.run("pull", "--theirs", "media/b.bin")).code).toBe(0)
    expect(await local.bytes("media/b.bin")).toEqual(new Uint8Array([0, 255, 9]))
    expect((await local.run("resolve", "content", "media/a.bin")).code).toBe(0)
    expect((await local.run("push")).code).toBe(0)

    const tree = new Map(fake.tree("main").map(entry => [entry.path, entry.sha]))
    expect(fake.blobs.get(tree.get("content/media/a.bin")!)).toEqual(new Uint8Array([0, 255, 7]))
    expect(fake.blobs.get(tree.get("content/media/b.bin")!)).toEqual(new Uint8Array([0, 255, 9]))
  })

  it("keeps a local edit of a file the remote deleted, and restores a remote edit of a file deleted locally", async () => {
    fake.commit("main", { "content/posts/kept.md": post("Kept", "One."), "content/posts/back.md": post("Back", "One.") })
    const server = app()
    const local = await project(server.fetch, "deletes")
    await local.run("pull", "content", "--dir", "content", "--url", remote)
    await server.edit({ delete: ["posts/kept.md"], put: { "posts/back.md": post("Back", "Two.") } })
    await local.write("posts/kept.md", post("Kept", "Edited."))
    await local.remove("posts/back.md")

    const pulled = await local.json("pull")

    expect(pulled.value[0].files).toEqual([
      { action: "updated", note: expect.stringContaining("You deleted this file"), path: "posts/back.md" },
      { action: "kept", note: expect.stringContaining("The remote deleted this file"), path: "posts/kept.md" },
    ])
    expect((await local.status())[0]!.local.added).toEqual(["posts/kept.md"])
    expect((await local.run("push")).code).toBe(0)
    expect(remoteText("content/posts/kept.md")).toBe(post("Kept", "Edited."))
  })

  it("pulls again and retries when a Console save lands between the pull and the commit", async () => {
    fake.commit("main", { "content/posts/hello.md": post("Hello", "One.") })
    const server = app()
    let raced = false
    const local = await project(async (url, init) => {
      const body = operationRpcRequest(init!.body)
      if (body.operation === "workspace.commit" && !raced) {
        raced = true
        await server.edit({ put: { "posts/race.md": post("Race", "Console.") } })
      }
      return await server.fetch(url, init)
    }, "race")
    await local.run("pull", "content", "--dir", "content", "--url", remote)
    await local.write("posts/hello.md", post("Hello", "Local."))

    expect((await local.run("push")).code).toBe(0)
    expect(await local.read("posts/race.md")).toBe(post("Race", "Console."))
    expect(remoteText("content/posts/hello.md")).toBe(post("Hello", "Local."))
    expect(remoteText("content/posts/race.md")).toBe(post("Race", "Console."))
  })

  it("retries once when another commit lands on GitHub after the Store read the branch", async () => {
    fake.commit("main", { "content/posts/hello.md": post("Hello", "One.") })
    const server = app()
    const local = await project(server.fetch, "tight-race")
    await local.run("pull", "content", "--dir", "content", "--url", remote)
    await local.write("posts/hello.md", post("Hello", "Local."))
    let raced = false
    // The other commit lands after the Store checked the head and before GitHub runs the commit mutation.
    fake.respond((request) => {
      if (request.operation !== "CreateCommitOnBranch" || raced) return undefined
      raced = true
      fake.commit("main", { "content/posts/race.md": post("Race", "GitHub.") })
      return undefined
    })

    const pushed = await local.run("push")

    expect(pushed.code).toBe(0)
    expect(server.calls.filter(call => call === "workspace.commit")).toHaveLength(2)
    expect(await local.read("posts/race.md")).toBe(post("Race", "GitHub."))
    expect(remoteText("content/posts/hello.md")).toBe(post("Hello", "Local."))
    expect(remoteText("content/posts/race.md")).toBe(post("Race", "GitHub."))
  })

  it("pulls from an older revision on a new instance without walking the whole branch history", async () => {
    const refs = { published: "main", draft: "vitehub/content" }
    fake.commit("main", { "content/posts/hello.md": post("Hello", "One.") })
    // A long published history. The draft branch starts from its head.
    for (let index = 0; index < 250; index++) fake.commit("main", { "README.md": `# Repo ${index}\n` })
    let server = app({ refs })
    const draft = await server.edit({ put: { "posts/draft.md": post("Draft", "One.") } }, "draft")
    const local = await project(async (url, init) => await server.fetch(url, init), "behind")
    await local.run("pull", "content", "--dir", "content", "--ref", "draft", "--url", remote)
    expect((await local.lock()).workspaces.content.head).toBe(draft.id)
    await server.edit({ put: { "posts/draft.md": post("Draft", "Two.") } }, "draft")
    const last = await server.edit({ put: { "posts/other.md": post("Other", "One.") } }, "draft")

    // A cold instance has no cache of the ref that holds the base revision.
    server = app({ refs })
    const old = await server.history.open(draft.id)
    expect(old.revision).toMatchObject({ id: draft.id, ref: "draft" })
    expect(await old.readFile("posts/draft.md", { encoding: "utf8" })).toBe(post("Draft", "One."))
    server = app({ refs })
    fake.requests.length = 0

    const result = await local.json("pull")

    expect(result.code).toBe(0)
    expect(result.value[0]).toMatchObject({ from: draft.id, head: last.id })
    expect(await local.read("posts/draft.md")).toBe(post("Draft", "Two."))
    expect(await local.read("posts/other.md")).toBe(post("Other", "One."))
    const commitLists = fake.requests.filter(request => request.method === "GET" && request.path === "/repos/onmax/repo/commits")
    expect(commitLists).toHaveLength(0)
    // One compare per branch until one holds the revision: main first, then the draft branch.
    expect(fake.requests.filter(request => request.path.startsWith("/repos/onmax/repo/compare/"))).toHaveLength(2)
  })

  it("opens an old revision of a branch that shares no history with the published branch", async () => {
    const refs = { published: "main", draft: "vitehub/content" }
    fake.commit("main", { "content/posts/hello.md": post("Hello", "One.") })
    // The draft branch has its own root commit, so its compare with main is "No common ancestor".
    const old = fake.commit("vitehub/content", { "content/posts/draft.md": post("Draft", "One.") })
    fake.commit("vitehub/content", { "content/posts/draft.md": post("Draft", "Two.") })

    const view = await app({ refs }).history.open(old)

    expect(view.revision).toMatchObject({ id: old, ref: "draft" })
  })

  it("fails to open an old revision when a compare fails, and does not keep the fallback ref", async () => {
    const refs = { published: "main", draft: "vitehub/content" }
    fake.commit("main", { "content/posts/hello.md": post("Hello", "One.") })
    let server = app({ refs })
    const draft = await server.edit({ put: { "posts/draft.md": post("Draft", "One.") } }, "draft")
    await server.edit({ put: { "posts/draft.md": post("Draft", "Two.") } }, "draft")
    let failures = 1
    // GitHub documents 422 on compare as "Validation failed, or the endpoint has been spammed".
    fake.respond(request => request.path.startsWith("/repos/onmax/repo/compare/") && failures-- > 0 ? Response.json({ message: "Validation Failed" }, { status: 422 }) : undefined)
    server = app({ refs })

    await expect(server.history.open(draft.id)).rejects.toThrow()

    // The same instance finds the draft ref once GitHub answers.
    expect((await server.history.open(draft.id)).revision).toMatchObject({ id: draft.id, ref: "draft" })
  })

  it("reports a missing revision only when GitHub has no such commit, and lets other lookup failures through", async () => {
    const head = fake.commit("main", { "content/posts/hello.md": post("Hello", "One.") })
    const server = app()

    await expect(server.history.open("0123456789abcdef0123456789abcdef01234567")).rejects.toMatchObject({ code: "WORKSPACE_NOT_FOUND" })

    let failures = 1
    // GitHub documents 422 as "Validation failed, or the endpoint has been spammed". It does not say that the commit is gone.
    fake.respond(request => request.path.startsWith("/repos/onmax/repo/commits/") && failures-- > 0 ? Response.json({ message: "Validation Failed" }, { status: 422 }) : undefined)

    const failed = await server.history.open(head).then(() => undefined, (error: unknown) => error)
    expect(failed).toBeInstanceOf(Error)
    expect(failed).not.toMatchObject({ code: "WORKSPACE_NOT_FOUND" })
    expect((await server.history.open(head)).revision).toMatchObject({ id: head })
  })

  it("reads one blob for each changed file on a pull, and none for a dry run", async () => {
    const files = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`content/posts/${index}.md`, post(`Cost ${index}`, `Unique ${index}.`)]))
    fake.commit("main", files)
    const server = app()
    const local = await project(server.fetch, "cost")
    const blobReads = () => fake.requests.filter(request => request.method === "GET" && request.path.startsWith("/repos/onmax/repo/git/blobs/")).length

    await local.run("pull", "content", "--dir", "content", "--url", remote)
    expect(blobReads()).toBe(20)

    await server.edit({ put: { "posts/0.md": post("Cost 0", "Edited.") } })
    fake.requests.length = 0
    expect((await local.json("pull", "--dry-run")).value[0].remoteChanges).toEqual([{ change: "changed", path: "posts/0.md" }])
    expect(blobReads()).toBe(0)
  })

  it("answers 404 with a fix when the base revision of the checkout is gone", async () => {
    fake.commit("main", { "content/posts/hello.md": post("Hello", "One.") })
    const server = app()
    const local = await project(server.fetch, "gone")
    await local.run("pull", "content", "--dir", "content", "--url", remote)
    const lock = await local.lock()
    lock.workspaces.content.head = "0123456789abcdef0123456789abcdef01234567"
    await local.writeLock(lock)

    const pulled = await local.run("pull")

    expect(pulled.code).toBe(1)
    expect(pulled.stderr).toContain("WORKSPACE_NOT_FOUND")
    expect(pulled.stderr).toContain("has no revision")
  })

  it.each([
    { name: "a draft that starts from published", refs: { published: "main", draft: "vitehub/content" }, ref: "draft", branch: "vitehub/content" },
    { name: "a branch that starts from the default branch", refs: undefined, ref: "feature", branch: "feature" },
  ])("brings the files that the remote copied into a new ref on the first push: $name", async ({ refs, ref, branch }) => {
    fake.commit("main", { "content/posts/published.md": post("Published", "One.") })
    const server = app({ refs })
    const local = await project(server.fetch, "new-ref")
    const pulled = await local.json("pull", "content", "--dir", "content", "--ref", ref, "--url", remote)
    expect(pulled.value[0].head).toBeNull()
    await local.write("posts/new.md", post("New", "Local."))

    const pushed = await local.json("push")

    expect(pushed.code).toBe(0)
    expect(fake.tree(branch).map(entry => entry.path).sort()).toEqual(["content/posts/new.md", "content/posts/published.md"])
    // The checkout matches the new ref, also the file that the Store copied from the ref it started from.
    expect(await local.read("posts/published.md")).toBe(post("Published", "One."))
    expect(Object.keys((await local.lock()).workspaces.content.files).sort()).toEqual(["posts/new.md", "posts/published.md"])
    expect((await local.status())[0]!.local).toEqual(clean)
    expect((await local.run("pull")).stdout).toBe(`content: up to date with ${ref} (${fake.head(branch)}).\n`)
  })

  it("keeps the Git mode of an executable file that a push replaces", async () => {
    fake.commit("main", { "content/bin/run.sh": { content: "#!/bin/sh\necho one\n", mode: "100755" } })
    const server = app()
    const local = await project(server.fetch, "mode")
    await local.run("pull", "content", "--dir", "content", "--url", remote)
    await local.write("bin/run.sh", "#!/bin/sh\necho two\n")

    expect((await local.run("push")).code).toBe(0)

    expect(fake.tree("main").find(entry => entry.path === "content/bin/run.sh")).toMatchObject({ mode: "100755", sha: textSha("#!/bin/sh\necho two\n") })
    const view = await server.history.open(fake.head("main")!)
    expect(await view.stat("bin/run.sh")).toMatchObject({ metadata: { gitMode: "100755" } })
  })

  it("records the signed-in user in the commit trailer, and reports the Git author as the revision author", async () => {
    fake.commit("main", { "content/posts/hello.md": post("Hello", "One.") })
    const server = app({ user: { id: "user-1", name: "Ana", email: "ana@example.com" } })
    const local = await project(server.fetch, "author")
    await local.run("pull", "content", "--dir", "content", "--url", remote)
    await local.write("posts/hello.md", post("Hello", "Two."))

    expect((await local.run("push")).code).toBe(0)

    const [input] = fake.commitInputs().slice(-1)
    expect(input!.message.body).toBe(`Vitehub-Metadata: ${JSON.stringify({ source: "cli", author: { id: "user-1", name: "Ana", email: "ana@example.com" } })}`)
    expect(additionText(input!.fileChanges.additions![0]!.contents)).toBe(post("Hello", "Two."))
    // GitHub writes the commit as the account of the token. Its author wins over the trailer, so a commit message cannot forge it.
    const revision = await server.history.head()
    expect(revision!.metadata).toMatchObject({ source: "cli", author: "Bot", authorEmail: "bot@example.com" })
    const listed = await runOperation(registry, "workspace.history", { workspace: "content", ref: "main", limit: 1 }, { access: { mode: "local", sections: "all" }, surface: "cli", user: null })
    expect(listed).toMatchObject({ ok: true, value: { revisions: [{ author: "Bot", id: revision!.id }] } })
  })
})
