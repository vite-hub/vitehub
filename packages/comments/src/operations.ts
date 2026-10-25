import { defineOperation } from "@vite-hub/internal/operations"
import * as v from "valibot"

import { builtinCommentSubjects } from "./define.ts"
import { commentsErrorDiagnostics } from "./errors.ts"
import { commentsRuntime } from "./server.ts"

import type { AnyOperation, OperationContext } from "@vite-hub/internal/operations"
import type { CommentAction } from "./define.ts"
import type { CommentsRuntime } from "./server.ts"
import type {
  CommentActor,
  CommentMessage,
  CommentSubject,
  CommentThread,
  CommentUser,
} from "./types.ts"

/** Longest message, in characters. */
export const maximumCommentBodyLength = 10_000
const maximumMentions = 20
const maximumAttachments = 10

const thousandths = v.pipe(v.number(), v.minValue(0), v.maxValue(1_000))
const selector = v.pipe(v.string(), v.minLength(1), v.maxLength(500))
const quote = v.pipe(v.string(), v.maxLength(2_000))
const anchor = v.union([
  v.strictObject({ kind: v.literal("page") }),
  v.strictObject({ kind: v.literal("element"), selector, x: thousandths, y: thousandths }),
  v.strictObject({ exact: v.pipe(v.string(), v.minLength(1), v.maxLength(2_000)), kind: v.literal("text"), prefix: quote, selector, suffix: quote }),
  v.pipe(
    v.strictObject({ height: v.pipe(v.number(), v.minValue(1), v.maxValue(1_000)), kind: v.literal("area"), selector, width: v.pipe(v.number(), v.minValue(1), v.maxValue(1_000)), x: thousandths, y: thousandths }),
    v.check(area => area.x + area.width <= 1_000 && area.y + area.height <= 1_000, "An area must stay inside the element box: x + width and y + height are at most 1000."),
  ),
  v.pipe(
    v.strictObject({ height: v.optional(v.pipe(v.number(), v.minValue(1), v.maxValue(1_000))), kind: v.literal("image"), selector, width: v.optional(v.pipe(v.number(), v.minValue(1), v.maxValue(1_000))), x: thousandths, y: thousandths }),
    v.check(area => (area.width === undefined) === (area.height === undefined), "An image area needs width and height together."),
    v.check(area => area.x + (area.width ?? 0) <= 1_000 && area.y + (area.height ?? 0) <= 1_000, "An image area must stay inside the element box."),
  ),
])

const subject = v.strictObject({ id: v.pipe(v.string(), v.minLength(1), v.maxLength(500)), kind: v.pipe(v.string(), v.minLength(1), v.maxLength(40)) })
const text = v.pipe(v.string(), v.maxLength(maximumCommentBodyLength))
const id = v.pipe(v.string(), v.minLength(1), v.maxLength(100))
const mentions = v.optional(v.pipe(v.array(id), v.maxLength(maximumMentions)))
const attachments = v.optional(v.pipe(v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(500))), v.maxLength(maximumAttachments)))
const threadId = v.strictObject({ threadId: id })

function fail(error: Error, status: number): Error {
  return Object.assign(error, { status })
}

function personOf(user: OperationContext["user"]): CommentUser | null {
  if (!user) return null
  return { id: user.id, ...(user.name ? { name: user.name } : {}), ...(user.image ? { image: user.image } : {}) }
}

function actorOf(actor: OperationContext["actor"]): CommentActor | undefined {
  return actor ? { id: actor.id, ...(actor.label ? { name: actor.label } : {}) } : undefined
}

interface Caller {
  actor?: CommentActor
  runtime: CommentsRuntime
  user: CommentUser | null
}

async function caller(context: OperationContext): Promise<Caller> {
  const actor = actorOf(context.actor)
  return { runtime: await commentsRuntime(), user: personOf(context.user), ...(actor ? { actor } : {}) }
}

/** Without an `authorize` policy nobody can do anything. */
async function allow(who: Caller, action: CommentAction, thread?: CommentThread): Promise<void> {
  const { authorize } = who.runtime.definition
  if (!authorize) throw fail(commentsErrorDiagnostics.COMMENTS_R0006(), 403)
  const allowed = await authorize({ action, user: who.user, ...(who.actor ? { actor: who.actor } : {}), ...(thread ? { thread } : {}) })
  if (!allowed) throw fail(commentsErrorDiagnostics.COMMENTS_R0009({ action }), 403)
}

function author(who: Caller): CommentUser {
  if (!who.user) throw fail(commentsErrorDiagnostics.COMMENTS_R0012(), 401)
  return who.user
}

function scopeOf(runtime: CommentsRuntime, target: CommentSubject): string {
  const definition = [...builtinCommentSubjects, ...(runtime.definition.subjects ?? [])].reverse().find(candidate => candidate.kind === target.kind)
  if (!definition) throw fail(commentsErrorDiagnostics.COMMENTS_R0008({ kind: target.kind }), 400)
  if (target.kind === "page" && !target.id.startsWith("/")) throw fail(commentsErrorDiagnostics.COMMENTS_R0007({ message: 'A page subject takes an app path that starts with "/".' }), 400)
  if (target.kind === "content" && !target.id.includes("/")) throw fail(commentsErrorDiagnostics.COMMENTS_R0007({ message: 'A content subject is "<collection>/<id>".' }), 400)
  return definition.scope(target.id)
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** The mentioned ids must be real people, and the text must name each of them with `@name`. */
async function checkMentions(who: Caller, body: string, ids: readonly string[] | undefined): Promise<CommentUser[]> {
  const unique = [...new Set(ids ?? [])]
  if (!unique.length) return []
  const found = new Map((await (who.runtime.users ? who.runtime.users.byIds(unique) : who.runtime.store.knownUsersByIds(unique))).map(person => [person.id, person]))
  const people: CommentUser[] = []
  for (const mentioned of unique) {
    const person = found.get(mentioned)
    if (!person) throw fail(commentsErrorDiagnostics.COMMENTS_R0007({ message: `The mentioned user ${JSON.stringify(mentioned)} does not exist.` }), 400)
    const name = person.name ?? person.id
    if (!new RegExp(`(^|\\s)@${escapeRegExp(name)}(?=$|[\\s.,;:!?)])`, "i").test(body)) {
      throw fail(commentsErrorDiagnostics.COMMENTS_R0007({ message: `The text does not name @${name}, but the comment mentions ${name}.` }), 400)
    }
    people.push(person)
  }
  return people
}

function cleanBody(body: string): string {
  const trimmed = body.trim()
  if (!trimmed) throw fail(commentsErrorDiagnostics.COMMENTS_R0005(), 400)
  return trimmed
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`
}

/** Runs `onMention` after the change is saved. A failure never fails the comment. */
function announce(who: Caller, context: OperationContext, thread: CommentThread, message: CommentMessage | undefined, mentioned: CommentUser[]): void {
  const onMention = who.runtime.definition.onMention
  if (!onMention || !message || !mentioned.length) return
  const task = (async () => {
    try {
      await onMention({ mentioned, message, thread })
    }
    catch (error) {
      globalThis.console.error("[vitehub] comments onMention failed.", error)
    }
  })()
  if (context.waitUntil) context.waitUntil(task)
}

async function load(who: Caller, threadIdValue: string): Promise<CommentThread> {
  const found = await who.runtime.store.getById(threadIdValue)
  if (!found) throw fail(commentsErrorDiagnostics.COMMENTS_R0002({ id: threadIdValue }), 404)
  return found
}

const list = defineOperation({
  description: "List comment threads, filtered by subject, page, status, author, or mention.",
  input: v.strictObject({ mentions: v.optional(v.boolean()), mine: v.optional(v.boolean()), page: v.optional(v.string()), status: v.optional(v.picklist(["open", "resolved"])), subject: v.optional(subject) }),
  kind: "read",
  name: "comments.list",
  run: async (input, context): Promise<CommentThread[]> => {
    const who = await caller(context)
    await allow(who, "read")
    const threads = await who.runtime.store.list({ ...input, ...(who.user ? { userId: who.user.id } : {}) })
    const readable = await Promise.all(threads.map(async (thread) => {
      try {
        await allow(who, "read", thread)
        return true
      }
      catch {
        return false
      }
    }))
    return threads.filter((_thread, index) => readable[index])
  },
  section: "comments",
})

const get = defineOperation({
  description: "Read one comment thread by id, or by number inside its scope.",
  input: v.union([v.strictObject({ id }), v.strictObject({ n: v.pipe(v.number(), v.integer(), v.minValue(1)), scope: v.pipe(v.string(), v.minLength(1), v.maxLength(200)) })]),
  kind: "read",
  name: "comments.get",
  run: async (input, context): Promise<CommentThread | null> => {
    const who = await caller(context)
    await allow(who, "read")
    const found = "id" in input ? await who.runtime.store.getById(input.id) : await who.runtime.store.getByNumber(input.scope, input.n)
    if (!found) return null
    await allow(who, "read", found)
    return found
  },
  section: "comments",
})

const create = defineOperation({
  description: "Start a comment thread on a subject, such as a page, with an anchor and a first message.",
  input: v.strictObject({ anchor, attachments, body: text, mentions, subject }),
  kind: "write",
  name: "comments.create",
  run: async (input, context): Promise<CommentThread> => {
    const who = await caller(context)
    await allow(who, "write")
    const person = author(who)
    const body = cleanBody(input.body)
    const mentioned = await checkMentions(who, body, input.mentions)
    const now = Date.now()
    const created = await who.runtime.store.createThread({
      anchor: input.anchor,
      attachments: input.attachments ?? [],
      author: person,
      body,
      id: newId("message"),
      mentions: mentioned.map(entry => entry.id),
      now,
      scope: scopeOf(who.runtime, input.subject),
      subject: input.subject,
      threadId: newId("thread"),
      ...(who.actor ? { actor: who.actor } : {}),
    })
    announce(who, context, created, created.messages[0], mentioned)
    return created
  },
  section: "comments",
})

const reply = defineOperation({
  description: "Add a message to a comment thread.",
  input: v.strictObject({ attachments, body: text, mentions, threadId: id }),
  kind: "write",
  name: "comments.reply",
  run: async (input, context): Promise<CommentThread> => {
    const who = await caller(context)
    const found = await load(who, input.threadId)
    await allow(who, "write", found)
    const person = author(who)
    const body = cleanBody(input.body)
    const mentioned = await checkMentions(who, body, input.mentions)
    const messageId = newId("message")
    const next = await who.runtime.store.addMessage(found.id, {
      attachments: input.attachments ?? [],
      author: person,
      body,
      id: messageId,
      mentions: mentioned.map(entry => entry.id),
      now: Date.now(),
      ...(who.actor ? { actor: who.actor } : {}),
    })
    announce(who, context, next, next.messages.find(entry => entry.id === messageId), mentioned)
    return next
  },
  section: "comments",
})

const edit = defineOperation({
  description: "Change the text of your own message.",
  input: v.strictObject({ body: text, mentions, messageId: id, threadId: id }),
  kind: "write",
  name: "comments.edit",
  run: async (input, context): Promise<CommentThread> => {
    const who = await caller(context)
    const found = await load(who, input.threadId)
    const target = found.messages.find(entry => entry.id === input.messageId)
    if (!target) throw fail(commentsErrorDiagnostics.COMMENTS_R0003({ messageId: input.messageId }), 404)
    // Authors always edit their own messages, and nobody else edits them.
    if (!who.user || target.author.id !== who.user.id) throw fail(commentsErrorDiagnostics.COMMENTS_R0004(), 403)
    const body = cleanBody(input.body)
    const mentioned = await checkMentions(who, body, input.mentions)
    const next = await who.runtime.store.editMessage(found.id, target.id, { body, mentions: mentioned.map(entry => entry.id), now: Date.now() })
    announce(who, context, next, next.messages.find(entry => entry.id === target.id), mentioned.filter(entry => !target.mentions.includes(entry.id)))
    return next
  },
  section: "comments",
})

const remove = defineOperation({
  description: "Delete a message, or the whole thread. Deleting the first message deletes the thread.",
  input: v.strictObject({ messageId: v.optional(id), threadId: id }),
  kind: "destructive",
  name: "comments.delete",
  run: async (input, context): Promise<CommentThread | null> => {
    const who = await caller(context)
    const found = await load(who, input.threadId)
    const target = input.messageId === undefined ? undefined : found.messages.find(entry => entry.id === input.messageId)
    if (input.messageId !== undefined && !target) throw fail(commentsErrorDiagnostics.COMMENTS_R0003({ messageId: input.messageId }), 404)
    // Authors always delete their own messages. Anyone else needs the `delete` action.
    const owner = (target ?? found).author.id
    if (!who.user || owner !== who.user.id) await allow(who, "delete", found)
    if (!target || target.id === found.messages[0]?.id) {
      await who.runtime.store.deleteThread(found.id)
      return null
    }
    return who.runtime.store.deleteMessage(found.id, target.id, Date.now())
  },
  section: "comments",
})

function statusOperation(name: "comments.reopen" | "comments.resolve", status: "open" | "resolved", description: string): AnyOperation {
  return defineOperation({
    description,
    input: threadId,
    kind: "write",
    name,
    run: async (input, context): Promise<CommentThread> => {
      const who = await caller(context)
      const found = await load(who, input.threadId)
      await allow(who, "resolve", found)
      return who.runtime.store.setStatus(found.id, status, author(who), Date.now())
    },
    section: "comments",
  })
}

const users = defineOperation({
  description: "Find people to mention by name.",
  input: v.strictObject({ limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(20))), query: v.pipe(v.string(), v.maxLength(100)) }),
  kind: "read",
  name: "comments.users",
  run: async (input, context): Promise<CommentUser[]> => {
    const who = await caller(context)
    await allow(who, "read")
    const query = input.query.trim()
    const limit = input.limit ?? 5
    return who.runtime.users ? who.runtime.users.search(query, limit) : who.runtime.store.knownUsers(query, limit)
  },
  section: "comments",
})

/** The comment operations. The Console, the CLI, MCP, and the comments client call them. */
export const commentsOperations: readonly AnyOperation[] = [list, get, create, reply, edit, remove, statusOperation("comments.resolve", "resolved", "Mark a comment thread as resolved."), statusOperation("comments.reopen", "open", "Open a resolved comment thread again."), users]
