import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createClient } from "@libsql/client"
import { readViteHubConsoleActionFailure } from "@vite-hub/internal/console"
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/libsql"
import { afterEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"

import { useWorkspace } from "@vite-hub/workspace"
import { createBlobDatabaseWorkspaceStore, workspaceHistorySchema } from "@vite-hub/workspace/blob-database"
import { registerWorkspace } from "@vite-hub/workspace/test"

import { createBlobStorage } from "../../blob/src/storage.ts"
import { createDriver } from "../../blob/src/drivers/fs.ts"
import { defineSchedule } from "../../schedule/src/definition.ts"
import { runSchedule } from "../../schedule/src/runtime/execute.ts"
import { executeCloudflareStaticSchedules, executeStaticSchedule } from "../../schedule/src/runtime/static.ts"
import { contentScheduleOverdueMs, contentSchedulesRef, defineContent, documents, singleton } from "../src/index.ts"
import { createContentConsoleActions } from "../src/runtime/console.ts"

const migration = await readFile(new URL("../../workspace/test/fixtures/history.sql", import.meta.url), "utf8")
const cleanup: Array<() => Promise<void> | void> = []
let workspaces = 0

afterEach(async () => {
  vi.useRealTimers()
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

async function historyWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vitehub-content-schedules-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const client = createClient({ url: `file:${join(root, "history.sqlite")}` })
  cleanup.push(() => client.close())
  const database = drizzle(client, { schema: workspaceHistorySchema })
  for (const statement of migration.split(";").filter(statement => statement.trim())) await database.run(sql.raw(statement))
  const blob = createBlobStorage(createDriver({ driver: "fs", base: join(root, "objects") }))
  const name = `schedules-${++workspaces}`
  registerWorkspace(name, { store: createBlobDatabaseWorkspaceStore({ blob, database, workspace: name }) })
  return name
}

async function setup() {
  const workspace = await historyWorkspace()
  const content = defineContent({
    workspace,
    collections: {
      // A root `*.json` collection must not see the extensionless schedule files.
      pages: documents({ path: "*.json", fields: { title: z.string() } }),
      posts: documents({ path: "posts/*.md", fields: { title: z.string() } }),
      settings: singleton({ path: "config/settings.yaml", fields: { title: z.string() } }),
    },
    authorize: ({ action, user }) => action !== "publish" || user?.role === "editor",
    logger: false,
  })
  cleanup.push(() => content.dispose())
  return { content, workspace, posts: content.collection("posts"), settings: content.collection("settings") }
}

async function rejection(promise: Promise<unknown>): Promise<any> {
  try {
    await promise
  }
  catch (error) {
    return error
  }
  throw new Error("Expected the promise to reject.")
}

async function failure(promise: unknown): Promise<any> {
  try {
    await promise
  }
  catch (error) {
    return readViteHubConsoleActionFailure(error) ?? error
  }
  throw new Error("Expected the action to fail.")
}

const hour = 60 * 60_000
const later = () => new Date(Date.now() + hour)

describe("scheduled publishing", { timeout: 30_000 }, () => {
  it("publishes exactly the reviewed drafts when the schedule is due", async () => {
    const { content, workspace, posts } = await setup()
    const saved = await posts.save("hello", { data: { title: "Hello" }, body: "Hi." })
    const at = later()
    const schedule = await content.schedule({ at, expect: [{ collection: "posts", id: "hello", digest: saved.digest }], message: "Launch", metadata: { author: { id: "ada" } } })
    expect(schedule).toMatchObject({ at: at.toISOString(), status: "pending", expect: [{ collection: "posts", id: "hello", digest: saved.digest }], message: "Launch", metadata: { author: { id: "ada" } } })
    await expect(content.schedules()).resolves.toEqual([schedule])
    await expect(content.schedules({ collection: "posts", id: "hello" })).resolves.toHaveLength(1)
    await expect(rejection(content.schedules({ id: "hello" }))).resolves.toMatchObject({ code: "CONTENT_R0011", message: expect.stringContaining("requires collection") })
    await expect(content.schedules({ collection: "settings" })).resolves.toEqual([])
    await expect(posts.status("hello")).resolves.toMatchObject({ state: "draft", schedule: { id: schedule.id, at: schedule.at, status: "pending", digest: saved.digest } })

    // Before its time a run publishes nothing.
    await expect(content.publishDue({ now: new Date(at.getTime() - 1) })).resolves.toEqual({ published: [], failed: [] })
    await expect(posts.get("hello")).resolves.toBeNull()

    const result = await content.publishDue({ now: at })
    expect(result).toMatchObject({ published: [{ schedule: schedule.id, documents: [{ collection: "posts", id: "hello", change: "add" }] }], failed: [] })
    await expect(posts.get("hello")).resolves.toMatchObject({ data: { title: "Hello" }, digest: saved.digest })
    await expect(content.schedules()).resolves.toEqual([])
    await expect(posts.status("hello")).resolves.not.toHaveProperty("schedule")

    // The publish revision names the schedule and keeps its message and metadata.
    const [published] = (await content.revisions("posts", "hello", { ref: "published" })).revisions
    expect(published).toMatchObject({ id: result.published[0]!.revision, message: "Launch", metadata: { author: { id: "ada" }, content: { action: "publish", schedule: schedule.id } } })
    // The schedules ref keeps the whole life of the schedule.
    const history = useWorkspace(workspace as never).history
    const { revisions } = await history.list({ ref: contentSchedulesRef })
    expect(revisions.map(revision => revision.metadata?.content)).toMatchObject([
      { action: "schedule-published", schedule: schedule.id, revision: published!.id },
      { action: "schedule", schedule: schedule.id, at: schedule.at, documents: [{ collection: "posts", id: "hello" }] },
    ])
    // A second run finds nothing due.
    await expect(content.publishDue({ now: at })).resolves.toEqual({ published: [], failed: [] })
  })

  it("fails visibly instead of publishing a draft that changed after scheduling", async () => {
    const { content, posts } = await setup()
    const reviewed = await posts.save("hello", { data: { title: "Reviewed" }, body: "" })
    const at = later()
    const schedule = await content.schedule({ at, expect: [{ collection: "posts", id: "hello", digest: reviewed.digest }] })
    const changed = await posts.save("hello", { data: { title: "Not reviewed" }, body: "" })

    const result = await content.publishDue({ now: at })
    expect(result.published).toEqual([])
    expect(result.failed).toEqual([expect.objectContaining({
      id: schedule.id,
      status: "failed",
      failure: expect.objectContaining({
        code: "WORKSPACE_CONFLICT",
        details: { ref: "draft", documents: [{ collection: "posts", id: "hello", expected: reviewed.digest, actual: changed.digest }] },
      }),
    })])
    await expect(posts.get("hello")).resolves.toBeNull()
    // The failure stays until someone dismisses it, and later runs leave it alone.
    await expect(content.schedules({ status: "failed" })).resolves.toEqual(result.failed)
    await expect(posts.status("hello")).resolves.toMatchObject({ state: "draft", schedule: { id: schedule.id, status: "failed", digest: reviewed.digest } })
    await expect(content.publishDue({ now: new Date(at.getTime() + hour) })).resolves.toEqual({ published: [], failed: [] })

    // A failed schedule does not block a new one for the latest draft.
    const next = await content.schedule({ at: new Date(at.getTime() + hour), expect: [{ collection: "posts", id: "hello", digest: changed.digest }] })
    await expect(posts.status("hello")).resolves.toMatchObject({ schedule: { id: next.id, status: "pending" } })
    await content.unschedule(schedule.id)
    await expect(content.schedules()).resolves.toEqual([next])
  })

  it("cancels a pending schedule", async () => {
    const { content, posts } = await setup()
    const saved = await posts.save("hello", { data: { title: "Hello" }, body: "" })
    const at = later()
    const schedule = await content.schedule({ at, expect: [{ collection: "posts", id: "hello", digest: saved.digest }] })
    await content.unschedule(schedule.id, { metadata: { author: { id: "grace" } } })
    await expect(content.schedules()).resolves.toEqual([])
    await expect(content.publishDue({ now: at })).resolves.toEqual({ published: [], failed: [] })
    await expect(posts.get("hello")).resolves.toBeNull()
    await expect(rejection(content.unschedule(schedule.id))).resolves.toMatchObject({ code: "CONTENT_NOT_FOUND", details: { schedule: schedule.id } })
  })

  it("reports schedules past their time without a run as overdue, and runs them late", async () => {
    const { content, posts } = await setup()
    const saved = await posts.save("hello", { data: { title: "Hello" }, body: "" })
    const at = later()
    const schedule = await content.schedule({ at, expect: [{ collection: "posts", id: "hello", digest: saved.digest }] })
    vi.useFakeTimers({ toFake: ["Date"] })
    // A runner that fires within the grace period keeps it pending.
    vi.setSystemTime(at.getTime() + contentScheduleOverdueMs)
    await expect(content.schedules()).resolves.toMatchObject([{ id: schedule.id, status: "pending" }])
    vi.setSystemTime(at.getTime() + contentScheduleOverdueMs + 1)
    await expect(content.schedules({ status: "overdue" })).resolves.toMatchObject([{ id: schedule.id, status: "overdue" }])
    await expect(posts.status("hello")).resolves.toMatchObject({ schedule: { status: "overdue" } })
    await expect(content.publishDue()).resolves.toMatchObject({ published: [{ schedule: schedule.id }] })
    await expect(posts.get("hello")).resolves.toMatchObject({ digest: saved.digest })
  })

  it("schedules singletons, deletions, and several documents in one publish", async () => {
    const { content, posts, settings } = await setup()
    const old = await posts.save("old", { data: { title: "Old" }, body: "" })
    await content.publish({ expect: [{ collection: "posts", id: "old", digest: old.digest }] })
    await posts.remove("old")
    const site = await settings.save({ data: { title: "Site" } })
    const at = later()
    const schedule = await content.schedule({
      at: at.toISOString().replace("Z", "+00:00"),
      expect: [{ collection: "settings", digest: site.digest }, { collection: "posts", id: "old", digest: null }],
    })
    expect(schedule.expect).toEqual([{ collection: "settings", id: "settings", digest: site.digest }, { collection: "posts", id: "old", digest: null }])
    await expect(settings.status()).resolves.toMatchObject({ schedule: { id: schedule.id } })
    await expect(posts.status("old")).resolves.toMatchObject({ state: "deleted", schedule: { id: schedule.id, digest: null } })
    const result = await content.publishDue({ now: at })
    expect(result.published[0]!.documents).toEqual([
      { collection: "settings", id: "settings", change: "add" },
      { collection: "posts", id: "old", change: "delete" },
    ])
    await expect(posts.get("old")).resolves.toBeNull()
  })

  it("rejects schedules that could not publish what was reviewed", async () => {
    const { content, posts } = await setup()
    const saved = await posts.save("hello", { data: { title: "Hello" }, body: "" })
    const expected = [{ collection: "posts", id: "hello", digest: saved.digest }]
    await expect(rejection(content.schedule({ at: new Date(Date.now() - 1), expect: expected }))).resolves.toMatchObject({ code: "CONTENT_R0011", message: expect.stringContaining("must be in the future") })
    await expect(rejection(content.schedule({ at: "2099-10-20T09:00", expect: expected }))).resolves.toMatchObject({ code: "CONTENT_R0011", message: expect.stringContaining("time zone") })
    await expect(rejection(content.schedule({ at: later(), expect: [] }))).resolves.toMatchObject({ code: "CONTENT_R0011" })
    await expect(rejection(content.schedule({ at: later(), expect: [{ collection: "posts", id: "hello", digest: "0".repeat(64) }] }))).resolves.toMatchObject({
      code: "WORKSPACE_CONFLICT",
      message: expect.stringContaining("schedule() scheduled nothing"),
      details: { ref: "draft", documents: [{ collection: "posts", id: "hello", expected: "0".repeat(64), actual: saved.digest }] },
    })
    const first = await content.schedule({ at: later(), expect: expected })
    await expect(rejection(content.schedule({ at: later(), expect: expected }))).resolves.toMatchObject({ code: "CONTENT_R0011", message: expect.stringContaining(`unschedule(${JSON.stringify(first.id)})`) })
    await content.unschedule(first.id)
    await content.publish({ expect: expected })
    await expect(rejection(content.schedule({ at: later(), expect: expected }))).resolves.toMatchObject({ code: "CONTENT_R0011", message: expect.stringContaining("already published") })
  })

  it("settles each schedule once when runs overlap", async () => {
    const { content, posts } = await setup()
    const saved = await posts.save("hello", { data: { title: "Hello" }, body: "" })
    const at = later()
    const schedule = await content.schedule({ at, expect: [{ collection: "posts", id: "hello", digest: saved.digest }] })
    const runs = await Promise.all([content.publishDue({ now: at }), content.publishDue({ now: at })])
    expect(runs.flatMap(run => run.published.map(entry => entry.schedule))).toEqual([schedule.id])
    expect(runs.flatMap(run => run.failed)).toEqual([])
    await expect(content.revisions("posts", "hello", { ref: "published" })).resolves.toMatchObject({ revisions: [{ metadata: { content: { schedule: schedule.id } } }] })
  })
})

describe("scheduled publishing on Schedule hosts", { timeout: 30_000 }, () => {
  // The Schedule Definition the docs show: `server/schedules/content-publish.ts`.
  function runner(content: Awaited<ReturnType<typeof setup>>["content"]) {
    return defineSchedule({ cron: "* * * * *", manual: true, handler: () => content.publishDue() })
  }

  async function due() {
    const context = await setup()
    const saved = await context.posts.save("hello", { data: { title: "Hello" }, body: "" })
    vi.useFakeTimers({ toFake: ["Date"] })
    const at = later()
    await context.content.schedule({ at, expect: [{ collection: "posts", id: "hello", digest: saved.digest }] })
    vi.setSystemTime(at)
    return context
  }

  it("publishes from a Cloudflare Cron Trigger", async () => {
    const { content, posts } = await due()
    const definition = runner(content)
    const [result] = await executeCloudflareStaticSchedules(
      { cron: "* * * * *", scheduledTime: Date.now() },
      { registry: { "content-publish": async () => ({ default: definition }) } },
    )
    expect(result).toMatchObject({ published: [{ documents: [{ id: "hello", change: "add" }] }] })
    await expect(posts.get("hello")).resolves.not.toBeNull()
  })

  it("publishes from a Vercel Cron Job or Process Runtime wake", async () => {
    const { content, posts } = await due()
    const definition = runner(content)
    await executeStaticSchedule({ cron: definition.cron, definition, name: "content-publish", scheduledAt: new Date() })
    await expect(posts.get("hello")).resolves.not.toBeNull()
  })

  it("publishes from a manual run, as `vitehub schedule run content-publish` starts it", async () => {
    const { content, posts } = await due()
    const definition = runner(content)
    const run = await runSchedule("content-publish", { registry: { "content-publish": async () => ({ default: definition }) } })
    expect(run.status).toBe("succeeded")
    await expect(posts.get("hello")).resolves.not.toBeNull()
  })
})

describe("scheduled publishing in the Console", { timeout: 30_000 }, () => {
  const editor = { user: { id: "ada", name: "Ada", role: "editor" } }
  const writer = { user: { id: "lin", role: "writer" } }

  it("schedules, lists, and cancels with publish access", async () => {
    const { content, posts } = await setup()
    const actions = createContentConsoleActions({ content })
    const saved = await posts.save("hello", { data: { title: "Hello" }, body: "" })
    await posts.save("other", { data: { title: "Other" }, body: "" })
    const at = later().toISOString()
    const input = { collection: "posts", at, expect: [{ id: "hello", digest: saved.digest }] }
    await expect(failure(actions.schedule(input, writer))).resolves.toMatchObject({ status: 403, code: "CONTENT_FORBIDDEN" })
    const schedule = await actions.schedule(input, editor)
    expect(schedule).toMatchObject({ at, status: "pending", documents: [{ id: "hello", digest: saved.digest }] })
    await expect(content.schedules()).resolves.toMatchObject([{ id: schedule.id, metadata: { author: { id: "ada", name: "Ada" }, source: "console" } }])

    const page = await actions.list({ collection: "posts" }, editor)
    expect(page.scheduled).toBe(1)
    expect(page.items.find(item => item.id === "hello")).toMatchObject({ schedule: { id: schedule.id, at, status: "pending" } })
    expect(page.items.find(item => item.id === "other")).not.toHaveProperty("schedule")
    await expect(actions.list({ collection: "posts", scheduled: true }, editor)).resolves.toMatchObject({ total: 1, items: [{ id: "hello" }] })
    await expect(actions.get({ collection: "posts", id: "hello" }, editor)).resolves.toMatchObject({ schedule: { id: schedule.id, at } })
    // The dashboard lists scheduled publishes with their titles, soonest first.
    const overview = await actions.overview({ activity: 0 }, editor)
    expect(overview.collections.find(collection => collection.name === "posts")?.scheduled).toEqual([{ id: "hello", title: "Hello", schedule: { id: schedule.id, at, status: "pending" } }])

    // A changed draft fails with the conflict the editor already shows for publish.
    await expect(failure(actions.schedule({ ...input, expect: [{ id: "other", digest: saved.digest }] }, editor))).resolves.toMatchObject({ status: 409, code: "WORKSPACE_CONFLICT", details: { documents: [{ id: "other" }] } })
    await expect(failure(actions.unschedule({ collection: "posts", schedule: schedule.id }, writer))).resolves.toMatchObject({ status: 403, code: "CONTENT_FORBIDDEN" })
    await actions.unschedule({ collection: "posts", schedule: schedule.id }, editor)
    await expect(actions.list({ collection: "posts", scheduled: true }, editor)).resolves.toMatchObject({ total: 0, scheduled: 0 })
    expect((await actions.overview({ activity: 0 }, editor)).collections.find(collection => collection.name === "posts")?.scheduled).toEqual([])
    await expect(failure(actions.unschedule({ collection: "posts", schedule: schedule.id }, editor))).resolves.toMatchObject({ status: 404, code: "CONTENT_SCHEDULE_NOT_FOUND" })
  })

  it("names no document of a failed schedule that a per-document policy hides", async () => {
    const { content, posts, workspace } = await setup()
    const hello = await posts.save("hello", { data: { title: "Hello" }, body: "" })
    const secret = await posts.save("secret", { data: { title: "Secret plan" }, body: "" })
    const at = later()
    await content.schedule({ at, expect: [{ collection: "posts", id: "hello", digest: hello.digest }, { collection: "posts", id: "secret", digest: secret.digest }] })
    await posts.save("secret", { data: { title: "Secret plan v2" }, body: "" })
    const run = await content.publishDue({ now: at })
    // The runtime failure names the document that moved.
    expect(run.failed[0]?.failure?.message).toContain("posts/secret")

    const scoped = defineContent({
      workspace,
      collections: { posts: documents({ path: "posts/*.md", fields: { title: z.string() } }) },
      authorize: ({ action, id }) => action === "read" && id !== "secret",
      logger: false,
    })
    cleanup.push(() => scoped.dispose())
    const actions = createContentConsoleActions({ content: scoped })
    const reader = { user: { id: "rae", role: "reader" } }
    const page = await actions.list({ collection: "posts" }, reader)
    expect(page.items.map(item => item.id)).toEqual(["hello"])
    const failed = { status: "failed", failure: "A document changed after it was scheduled, so nothing was published." }
    expect(page.items[0]!.schedule).toMatchObject(failed)
    const document = await actions.get({ collection: "posts", id: "hello" }, reader)
    expect(document?.schedule).toMatchObject(failed)
    const overview = await actions.overview({ activity: 0 }, reader)
    expect(overview.collections[0]!.scheduled).toEqual([{ id: "hello", title: "Hello", schedule: expect.objectContaining(failed) }])
    expect(JSON.stringify([page, document, overview])).not.toMatch(/secret/i)
  })
})
