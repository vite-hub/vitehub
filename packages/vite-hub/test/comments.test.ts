import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createClient } from "@libsql/client"
import { drizzle } from "drizzle-orm/libsql"
import { defineCommentSubject, defineComments } from "@vite-hub/comments"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { commentsOperations } from "@vite-hub/comments/operations"
import { createRpcTransport } from "@vite-hub/comments/rpc"
import { createCommentsStore, installComments } from "@vite-hub/comments/server"
import { readCommentsConsoleRecords } from "@vite-hub/comments/runtime/console"
import { runViteHubCli } from "@vite-hub/cli"

import { discoverConsoleBuildCatalog, withConsoleDocumentEditorSections } from "../src/console/build.ts"
import { consoleRpcHeader } from "../src/console/runtime/rpc.ts"
import { installConsoleAccess } from "../src/console/runtime/server/access.ts"
import { installConsoleOperations } from "../src/console/runtime/server/operation-contributions.ts"
import { handleConsoleRpcRequest } from "./support/console-rpc.ts"

import type { CommentsDefinition, CommentThread, CommentUser } from "@vite-hub/comments"

const ddl = [
  `create table vitehub_comment_threads (id text primary key, scope text not null, n integer not null, subject_kind text not null, subject_id text not null, anchor text not null, status text not null, resolved_by text, resolved_at integer, author_id text not null, author_name text, author_image text, actor text, created_at integer not null, updated_at integer not null)`,
  `create unique index vitehub_comment_threads_scope_n on vitehub_comment_threads (scope, n)`,
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
    expect(authorize).toHaveBeenCalledWith({ action: "write", user: ana })
    await value("comments.resolve", { threadId: thread.id })
    expect(authorize).toHaveBeenLastCalledWith({ action: "resolve", thread: expect.objectContaining({ id: thread.id }), user: ana })
    await value("comments.get", { id: thread.id })
    expect(authorize).toHaveBeenLastCalledWith({ action: "read", thread: expect.objectContaining({ id: thread.id }), user: ana })
  })

  it("filters the list by what authorize lets the user read", async () => {
    await setup(defineComments({ authorize: ({ action, thread, user }) => action !== "read" || !thread || thread.author.id === user?.id }))
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
    expect(await value<CommentUser[]>("comments.users", { query: "" })).toHaveLength(2)
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
    let output = ""
    const code = await runViteHubCli({
      args: ["comments", "list", "--json"],
      cwd: "/app",
      env: { VITEHUB_DEV_SERVER_URL: "http://localhost:5173" },
      fetch: ((url: string | URL | Request, init?: RequestInit) => handleConsoleRpcRequest(new Request(String(url), init))) as typeof fetch,
      loadConfig: async () => ({ plugins: [{ name: "comments", vitehub: { operations: [{ export: "commentsOperations", load: async () => commentsOperations, module: "@vite-hub/comments/operations" }] } }], root: "/app" }),
      loadNuxtViteConfig: async () => undefined,
      stderr: { write: () => true },
      stdout: { write: (chunk: string | Uint8Array) => { output += String(chunk); return true } },
    })
    expect(code).toBe(0)
    expect(JSON.parse(output)).toEqual([thread])
  })

  it("lists the threads in the Console section, with page links and the missing policy hint", async () => {
    await setup()
    const thread = await create("Make it bigger")
    const [row] = await readCommentsConsoleRecords()
    expect(row).toMatchObject({ cells: { comment: "Make it bigger", number: "1", status: "open", subject: "/pricing" }, id: `comments:${thread.id}` })
    expect(row!.fields).toContainEqual({ label: "Link", value: "/pricing?comment=1" })
    await setup(defineComments())
    const [hint] = await readCommentsConsoleRecords()
    expect(hint).toMatchObject({ id: "comments:no-policy", cells: { status: "No policy" } })
    expect(hint!.fields.map(field => field.value).join(" ")).toContain("authorize")
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
      expect(catalog.extraSections).toEqual(["comments"])
      expect(withConsoleDocumentEditorSections(["env"], catalog)).toContain("comments")
      expect(catalog.content.comments).toMatchObject({ kind: "record-table" })
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})
