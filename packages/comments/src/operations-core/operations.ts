import { defineOperation } from "@vite-hub/internal/operations"
import * as v from "valibot"

import { builtinCommentSubjects } from "./define.ts"
import { commentsErrorDiagnostics } from "./errors.ts"
import { isPagePath } from "./path.ts"
import { commentsRuntime } from "./server.ts"

import type { AnyOperation, OperationContext } from "@vite-hub/internal/operations"
import type { CommentAction } from "./define.ts"
import type { CommentsRuntime } from "./server.ts"
import type {
  CommentActor,
  CommentListCursor,
  CommentMessage,
  CommentSubject,
  CommentThread,
  CommentUser,
} from "./types.ts"

/** Longest message, in characters. */
export const maximumCommentBodyLength = 10_000
const maximumMentions = 20
const maximumAttachments = 10
const defaultLimit = 200
const maximumLimit = 500
const maximumSuggestions = 10
const minimumQuery = 2
/** Threads that `authorize` checks at once. */
const authorizeConcurrency = 16

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
const page = v.pipe(v.string(), v.check(isPagePath, 'A page is an app path that starts with one "/", such as "/pricing", without "?" or "#".'))
const cursor = v.strictObject({ id: v.pipe(v.string(), v.minLength(1), v.maxLength(100)), updatedAt: v.number() })
const text = v.pipe(v.string(), v.maxLength(maximumCommentBodyLength))
const id = v.pipe(v.string(), v.minLength(1), v.maxLength(100))
const mentions = v.optional(v.pipe(v.array(id), v.maxLength(maximumMentions)))
const attachments = v.optional(v.pipe(v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(500))), v.maxLength(maximumAttachments)))
const threadId = v.strictObject({ threadId: id })

function fail(error: Error, status: number): Error {
  return Object.assign(error, { status })
}

/** Public identity for stored comments and notifications; policies keep the full user. */
function personOf(user: CommentUser): CommentUser {
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
  return { runtime: await commentsRuntime(), user: context.user, ...(actor ? { actor } : {}) }
}

interface Target {
  subject?: CommentSubject
  thread?: CommentThread
}

/** Without an `authorize` policy nobody can do anything. */
function policy(who: Caller): NonNullable<CommentsRuntime["definition"]["authorize"]> {
  const { authorize } = who.runtime.definition
  if (!authorize) throw fail(commentsErrorDiagnostics.COMMENTS_R0006(), 403)
  return authorize
}

/** Asks the policy, with the thread and its subject, or the subject a thread would start on. */
async function permitted(who: Caller, action: CommentAction, target: Target = {}, user: CommentUser | null = who.user): Promise<boolean> {
  const subject = target.subject ?? target.thread?.subject
  const actor = user === who.user ? who.actor : undefined
  return Boolean(await policy(who)({ action, user: user ? { ...user } : null, ...(actor ? { actor } : {}), ...(target.thread ? { thread: target.thread } : {}), ...(subject ? { subject } : {}) }))
}

async function allow(who: Caller, action: CommentAction, target?: Target): Promise<void> {
  if (!(await permitted(who, action, target))) throw fail(commentsErrorDiagnostics.COMMENTS_R0009({ action }), 403)
}

function author(who: Caller): CommentUser {
  if (!who.user) throw fail(commentsErrorDiagnostics.COMMENTS_R0012(), 401)
  return personOf(who.user)
}

function scopeOf(runtime: CommentsRuntime, target: CommentSubject): string {
  const definition = [...builtinCommentSubjects, ...(runtime.definition.subjects ?? [])].reverse().find(candidate => candidate.kind === target.kind)
  if (!definition) throw fail(commentsErrorDiagnostics.COMMENTS_R0008({ kind: target.kind }), 400)
  if (target.kind === "page" && !isPagePath(target.id)) throw fail(commentsErrorDiagnostics.COMMENTS_R0007({ message: 'A page subject takes an app path that starts with one "/", such as "/pricing", without "?" or "#".' }), 400)
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
  const found = new Map((await (who.runtime.users ? who.runtime.users.byIds(unique) : who.runtime.store.knownUsersByIds(unique, thread => permitted(who, "read", { thread }).catch(() => false)))).map(person => [person.id, person]))
  const people: CommentUser[] = []
  for (const mentioned of unique) {
    const person = found.get(mentioned)
    if (!person) throw fail(commentsErrorDiagnostics.COMMENTS_R0007({ message: `The mentioned user ${JSON.stringify(mentioned)} does not exist.` }), 400)
    const name = person.name ?? person.id
    if (!new RegExp(`(^|[^\\p{L}\\p{N}\\p{M}_])@${escapeRegExp(name)}(?=$|[^\\p{L}\\p{N}\\p{M}_])`, "iu").test(body)) {
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

/**
 * Runs `onMention` after the change is saved, for the mentioned people that may read the thread. The mention stays in
 * the text for the others. A failure never fails the comment.
 */
function announce(who: Caller, context: OperationContext, thread: CommentThread, message: CommentMessage | undefined, mentioned: CommentUser[]): void {
  const onMention = who.runtime.definition.onMention
  if (!onMention || !message || !mentioned.length) return
  const task = (async () => {
    try {
      const readers: CommentUser[] = []
      for (const person of mentioned) {
        if (await permitted(who, "read", { thread }, person).catch(() => false)) readers.push(personOf(person))
      }
      if (readers.length) await onMention({ mentioned: readers, message, thread })
    }
    catch (error) {
      globalThis.console.error("[vitehub] comments onMention failed.", error)
    }
  })()
  if (context.waitUntil) context.waitUntil(task)
}

/** A thread that does not exist and one that the caller may not read look the same: not found. */
async function load(who: Caller, threadIdValue: string): Promise<CommentThread> {
  policy(who)
  const found = await who.runtime.store.getById(threadIdValue)
  if (!found || !(await permitted(who, "read", { thread: found }))) throw fail(commentsErrorDiagnostics.COMMENTS_R0002({ id: threadIdValue }), 404)
  return found
}

async function mapLimit<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length })
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await run(items[index]!)
    }
  }))
  return results
}

function cursorOf(thread: CommentThread): CommentListCursor {
  return { id: thread.id, updatedAt: thread.updatedAt }
}

function noAttachments(attachmentList: readonly string[] | undefined): void {
  if (attachmentList?.length) throw fail(commentsErrorDiagnostics.COMMENTS_R0014(), 400)
}

const list = defineOperation({
  description: "List comment threads, newest first, filtered by subject, page, status, author, or mention. Pass the last thread as `before` for the next page.",
  input: v.strictObject({
    before: v.optional(cursor),
    limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(maximumLimit))),
    mentions: v.optional(v.boolean()),
    mine: v.optional(v.boolean()),
    page: v.optional(page),
    status: v.optional(v.picklist(["open", "resolved"])),
    subject: v.optional(subject),
  }),
  kind: "read",
  name: "comments.list",
  run: async (input, context): Promise<CommentThread[]> => {
    const who = await caller(context)
    policy(who)
    const limit = input.limit ?? defaultLimit
    const readable: CommentThread[] = []
    let before = input.before
    // Threads the caller may not read are left out, so ask again after them until the page is full or the threads end.
    while (readable.length < limit) {
      const threads = await who.runtime.store.list({ ...input, limit, ...(before ? { before } : {}), ...(who.user ? { userId: who.user.id } : {}) })
      const allowed = await mapLimit(threads, authorizeConcurrency, thread => permitted(who, "read", { thread }).catch(() => false))
      for (const [index, thread] of threads.entries()) {
        if (allowed[index] && readable.length < limit) readable.push(thread)
      }
      if (threads.length < limit) break
      before = cursorOf(threads.at(-1)!)
    }
    return readable
  },
  section: "comments",
})

const get = defineOperation({
  description: "Read one comment thread by id, or by number inside its scope. A thread that does not exist or that you may not read is null.",
  input: v.union([v.strictObject({ id }), v.strictObject({ n: v.pipe(v.number(), v.integer(), v.minValue(1)), scope: v.pipe(v.string(), v.minLength(1), v.maxLength(200)) })]),
  kind: "read",
  name: "comments.get",
  run: async (input, context): Promise<CommentThread | null> => {
    const who = await caller(context)
    policy(who)
    const found = "id" in input ? await who.runtime.store.getById(input.id) : await who.runtime.store.getByNumber(input.scope, input.n)
    return found && await permitted(who, "read", { thread: found }) ? found : null
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
    await allow(who, "read", { subject: input.subject })
    await allow(who, "write", { subject: input.subject })
    noAttachments(input.attachments)
    const person = author(who)
    const body = cleanBody(input.body)
    const mentioned = await checkMentions(who, body, input.mentions)
    const now = Date.now()
    const created = await who.runtime.store.createThread({
      anchor: input.anchor,
      attachments: [],
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
    await allow(who, "write", { thread: found })
    noAttachments(input.attachments)
    const person = author(who)
    const body = cleanBody(input.body)
    const mentioned = await checkMentions(who, body, input.mentions)
    const messageId = newId("message")
    const next = await who.runtime.store.addMessage(found.id, {
      attachments: [],
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
    // An Agent edits only when the policy lets it write. Authors who are people always edit their own messages.
    if (who.actor) await allow(who, "write", { thread: found })
    const target = found.messages.find(entry => entry.id === input.messageId)
    if (!target) throw fail(commentsErrorDiagnostics.COMMENTS_R0003({ messageId: input.messageId }), 404)
    // Nobody else edits a message.
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
    const deletesThread = !target || target.id === found.messages[0]?.id
    // People delete their own messages, and a thread only when every message in it is theirs. Everything else, and every
    // Agent, needs the `delete` action.
    const ownerId = who.user && !who.actor ? who.user.id : undefined
    const owns = ownerId !== undefined && (deletesThread ? found.messages.every(entry => entry.author.id === ownerId) : target.author.id === ownerId)
    if (!owns) await allow(who, "delete", { thread: found })
    if (deletesThread) {
      const deleted = await who.runtime.store.deleteThread(found.id, owns ? ownerId : undefined)
      if (deleted === false) throw fail(commentsErrorDiagnostics.COMMENTS_R0009({ action: "delete" }), 403)
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
      await allow(who, "resolve", { thread: found })
      return who.runtime.store.setStatus(found.id, status, author(who), Date.now())
    },
    section: "comments",
  })
}

const users = defineOperation({
  description: "Find people to mention by name. Needs at least two characters, and the right to write.",
  input: v.strictObject({ limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(maximumSuggestions))), query: v.pipe(v.string(), v.maxLength(100)) }),
  kind: "read",
  name: "comments.users",
  run: async (input, context): Promise<CommentUser[]> => {
    const who = await caller(context)
    await allow(who, "read")
    // Only people who can write mention anyone, so only they get suggestions.
    await allow(who, "write")
    const query = input.query.trim()
    if (query.length < minimumQuery) return []
    const limit = Math.min(input.limit ?? 5, maximumSuggestions)
    const found = who.runtime.users ? await who.runtime.users.search(query, limit) : await who.runtime.store.knownUsers(query, limit, thread => permitted(who, "read", { thread }).catch(() => false))
    return found.slice(0, limit).map(person => ({ id: person.id, ...(person.name ? { name: person.name } : {}), ...(person.image ? { image: person.image } : {}) }))
  },
  section: "comments",
})

/** The comment operations. The Console, the CLI, MCP, and the comments client call them. */
export const commentsOperations: readonly AnyOperation[] = [list, get, create, reply, edit, remove, statusOperation("comments.resolve", "resolved", "Mark a comment thread as resolved."), statusOperation("comments.reopen", "open", "Open a resolved comment thread again."), users]
