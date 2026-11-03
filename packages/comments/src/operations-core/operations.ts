import { defineOperation, operationAccessAllows } from "@vite-hub/internal/operations"
import * as v from "valibot"

import { authorOf, guestFromHeaders } from "../identity.ts"
import { commentsErrorDiagnostics } from "./errors.ts"
import { isPagePath } from "./path.ts"
import { commentsRuntime } from "./server.ts"
import { attachmentThread, can, createThread, deniedError, editMessage, fail, maximumAttachmentBytes, maximumAttachments, maximumCommentBodyLength, maximumMentions, personOf, readAttachment, replyToThread, storeAttachment, suggest } from "./service.ts"

import type { AnyOperation, OperationContext } from "@vite-hub/internal/operations"
import type { CommentAction, CommentsPolicyGate, CommentsUser } from "./define.ts"
import type { CommentsAttachmentBody, CommentsRuntime } from "./service.ts"
import type {
  CommentActor,
  CommentAttachment,
  CommentContext,
  CommentCreateInput,
  CommentDeleteInput,
  CommentEditInput,
  CommentGetInput,
  CommentListCursor,
  CommentListQuery,
  CommentMessage,
  CommentReplyInput,
  CommentStatusInput,
  CommentUploadInput,
  CommentUsersInput,
  CommentSubject,
  CommentThread,
  CommentUser,
} from "./types.ts"

export { maximumCommentBodyLength }
const defaultLimit = 200
const maximumLimit = 500
const maximumSuggestions = 10
const minimumQuery = 2
/** Threads that `authorize` checks at once. */
const authorizeConcurrency = 16

const thousandths = v.pipe(v.number(), v.minValue(0), v.maxValue(1_000))
const selector = v.pipe(v.string(), v.minLength(1), v.maxLength(2_048))
const quote = v.pipe(v.string(), v.maxLength(2_000))
const anchor = v.union([
  v.strictObject({ kind: v.literal("page") }),
  v.strictObject({
    field: v.optional(v.pipe(v.string(), v.maxLength(512))),
    kind: v.literal("element"),
    label: v.optional(v.pipe(v.string(), v.maxLength(200))),
    page: v.optional(v.strictObject({ x: thousandths, y: v.pipe(v.number(), v.minValue(0), v.maxValue(1_000_000)) })),
    selector,
    viewport: v.optional(v.strictObject({ width: v.pipe(v.number(), v.minValue(0), v.maxValue(100_000)) })),
    x: thousandths,
    y: thousandths,
  }),
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

/** The anchor that `comments.create` takes, for the overlay API, which reads its input itself. */
export const commentAnchorSchema: typeof anchor = anchor

const subjectKind = v.pipe(v.string(), v.minLength(1), v.maxLength(40))
const subject = v.strictObject({ id: v.pipe(v.string(), v.minLength(1), v.maxLength(500)), kind: subjectKind })
const page = v.pipe(v.string(), v.check(isPagePath, 'A page is an app path that starts with one "/", such as "/pricing", without "?" or "#".'))
const cursor = v.strictObject({ id: v.pipe(v.string(), v.minLength(1), v.maxLength(100)), updatedAt: v.number() })
const text = v.pipe(v.string(), v.maxLength(maximumCommentBodyLength))
const id = v.pipe(v.string(), v.minLength(1), v.maxLength(100))
const mentions = v.optional(v.pipe(v.array(id), v.maxLength(maximumMentions)))
const attachments = v.optional(v.pipe(v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(500))), v.maxLength(maximumAttachments)))
const metadata = v.optional(v.record(v.string(), v.union([v.string(), v.number(), v.boolean(), v.null()])))
const revision = v.pipe(v.number(), v.integer(), v.minValue(0))
const threadId = v.strictObject({ threadId: id })

function actorOf(actor: OperationContext["actor"]): CommentActor | undefined {
  return actor ? { id: actor.id, ...(actor.label ? { name: actor.label } : {}) } : undefined
}

/**
 * Who calls a comment action, as the transport that received it checked: the operation RPC, the CLI, and MCP through
 * the Console's access check, or the overlay API through the session of its request.
 */
export interface CommentsCaller {
  runtime: CommentsRuntime
  /** The signed-in user, or null. A guest is null here; the request headers name it. */
  user: CommentsUser | null
  actor?: CommentActor
  /** What the transport checked before, for the default policy. */
  gate: CommentsPolicyGate
  /** The request, for the guest headers of an anonymous writer. */
  request?: Request
  waitUntil?: (task: Promise<unknown>) => void
}

/** Operations run only after the Console admitted the call to the `comments` section, so the default policy trusts it. */
async function caller(context: OperationContext): Promise<CommentsCaller> {
  const runtime = await commentsRuntime()
  const actor = actorOf(context.actor)
  return {
    gate: { console: true, development: runtime.development ?? context.development === true },
    runtime,
    user: context.user,
    ...(actor ? { actor } : {}),
    ...(context.request ? { request: context.request } : {}),
    ...(context.waitUntil ? { waitUntil: context.waitUntil } : {}),
  }
}

interface Target {
  subject?: CommentSubject
  thread?: CommentThread
}

/** Asks the policy, with the thread and its subject, or the subject a thread would start on. */
async function permitted(who: CommentsCaller, action: CommentAction, target: Target = {}): Promise<boolean> {
  return can(who.runtime, { action, user: who.user, ...(who.actor ? { actor: who.actor } : {}), ...target }, who.gate)
}

async function allow(who: CommentsCaller, action: CommentAction, target?: Target): Promise<void> {
  if (!(await permitted(who, action, target))) throw deniedError(who.runtime, action, who.user, who.gate)
}

/** The signed-in user, else the guest of the request, which only a policy that lets anonymous people write gets this far. */
function author(who: CommentsCaller): CommentUser {
  // A user without a name shows its email, else "Someone".
  if (who.user) return personOf(authorOf(who.user))
  const guest = who.request ? guestFromHeaders(who.request.headers) : undefined
  if (!guest) throw fail(commentsErrorDiagnostics.COMMENTS_R0012(), 401)
  return guest
}

function writeOptions(who: CommentsCaller) {
  return { gate: who.gate, user: who.user, ...(who.waitUntil ? { waitUntil: who.waitUntil } : {}) }
}

/** A thread that does not exist and one that the caller may not read look the same: not found. */
async function load(who: CommentsCaller, threadIdValue: string): Promise<CommentThread> {
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

async function withForge(who: CommentsCaller, threads: CommentThread[]): Promise<CommentThread[]> {
  return who.runtime.forge ? await who.runtime.forge.attach(threads) : threads
}

const listInput = v.strictObject({
  before: v.optional(cursor),
  limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(maximumLimit))),
  mentions: v.optional(v.boolean()),
  mine: v.optional(v.boolean()),
  page: v.optional(page),
  revision: v.optional(v.strictObject({ lte: revision })),
  status: v.optional(v.picklist(["open", "resolved"])),
  subject: v.optional(subject),
  subjectKind: v.optional(subjectKind),
})
const getInput = v.union([v.strictObject({ id }), v.strictObject({ n: v.pipe(v.number(), v.integer(), v.minValue(1)), scope: v.pipe(v.string(), v.minLength(1), v.maxLength(200)) })])
const createInput = v.strictObject({ anchor, attachments, body: text, mentions, metadata, revision: v.optional(revision), subject })
const replyInput = v.strictObject({ attachments, body: text, mentions, threadId: id })
const editInput = v.strictObject({ body: text, mentions, messageId: id, threadId: id })
const deleteInput = v.strictObject({ messageId: v.optional(id), threadId: id })
const usersInput = v.strictObject({
  limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(maximumSuggestions))),
  query: v.pipe(v.string(), v.maxLength(100)),
  subject: v.optional(subject),
  threadId: v.optional(id),
})
const uploadInput = v.strictObject({
  data: v.pipe(v.string(), v.minLength(1)),
  name: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  subject: v.optional(subject),
  type: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
})
const attachmentInput = v.strictObject({ key: v.pipe(v.string(), v.minLength(1), v.maxLength(500)) })

/** The inputs of the comment actions, for transports that read their input themselves, such as the overlay API. */
export const commentInputSchemas = {
  attachment: attachmentInput,
  create: createInput,
  delete: deleteInput,
  edit: editInput,
  get: getInput,
  list: listInput,
  reply: replyInput,
  status: threadId,
  upload: uploadInput,
  users: usersInput,
} as const

/**
 * The comment actions behind every surface. The operations (RPC, CLI, MCP) and the overlay API call the same
 * functions, so one policy, one set of checks, and one set of errors serve them all. Each one checks `authorize` for
 * its caller; the input must have passed `commentInputSchemas`.
 */
export const commentActions = {
  async list(input: CommentListQuery, who: CommentsCaller): Promise<CommentThread[]> {
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
    return withForge(who, readable)
  },

  async get(input: CommentGetInput, who: CommentsCaller): Promise<CommentThread | null> {
    const found = "id" in input ? await who.runtime.store.getById(input.id) : await who.runtime.store.getByNumber(input.scope, input.n)
    if (!found || !await permitted(who, "read", { thread: found })) return null
    return (await withForge(who, [found]))[0]!
  },

  /** `context` is the page context that the overlay read and its transport checked. */
  async create(input: CommentCreateInput & { context?: CommentContext }, who: CommentsCaller): Promise<CommentThread> {
    await allow(who, "read", { subject: input.subject })
    await allow(who, "write", { subject: input.subject })
    return createThread(who.runtime, { ...input, author: author(who), ...(who.actor ? { actor: who.actor } : {}) }, writeOptions(who))
  },

  /** `allowResolved`: the operations keep a reply box on resolved threads, and a reply keeps the thread resolved. */
  async reply(input: CommentReplyInput, who: CommentsCaller, options: { allowResolved?: boolean } = {}): Promise<{ thread: CommentThread, message: CommentMessage }> {
    const found = await load(who, input.threadId)
    await allow(who, "write", { thread: found })
    return replyToThread(who.runtime, found, {
      body: input.body,
      author: author(who),
      ...(input.mentions ? { mentions: input.mentions } : {}),
      ...(input.attachments ? { attachments: input.attachments } : {}),
      ...(who.actor ? { actor: who.actor } : {}),
    }, { allowResolved: options.allowResolved === true, ...writeOptions(who) })
  },

  async edit(input: CommentEditInput, who: CommentsCaller): Promise<CommentThread> {
    const found = await load(who, input.threadId)
    // An Agent edits only when the policy lets it write. Authors who are people always edit their own messages.
    if (who.actor) await allow(who, "write", { thread: found })
    const target = found.messages.find(entry => entry.id === input.messageId)
    if (!target) throw fail(commentsErrorDiagnostics.COMMENTS_R0003({ messageId: input.messageId }), 404)
    // Nobody else edits a message, and a guest id proves nothing.
    if (!who.user || who.user.guest === true || target.author.guest || target.author.id !== who.user.id) throw fail(commentsErrorDiagnostics.COMMENTS_R0004(), 403)
    return editMessage(who.runtime, found, target.id, { body: input.body, ...(input.mentions ? { mentions: input.mentions } : {}) }, writeOptions(who))
  },

  async delete(input: CommentDeleteInput, who: CommentsCaller): Promise<CommentThread | null> {
    const found = await load(who, input.threadId)
    const target = input.messageId === undefined ? undefined : found.messages.find(entry => entry.id === input.messageId)
    if (input.messageId !== undefined && !target) throw fail(commentsErrorDiagnostics.COMMENTS_R0003({ messageId: input.messageId }), 404)
    const deletesThread = !target || target.id === found.messages[0]?.id
    // People delete their own messages with `write`, and a thread only when every message in it is theirs. Everything
    // else, every Agent, and every guest needs the `delete` action. A guest id never proves ownership.
    const ownerId = who.user && !who.actor && who.user.guest !== true ? who.user.id : undefined
    const owns = ownerId !== undefined && (deletesThread ? found.messages.every(entry => !entry.author.guest && entry.author.id === ownerId) : !target.author.guest && target.author.id === ownerId)
    if (owns) await allow(who, "write", { thread: found })
    else {
      await allow(who, "delete", { thread: found })
      if (!who.user || who.user.guest === true) throw fail(commentsErrorDiagnostics.COMMENTS_R0009({ action: "delete" }), 403)
    }
    if (deletesThread) {
      const deleted = await who.runtime.store.deleteThread(found.id, owns ? ownerId : undefined)
      if (deleted === false) throw fail(commentsErrorDiagnostics.COMMENTS_R0009({ action: "delete" }), 403)
      who.runtime.forge?.changed(found.id)
      return null
    }
    const next = await who.runtime.store.deleteMessage(found.id, target.id, Date.now())
    who.runtime.forge?.changed(found.id)
    return next
  },

  async setStatus(input: CommentStatusInput, who: CommentsCaller, status: "open" | "resolved"): Promise<CommentThread> {
    const found = await load(who, input.threadId)
    await allow(who, "resolve", { thread: found })
    const next = await who.runtime.store.setStatus(found.id, status, author(who), Date.now())
    who.runtime.forge?.changed(found.id)
    return next
  },

  /** `minimum`: the shortest query that gets suggestions. The operations ask for two characters. */
  async users(input: CommentUsersInput, who: CommentsCaller, options: { minimum?: number } = {}): Promise<CommentUser[]> {
    const thread = input.threadId === undefined ? undefined : await load(who, input.threadId)
    const target = thread ? { thread } : input.subject ? { subject: input.subject } : {}
    await allow(who, "read", target)
    // Only people who can write mention anyone, so only they get suggestions.
    await allow(who, "write", target)
    const query = input.query.trim()
    if (query.length < (options.minimum ?? minimumQuery)) return []
    return suggest(who.runtime, { gate: who.gate, limit: Math.min(input.limit ?? 5, maximumSuggestions), query, user: who.user, ...target })
  },

  async upload(input: CommentUploadInput, who: CommentsCaller): Promise<CommentAttachment> {
    const target = input.subject ? { subject: input.subject } : {}
    await allow(who, "read", target)
    await allow(who, "write", target)
    author(who)
    return storeAttachment(who.runtime, input, who.user)
  },

  /** The file of an attachment key, for a caller who may read a thread whose messages list it. */
  async attachment(input: { key: string }, who: CommentsCaller): Promise<CommentsAttachmentBody> {
    const thread = await attachmentThread(who.runtime, input.key, candidate => permitted(who, "read", { thread: candidate }))
    return readAttachment(who.runtime, input.key, { thread, user: who.user })
  },
}

function base64(bytes: Uint8Array): string {
  let binary = ""
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  return btoa(binary)
}

const list = defineOperation({
  description: "List comment threads, newest first, filtered by subject, page, status, author, mention, or subject revision. Pass the last thread as `before` for the next page.",
  input: listInput,
  kind: "read",
  name: "comments.list",
  run: async (input, context): Promise<CommentThread[]> => commentActions.list(input, await caller(context)),
  section: "comments",
})

const get = defineOperation({
  description: "Read one comment thread by id, or by number inside its scope. A thread that does not exist or that you may not read is null.",
  input: getInput,
  kind: "read",
  name: "comments.get",
  run: async (input, context): Promise<CommentThread | null> => commentActions.get(input, await caller(context)),
  section: "comments",
})

const create = defineOperation({
  description: "Start a comment thread on a subject, such as a page, with an anchor and a first message.",
  input: createInput,
  kind: "write",
  name: "comments.create",
  run: async (input, context): Promise<CommentThread> => commentActions.create(input, await caller(context)),
  section: "comments",
})

const reply = defineOperation({
  description: "Add a message to a comment thread. A resolved thread stays resolved.",
  input: replyInput,
  kind: "write",
  name: "comments.reply",
  // The comment UI keeps a reply box on resolved threads. A reply keeps the thread resolved.
  run: async (input, context): Promise<CommentThread> => (await commentActions.reply(input, await caller(context), { allowResolved: true })).thread,
  section: "comments",
})

const edit = defineOperation({
  description: "Change the text of your own message.",
  input: editInput,
  kind: "write",
  name: "comments.edit",
  run: async (input, context): Promise<CommentThread> => commentActions.edit(input, await caller(context)),
  section: "comments",
})

const remove = defineOperation({
  description: "Delete a message, or the whole thread. Deleting the first message deletes the thread.",
  input: deleteInput,
  kind: "destructive",
  name: "comments.delete",
  run: async (input, context): Promise<CommentThread | null> => commentActions.delete(input, await caller(context)),
  section: "comments",
})

function statusOperation(name: "comments.reopen" | "comments.resolve", status: "open" | "resolved", description: string): AnyOperation {
  return defineOperation({
    description,
    input: threadId,
    kind: "write",
    name,
    run: async (input, context): Promise<CommentThread> => commentActions.setStatus(input, await caller(context), status),
    section: "comments",
  })
}

const users = defineOperation({
  description: "Find people to mention by name. Needs at least two characters, and the right to write.",
  input: usersInput,
  kind: "read",
  name: "comments.users",
  run: async (input, context): Promise<CommentUser[]> => commentActions.users(input, await caller(context)),
  section: "comments",
})

const upload = defineOperation({
  description: "Store a file to attach to a comment. Pass the returned key in `attachments` of comments.create or comments.reply.",
  input: uploadInput,
  kind: "write",
  // Base64 of the largest file, and the rest of the call.
  maxRequestBytes: Math.ceil(maximumAttachmentBytes / 3) * 4 + 4_096,
  mcp: false,
  name: "comments.upload",
  run: async (input, context): Promise<CommentAttachment> => commentActions.upload(input, await caller(context)),
  section: "comments",
})

const attachment = defineOperation({
  description: "Read the file of an attachment key, Base64-encoded, from a thread that you may read.",
  input: attachmentInput,
  kind: "read",
  mcp: false,
  name: "comments.attachment",
  run: async (input, context): Promise<CommentAttachment & { data: string, inline: boolean }> => {
    const file = await commentActions.attachment(input, await caller(context))
    return { data: base64(new Uint8Array(await file.data.arrayBuffer())), inline: file.inline, key: file.key, name: file.name, size: file.size, type: file.type }
  },
  section: "comments",
})

const session = defineOperation({
  description: "Tell the comments overlay who is signed in and what that person may do. Nothing else leaves the server.",
  input: v.strictObject({ subject: v.optional(subject), threadId: v.optional(id) }),
  kind: "read",
  name: "comments.session",
  run: async (input, context) => {
    const who = await caller(context)
    // A visitor who is not signed in gets no answer from the policy: the overlay asks on every page view, so the policy
    // does not run for each anonymous one, and nothing about the app leaks.
    if (!who.user) return { canRead: false, canWrite: false, user: null }
    if (input.threadId) {
      // Load through the same read policy as each mutation, then report its action and operation-access checks.
      const found = await load(who, input.threadId)
      const can = (action: CommentAction) => permitted(who, action, { thread: found }).catch(() => false)
      const [write, resolve, remove] = await Promise.all([can("write"), can("resolve"), can("delete")])
      const writes = operationAccessAllows(context.access, "comments", { kind: "write" })
      const deletes = operationAccessAllows(context.access, "comments", { kind: "destructive" })
      const signedIn = who.user.guest !== true
      const userId = who.user.id
      const owns = (message: CommentMessage) => signedIn && !who.actor && !message.author.guest && message.author.id === userId
      const ownsThread = found.messages.every(owns)
      const deleteThread = signedIn && deletes && (ownsThread ? write : remove)
      return {
        canRead: true,
        canWrite: writes && write,
        capabilities: {
          delete: found.messages.filter((message, index) => index === 0 ? deleteThread : signedIn && deletes && (owns(message) ? write : remove)).map(message => message.id),
          deleteThread,
          edit: signedIn && writes && (!who.actor || write) ? found.messages.filter(message => !message.author.guest && message.author.id === userId).map(message => message.id) : [],
          reply: writes && write,
          resolve: writes && resolve,
        },
        user: personOf(who.user),
      }
    }
    // A policy that cannot answer without a thread says no.
    const allowed = (action: CommentAction) => permitted(who, action, input.subject ? { subject: input.subject } : {}).catch(() => false)
    const [canRead, canWrite] = await Promise.all([allowed("read"), allowed("write")])
    return { canRead, canWrite: canRead && canWrite && operationAccessAllows(context.access, "comments", { kind: "write" }), user: personOf(who.user) }
  },
  section: "comments",
})

/** The comment operations. The Console, the CLI, MCP, and the comments client call them. */
export const commentsOperations: readonly AnyOperation[] = [list, get, create, reply, edit, remove, statusOperation("comments.resolve", "resolved", "Mark a comment thread as resolved."), statusOperation("comments.reopen", "open", "Open a resolved comment thread again."), users, upload, attachment, session]
