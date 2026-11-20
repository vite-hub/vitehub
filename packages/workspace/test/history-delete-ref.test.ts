import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { createClient } from "@libsql/client"
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/libsql"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createBlobDatabaseWorkspaceStore } from "../src/blob-database.ts"
import { useWorkspaceFiles } from "../src/files.ts"
import { resetWorkspaceRegistry } from "../src/core/registry.ts"
import { createGitHubWorkspaceStore } from "../src/providers/github/store.ts"
import { createBlobStorage } from "../../blob/src/storage.ts"
import { createDriver } from "../../blob/src/drivers/fs.ts"
import { createFakeGitHub } from "./fake-github.ts"
import { blobError } from "../../blob/src/errors.ts"

import type { BlobStorage } from "@vite-hub/blob"

const cleanup: Array<() => Promise<void> | void> = []
const migration = await readFile(new URL("fixtures/history.sql", import.meta.url), "utf8")

afterEach(async () => {
  resetWorkspaceRegistry()
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

async function historyDatabase() {
  await mkdir(join(homedir(), ".cache/fleet/tmp"), { recursive: true })
  const root = await mkdtemp(join(homedir(), ".cache/fleet/tmp/workspace-delete-ref-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const client = createClient({ url: `file:${join(root, "history.sqlite")}` })
  cleanup.push(() => client.close())
  const database = drizzle({ client })
  for (const statement of migration.split(";").filter(statement => statement.trim())) await database.run(sql.raw(statement))
  const blob = createBlobStorage(createDriver({ driver: "fs", base: join(root, "objects") }))
  return { blob, database }
}

async function objectCount(blob: BlobStorage) {
  const [error, page] = await blob.list({ prefix: "_vitehub/workspace-history/" })
  if (error) throw error
  return page.blobs.length
}

describe("history.deleteRef() on the Blob + Database Store", () => {
  it("deletes a run ref, its revisions, and the bytes that no other ref uses", async () => {
    const { blob, database } = await historyDatabase()
    const workspace = useWorkspaceFiles("meetups", { mode: "write", definition: { name: "meetups", store: createBlobDatabaseWorkspaceStore({ blob, database, workspace: "meetups" }) } })
    await workspace.history.commit({ ifHead: null, files: { "app.vue": "<NuxtPage />", "README.md": "Meetups" } })
    const run = await workspace.history.commit({ ref: "run-42", ifHead: null, files: { "app.vue": "<NuxtPage />", "server/api/rsvp.post.ts": "export default {}", "shared.ts": "both runs" } })
    await workspace.history.commit({ ref: "run-43", ifHead: null, files: { "shared.ts": "both runs" } })
    expect(await objectCount(blob)).toBe(4)

    await expect(workspace.history.deleteRef({ ref: "run-42", ifHead: "stale" })).rejects.toMatchObject({ code: "WORKSPACE_CONFLICT" })
    expect(await workspace.history.deleteRef({ ref: "run-42", ifHead: run.id })).toBe(true)

    expect((await workspace.history.refs()).map(ref => ref.name)).toEqual(["main", "run-43"])
    expect(await workspace.history.head({ ref: "run-42" })).toBeNull()
    await expect(workspace.history.open(run.id)).rejects.toMatchObject({ code: "WORKSPACE_NOT_FOUND" })
    // Only the bytes of `server/api/rsvp.post.ts` go: `main` has `app.vue`, and `run-43` has `shared.ts`.
    expect(await objectCount(blob)).toBe(3)
    expect(await workspace.history.usage()).toEqual({ bytes: 28, objects: 3 })
    expect(await workspace.history.deleteRef({ ref: "run-42" })).toBe(false)

    // A later commit with the same bytes uploads them again.
    const again = await workspace.history.commit({ ref: "run-44", ifHead: null, files: { "server/api/rsvp.post.ts": "export default {}" } })
    expect(await (await workspace.history.open(again.id)).readFile("server/api/rsvp.post.ts")).toBe("export default {}")
  })

  it("keeps the default ref", async () => {
    const { blob, database } = await historyDatabase()
    const workspace = useWorkspaceFiles("meetups", { mode: "write", definition: { name: "meetups", store: createBlobDatabaseWorkspaceStore({ blob, database, workspace: "meetups" }) } })
    await workspace.history.commit({ ifHead: null, files: { "app.vue": "<NuxtPage />" } })
    await expect(workspace.history.deleteRef({ ref: "main" })).rejects.toMatchObject({ code: "WORKSPACE_DEFAULT_REF_DELETE" })
    expect((await workspace.history.refs()).map(ref => ref.name)).toEqual(["main"])
  })

  it("uploads the bytes again when a deleteRef() in another process removes them during a commit", async () => {
    const { blob, database } = await historyDatabase()
    const writer = createBlobDatabaseWorkspaceStore({ blob, database, workspace: "meetups" })
    await writer.history.commit({ ref: "run-42", ifHead: null, files: { "rsvp.ts": { path: "rsvp.ts", content: "export default {}" } } })

    // The commit on `run-43` sees the object of `run-42` and skips the upload. Then another process deletes `run-42`.
    let interrupt: (() => Promise<void>) | undefined = async () => {
      await createBlobDatabaseWorkspaceStore({ blob, database, workspace: "meetups" }).history.deleteRef!({ ref: "run-42" })
    }
    const racing = new Proxy(blob, {
      get(target, key) {
        if (key !== "head") return Reflect.get(target, key)
        return async (pathname: string) => {
          const result = await target.head(pathname)
          const run = interrupt
          interrupt = undefined
          await run?.()
          return result
        }
      },
    })
    const committer = createBlobDatabaseWorkspaceStore({ blob: racing, database, workspace: "meetups" })
    const revision = await committer.history.commit({ ref: "run-43", ifHead: null, files: { "rsvp.ts": { path: "rsvp.ts", content: "export default {}" } } })

    expect(interrupt).toBeUndefined()
    expect(await (await writer.history.open(revision.id)).readFile("rsvp.ts")).toBe("export default {}")
  })

  it("does not publish against another writer's registration before its upload", async () => {
    const { blob, database } = await historyDatabase()
    const store = (storage = blob) => createBlobDatabaseWorkspaceStore({ blob: storage, database, workspace: "meetups" })
    const files = { "run.ts": { path: "run.ts", content: "results" } }
    await store().history.commit({ ref: "old", ifHead: null, files })

    const enteredHead = Promise.withResolvers<void>()
    const resumeHead = Promise.withResolvers<void>()
    const primary = Object.create(blob) as BlobStorage
    primary.head = vi.fn(blob.head.bind(blob)).mockImplementationOnce(async key => {
      const result = await blob.head(key)
      enteredHead.resolve()
      await resumeHead.promise
      return result
    })
    const commit = store(primary).history.commit({ ref: "primary", ifHead: null, files })
    await enteredHead.promise
    await store().history.deleteRef!({ ref: "old" })

    const enteredPut = Promise.withResolvers<void>()
    const resumePut = Promise.withResolvers<void>()
    const secondary = Object.create(blob) as BlobStorage
    secondary.put = vi.fn(blob.put.bind(blob)).mockImplementationOnce(async (...args) => {
      enteredPut.resolve()
      await resumePut.promise
      return await blob.put(...args)
    })
    const other = store(secondary).history.commit({ ref: "secondary", ifHead: null, files })
    await enteredPut.promise
    resumeHead.resolve()
    try {
      const result = await commit
      expect(await (await store().history.open(result.id)).readFile("run.ts")).toBe("results")
    }
    finally {
      resumePut.resolve()
      await other
    }
  })

  it("does not let a stalled cleanup delete replacement bytes after a retry", async () => {
    const { blob, database } = await historyDatabase()
    const store = (storage = blob) => createBlobDatabaseWorkspaceStore({ blob: storage, database, workspace: "meetups" })
    const files = { "run.ts": { path: "run.ts", content: "results" } }
    await store().history.commit({ ref: "old", ifHead: null, files })
    const entered = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    const stalled = Object.create(blob) as BlobStorage
    stalled.delete = vi.fn(blob.delete.bind(blob)).mockImplementationOnce(async (...args) => {
      entered.resolve()
      await resume.promise
      return await blob.delete(...args)
    })
    const cleanup = store(stalled).history.deleteRef!({ ref: "old" })
    await entered.promise
    const future = Date.now() + 11 * 60_000
    const clock = vi.spyOn(Date, "now").mockReturnValue(future)
    try {
      expect(await store().history.deleteRef!({ ref: "old" })).toBe(false)
      const result = await store().history.commit({ ref: "new", ifHead: null, files })
      resume.resolve()
      expect(await cleanup).toBe(true)
      expect(await (await store().history.open(result.id)).readFile("run.ts")).toBe("results")
    }
    finally {
      clock.mockRestore()
      resume.resolve()
      await cleanup
    }
  })

  it("retries catalog and Blob cleanup across failures without losing the candidates", async () => {
    const { blob, database } = await historyDatabase()
    const store = () => createBlobDatabaseWorkspaceStore({ blob, database, workspace: "meetups" })
    const files = { "run.ts": { path: "run.ts", content: "results" } }
    const run = await store().history.commit({ ref: "old", ifHead: null, files })
    await database.run(sql`create trigger fail_mark before update on workspace_history_objects begin select raise(abort, 'injected catalog failure'); end`)
    try {
      await expect(store().history.deleteRef!({ ref: "old" })).rejects.toThrow()
      expect((await store().history.head({ ref: "old" }))?.id).toBe(run.id)
    }
    finally {
      await database.run(sql`drop trigger fail_mark`)
    }
    vi.spyOn(blob, "delete").mockResolvedValueOnce([blobError("BLOB_OPERATION_FAILED", "delete", "test"), undefined])
    await expect(store().history.deleteRef!({ ref: "old" })).rejects.toMatchObject({ code: "BLOB_OPERATION_FAILED" })
    await expect(store().history.head({ ref: "old" })).resolves.toBeNull()
    expect(await objectCount(blob)).toBe(1)
    expect(await store().history.deleteRef!({ ref: "old" })).toBe(false)
    expect(await objectCount(blob)).toBe(0)
  })
})

describe("history.deleteRef() on the GitHub Store", () => {
  let fake: ReturnType<typeof createFakeGitHub>

  beforeEach(() => {
    fake = createFakeGitHub()
    vi.stubGlobal("fetch", vi.fn(fake.fetch))
    vi.stubEnv("VITEHUB_GITHUB_TOKEN", "")
    vi.stubEnv("FORGES_GITHUB_TOKEN", "")
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it("deletes the branch of the ref", async () => {
    fake.commit("main", { "app.vue": "<NuxtPage />" })
    const run = fake.commit("run-42", { "rsvp.ts": "export default {}" })
    const workspace = useWorkspaceFiles("meetups", { mode: "write", definition: { name: "meetups", store: createGitHubWorkspaceStore({ driver: "github", repo: "onmax/repo", token: "token", root: "" }, "meetups") } })

    await expect(workspace.history.deleteRef({ ref: "run-42", ifHead: "0".repeat(40) })).rejects.toMatchObject({ code: "WORKSPACE_CONFLICT" })
    expect(fake.head("run-42")).toBe(run)
    expect(await workspace.history.deleteRef({ ref: "run-42", ifHead: run })).toBe(true)
    expect(fake.head("run-42")).toBeUndefined()
    expect(await (await workspace.history.open(run)).readFile("rsvp.ts")).toBe("export default {}")
    expect((await workspace.history.refs()).map(ref => ref.name)).toEqual(["main"])
    expect(await workspace.history.deleteRef({ ref: "run-42" })).toBe(false)
  })

  it.each([
    { branch: "main", refs: { published: "main" }, ref: "published" },
    { branch: "working-tree", refs: undefined, ref: "working-tree" },
  ])("keeps the working branch $branch when deleting $ref", async ({ branch, refs, ref }) => {
    fake.state.defaultBranch = "trunk"
    fake.commit("trunk", { "README.md": "Repository default" })
    const head = fake.commit(branch, { "app.vue": "<NuxtPage />" })
    const store = createGitHubWorkspaceStore({ driver: "github", repo: "onmax/repo", token: "token", root: "", branch, ...(refs ? { refs } : {}) }, "meetups")

    await expect(store.history.deleteRef!({ ref })).rejects.toMatchObject({ code: "WORKSPACE_DEFAULT_REF_DELETE" })
    expect(fake.head(branch)).toBe(head)
    expect(fake.writes()).toHaveLength(0)
  })
})
