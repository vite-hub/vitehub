import * as v from "valibot"

import { builtinCommentSubjects, defaultPolicy, deniedForMissingPolicy } from "./define.ts"
import { commentsErrorDiagnostics } from "./errors.ts"
import { isPagePath } from "./path.ts"
import { foldName } from "../fold-name.ts"
import { guestIdPrefix } from "../identity.ts"

import type {
  CommentsAuthorizeContext,
  CommentsDefinition,
  CommentsPeople,
  CommentsPolicyGate,
  CommentSubjectDefinition,
  CommentsUser,
} from "./define.ts"
import type { CommentsStore } from "./store.ts"
import type {
  CommentActor,
  CommentAnchor,
  CommentAttachment,
  CommentContext,
  CommentMessage,
  CommentMetadata,
  CommentSubject,
  CommentThread,
  CommentUser,
} from "./types.ts"

/** Longest message, in characters. */
export const maximumCommentBodyLength = 10_000
export const maximumMentions = 20
export const maximumAttachments = 10
/** Largest attachment, in bytes. */
export const maximumAttachmentBytes = 5 * 1024 * 1024
/** The media types that `upload` stores. SVG and HTML are left out because a browser runs their scripts. */
export const attachmentTypes: readonly string[] = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "application/pdf", "text/plain"]

/** The parts of a Blob store that attachments use: `blob` of `@vite-hub/blob`. */
export interface CommentsAttachmentStore {
  put: (pathname: string, body: Uint8Array, options: { contentType: string }) => Promise<readonly [unknown, unknown]>
  get?: (pathname: string) => Promise<readonly [unknown, Blob | null | undefined]>
}

/** The media types that a browser may show inline. Every other file downloads. */
const inlineTypes: readonly string[] = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]

/** A file to answer, with the headers that keep a browser from running it. */
export interface CommentsAttachmentBody {
  key: string
  name: string
  /** The stored media type when Comments attaches that type, else `application/octet-stream`. */
  type: string
  size: number
  /** Whether a browser may show it in the page: images other than SVG. */
  inline: boolean
  data: Blob
}

/** The pull request sync of `defineComments({ forge })`. */
export interface CommentsForgeHooks {
  /** Starts the sync of a thread after a change. */
  changed: (threadId: string) => void
  /** The threads with their `forge` link. */
  attach: (threads: CommentThread[]) => Promise<CommentThread[]>
}

/** Everything that the comment operations, the server API, and the overlay API share. */
export interface CommentsRuntime {
  definition: CommentsDefinition
  /**
   * The app's `identify`, given the server event of a call. With it, the comment operations ask it for the user, as
   * the overlay API does, instead of taking the Console's user.
   */
  identify?: (event: unknown) => Promise<CommentsUser | null>
  store: CommentsStore
  /** The Auth adapter. `people` wins over it. Without both, `@` finds the authors that the store knows. */
  users?: CommentsPeople
  /** Vite's serve command, for the default guest policy. */
  development?: boolean
  /** The Blob store for attachments, when the app has one and no `storeAttachment`. */
  attachments?: CommentsAttachmentStore
  forge?: CommentsForgeHooks
  /** Work that runs after the answer, such as `onMention`. `flush()` of the server API waits for it. */
  background?: (task: Promise<unknown>) => void
}

/** An error with the HTTP status that the operation RPC answers. */
export function fail(error: Error, status: number): Error {
  return Object.assign(error, { status })
}

export function isGuestId(id: string): boolean {
  return id.startsWith(guestIdPrefix)
}

/**
 * Public identity for stored comments and notifications; policies keep the full user. A guest id gets the `guest:`
 * prefix, so a guest stays a guest in the Database and never owns the messages of a person with the same id.
 */
export function personOf(user: CommentUser): CommentUser {
  const guest = user.guest === true || isGuestId(user.id)
  return {
    id: guest && !isGuestId(user.id) ? `${guestIdPrefix}${user.id}` : user.id,
    ...(user.name ? { name: user.name } : {}),
    ...(user.image ? { image: user.image } : {}),
    ...(guest ? { guest: true } : {}),
  }
}

export function subjectDefinition(runtime: CommentsRuntime, kind: string): CommentSubjectDefinition | undefined {
  return [...builtinCommentSubjects, ...(runtime.definition.subjects ?? [])].reverse().find(candidate => candidate.kind === kind)
}

export function scopeOf(runtime: CommentsRuntime, target: CommentSubject): string {
  const definition = subjectDefinition(runtime, target.kind)
  if (!definition) throw fail(commentsErrorDiagnostics.COMMENTS_R0008({ kind: target.kind }), 400)
  if (target.kind === "page" && !isPagePath(target.id)) throw fail(commentsErrorDiagnostics.COMMENTS_R0007({ message: 'A page subject takes an app path that starts with one "/", such as "/pricing", without "?" or "#".' }), 400)
  if (target.kind === "content" && !target.id.includes("/")) throw fail(commentsErrorDiagnostics.COMMENTS_R0007({ message: 'A content subject is "<collection>/<id>".' }), 400)
  return definition.scope(target.id)
}

/**
 * The one access policy of every surface: `authorize`, else `defaultPolicy()`. Only `true` allows. `gate` says what the
 * server checked before, such as the Console's section access; `development` defaults to the runtime's.
 */
export async function can(runtime: Pick<CommentsRuntime, "definition" | "development">, context: CommentsAuthorizeContext, gate: CommentsPolicyGate = {}): Promise<boolean> {
  const { authorize } = runtime.definition
  const subject = context.subject ?? context.thread?.subject
  const full = { ...context, user: context.user ? { ...context.user } : null, ...(subject ? { subject } : {}) }
  const checked = { ...gate, development: gate.development ?? runtime.development === true }
  if (authorize) return await authorize(full) === true
  if (defaultPolicy(full.user, checked)) return true
  if (deniedForMissingPolicy(runtime.definition, full.user, checked)) warnMissingPolicy()
  return false
}

let warned = false

/** Says once per process, in the server log, that signed-in people wait for an `authorize` policy. */
function warnMissingPolicy(): void {
  if (warned) return
  warned = true
  const diagnostic = commentsErrorDiagnostics.COMMENTS_R0006()
  globalThis.console.warn(`[vitehub] ${diagnostic.code}: ${diagnostic.why} ${diagnostic.fix}`)
}

/** The diagnostic of a denied action: `COMMENTS_R0006` when only the missing `authorize` denied it, else `COMMENTS_R0009`. */
export function deniedError(runtime: Pick<CommentsRuntime, "definition" | "development">, action: string, user: CommentsUser | null, gate: CommentsPolicyGate = {}): Error {
  const checked = { ...gate, development: gate.development ?? runtime.development === true }
  if (deniedForMissingPolicy(runtime.definition, user, checked)) return fail(commentsErrorDiagnostics.COMMENTS_R0006(), 403)
  return fail(commentsErrorDiagnostics.COMMENTS_R0009({ action }), 403)
}

/** Whether `user` may mention `person`: `canMention`, else whether `person` may read the thread. */
async function mayMention(runtime: CommentsRuntime, user: CommentsUser | null, found: CommentUser, target: { thread?: CommentThread, subject?: CommentSubject, gate?: CommentsPolicyGate }): Promise<boolean> {
  const subject = target.subject ?? target.thread?.subject
  const person = { ...found }
  const context = { person, user, ...(target.thread ? { thread: target.thread } : {}), ...(subject ? { subject } : {}) }
  try {
    if (runtime.definition.canMention) return await runtime.definition.canMention(context) === true
    // The person signed in the same way as the writer, so the writer's gate stands for them.
    return await can(runtime, { action: "read", user: { ...person }, ...(target.thread ? { thread: target.thread } : {}), ...(subject ? { subject } : {}) }, target.gate)
  }
  catch {
    return false
  }
}

/** Where `@` finds people: `people`, else Auth, else the authors of threads that `reader` may read. */
function peopleOf(runtime: CommentsRuntime, reader: CommentsUser | null, gate?: CommentsPolicyGate): CommentsPeople {
  const explicit = runtime.definition.people ?? runtime.users
  if (explicit) return explicit
  const readable = (thread: CommentThread) => can(runtime, { action: "read", thread, user: reader }, gate).catch(() => false)
  return {
    byIds: ids => runtime.store.knownUsersByIds(ids, readable),
    search: (query, limit) => runtime.store.knownUsers(query, limit, readable),
  }
}

/** People that `@` suggests to `user`, without the ones that may not be mentioned in the thread. */
export async function suggest(runtime: CommentsRuntime, input: { query: string, limit: number, user: CommentsUser | null, thread?: CommentThread, subject?: CommentSubject, gate?: CommentsPolicyGate }): Promise<CommentUser[]> {
  const found = await peopleOf(runtime, input.user, input.gate).search(input.query, input.limit * 2)
  // Accents and case do not count, as in the menu, so an app's `search` that finds "José" for "jose" keeps him.
  const needle = foldName(input.query.trim())
  const people: CommentUser[] = []
  for (const person of found) {
    if (people.length >= input.limit) break
    if (isGuestId(person.id) || (needle && !foldName(person.name ?? person.id).includes(needle))) continue
    if (await mayMention(runtime, input.user, person, input)) people.push(personOf(person))
  }
  return people
}

/** The people that the messages of `threads` mention, so a UI can show their names. */
export async function mentionedPeople(runtime: CommentsRuntime, reader: CommentsUser | null, threads: readonly CommentThread[], gate?: CommentsPolicyGate): Promise<CommentUser[]> {
  const ids = [...new Set(threads.flatMap(thread => thread.messages.flatMap(message => message.mentions)))]
  if (!ids.length) return []
  return (await peopleOf(runtime, reader, gate).byIds(ids)).map(personOf)
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** The mentioned ids must be real people that `user` may mention there, and the text must name each one with `@name`. */
export async function checkMentions(runtime: CommentsRuntime, input: { body: string, ids: readonly string[] | undefined, user: CommentsUser | null, thread?: CommentThread, subject?: CommentSubject, gate?: CommentsPolicyGate }): Promise<CommentUser[]> {
  const unique = [...new Set(input.ids ?? [])]
  if (!unique.length) return []
  if (unique.length > maximumMentions) throw fail(commentsErrorDiagnostics.COMMENTS_R0007({ message: `A message mentions at most ${maximumMentions} people.` }), 400)
  const found = new Map((await peopleOf(runtime, input.user, input.gate).byIds(unique)).map(person => [person.id, person]))
  const people: CommentUser[] = []
  for (const mentioned of unique) {
    const person = found.get(mentioned)
    if (!person || isGuestId(person.id)) throw fail(commentsErrorDiagnostics.COMMENTS_R0007({ message: `The mentioned user ${JSON.stringify(mentioned)} does not exist.` }), 400)
    const name = person.name ?? person.id
    if (!new RegExp(`(^|[^\\p{L}\\p{N}\\p{M}_])@${escapeRegExp(name)}(?=$|[^\\p{L}\\p{N}\\p{M}_])`, "iu").test(input.body)) {
      throw fail(commentsErrorDiagnostics.COMMENTS_R0007({ message: `The text does not name @${name}, but the comment mentions ${name}.` }), 400)
    }
    if (!await mayMention(runtime, input.user, person, input)) {
      throw fail(commentsErrorDiagnostics.COMMENTS_R0007({ message: `${name} may not be mentioned here.` }), 400)
    }
    people.push(personOf(person))
  }
  return people
}

const metadataSchema = v.pipe(
  v.record(v.pipe(v.string(), v.minLength(1), v.maxLength(64)), v.union([v.pipe(v.string(), v.maxLength(4_000)), v.number(), v.boolean(), v.null()])),
  v.check(value => Object.keys(value).length <= 50, "Keep at most 50 metadata fields."),
)

const short = (max: number) => v.pipe(v.string(), v.maxLength(max))
const size = v.pipe(v.number(), v.minValue(0), v.maxValue(100_000))

/** The page context that the overlay reads. The server checks its URL and adds the build. */
export const contextSchema = v.object({
  url: short(2048),
  title: v.optional(short(256)),
  route: v.optional(short(256)),
  element: v.optional(v.object({
    tag: short(64),
    id: v.optional(short(128)),
    testId: v.optional(short(128)),
    role: v.optional(short(64)),
    name: v.optional(short(120)),
    classes: v.optional(v.pipe(v.array(short(64)), v.maxLength(8))),
  })),
  components: v.optional(v.pipe(v.array(v.object({ name: short(128), files: v.optional(v.pipe(v.array(short(512)), v.maxLength(8))) })), v.maxLength(12))),
  environment: v.optional(v.object({
    viewport: v.object({ width: size, height: size }),
    devicePixelRatio: v.pipe(v.number(), v.minValue(0), v.maxValue(16)),
    userAgent: short(512),
    language: v.optional(short(64)),
    colorScheme: v.optional(v.picklist(["light", "dark"])),
    timeZone: v.optional(short(64)),
  })),
  build: v.optional(v.object({
    commit: v.optional(short(64)),
    branch: v.optional(short(256)),
    repository: v.optional(short(256)),
    pullRequest: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  })),
})

const revisionSchema = v.pipe(v.number(), v.integer(), v.minValue(0))
/** The retry key of `comments.create`, such as `crypto.randomUUID()`. */
export const requestIdSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(200))
const attachmentKey = v.pipe(v.string(), v.minLength(1), v.maxLength(500))

function invalid(issues: readonly v.BaseIssue<unknown>[], field: string): Error {
  const issue = issues[0]
  const path = [field, ...(issue?.path?.map(item => String(item.key)) ?? [])].join(".")
  return fail(commentsErrorDiagnostics.COMMENTS_R0018({ message: `${path}: ${issue?.message ?? "invalid."}` }), 400)
}

function check<T>(schema: v.GenericSchema<unknown, T>, value: unknown, field: string): T {
  const parsed = v.safeParse(schema, value)
  if (!parsed.success) throw invalid(parsed.issues, field)
  return parsed.output
}

/** The trimmed text. Empty only with attachments, or on a subject that allows it. */
function cleanBody(runtime: CommentsRuntime, input: { body: string, attachments: readonly string[], subject: CommentSubject, metadata?: CommentMetadata }): string {
  if (input.body.length > maximumCommentBodyLength) throw fail(commentsErrorDiagnostics.COMMENTS_R0018({ message: `body: Keep a message under ${maximumCommentBodyLength.toLocaleString("en")} characters.` }), 400)
  const trimmed = input.body.trim()
  if (trimmed || input.attachments.length) return trimmed
  const allowed = subjectDefinition(runtime, input.subject.kind)?.emptyBody
  if (allowed === true || (typeof allowed === "function" && allowed(input.metadata ? { metadata: input.metadata } : {}))) return ""
  throw fail(commentsErrorDiagnostics.COMMENTS_R0005(), 400)
}

function attachmentsOf(list: readonly string[] | undefined): string[] {
  const keys = check(v.pipe(v.array(attachmentKey), v.maxLength(maximumAttachments)), list ?? [], "attachments")
  return [...new Set(keys)]
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`
}

/**
 * Runs `onComment` before the answer and `onMention` after it, for one saved message. A failure is logged and never
 * fails the comment.
 */
async function announce(runtime: CommentsRuntime, thread: CommentThread, message: CommentMessage | undefined, mentions: CommentUser[], fresh: CommentUser[], options: { comment: boolean, waitUntil?: (task: Promise<unknown>) => void }): Promise<void> {
  if (!message) return
  const { onComment, onMention } = runtime.definition
  if (options.comment && onComment) {
    try {
      await onComment({ mentions, message, thread })
    }
    catch (error) {
      globalThis.console.error("[vitehub] Comments onComment failed:", error)
    }
  }
  if (!onMention || !fresh.length) return
  const link = subjectDefinition(runtime, thread.subject.kind)?.link?.(thread)
  const task = (async () => {
    try {
      await onMention({ message, thread, users: fresh, ...(link ? { link } : {}) })
    }
    catch (error) {
      globalThis.console.error("[vitehub] Comments onMention failed:", error)
    }
  })()
  options.waitUntil?.(task)
  runtime.background?.(task)
}

export interface CreateThreadInput {
  subject: CommentSubject
  anchor?: CommentAnchor
  body: string
  author: CommentUser
  actor?: CommentActor
  mentions?: readonly string[]
  attachments?: readonly string[]
  metadata?: CommentMetadata
  context?: CommentContext
  revision?: number
  /** A retry with the same key in the same scope gets the thread of the first call. */
  requestId?: string
}

export interface WriteOptions {
  /** The person whose `@` suggestions the mentions came from. Default: the author. */
  user?: CommentsUser | null
  /** What the server checked about `user`, for the mention checks. */
  gate?: CommentsPolicyGate
  waitUntil?: (task: Promise<unknown>) => void
  /** Whether the caller may read the thread that a retry of `createThread` gets back. Default: yes. */
  canRead?: (thread: CommentThread) => Promise<boolean>
}

/** The thread that an earlier `createThread` with this `requestId` stored. A retry gets it back before the create checks. */
export async function earlierThread(runtime: CommentsRuntime, input: Pick<CreateThreadInput, "requestId" | "subject">): Promise<CommentThread | undefined> {
  if (input.requestId === undefined) return undefined
  return await runtime.store.getByRequestId(scopeOf(runtime, input.subject), check(requestIdSchema, input.requestId, "requestId")) ?? undefined
}

/** Only the author of the first call gets its thread back, for the same subject, and only while they may read it. */
export async function retried(thread: CommentThread, input: Pick<CreateThreadInput, "author" | "subject">, canRead?: WriteOptions["canRead"]): Promise<CommentThread> {
  const sameSubject = thread.subject.kind === input.subject.kind && thread.subject.id === input.subject.id
  if (!sameSubject || thread.author.id !== personOf(input.author).id || (canRead && !(await canRead(thread)))) throw fail(commentsErrorDiagnostics.COMMENTS_R0022(), 409)
  return thread
}

/** Starts a thread. The caller checked access. */
export async function createThread(runtime: CommentsRuntime, input: CreateThreadInput, options: WriteOptions = {}): Promise<CommentThread> {
  const earlier = await earlierThread(runtime, input)
  if (earlier) return retried(earlier, input, options.canRead)
  const scope = scopeOf(runtime, input.subject)
  const metadata = input.metadata === undefined ? undefined : check(metadataSchema, input.metadata, "metadata")
  const context = input.context === undefined ? undefined : check(contextSchema, input.context, "context")
  const revision = input.revision === undefined ? undefined : check(revisionSchema, input.revision, "revision")
  const requestId = input.requestId === undefined ? undefined : check(requestIdSchema, input.requestId, "requestId")
  const attachments = attachmentsOf(input.attachments)
  const body = cleanBody(runtime, { attachments, body: input.body, subject: input.subject, ...(metadata ? { metadata } : {}) })
  const user = options.user === undefined ? { ...input.author } : options.user
  const mentioned = await checkMentions(runtime, { body, ids: input.mentions, subject: input.subject, user, ...(options.gate ? { gate: options.gate } : {}) })
  const author = personOf(input.author)
  const threadId = newId("thread")
  const created = await runtime.store.createThread({
    anchor: input.anchor ?? { kind: "page" },
    attachments,
    author,
    body,
    id: newId("message"),
    mentions: mentioned.map(person => person.id),
    now: Date.now(),
    scope,
    subject: input.subject,
    threadId,
    ...(input.actor ? { actor: input.actor } : {}),
    ...(metadata ? { metadata } : {}),
    ...(context ? { context } : {}),
    ...(revision === undefined ? {} : { revision }),
    ...(requestId === undefined ? {} : { requestId }),
  })
  // A retry won the race: the first call stored the thread and sent its notifications.
  if (created.id !== threadId) return retried(created, input, options.canRead)
  await announce(runtime, created, created.messages[0], mentioned, mentioned, { comment: true, ...(options.waitUntil ? { waitUntil: options.waitUntil } : {}) })
  runtime.forge?.changed(created.id)
  return created
}

export interface ReplyInput {
  body: string
  author: CommentUser
  actor?: CommentActor
  mentions?: readonly string[]
  attachments?: readonly string[]
}

/** Adds a message to a thread. The caller checked access. */
export async function replyToThread(runtime: CommentsRuntime, thread: CommentThread, input: ReplyInput, options: WriteOptions & { allowResolved?: boolean } = {}): Promise<{ thread: CommentThread, message: CommentMessage }> {
  if (thread.status === "resolved" && !options.allowResolved) throw fail(commentsErrorDiagnostics.COMMENTS_R0016(), 409)
  const attachments = attachmentsOf(input.attachments)
  const body = cleanBody(runtime, { attachments, body: input.body, subject: thread.subject, ...(thread.metadata ? { metadata: thread.metadata } : {}) })
  const user = options.user === undefined ? { ...input.author } : options.user
  const mentioned = await checkMentions(runtime, { body, ids: input.mentions, thread, user, ...(options.gate ? { gate: options.gate } : {}) })
  const id = newId("message")
  let next: CommentThread
  try {
    next = await runtime.store.addMessage(thread.id, {
      attachments,
      author: personOf(input.author),
      body,
      id,
      mentions: mentioned.map(person => person.id),
      now: Date.now(),
      ...(input.actor ? { actor: input.actor } : {}),
    }, { allowResolved: options.allowResolved === true })
  }
  catch (error) {
    if (error instanceof Error && Reflect.get(error, "code") === "COMMENTS_R0016") throw fail(error, 409)
    if (error instanceof Error && Reflect.get(error, "code") === "COMMENTS_R0002") throw fail(error, 404)
    throw error
  }
  const message = next.messages.find(entry => entry.id === id)!
  await announce(runtime, next, message, mentioned, mentioned, { comment: true, ...(options.waitUntil ? { waitUntil: options.waitUntil } : {}) })
  runtime.forge?.changed(next.id)
  return { message, thread: next }
}

/** Changes the text of a message. The caller checked access and authorship. */
export async function editMessage(runtime: CommentsRuntime, thread: CommentThread, messageId: string, input: { body: string, mentions?: readonly string[] }, options: WriteOptions & { user: CommentsUser | null }): Promise<CommentThread> {
  const target = thread.messages.find(entry => entry.id === messageId)
  if (!target) throw fail(commentsErrorDiagnostics.COMMENTS_R0003({ messageId }), 404)
  const body = cleanBody(runtime, { attachments: target.attachments, body: input.body, subject: thread.subject, ...(thread.metadata ? { metadata: thread.metadata } : {}) })
  const mentioned = await checkMentions(runtime, { body, ids: input.mentions, thread, user: options.user, ...(options.gate ? { gate: options.gate } : {}) })
  const next = await runtime.store.editMessage(thread.id, target.id, { body, mentions: mentioned.map(person => person.id), now: Date.now() })
  const fresh = mentioned.filter(person => !target.mentions.includes(person.id))
  await announce(runtime, next, next.messages.find(entry => entry.id === target.id), mentioned, fresh, { comment: false, ...(options.waitUntil ? { waitUntil: options.waitUntil } : {}) })
  runtime.forge?.changed(next.id)
  return next
}

function safeName(name: string): string {
  const cleaned = name.normalize("NFKC").replaceAll(/[^\w.-]+/g, "-").replaceAll(/^[-.]+|-+$/g, "").slice(0, 100)
  return cleaned || "file"
}

function decodeBase64(data: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 !== 0) throw fail(commentsErrorDiagnostics.COMMENTS_R0017({ message: "The file data is not Base64." }), 400)
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

/** Binds an upload to its exact key and bytes, including after a process restart or an app Blob replacement. */
async function attachmentRecord(key: string, data: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(data)))
  const sha256 = Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("")
  return JSON.stringify({ key, sha256 })
}

/** Checks a file and stores it with `storeAttachment`, else in the Blob store. The caller checked access. */
export async function storeAttachment(runtime: CommentsRuntime, input: { name: string, type: string, data: Uint8Array | string, subject?: CommentSubject }, user: CommentsUser | null): Promise<CommentAttachment> {
  const type = input.type.toLowerCase().split(";", 1)[0]!.trim()
  if (!attachmentTypes.includes(type)) throw fail(commentsErrorDiagnostics.COMMENTS_R0017({ message: `Comments does not attach files of type ${JSON.stringify(input.type)}.` }), 415)
  // Base64 takes 4 characters for 3 bytes, so a longer string cannot hold a file under the limit.
  if (typeof input.data === "string" && input.data.length > Math.ceil(maximumAttachmentBytes / 3) * 4) throw fail(commentsErrorDiagnostics.COMMENTS_R0017({ message: "The file is larger than 5 MB." }), 413)
  const data = typeof input.data === "string" ? decodeBase64(input.data) : input.data
  if (data.byteLength > maximumAttachmentBytes) throw fail(commentsErrorDiagnostics.COMMENTS_R0017({ message: "The file is larger than 5 MB." }), 413)
  if (!data.byteLength) throw fail(commentsErrorDiagnostics.COMMENTS_R0017({ message: "The file is empty." }), 400)
  const name = safeName(input.name)
  const file = { data, name, size: data.byteLength, type }
  if (input.subject) scopeOf(runtime, input.subject)
  let key: string
  if (runtime.definition.storeAttachment) {
    key = check(attachmentKey, await runtime.definition.storeAttachment(file, { user, ...(input.subject ? { subject: input.subject } : {}) }), "storeAttachment")
  }
  else {
    if (!runtime.attachments) throw fail(commentsErrorDiagnostics.COMMENTS_R0014(), 501)
    const id = crypto.randomUUID()
    key = `comments/${id}/${name}`
    const [error] = await runtime.attachments.put(key, data, { contentType: type })
    if (error) throw error
    const record = new TextEncoder().encode(await attachmentRecord(key, data))
    const [recordError] = await runtime.attachments.put(`comments/${id}/.upload.json`, record, { contentType: "application/json" })
    if (recordError) throw recordError
  }
  return { key, name, size: file.size, type }
}

/** The thread through which `user` may read the file of `key`, else `COMMENTS_R0020` as not found. */
export async function attachmentThread(runtime: CommentsRuntime, key: string, readable: (thread: CommentThread) => Promise<boolean>): Promise<CommentThread> {
  check(attachmentKey, key, "key")
  let cursor: string | undefined
  do {
    const page = await runtime.store.getByAttachment(key, cursor)
    for (const thread of page.threads) {
      if (await readable(thread).catch(() => false)) return thread
    }
    cursor = page.cursor
  } while (cursor)
  throw fail(commentsErrorDiagnostics.COMMENTS_R0020({ key }), 404)
}

/**
 * Reads the file of `key` with `readAttachment`, else from the Blob store, for a reader who may read `thread`. A
 * stored type that Comments does not attach, such as SVG from an app's own hook, answers as a download.
 */
export async function readAttachment(runtime: CommentsRuntime, key: string, context: { user: CommentsUser | null, thread: CommentThread }): Promise<CommentsAttachmentBody> {
  const { readAttachment: read, storeAttachment: store } = runtime.definition
  let data: Blob | null | undefined
  if (read) data = await read(key, { thread: context.thread, user: context.user ? { ...context.user } : null })
  // Files that the app's own hook stored are not in the Blob store.
  else if (store) throw fail(commentsErrorDiagnostics.COMMENTS_R0021(), 501)
  else if (runtime.attachments?.get) {
    const match = /^comments\/([\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12})\/\w[\w.-]{0,99}$/.exec(key)
    if (!match) {
      throw fail(commentsErrorDiagnostics.COMMENTS_R0020({ key }), 404)
    }
    // A pathname convention cannot prove ownership: an app can also put files under comments/.
    const [recordError, record] = await runtime.attachments.get(`comments/${match[1]}/.upload.json`)
    if (recordError) throw recordError
    if (!record || record.size > 1024) {
      throw fail(commentsErrorDiagnostics.COMMENTS_R0020({ key }), 404)
    }
    const [error, found] = await runtime.attachments.get(key)
    if (error) throw error
    if (!found || found.size > maximumAttachmentBytes || await record.text() !== await attachmentRecord(key, new Uint8Array(await found.arrayBuffer()))) {
      throw fail(commentsErrorDiagnostics.COMMENTS_R0020({ key }), 404)
    }
    data = found
  }
  else throw fail(commentsErrorDiagnostics.COMMENTS_R0014(), 501)
  if (!data) throw fail(commentsErrorDiagnostics.COMMENTS_R0020({ key }), 404)
  const stored = data.type.toLowerCase().split(";", 1)[0]!.trim()
  const type = attachmentTypes.includes(stored) ? stored : "application/octet-stream"
  const name = safeName(data instanceof File && data.name ? data.name : key.split("/").at(-1) ?? "file")
  return { data, inline: inlineTypes.includes(type), key, name, size: data.size, type }
}
