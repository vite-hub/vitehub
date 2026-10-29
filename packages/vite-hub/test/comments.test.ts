import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createClient } from "@libsql/client"
import { drizzle } from "drizzle-orm/libsql"
import { defineCommentSubject, defineComments } from "@vite-hub/comments"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { commentsOperations } from "@vite-hub/comments/operations"
import { commentsOperationsConsoleSection as commentsConsoleSection } from "@vite-hub/comments/vite"
import { describeViteHubConsoleSection } from "@vite-hub/internal/console"
import { createOperationRegistry, runOperation } from "@vite-hub/internal/operations"
import { createRpcTransport } from "@vite-hub/comments/rpc"
import { createCommentsStore, installComments } from "@vite-hub/comments/server"
import { runViteHubCli } from "@vite-hub/cli"

import { discoverConsoleBuildCatalog, withConsoleDocumentEditorSections } from "../src/console/build.ts"
import { operationCell, operationLink } from "../src/console/runtime/client/operation-view.ts"
import { consoleRpcHeader } from "../src/console/runtime/rpc.ts"
import { installConsoleDevelopment } from "../src/console/runtime/server/development.ts"
import { installConsoleAccess } from "../src/console/runtime/server/access.ts"
import { installConsoleOperations, installConsoleProjectRoot } from "../src/console/runtime/server/operation-contributions.ts"
import { handleConsoleRpcRequest } from "./support/console-rpc.ts"

import type { CommentsDefinition, CommentUser } from "@vite-hub/comments"
import type { CommentThread } from "@vite-hub/comments/client"

const ddl = [
  `create table vitehub_comment_threads (id text primary key, scope text not null, n integer not null, subject_kind text not null, subject_id text not null, anchor text not null, status text not null, resolved_by text, resolved_at integer, author_id text not null, author_name text, author_image text, actor text, created_at integer not null, updated_at integer not null)`,
  `create unique index vitehub_comment_threads_scope_n on vitehub_comment_threads (scope, n)`,
  `create table vitehub_comment_counters (scope text primary key, next integer not null)`,
  `create table vitehub_comment_messages (id text primary key, thread_id text not null, body text not null, author_id text not null, author_name text, author_image text, actor text, mentions text not null, attachments text not null, created_at integer not null, edited_at integer)`,
]

const ana: CommentUser = { id: "ana", name: "Ana" }
const ben: CommentUser = { id: "ben", name: "Ben" }
let signedIn: CommentUser | undefined = ana
const mentions: unknown[] = []
const pending: Promise<unknown>[] = []

async function setup(definition: CommentsDefinition = defineComments({ authorize: () => true })) {
  const client = createClient({ url: ":memory:" })
  for (const statement of ddl) await client.execute(statement)
  // SAFETY: The test database has the tables of the comments schema.
  const store = createCommentsStore(drizzle(client) as never)
  installComments({ definition, store })
  return { client, store }
}

function call(operation: string, input: unknown = {}) {
  return handleConsoleRpcRequest(new Request("http://localhost/_vitehub/rpc/__call", {
    body: JSON.stringify({ input, operation }),
    headers: { "content-type": "application/json", [consoleRpcHeader]: "1" },
    method: "POST",
  }), { waitUntil: task => void pending.push(task) })
}

async function value<T>(operation: string, input?: unknown): Promise<T> {
  const response = await call(operation, input)
  const body = await response.json() as { ok: boolean, value: T, code?: string, message?: string }
  if (!body.ok) throw new Error(`${operation} failed: ${body.code} ${body.message}`)
  return body.value
}

async function failure(operation: string, input?: unknown) {
  const response = await call(operation, input)
  expect(response.ok).toBe(false)
  return await response.json() as { code: string, fix?: string, message: string, status: number }
}

const page = { id: "/pricing", kind: "page" }
const create = (body = "Too small.", extra: Record<string, unknown> = {}) => value<CommentThread>("comments.create", { anchor: { kind: "page" }, body, subject: page, ...extra })

beforeEach(() => {
  signedIn = ana
  mentions.length = 0
  installConsoleOperations([{ operations: commentsOperations, plugin: "@vite-hub/comments" }])
  installConsoleAccess({ check: async () => undefined, mode: "auth", user: async () => signedIn as never })
})

afterEach(async () => {
  installConsoleDevelopment("/test/app", false)
  vi.unstubAllEnvs()
  await Promise.all(pending.splice(0))
  installConsoleOperations([])
  installConsoleAccess({ mode: "open" })
  installComments(() => { throw new Error("not installed") })
  vi.restoreAllMocks()
})

describe("comment operations over the Console RPC", () => {
  it("creates, lists, and gets threads in the shapes of the client types", async () => {
    await setup()
    const thread = await create()
    expect(thread).toMatchObject({ author: ana, n: 1, scope: "site", status: "open", subject: page, anchor: { kind: "page" } })
    expect(thread.messages).toHaveLength(1)
    expect(thread.messages[0]).toMatchObject({ author: ana, body: "Too small.", mentions: [], attachments: [], threadId: thread.id })
    expect(typeof thread.createdAt).toBe("number")
    expect(await value<CommentThread[]>("comments.list", { page: "/pricing" })).toEqual([thread])
    expect(await value<CommentThread[]>("comments.list", { page: "/other" })).toEqual([])
    expect(await value("comments.get", { id: thread.id })).toEqual(thread)
    expect(await value("comments.get", { n: 1, scope: "site" })).toEqual(thread)
    expect(await value("comments.get", { id: "thread_missing" })).toBeNull()
    expect(await value<CommentThread[]>("comments.list", { mine: true })).toHaveLength(1)
    signedIn = ben
    expect(await value<CommentThread[]>("comments.list", { mine: true })).toEqual([])
  })

  it("denies without a policy, and when authorize says no", async () => {
    await setup(defineComments())
    const none = await failure("comments.list")
    expect(none).toMatchObject({ code: "COMMENTS_R0006", status: 403 })
    expect(none.fix).toContain("authorize")
    await setup(defineComments({ authorize: ({ action }) => action === "read" }))
    expect(await failure("comments.create", { anchor: { kind: "page" }, body: "x", subject: page })).toMatchObject({ code: "COMMENTS_R0009", status: 403 })
    expect(await value("comments.list")).toEqual([])
  })

  it("gives the policy the user, the action, and the thread", async () => {
    const authorize = vi.fn(() => true)
    await setup(defineComments({ authorize }))
    const thread = await create()
    // `create` has no thread yet, so it gets the subject that the thread starts on.
    expect(authorize).toHaveBeenCalledWith({ action: "write", subject: page, user: ana })
    await value("comments.resolve", { threadId: thread.id })
    expect(authorize).toHaveBeenLastCalledWith({ action: "resolve", subject: page, thread: expect.objectContaining({ id: thread.id }), user: ana })
    await value("comments.get", { id: thread.id })
    expect(authorize).toHaveBeenLastCalledWith({ action: "read", subject: page, thread: expect.objectContaining({ id: thread.id }), user: ana })
  })

  it("filters the list by what authorize lets the user read", async () => {
    await setup(defineComments({ authorize: ({ action, thread, user }) => action !== "read" || !thread || thread.author.id === user?.id } satisfies CommentsDefinition))
    await create("Mine")
    signedIn = ben
    await create("Ben's")
    expect((await value<CommentThread[]>("comments.list")).map(thread => thread.author.id)).toEqual(["ben"])
  })

  it("numbers threads inside a scope, also when several are created at once", async () => {
    await setup(defineComments({ authorize: () => true, subjects: [defineCommentSubject({ kind: "drop", scope: id => `drop:${id.split("@")[0]}` })] }))
    const created = await Promise.all(Array.from({ length: 8 }, (_, index) => create(`Comment ${index}`)))
    expect(created.map(thread => thread.n).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    // Another scope starts again at 1, and a custom subject picks its own scope.
    const first = await value<CommentThread>("comments.create", { anchor: { kind: "page" }, body: "Review", subject: { id: "abc@v2", kind: "drop" } })
    const second = await value<CommentThread>("comments.create", { anchor: { kind: "page" }, body: "More", subject: { id: "abc@v3", kind: "drop" } })
    expect([first.scope, first.n, second.scope, second.n]).toEqual(["drop:abc", 1, "drop:abc", 2])
    expect((await value<CommentThread>("comments.get", { n: 2, scope: "drop:abc" })).id).toBe(second.id)
    const content = await value<CommentThread>("comments.create", { anchor: { kind: "page" }, body: "Typo", subject: { id: "posts/hello", kind: "content" } })
    expect([content.scope, content.n]).toEqual(["site", 9])
  })

  it("rejects an unknown subject kind and a bad subject id", async () => {
    await setup()
    expect(await failure("comments.create", { anchor: { kind: "page" }, body: "x", subject: { id: "1", kind: "nope" } })).toMatchObject({ code: "COMMENTS_R0008", status: 400 })
    expect(await failure("comments.create", { anchor: { kind: "page" }, body: "x", subject: { id: "pricing", kind: "page" } })).toMatchObject({ code: "COMMENTS_R0007", status: 400 })
  })

  it("lets only the author edit a message", async () => {
    await setup()
    const thread = await create("First")
    signedIn = ben
    const messageId = thread.messages[0]!.id
    expect(await failure("comments.edit", { body: "Hijacked", messageId, threadId: thread.id })).toMatchObject({ code: "COMMENTS_R0004", status: 403 })
    signedIn = ana
    const edited = await value<CommentThread>("comments.edit", { body: "Changed", messageId, threadId: thread.id })
    expect(edited.messages[0]).toMatchObject({ body: "Changed" })
    expect(typeof edited.messages[0]!.editedAt).toBe("number")
  })

  it("keeps empty and too long text out", async () => {
    await setup()
    expect(await failure("comments.create", { anchor: { kind: "page" }, body: "   ", subject: page })).toMatchObject({ code: "COMMENTS_R0005", status: 400 })
    expect(await failure("comments.create", { anchor: { kind: "page" }, body: "x".repeat(10_001), subject: page })).toMatchObject({ code: "INTERNAL_R0022", status: 400 })
    expect(await failure("comments.create", { anchor: { kind: "area", height: 600, selector: "#a", width: 600, x: 600, y: 0 }, body: "x", subject: page })).toMatchObject({ code: "INTERNAL_R0022" })
  })

  it("checks mentions against real people named in the text, and announces them after the commit", async () => {
    const { store } = await setup(defineComments({ authorize: () => true, onMention: event => void mentions.push({ mentioned: event.mentioned.map(person => person.id), thread: event.thread.n }) }))
    // Ben has written a comment, so the store knows him.
    signedIn = ben
    await create("Ben was here")
    signedIn = ana
    expect(await failure("comments.create", { anchor: { kind: "page" }, body: "Hi @Ben", mentions: ["ghost"], subject: page })).toMatchObject({ code: "COMMENTS_R0007", status: 400 })
    expect(await failure("comments.create", { anchor: { kind: "page" }, body: "No name here", mentions: ["ben"], subject: page })).toMatchObject({ code: "COMMENTS_R0007" })
    expect(mentions).toEqual([])
    const thread = await create("Look @Ben, this is wrong", { mentions: ["ben"] })
    expect(thread.messages[0]!.mentions).toEqual(["ben"])
    await Promise.all(pending.splice(0))
    expect(mentions).toEqual([{ mentioned: ["ben"], thread: thread.n }])
    expect((await store.list({ mentions: true, userId: "ben" })).map(entry => entry.id)).toEqual([thread.id])
    signedIn = ben
    expect((await value<CommentThread[]>("comments.list", { mentions: true })).map(entry => entry.id)).toEqual([thread.id])
  })

  it("deletes the thread with its first message, and only the message with a reply", async () => {
    await setup()
    const thread = await create("First")
    signedIn = ben
    const replied = await value<CommentThread>("comments.reply", { body: "Reply", threadId: thread.id })
    expect(replied.messages.map(message => message.author.id)).toEqual(["ana", "ben"])
    const reply = replied.messages[1]!
    // A reply goes back to the thread. A thread of someone else needs the delete action.
    const after = await value<CommentThread | null>("comments.delete", { messageId: reply.id, threadId: thread.id })
    expect(after?.messages).toHaveLength(1)
    await setup(defineComments({ authorize: ({ action }) => action !== "delete" }))
    signedIn = ana
    const mine = await create("Mine")
    signedIn = ben
    expect(await failure("comments.delete", { threadId: mine.id })).toMatchObject({ code: "COMMENTS_R0009", status: 403 })
    signedIn = ana
    expect(await value("comments.delete", { messageId: mine.messages[0]!.id, threadId: mine.id })).toBeNull()
    expect(await value("comments.get", { id: mine.id })).toBeNull()
    expect(await failure("comments.delete", { threadId: mine.id })).toMatchObject({ code: "COMMENTS_R0002", status: 404 })
  })

  it("resolves and reopens a thread", async () => {
    await setup()
    const thread = await create()
    signedIn = ben
    const resolved = await value<CommentThread>("comments.resolve", { threadId: thread.id })
    expect(resolved).toMatchObject({ resolvedBy: ben, status: "resolved" })
    expect(typeof resolved.resolvedAt).toBe("number")
    expect(await value<CommentThread[]>("comments.list", { status: "open" })).toEqual([])
    const reopened = await value<CommentThread>("comments.reopen", { threadId: thread.id })
    expect(reopened.status).toBe("open")
    expect(reopened).not.toHaveProperty("resolvedBy")
    await setup(defineComments({ authorize: ({ action }) => action !== "resolve" }))
    const other = await create()
    expect(await failure("comments.resolve", { threadId: other.id })).toMatchObject({ code: "COMMENTS_R0009" })
  })

  it("finds the people that wrote comments", async () => {
    await setup()
    await create()
    signedIn = ben
    await create("Ben's")
    expect(await value<CommentUser[]>("comments.users", { query: "be" })).toEqual([ben])
    expect(await value<CommentUser[]>("comments.users", { query: "en" })).toEqual([ben])
  })

  it("asks Auth for people when the runtime has an Auth adapter", async () => {
    const { store } = await setup()
    const users = { byIds: vi.fn(async (ids: readonly string[]) => ids.map(id => ({ id, name: id }))), search: vi.fn(async () => [{ id: "zed", name: "Zed" }]) }
    installComments({ definition: defineComments({ authorize: () => true }), store, users })
    expect(await value("comments.users", { query: "ze" })).toEqual([{ id: "zed", name: "Zed" }])
    const thread = await create("Hello @zed", { mentions: ["zed"] })
    expect(thread.messages[0]!.mentions).toEqual(["zed"])
    expect(users.byIds).toHaveBeenCalledWith(["zed"])
  })
})

describe("comments in the CLI, the Console, and the browser transport", () => {
  it("prints the threads for `vitehub comments list --json`", async () => {
    await setup()
    const thread = await create()
    installConsoleProjectRoot("/app")
    let output = ""
    let errors = ""
    const code = await runViteHubCli({
      args: ["comments", "list", "--json"],
      cwd: "/app",
      env: { VITEHUB_DEV_SERVER_URL: "http://localhost:5173" },
      fetch: ((url: string | URL | Request, init?: RequestInit) => handleConsoleRpcRequest(new Request(String(url), init))) as typeof fetch,
      loadConfig: async () => ({ plugins: [{ name: "comments", vitehub: { operations: [{ export: "commentsOperations", load: async () => commentsOperations, module: "@vite-hub/comments/operations" }] } }], root: "/app" }),
      loadNuxtViteConfig: async () => undefined,
      stderr: { write: (chunk: string | Uint8Array) => { errors += String(chunk); return true } },
      stdout: { write: (chunk: string | Uint8Array) => { output += String(chunk); return true } },
    })
    expect(code, errors || output).toBe(0)
    expect(JSON.parse(output)).toEqual([thread])
  })

  it("describes the Console section as a list of comments.list with filter chips and page links", () => {
    const view = commentsConsoleSection.view
    expect(view).toMatchObject({ kind: "operation-view", operation: "comments.list" })
    if (view.kind !== "operation-view") throw new Error("expected an operation view")
    expect(view.filters?.map(filter => [filter.id, filter.input])).toEqual([["all", {}], ["open", { status: "open" }], ["resolved", { status: "resolved" }], ["mine", { mine: true }], ["mentions", { mentions: true }]])
    // Every chip is an input of the operation, so the server checks access for each thread.
    const operation = commentsOperations.find(candidate => candidate.name === view.operation)!
    expect(view.filters!.every(filter => Object.keys(filter.input).every(key => ["mentions", "mine", "status"].includes(key)))).toBe(true)
    expect(operation.kind).toBe("read")
    const thread = { author: { id: "ana" }, id: "t1", messages: [{ body: "Make it bigger" }], n: 3, status: "open", subject: { id: "/pricing", kind: "page" }, updatedAt: Date.UTC(2026, 9, 25, 10, 30) }
    expect(view.columns.map(column => operationCell(thread, column))).toEqual(["3", "/pricing", "open", "ana", "Make it bigger", "2026-10-25 10:30"])
    expect(operationLink(thread, view)).toBe("/pricing?comment=3")
    expect(operationLink({ ...thread, subject: { id: "posts/hello", kind: "content" } }, view)).toBeUndefined()
    expect(describeViteHubConsoleSection(commentsConsoleSection)).toMatchObject({ id: "comments", view: { kind: "operation-view" } })
  })

  it("shows the Console user only the threads that authorize lets that user read", async () => {
    await setup(defineComments({ authorize: ({ action, thread, user }) => action !== "read" || !thread || thread.author.id === user?.id } satisfies CommentsDefinition))
    await create("Ana's")
    signedIn = ben
    await create("Ben's")
    // The view calls the operation of its filter over the RPC, as the signed-in Console user.
    const view = commentsConsoleSection.view
    if (view.kind !== "operation-view") throw new Error("expected an operation view")
    const open = view.filters!.find(filter => filter.id === "open")!
    expect((await value<CommentThread[]>(view.operation, open.input)).map(thread => thread.author.id)).toEqual(["ben"])
    signedIn = ana
    expect((await value<CommentThread[]>(view.operation, open.input)).map(thread => thread.author.id)).toEqual(["ana"])
    // Without a policy the view gets the failure and its fix instead of a list.
    await setup(defineComments())
    expect(await failure(view.operation, {})).toMatchObject({ code: "COMMENTS_R0006", fix: expect.stringContaining("authorize") })
  })

  it("lets a development server without sign-in comment as the local developer", async () => {
    await setup()
    installConsoleDevelopment("/test/app", true)
    for (const mode of ["local", "open"] as const) {
      installConsoleAccess({ mode })
      const response = await handleConsoleRpcRequest(new Request("http://localhost:5173/_vitehub/rpc/__call", {
        body: JSON.stringify({ input: { anchor: { kind: "page" }, body: `From ${mode}`, subject: page }, operation: "comments.create" }),
        headers: { "content-type": "application/json", [consoleRpcHeader]: "1" },
        method: "POST",
      }))
      const body = await response.json() as { ok: boolean, value: CommentThread }
      expect(body.ok).toBe(true)
      expect(body.value.author).toEqual({ id: "local", name: "You" })
    }
    // Production never invents a user.
    installConsoleDevelopment("/test/app", false)
    installConsoleAccess({ mode: "open" })
    expect(await failure("comments.create", { anchor: { kind: "page" }, body: "x", subject: page })).toMatchObject({ code: "COMMENTS_R0012", status: 401 })
  })

  it("runs the client transport against the RPC", async () => {
    await setup()
    const seen: string[] = []
    const transport = createRpcTransport({
      base: "/portal",
      fetch: ((url: string | URL | Request, init?: RequestInit) => {
        seen.push(String(url))
        expect(init?.credentials).toBe("same-origin")
        return handleConsoleRpcRequest(new Request(new URL(String(url), "http://localhost"), init))
      }) as typeof fetch,
    })
    const thread = await transport.create({ anchor: { kind: "page" }, body: "Hi", subject: page })
    expect(seen[0]).toBe("/portal/_vitehub/rpc/__call")
    expect(await transport.list({ page: "/pricing" })).toEqual([thread])
    expect(await transport.get({ n: 1, scope: "site" })).toEqual(thread)
    expect((await transport.reply({ body: "Again", threadId: thread.id })).messages).toHaveLength(2)
    expect((await transport.resolve({ threadId: thread.id })).status).toBe("resolved")
    expect((await transport.reopen({ threadId: thread.id })).status).toBe("open")
    expect(await transport.users({ query: "an" })).toEqual([ana])
    expect(await transport.delete({ threadId: thread.id })).toBeNull()
    expect(transport.subscribe).toBeUndefined()
    await expect(transport.get({ id: "x" })).resolves.toBeNull()
    await expect(transport.edit({ body: "x", messageId: "m", threadId: "missing" })).rejects.toMatchObject({ code: "COMMENTS_R0002", name: "CommentsRpcError", status: 404 })
  })
})

describe("the Console section", () => {
  it("joins the sections when the app has server/comments.ts", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-comments-console-"))
    try {
      await mkdir(join(root, "server"))
      const discover = () => discoverConsoleBuildCatalog({ discoveryRoot: root, plugins: [], projectRoot: root, sections: ["env"] })
      const without = await discover()
      expect(withConsoleDocumentEditorSections(["env"], without)).toEqual(["env"])
      await writeFile(join(root, "server", "comments.ts"), "export default {}\n")
      const catalog = await discover()
      expect(catalog.entries).toEqual(["comments"])
      expect(withConsoleDocumentEditorSections(["env"], catalog)).toContain("comments")
      expect(catalog.content.comments).toMatchObject({ kind: "operation-view" })
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})

const agent = { id: "agent-1", label: "Reviewer" }

/** Runs an operation as an Agent that acts for `ana`, which the RPC cannot do. */
async function asAgent<T>(name: string, input: unknown, user: CommentUser | null = ana): Promise<{ ok: boolean, value?: T, code?: string }> {
  const registry = createOperationRegistry([{ operations: commentsOperations }])
  const result = await runOperation(registry, name, input, { access: { mode: "open", sections: "all" } as never, actor: agent, surface: "agent", user: user as never })
  return result as never
}

function database() {
  const client = createClient({ url: ":memory:" })
  return { client, db: drizzle(client) }
}

async function ready() {
  const made = database()
  for (const statement of ddl) await made.client.execute(statement)
  return made
}

async function count(client: ReturnType<typeof createClient>, table: string): Promise<number> {
  return Number((await client.execute(`select count(*) as total from ${table}`)).rows[0]!.total)
}

const stub = { author: ana, id: "m", mentions: [], attachments: [], now: 1 }
const newThread = (threadId: string, id: string, scope = "site") => ({ ...stub, anchor: { kind: "page" as const }, body: "Hi", id, scope, subject: page, threadId })

describe("who can see and change a thread", () => {
  const ownOnly: CommentsDefinition = defineComments({ authorize: ({ action, thread, user }) => action === "read" ? !thread || thread.author.id === user?.id : true } satisfies CommentsDefinition)

  it("treats a thread you may not read as missing, in every operation", async () => {
    await setup(ownOnly)
    const thread = await create("Private")
    const messageId = thread.messages[0]!.id
    signedIn = ben
    for (const [name, input] of [
      ["comments.reply", { body: "Hi", threadId: thread.id }],
      ["comments.edit", { body: "Hi", messageId, threadId: thread.id }],
      ["comments.delete", { threadId: thread.id }],
      ["comments.resolve", { threadId: thread.id }],
      ["comments.reopen", { threadId: thread.id }],
    ] as const) expect(await failure(name, input), name).toMatchObject({ code: "COMMENTS_R0002", status: 404 })
    expect(await failure("comments.reply", { body: "Hi", threadId: "thread_missing" })).toMatchObject({ code: "COMMENTS_R0002", status: 404 })
    // get answers null for a hidden thread and for a missing one, by id and by number.
    expect(await value("comments.get", { id: thread.id })).toBeNull()
    expect(await value("comments.get", { n: thread.n, scope: thread.scope })).toBeNull()
    signedIn = ana
    expect(await value("comments.get", { n: thread.n, scope: thread.scope })).toEqual(thread)
  })

  it("lets nobody do anything without an authorize policy", async () => {
    const { store } = await setup(defineComments({ authorize: () => true }))
    const thread = await create("Mine")
    installComments({ definition: defineComments(), store })
    const messageId = thread.messages[0]!.id
    for (const [name, input] of [
      ["comments.get", { id: thread.id }],
      ["comments.list", {}],
      ["comments.users", { query: "an" }],
      ["comments.edit", { body: "Changed", messageId, threadId: thread.id }],
      ["comments.delete", { messageId, threadId: thread.id }],
      ["comments.delete", { threadId: thread.id }],
      ["comments.reply", { body: "Hi", threadId: thread.id }],
      ["comments.resolve", { threadId: thread.id }],
    ] as const) expect(await failure(name, input), name).toMatchObject({ code: "COMMENTS_R0006", status: 403 })
  })

  it("makes an Agent earn what the author keeps: write to edit, delete to delete", async () => {
    await setup(defineComments({ authorize: ({ action, actor }) => !actor || action === "read" }))
    const thread = await create("Mine")
    const messageId = thread.messages[0]!.id
    // The Agent acts for ana, the author, but "authors may edit their own" is for people.
    expect(await asAgent("comments.edit", { body: "Agent edit", messageId, threadId: thread.id })).toMatchObject({ code: "COMMENTS_R0009", ok: false })
    expect(await asAgent("comments.delete", { threadId: thread.id })).toMatchObject({ code: "COMMENTS_R0009", ok: false })
    expect(await asAgent("comments.reply", { body: "Agent reply", threadId: thread.id })).toMatchObject({ code: "COMMENTS_R0009", ok: false })
    // Ana herself still can.
    expect((await value<CommentThread>("comments.edit", { body: "My edit", messageId, threadId: thread.id })).messages[0]!.body).toBe("My edit")
    await setup(defineComments({ authorize: () => true }))
    const next = await create("Again")
    const edited = await asAgent<CommentThread>("comments.edit", { body: "Agent edit", messageId: next.messages[0]!.id, threadId: next.id })
    expect(edited).toMatchObject({ ok: true })
    expect(edited.value!.messages[0]!.body).toBe("Agent edit")
  })

  it("lets an author delete a thread only when every message in it is theirs", async () => {
    await setup(defineComments({ authorize: ({ action }) => action !== "delete" }))
    const alone = await create("Alone")
    const answered = await create("Answered")
    signedIn = ben
    const withReply = await value<CommentThread>("comments.reply", { body: "Reply", threadId: answered.id })
    signedIn = ana
    // The whole thread, and its first message, are not hers alone any more.
    expect(await failure("comments.delete", { threadId: answered.id })).toMatchObject({ code: "COMMENTS_R0009", status: 403 })
    expect(await failure("comments.delete", { messageId: answered.messages[0]!.id, threadId: answered.id })).toMatchObject({ code: "COMMENTS_R0009" })
    // She can still delete a reply of her own, and a thread that holds only her messages.
    const own = await value<CommentThread>("comments.reply", { body: "Mine again", threadId: answered.id })
    expect((await value<CommentThread>("comments.delete", { messageId: own.messages.find(message => message.body === "Mine again")!.id, threadId: answered.id })).messages).toHaveLength(2)
    expect(withReply.messages).toHaveLength(2)
    expect(await value("comments.delete", { threadId: alone.id })).toBeNull()
    // Ben's reply is not hers to delete.
    expect(await failure("comments.delete", { messageId: withReply.messages.find(message => message.body === "Reply")!.id, threadId: answered.id })).toMatchObject({ code: "COMMENTS_R0009" })
  })
})

describe("mention suggestions", () => {
  it("need two characters and the right to write, and give only id, name, and image", async () => {
    await setup()
    await create()
    expect(await value("comments.users", { query: "a" })).toEqual([])
    expect(await value("comments.users", { query: " a " })).toEqual([])
    expect(await value("comments.users", { query: "an" })).toEqual([ana])
    expect(await failure("comments.users", { query: "an", limit: 11 })).toMatchObject({ code: "INTERNAL_R0022" })
    await setup(defineComments({ authorize: ({ action }) => action === "read" }))
    expect(await failure("comments.users", { query: "an" })).toMatchObject({ code: "COMMENTS_R0009", status: 403 })
  })

  it("keeps the Auth adapter's extra fields and more than ten people out", async () => {
    const { store } = await setup()
    const people = Array.from({ length: 30 }, (_, index) => ({ email: `p${index}@example.com`, id: `p${index}`, image: "i.png", name: `Person ${index}` }))
    const users = { byIds: async () => [], search: vi.fn(async () => people) }
    installComments({ definition: defineComments({ authorize: () => true }), store, users })
    const found = await value<Array<Record<string, unknown>>>("comments.users", { query: "pe", limit: 10 })
    expect(found).toHaveLength(10)
    expect(found[0]).toEqual({ id: "p0", image: "i.png", name: "Person 0" })
    expect(users.search).toHaveBeenCalledWith("pe", 10)
  })

  it("search only authors of threads that the caller can read, and never an orphaned message", async () => {
    const { client } = await setup(defineComments({ authorize: ({ action, thread, user }) => action !== "read" || !thread || thread.author.id === user?.id } satisfies CommentsDefinition))
    signedIn = ben
    await create("Ben's private thread")
    signedIn = ana
    await create("Mine")
    await client.execute(`insert into vitehub_comment_messages (id, thread_id, body, author_id, author_name, mentions, attachments, created_at) values ('orphan', 'gone', 'x', 'bea', 'Bea', '[]', '[]', 1)`)
    expect(await value("comments.users", { query: "be" })).toEqual([])
    signedIn = ben
    expect(await value("comments.users", { query: "be" })).toEqual([ben])
  })

  it("count only authors that have a thread when a mention names them", async () => {
    const { client } = await setup()
    await client.execute(`insert into vitehub_comment_messages (id, thread_id, body, author_id, author_name, mentions, attachments, created_at) values ('orphan', 'gone', 'x', 'bea', 'Bea', '[]', '[]', 1)`)
    expect(await failure("comments.create", { anchor: { kind: "page" }, body: "Hi @Bea", mentions: ["bea"], subject: page })).toMatchObject({ code: "COMMENTS_R0007" })
  })
})

describe("onMention", () => {
  it("runs for the mentioned people who may read the thread, and the mention stays in the text", async () => {
    const seen: string[][] = []
    const readers = ({ action, user }: { action: string, user: CommentUser | null }) => action !== "read" || user?.id !== "cat"
    const { store } = await setup()
    const cat = { id: "cat", name: "Cat" }
    for (const person of [ben, cat]) {
      signedIn = person
      await create(`${person.name} was here`)
    }
    installComments({ definition: defineComments({ authorize: readers, onMention: event => void seen.push(event.mentioned.map(person => person.id)) }), store })
    signedIn = ana
    const thread = await create("Look @Ben and @Cat", { mentions: ["ben", "cat"] })
    await Promise.all(pending.splice(0))
    expect(thread.messages[0]!.mentions).toEqual(["ben", "cat"])
    expect(seen).toEqual([["ben"]])
    // Nobody who may read: the hook does not run.
    seen.length = 0
    installComments({ definition: defineComments({ authorize: ({ action, user }) => action !== "read" || user?.id === "ana", onMention: event => void seen.push(event.mentioned.map(person => person.id)) }), store })
    await create("Only @Ben", { mentions: ["ben"] })
    await Promise.all(pending.splice(0))
    expect(seen).toEqual([])
  })
})

describe("the comments store", () => {
  it("creates the thread and its first message together, and leaves nothing when it fails", async () => {
    const { client, db } = await ready()
    const store = createCommentsStore(db as never)
    await store.createThread(newThread("t1", "m1"))
    // The message id is taken, so the batch fails as a whole.
    await expect(store.createThread(newThread("t2", "m1"))).rejects.toThrow()
    expect(await count(client, "vitehub_comment_threads")).toBe(1)
    expect(await count(client, "vitehub_comment_messages")).toBe(1)
  })

  it("leaves nothing visible on a driver with no batch and no transaction, and shows the original error", async () => {
    const { client, db } = await ready()
    const plain = new Proxy(db, { get: (target, key) => key === "batch" || key === "transaction" ? undefined : Reflect.get(target, key) })
    const store = createCommentsStore(plain as never)
    await store.createThread(newThread("t1", "m1"))
    // The thread id is taken: the message went in first, the thread fails, and the message goes again.
    await expect(store.createThread(newThread("t1", "m2"))).rejects.toMatchObject({ code: "COMMENTS_R0011" })
    expect(await count(client, "vitehub_comment_messages")).toBe(1)
    expect(await count(client, "vitehub_comment_threads")).toBe(1)
  })

  it("never hands out a number twice, also after a delete or with threads from before the counter", async () => {
    const { client, db } = await ready()
    const store = createCommentsStore(db as never)
    const numbers: number[] = []
    for (const id of ["a", "b", "c"]) numbers.push((await store.createThread(newThread(`t-${id}`, `m-${id}`))).n)
    await store.deleteThread("t-c")
    numbers.push((await store.createThread(newThread("t-d", "m-d"))).n)
    expect(numbers).toEqual([1, 2, 3, 4])
    // Deleting a thread deletes its messages, and nobody else's.
    expect(await count(client, "vitehub_comment_messages")).toBe(3)
    // A scope with threads and no counter row starts after the highest number.
    await client.execute(`insert into vitehub_comment_threads (id, scope, n, subject_kind, subject_id, anchor, status, author_id, created_at, updated_at) values ('old', 'legacy', 7, 'page', '/', '{"kind":"page"}', 'open', 'ana', 1, 1)`)
    expect((await store.createThread(newThread("t-e", "m-e", "legacy"))).n).toBe(8)
  })

  it("takes the next number when the unique index refuses one, and gives up on any other error", async () => {
    const { client, db } = await ready()
    const store = createCommentsStore(db as never)
    await store.createThread(newThread("t1", "m1"))
    // The counter lags the threads: it offers number 2 again.
    await client.execute(`insert into vitehub_comment_threads (id, scope, n, subject_kind, subject_id, anchor, status, author_id, created_at, updated_at) values ('lag', 'site', 2, 'page', '/', '{"kind":"page"}', 'open', 'ana', 1, 1)`)
    expect((await store.createThread(newThread("t2", "m2"))).n).toBe(3)

    // The wrapper's message carries the parameters, which hold user text. Only the driver's own error decides.
    const failing = (cause: unknown) => {
      const calls = { batch: 0 }
      const broken = new Proxy(db, { get: (target, key) => key === "batch" ? async () => { calls.batch++; throw Object.assign(new Error("Failed query: insert ... params: unique constraint, duplicate key"), { cause }) } : Reflect.get(target, key) })
      return { calls, store: createCommentsStore(broken as never) }
    }
    const disk = failing(new Error("disk full"))
    await expect(disk.store.createThread(newThread("t3", "m3"))).rejects.toThrow(/Failed query/)
    expect(disk.calls.batch).toBe(1)
    const unique = failing(Object.assign(new Error("constraint"), { code: "SQLITE_CONSTRAINT_UNIQUE" }))
    await expect(unique.store.createThread(newThread("t4", "m4"))).rejects.toMatchObject({ code: "COMMENTS_R0011" })
    expect(unique.calls.batch).toBe(12)
    const postgres = failing(Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" }))
    await expect(postgres.store.createThread(newThread("t5", "m5"))).rejects.toMatchObject({ code: "COMMENTS_R0011" })
    const d1 = failing(new Error("D1_ERROR: UNIQUE constraint failed: vitehub_comment_threads.scope, vitehub_comment_threads.n"))
    await expect(d1.store.createThread(newThread("t6", "m6"))).rejects.toMatchObject({ code: "COMMENTS_R0011" })
  })
})

describe("listing threads", () => {
  it("lists the newest first, filters mentions in SQL, and pages with a cursor", async () => {
    await setup()
    const created: CommentThread[] = []
    for (let index = 0; index < 5; index++) created.push(await create(`Thread ${index}`))
    // Ben was mentioned in the oldest thread only. Ana then answers the second one, which moves it to the top.
    signedIn = ben
    await create("Ben's")
    signedIn = ana
    const mentioned = await create("Hey @Ben", { mentions: ["ben"] })
    await new Promise(done => setTimeout(done, 5))
    const touched = await value<CommentThread>("comments.reply", { body: "More", threadId: created[1]!.id })
    const all = await value<CommentThread[]>("comments.list")
    expect(all[0]!.id).toBe(touched.id)
    expect(all.map(thread => thread.updatedAt)).toEqual(all.map(thread => thread.updatedAt).toSorted((a, b) => b - a))

    signedIn = ben
    expect((await value<CommentThread[]>("comments.list", { limit: 1, mentions: true })).map(thread => thread.id)).toEqual([mentioned.id])
    signedIn = ana
    const first = await value<CommentThread[]>("comments.list", { limit: 3 })
    const last = first.at(-1)!
    const second = await value<CommentThread[]>("comments.list", { before: { id: last.id, updatedAt: last.updatedAt }, limit: 3 })
    expect([...first, ...second].map(thread => thread.id)).toEqual(all.slice(0, 6).map(thread => thread.id))
    expect(await failure("comments.list", { limit: 501 })).toMatchObject({ code: "INTERNAL_R0022" })
    expect(await failure("comments.list", { limit: 0 })).toMatchObject({ code: "INTERNAL_R0022" })
  })

  it("fills a page with readable threads and asks authorize for at most 16 at once", async () => {
    let running = 0
    let peak = 0
    const authorize: CommentsDefinition["authorize"] = async ({ action, thread }) => {
      if (action !== "read" || !thread) return true
      running++
      peak = Math.max(peak, running)
      await new Promise(done => setTimeout(done, 2))
      running--
      return thread.messages[0]!.body.startsWith("show")
    }
    const { store } = await setup(defineComments({ authorize }))
    // Every other thread is hidden, and the hidden ones are the newest.
    for (let index = 0; index < 40; index++) await store.createThread({ ...newThread(`t${index}`, `m${index}`), body: index % 2 ? "hide" : "show", now: index + 1 })
    const page = await value<CommentThread[]>("comments.list", { limit: 5 })
    expect(page.map(thread => thread.messages[0]!.body)).toEqual(["show", "show", "show", "show", "show"])
    // Odd indexes are hidden: the newest readable threads are numbers 39, 37, ... (index + 1).
    expect(page.map(thread => thread.n)).toEqual([39, 37, 35, 33, 31])
    expect(peak).toBeLessThanOrEqual(16)
    expect(peak).toBeGreaterThan(1)
  })
})

describe("what a page subject may be", () => {
  it("refuses a path that leaves the site, and builds links from encoded segments", async () => {
    await setup()
    for (const id of ["//evil.com/x", "/\\evil.com", "/a b", "/a?b", "/a#b", "pricing", `/${"x".repeat(600)}`]) {
      expect(await failure("comments.create", { anchor: { kind: "page" }, body: "x", subject: { id, kind: "page" } }), id).toMatchObject({ status: 400 })
    }
    expect(await failure("comments.list", { page: "//evil.com/x" })).toMatchObject({ code: "INTERNAL_R0022" })
    const view = commentsConsoleSection.view
    const row = (id: string) => ({ n: 3, subject: { id, kind: "page" } })
    expect(operationLink(row("//evil.com/x"), view as never)).toBeUndefined()
    expect(operationLink(row("/pricing/é ü"), view as never)).toBeUndefined()
    expect(operationLink(row("/pricing/é"), view as never)).toBe("/pricing/%C3%A9?comment=3")
    expect(operationLink(row("/"), view as never)).toBe("/?comment=3")
  })

  it("takes no attachments until an upload operation exists", async () => {
    await setup()
    expect(await failure("comments.create", { anchor: { kind: "page" }, attachments: ["blob/a.png"], body: "x", subject: page })).toMatchObject({ code: "COMMENTS_R0014", status: 400 })
    const thread = await create("No files", { attachments: [] })
    expect(thread.messages[0]!.attachments).toEqual([])
    expect(await failure("comments.reply", { attachments: ["blob/a.png"], body: "x", threadId: thread.id })).toMatchObject({ code: "COMMENTS_R0014" })
  })
})

describe("the overlay session", () => {
  it("tells the overlay who is signed in and what that person may do, and nothing else", async () => {
    await setup(defineComments({ authorize: ({ action, user }) => action === "read" || user?.id === "ana" }))
    expect(await value("comments.session")).toEqual({ canRead: true, canWrite: true, user: ana })
    signedIn = ben
    expect(await value("comments.session")).toEqual({ canRead: true, canWrite: false, user: ben })
  })

  it("answers an anonymous visitor without asking the policy", async () => {
    const authorize = vi.fn(() => true)
    await setup(defineComments({ authorize }))
    signedIn = undefined
    expect(await value("comments.session")).toEqual({ canRead: false, canWrite: false, user: null })
    expect(authorize).not.toHaveBeenCalled()
  })

  it("says no to everything without a policy, when the policy refuses, or when it cannot answer without a thread", async () => {
    const { store } = await setup(defineComments())
    expect(await value("comments.session")).toEqual({ canRead: false, canWrite: false, user: ana })
    installComments({ definition: defineComments({ authorize: () => false }), store })
    expect(await value("comments.session")).toEqual({ canRead: false, canWrite: false, user: ana })
    installComments({ definition: defineComments({ authorize: ({ thread }) => thread!.author.id === "ana" } satisfies CommentsDefinition), store })
    expect(await value("comments.session")).toEqual({ canRead: false, canWrite: false, user: ana })
    // The optional subject is the only accepted input.
    expect(await failure("comments.session", { threadId: "x" })).toMatchObject({ code: "INTERNAL_R0022" })
  })
})
