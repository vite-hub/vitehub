import { getCloudflareEnv, resolveWaitUntil, runWithActiveCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"
import { forwardedRequestOrigin } from "@vite-hub/internal/runtime/request-origin"
import { defineGrant } from "@vite-hub/runtime/internal/grant"
import { defineEventHandler } from "h3"
import * as v from "valibot"

import { commentsErrors } from "../errors.ts"
import { authorOf, guestFromHeaders } from "../identity.ts"
import { resolveCommentsRuntime } from "../index.ts"
import { commentActions, commentAnchorSchema, commentInputSchemas } from "../operations-core/operations.ts"
import { deniedForMissingPolicy } from "../operations-core/define.ts"
import { can as policyCan, contextSchema, deniedError, mentionedPeople } from "../operations-core/service.ts"
import { commentsRoute, normalizeCommentPage } from "../page.ts"
import { requestOf } from "./request.ts"
import { resolveCommentsUser } from "./session.ts"

import type { Result, ResultError } from "@vite-hub/runtime"
import type { H3Event } from "h3"
import type { Comments } from "../index.ts"
import type { CommentsGitHubLogin } from "./github-login.ts"
import type { CommentsCaller } from "../operations-core/operations.ts"
import type { CommentsRuntime } from "../operations-core/service.ts"
import type { CommentAction, CommentContext, CommentListQuery, CommentsUser, CommentSubject, CommentThread, CommentUser } from "../types.ts"
import type { CommentsSessionOptions } from "./session.ts"

/** One field address, as `parseContentField()` from `@vite-hub/content/client` reads it. */
export interface CommentsContentField {
  collection: string
  id?: string
  field: string
}

interface ContentDocumentLike {
  id: string
  data: Record<string, unknown>
  body?: string
  digest: string
}

interface ContentCollectionLike {
  readonly name: string
  readonly kind: "documents" | "singleton"
  readonly id?: string
  readonly format: string
  get(id: string, options: { ref: "draft" }): Promise<ContentDocumentLike | null>
  save(id: string, input: { data: Record<string, unknown>, body?: string }, options: { ifDigest: string, message: string, metadata: Record<string, string> }): Promise<ContentDocumentLike>
}

/** The parts of a Content runtime that inline edits use: `content` from `server/content.ts`. */
export interface CommentsContent {
  can(context: { user?: Record<string, unknown>, collection: string, action: "write", id?: string }): Promise<boolean>
  collections(): readonly ContentCollectionLike[]
}

export interface CommentsHandlerOptions extends CommentsSessionOptions {
  comments: Comments
  /**
   * Sign in with GitHub, for apps without their own sign-in: people who are not signed in another way see **Sign in
   * with GitHub** in the overlay. It works once the server has a GitHub OAuth client.
   */
  githubLogin?: CommentsGitHubLogin
  /** Inline edits of Content fields. Omitted when the app has no Content collections. */
  content?: { runtime: CommentsContent, parseField: (value: string) => CommentsContentField | undefined }
  /** Whether the page presence rooms run, because the host has a Realtime authority. */
  realtime: boolean
  /** The commit and branch of this build. New threads keep them in `context.build`. */
  build?: NonNullable<CommentContext["build"]>
  /**
   * The Vue files of the project by component name, relative to the project root. New threads get the files of each
   * component that the overlay names, because production builds keep only the name.
   */
  components?: Readonly<Record<string, readonly string[]>>
}

const fieldEditGrant = defineGrant("vitehub.comments.field-edit", (input: { collection: ContentCollectionLike, id: string, field: string, user: CommentUser }) => input)

const pageSchema = v.pipe(v.string(), v.startsWith("/", "A page starts with `/`."), v.maxLength(1024))
/** `POST /threads`: the input of `comments.create`, or a `page` instead of the subject, and the page context of the overlay. */
const createBody = v.object({
  ...commentInputSchemas.create.entries,
  subject: v.optional(commentInputSchemas.create.entries.subject),
  page: v.optional(pageSchema),
  anchor: v.optional(commentAnchorSchema),
  context: v.optional(contextSchema),
})
const replyBody = v.object({ body: commentInputSchemas.reply.entries.body, mentions: commentInputSchemas.reply.entries.mentions, attachments: commentInputSchemas.reply.entries.attachments })
const editBody = v.object({ body: commentInputSchemas.edit.entries.body, mentions: commentInputSchemas.edit.entries.mentions })

/** The first issue as one sentence, for `COMMENTS_INVALID_INPUT`. */
function describeIssue(issues: readonly v.BaseIssue<unknown>[]): string {
  const issue = issues[0]
  if (!issue) return "unknown issue."
  const path = issue.path?.map(item => String(item.key)).join(".")
  return path ? `${path}: ${issue.message}` : issue.message
}
const fieldBody = v.object({ field: v.pipe(v.string(), v.maxLength(512)), value: v.pipe(v.string(), v.maxLength(20_000)), ifDigest: v.string() })

function status(code: string): number {
  switch (code) {
    case "COMMENTS_NOT_FOUND":
    case "COMMENTS_CONTENT_MISSING":
      return 404
    case "COMMENTS_FORBIDDEN":
    case "COMMENTS_POLICY_MISSING":
    case "COMMENTS_FIELD_FORBIDDEN":
      return 403
    case "COMMENTS_RESOLVED":
    case "COMMENTS_FIELD_CONFLICT":
      return 409
    case "COMMENTS_FIELD_LOCKED":
      return 423
    case "COMMENTS_FIELD_NOT_EDITABLE":
      return 422
    case "COMMENTS_NOT_INSTALLED":
      return 503
    default:
      return 400
  }
}

function json(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers)
  headers.set("content-type", "application/json; charset=utf-8")
  headers.set("cache-control", "private, no-store")
  return new Response(JSON.stringify(value), { ...init, headers })
}

function failure(error: ResultError): Response {
  return json({ error }, { status: status(error.code) })
}

/** A thrown Comments diagnostic, such as `COMMENTS_R0019` for tables that need a migration, as the API's error object. */
function diagnosticResponse(error: unknown): Response {
  const code = Reflect.get(Object(error), "code")
  const status = Reflect.get(Object(error), "status")
  if (!(error instanceof Error) || typeof code !== "string" || !code.startsWith("COMMENTS_") || typeof status !== "number") throw error
  const fix = Reflect.get(error, "fix")
  return json({ error: { code, why: Reflect.get(error, "why") ?? error.message, ...(typeof fix === "string" ? { fix } : {}) } }, { status })
}

/** The REST code of a diagnostic of the comment actions. Codes without one, such as `COMMENTS_R0019`, stay as they are. */
const restCodes: Readonly<Record<string, "COMMENTS_NOT_FOUND" | "COMMENTS_FORBIDDEN" | "COMMENTS_POLICY_MISSING" | "COMMENTS_RESOLVED" | "COMMENTS_INVALID_INPUT">> = {
  COMMENTS_R0002: "COMMENTS_NOT_FOUND",
  COMMENTS_R0003: "COMMENTS_NOT_FOUND",
  COMMENTS_R0004: "COMMENTS_FORBIDDEN",
  COMMENTS_R0005: "COMMENTS_INVALID_INPUT",
  COMMENTS_R0006: "COMMENTS_POLICY_MISSING",
  COMMENTS_R0007: "COMMENTS_INVALID_INPUT",
  COMMENTS_R0008: "COMMENTS_INVALID_INPUT",
  COMMENTS_R0009: "COMMENTS_FORBIDDEN",
  COMMENTS_R0012: "COMMENTS_FORBIDDEN",
  COMMENTS_R0016: "COMMENTS_RESOLVED",
  COMMENTS_R0017: "COMMENTS_INVALID_INPUT",
  COMMENTS_R0018: "COMMENTS_INVALID_INPUT",
}

/** A failure of a comment action as the API's error object: the REST code, and the status of the diagnostic. */
function actionFailure(error: unknown, action: string): Response {
  const code = Reflect.get(Object(error), "code")
  const mapped = typeof code === "string" ? restCodes[code] : undefined
  if (!(error instanceof Error) || !mapped) return diagnosticResponse(error)
  const why = String(Reflect.get(error, "why") ?? error.message)
  const result = mapped === "COMMENTS_FORBIDDEN"
    ? commentsErrors.COMMENTS_FORBIDDEN({ action })
    : mapped === "COMMENTS_POLICY_MISSING"
      ? commentsErrors.COMMENTS_POLICY_MISSING()
      : mapped === "COMMENTS_RESOLVED"
        ? commentsErrors.COMMENTS_RESOLVED()
        : mapped === "COMMENTS_NOT_FOUND"
          ? commentsErrors.COMMENTS_NOT_FOUND({ id: why })
          : commentsErrors.COMMENTS_INVALID_INPUT({ issue: why })
  const statusOf = Reflect.get(error, "status")
  return json({ error: mapped === "COMMENTS_NOT_FOUND" ? { ...result, why } : result }, { status: mapped === "COMMENTS_INVALID_INPUT" && typeof statusOf === "number" ? statusOf : status(mapped) })
}

/** Response headers for a stored file: its checked type, a file name, and no way for the browser to run it. */
function attachmentHeaders(file: { name: string, type: string, size: number, inline: boolean }): Headers {
  return new Headers({
    "cache-control": "private, max-age=300",
    "content-disposition": `${file.inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    "content-length": String(file.size),
    "content-security-policy": "default-src 'none'; sandbox",
    "content-type": file.type === "text/plain" ? "text/plain; charset=utf-8" : file.type,
    "cross-origin-resource-policy": "same-origin",
    "x-content-type-options": "nosniff",
  })
}

function respond<T>([error, data]: Result<T>): Response {
  return error ? failure(error) : json({ data: data ?? null })
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin")
  // Browsers send Origin on every cross-site POST and DELETE, so a request without one is not a cross-site page.
  return !origin || origin === forwardedRequestOrigin(request)
}

function readPath(data: unknown, path: readonly string[]): unknown {
  let current = data
  for (const key of path) {
    if (current === null || typeof current !== "object") return undefined
    current = Reflect.get(current, key)
  }
  return current
}

function writePath(data: Record<string, unknown>, path: readonly string[], value: string): Record<string, unknown> {
  const copy = structuredClone(data)
  let current: unknown = copy
  for (const key of path.slice(0, -1)) current = Reflect.get(Object(current), key)
  Reflect.set(Object(current), path.at(-1)!, value)
  return copy
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined
}

function leaseHolder(error: unknown): string {
  const details = error instanceof Error && "details" in error ? error.details : undefined
  const name = readPath(details, ["holder", "user", "name"]) ?? readPath(details, ["holder", "user", "id"])
  return typeof name === "string" && name ? name : "Someone"
}

/**
 * The Comments API at `/api/_vitehub/comments/**`. The overlay calls it; every route checks the `authorize` policy of
 * `defineComments()` for the user of the request, and inline edits also check `content.can()`.
 */
export function createCommentsHandler(options: CommentsHandlerOptions): ReturnType<typeof defineEventHandler> {
  const { comments } = options
  // With the Console, every user here passed its Comments section access first.
  const gate = { console: Boolean(options.consoleSession) }

  async function resolveUser(event: H3Event, action: CommentAction = "read"): Promise<CommentsUser | null | false> {
    return resolveCommentsUser(comments, event, {
      ...options,
      session: async request => await options.session?.(request) ?? await options.githubLogin?.user(request),
    }, action)
  }

  async function access(event: H3Event, action: CommentAction, thread?: CommentThread, subject?: CommentSubject): Promise<Result<{ user: CommentsUser | null, author: CommentUser | undefined }, "COMMENTS_FORBIDDEN" | "COMMENTS_POLICY_MISSING">> {
    const user = await resolveUser(event, action)
    if (user === false) return [commentsErrors.COMMENTS_FORBIDDEN({ action }), undefined]
    if (!await comments.can({ user, action, ...(thread ? { thread } : {}), ...(subject ? { subject } : {}) }, gate)) {
      return [deniedForMissingPolicy(comments.options, user, { ...gate, development: (await resolveCommentsRuntime(comments))?.development === true }) ? commentsErrors.COMMENTS_POLICY_MISSING() : commentsErrors.COMMENTS_FORBIDDEN({ action }), undefined]
    }
    // A user writes as itself; without one, a guest that named itself, when the policy lets anonymous people act.
    const author = user ? authorOf(user) : guestFromHeaders(requestOf(event).headers)
    return [undefined, { user, author }]
  }

  /**
   * The caller of a comment action: the user of the request, after the Console's section access for `action`. A
   * person that the Console refuses is denied before the policy runs.
   */
  async function callerOf(event: H3Event, action: CommentAction): Promise<{ who: CommentsCaller } | { denied: Response }> {
    const runtime = await resolveCommentsRuntime(comments)
    if (!runtime) return { denied: failure(commentsErrors.COMMENTS_NOT_INSTALLED()) }
    const user = await resolveUser(event, action)
    if (user === false) return { denied: failure(commentsErrors.COMMENTS_FORBIDDEN({ action })) }
    const waitUntil = resolveWaitUntil(event, { preferHost: true })
    return { who: { gate: { ...gate, development: runtime.development === true }, request: requestOf(event), runtime, user, ...(waitUntil ? { waitUntil } : {}) } }
  }

  /** Runs a comment action for the request, and answers its diagnostics as the API's error objects. */
  async function act<T>(event: H3Event, action: CommentAction, run: (who: CommentsCaller) => Promise<T>, answer: (value: T, who: CommentsCaller) => Promise<Response> | Response): Promise<Response> {
    const called = await callerOf(event, action)
    if ("denied" in called) return called.denied
    let value: T
    try {
      value = await run(called.who)
    }
    catch (error) {
      return actionFailure(error, action)
    }
    return await answer(value, called.who)
  }

  /** Adds the build, and the source files of each component, to the context that the overlay read. */
  function completeContext(context: CommentContext): CommentContext {
    // Keep the app's own components: names without a project file, such as RouterView or a UI library's, are noise.
    // Without a file map, or when none matches, keep the three innermost names.
    const named = context.components?.map((component) => {
      const files = options.components && Object.hasOwn(options.components, component.name) ? options.components[component.name] : undefined
      return files?.length ? { name: component.name, files: files.slice(0, 8) } : { name: component.name }
    })
    const own = named?.filter(component => component.files)
    const components = own?.length ? own : named?.slice(-3)
    // The browser does not know the build, and cannot name files: both come from the server.
    const { build: _build, ...read } = context
    return {
      ...read,
      ...(components ? { components } : {}),
      ...(options.build && Object.values(options.build).some(Boolean) ? { build: options.build } : {}),
    }
  }

  async function readJson(event: H3Event): Promise<unknown> {
    try {
      return await requestOf(event).json()
    }
    catch {
      return undefined
    }
  }

  function invalid(issues: readonly v.BaseIssue<unknown>[]): Response {
    return failure(commentsErrors.COMMENTS_INVALID_INPUT({ issue: describeIssue(issues) }))
  }

  /** Who the overlay's person is and what they may do. The page tools session decides whether the overlay loads. */
  async function session(event: H3Event, subject?: CommentSubject): Promise<Response> {
    const user = await resolveUser(event)
    const [read, comment, resolve, remove] = await Promise.all((["read", "write", "resolve", "delete"] as const).map(action => can(event, user, action, undefined, subject)))
    const github = options.githubLogin?.configured() ? options.githubLogin : undefined
    const pathname = new URL(requestOf(event).url).pathname
    const route = pathname.slice(0, pathname.indexOf(commentsRoute) + commentsRoute.length)
    // People who are not signed in can sign in with GitHub, and a GitHub account that may not comment can switch.
    const signIn = user !== false && !user && !comments.options.identify && github ? { provider: "github" as const, url: `${route}/auth/github` } : undefined
    const signOut = user && user.github && github ? `${route}/auth/sign-out` : undefined
    return json({
      data: {
        user: user ? authorOf(user) : null,
        ...(user && user.github ? { github: user.github } : {}),
        can: { read, comment, resolve, delete: remove },
        ...(signIn ? { signIn } : {}),
        ...(signOut ? { signOut } : {}),
        realtime: options.realtime,
        content: Boolean(options.content),
      },
    })
  }

  async function can(event: H3Event, user: CommentsUser | null | false, action: CommentAction, thread?: CommentThread, subject?: CommentSubject): Promise<boolean> {
    if (user === false) return false
    if (action !== "read" && await options.consoleSession?.(event, action).catch(() => false as const) === false) return false
    return comments.can({ user, action, ...(thread ? { thread } : {}), ...(subject ? { subject } : {}) }, gate)
  }

  async function permissions(event: H3Event, user: CommentsUser | null, thread: CommentThread) {
    const [comment, resolve, remove] = await Promise.all((["write", "resolve", "delete"] as const).map(action => can(event, user, action, thread)))
    return { ...thread, can: { comment, resolve, delete: remove } }
  }

  /** The people that the threads mention, so a UI shows their names. */
  async function people(runtime: CommentsRuntime, user: CommentsUser | null, threads: readonly CommentThread[]): Promise<CommentUser[]> {
    return await mentionedPeople(runtime, user, threads, gate)
  }

  /** A thread with what the reader may do with it, and the people that it mentions. */
  async function threadResponse(event: H3Event, who: CommentsCaller, thread: CommentThread | null, extra: Record<string, unknown> = {}): Promise<Response> {
    if (!thread) return json({ data: null, ...extra })
    return json({ data: await permissions(event, who.user, thread), people: await people(who.runtime, who.user, [thread]), ...extra })
  }

  /** Lists check `read` on the filter first, so a person who may not read gets `403`, not an empty list. */
  async function mayRead(who: CommentsCaller, subject: CommentSubject | undefined): Promise<void> {
    if (!await policyCan(who.runtime, { action: "read", user: who.user, ...(subject ? { subject } : {}) }, who.gate)) throw deniedError(who.runtime, "read", who.user, who.gate)
  }

  /** The list query of `GET /threads`: the filters of `comments.list` as search parameters. */
  function listQuery(url: URL): Result<CommentListQuery, "COMMENTS_INVALID_INPUT"> {
    const params = url.searchParams
    const number = (name: string) => params.has(name) ? Number(params.get(name)) : undefined
    const flag = (name: string) => params.has(name) ? params.get(name) === "true" || params.get(name) === "1" : undefined
    const page = params.get("page")
    const kind = params.get("subjectKind")
    const subjectId = params.get("subjectId")
    const state = params.get("status")
    const lte = number("revision")
    const beforeId = params.get("beforeId")
    const beforeUpdatedAt = number("beforeUpdatedAt")
    const parsed = v.safeParse(commentInputSchemas.list, {
      ...(page ? { subject: { kind: "page", id: normalizeCommentPage(page) } } : kind && subjectId ? { subject: { kind, id: subjectId } } : kind ? { subjectKind: kind } : {}),
      ...(state === "open" || state === "resolved" ? { status: state } : {}),
      ...(lte === undefined ? {} : { revision: { lte } }),
      ...(number("limit") === undefined ? {} : { limit: number("limit") }),
      ...(beforeId && beforeUpdatedAt !== undefined ? { before: { id: beforeId, updatedAt: beforeUpdatedAt } } : {}),
      ...(flag("mine") === undefined ? {} : { mine: flag("mine") }),
      ...(flag("mentions") === undefined ? {} : { mentions: flag("mentions") }),
    })
    return parsed.success ? [undefined, parsed.output] : [commentsErrors.COMMENTS_INVALID_INPUT({ issue: describeIssue(parsed.issues) }), undefined]
  }

  /** Checks the page context that the overlay read: same origin, same page. Keeps only the origin and the path. */
  function checkContext(request: Request, context: CommentContext, subject: CommentSubject): Result<CommentContext, "COMMENTS_INVALID_INPUT"> {
    if (subject.kind !== "page") return [commentsErrors.COMMENTS_INVALID_INPUT({ issue: "context: Only a page thread keeps the page context." }), undefined]
    const origin = forwardedRequestOrigin(request)
    let submitted: URL
    try {
      submitted = new URL(context.url)
    }
    catch {
      return [commentsErrors.COMMENTS_INVALID_INPUT({ issue: "context.url: Expected an absolute page URL." }), undefined]
    }
    if (submitted.origin !== origin || normalizeCommentPage(submitted.pathname) !== subject.id) {
      return [commentsErrors.COMMENTS_INVALID_INPUT({ issue: "context.url: Must match the request origin and thread page." }), undefined]
    }
    // Only the trusted origin and page are shared with thread readers, never query credentials or fragments.
    return [undefined, completeContext({ ...context, url: `${origin}${subject.id}` })]
  }

  async function fieldTarget(event: H3Event, address: string, subject?: CommentSubject): Promise<Result<{ collection: ContentCollectionLike, id: string, path: string[], document: ContentDocumentLike, author: CommentUser, user: CommentsUser | null }, "COMMENTS_CONTENT_MISSING" | "COMMENTS_FIELD_INVALID" | "COMMENTS_FIELD_FORBIDDEN" | "COMMENTS_FORBIDDEN" | "COMMENTS_POLICY_MISSING">> {
    if (!options.content) return [commentsErrors.COMMENTS_CONTENT_MISSING(), undefined]
    const [denied, allowed] = await access(event, "write", undefined, subject)
    if (denied) return [denied, undefined]
    const parsed = options.content.parseField(address)
    const collection = parsed && options.content.runtime.collections().find(candidate => candidate.name === parsed.collection)
    const id = collection?.kind === "singleton" ? collection.id : parsed?.id
    if (!parsed || !collection || !id) return [commentsErrors.COMMENTS_FIELD_INVALID({ field: address }), undefined]
    if (!allowed.author) return [commentsErrors.COMMENTS_FORBIDDEN({ action: "write" }), undefined]
    if (!await options.content.runtime.can({ user: allowed.user ?? undefined, collection: collection.name, action: "write", id })) {
      return [commentsErrors.COMMENTS_FIELD_FORBIDDEN({ field: address }), undefined]
    }
    const document = await collection.get(id, { ref: "draft" })
    if (!document) return [commentsErrors.COMMENTS_FIELD_INVALID({ field: address }), undefined]
    return [undefined, { collection, id, path: parsed.field.split("."), document, author: allowed.author, user: allowed.user }]
  }

  async function readField(event: H3Event, address: string, subject?: CommentSubject): Promise<Response> {
    const [error, target] = await fieldTarget(event, address, subject)
    if (error) return failure(error)
    const value = readPath(target.document.data, target.path)
    return json({
      data: {
        field: address,
        value: typeof value === "string" ? value : null,
        editable: typeof value === "string",
        digest: target.document.digest,
        collection: target.collection.name,
        id: target.id,
      },
    })
  }

  async function saveField(event: H3Event, subject?: CommentSubject): Promise<Response> {
    const parsed = v.safeParse(fieldBody, await readJson(event))
    if (!parsed.success) return invalid(parsed.issues)
    const [error, target] = await fieldTarget(event, parsed.output.field, subject)
    if (error) return failure(error)
    if (typeof readPath(target.document.data, target.path) !== "string") return failure(commentsErrors.COMMENTS_FIELD_NOT_EDITABLE({ field: parsed.output.field }))
    if (target.document.digest !== parsed.output.ifDigest) return failure(commentsErrors.COMMENTS_FIELD_CONFLICT({ field: parsed.output.field }))
    const grant = fieldEditGrant.issue({ collection: target.collection, id: target.id, field: parsed.output.field, user: target.author })
    return await writeField(grant, target, parsed.output)
  }

  /** Saves one field as a new draft. It needs the grant that `saveField` issues after `authorize` and `content.can()`. */
  async function writeField(
    grant: ReturnType<typeof fieldEditGrant.issue>,
    target: { path: string[], document: ContentDocumentLike },
    input: { value: string, ifDigest: string },
  ): Promise<Response> {
    const { collection, id, field, user } = fieldEditGrant.consume(grant)
    try {
      const saved = await collection.save(id, {
        data: writePath(target.document.data, target.path, input.value),
        ...(target.document.body === undefined || collection.format !== "markdown" ? {} : { body: target.document.body }),
      }, {
        ifDigest: input.ifDigest,
        message: `Edit ${target.path.join(".")} on the page`,
        metadata: { source: "comments", author: user.name ?? user.id },
      })
      return json({ data: { field, value: input.value, digest: saved.digest } })
    }
    catch (cause) {
      const code = errorCode(cause)
      if (code === "WORKSPACE_CONFLICT") return failure(commentsErrors.COMMENTS_FIELD_CONFLICT({ field }))
      if (code === "CONTENT_LEASE_HELD") return failure(commentsErrors.COMMENTS_FIELD_LOCKED({ holder: leaseHolder(cause) }))
      throw cause
    }
  }

  async function handle(event: H3Event) {
    const request = requestOf(event)
    const response = await route(event, request).catch(diagnosticResponse)
    // A change starts its pull request sync. Hosts that end work with the response keep it running until it ends.
    if (request.method !== "GET" && comments.options.forge) resolveWaitUntil(event, { preferHost: true })?.(comments.flush())
    return response
  }

  return defineEventHandler((event) => {
    // Nitro's workerd dev server gives the Cloudflare bindings only with the request, so the database finds D1 there.
    const env = getCloudflareEnv(event, { fallback: false })
    return env ? runWithActiveCloudflareEnv(env, () => handle(event)) : handle(event)
  })

  async function route(event: H3Event, request: Request): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname.slice(url.pathname.indexOf(commentsRoute) + commentsRoute.length).replace(/\/+$/, "") || "/"
    const parts = path.split("/").filter(Boolean)
    const method = request.method
    const page = url.searchParams.get("page")
    const subjectKind = url.searchParams.get("subjectKind")
    const subjectId = url.searchParams.get("subjectId")
    const subject: CommentSubject | undefined = page ? { kind: "page", id: normalizeCommentPage(page) } : subjectKind && subjectId ? { kind: subjectKind, id: subjectId } : undefined
    if (method !== "GET" && !sameOrigin(request)) return json({ error: { code: "COMMENTS_FORBIDDEN", why: "Comments requests must come from the site's own pages." } }, { status: 403 })

    if (method === "GET" && path === "/session") return await session(event, subject)
    // Better Auth checks the origin of its own POST routes.
    if (path.startsWith("/auth/") && options.githubLogin) return await options.githubLogin.handle(event, path)

    if (path === "/threads") {
      if (method === "GET") {
        const [invalidQuery, query] = listQuery(url)
        if (invalidQuery) return failure(invalidQuery)
        return await act(event, "read", async (who) => {
          await mayRead(who, query.subject)
          return await commentActions.list(query, who)
        }, async (threads, who) => json({ data: await Promise.all(threads.map(thread => permissions(event, who.user, thread))), people: await people(who.runtime, who.user, threads) }))
      }
      if (method === "POST") {
        const parsed = v.safeParse(createBody, await readJson(event))
        if (!parsed.success) return invalid(parsed.issues)
        const { page, subject: given, context, anchor, ...input } = parsed.output
        const target = given ?? (page === undefined ? undefined : { kind: "page", id: normalizeCommentPage(page) })
        if (!target) return failure(commentsErrors.COMMENTS_INVALID_INPUT({ issue: "subject: Give a subject, or a page." }))
        const [badContext, checked] = context ? checkContext(request, context, target) : [undefined, undefined]
        if (badContext) return failure(badContext)
        return await act(event, "write", who => commentActions.create({ ...input, anchor: anchor ?? { kind: "page" }, subject: target, ...(checked ? { context: checked } : {}) }, who), (thread, who) => threadResponse(event, who, thread))
      }
    }

    if (parts[0] === "scopes" && parts[1] && parts[2] === "threads" && parts[3] && !parts[4] && method === "GET") {
      const parsed = v.safeParse(commentInputSchemas.get, { scope: decodeURIComponent(parts[1]), n: Number(parts[3]) })
      if (!parsed.success) return invalid(parsed.issues)
      return await act(event, "read", who => commentActions.get(parsed.output, who), (thread, who) => threadResponse(event, who, thread))
    }

    if (parts[0] === "threads" && parts[1]) {
      const threadId = decodeURIComponent(parts[1])
      const action = parts[2]
      const messageId = parts[3] ? decodeURIComponent(parts[3]) : undefined
      if (method === "GET" && !action) return await act(event, "read", who => commentActions.get({ id: threadId }, who), (thread, who) => threadResponse(event, who, thread))
      if (method === "POST" && action === "comments" && !messageId) {
        const parsed = v.safeParse(replyBody, await readJson(event))
        if (!parsed.success) return invalid(parsed.issues)
        // The overlay reads the message as `data`; other clients read the thread as `thread`.
        return await act(event, "write", who => commentActions.reply({ ...parsed.output, threadId }, who), async ({ message, thread }, who) => json({
          data: message,
          thread: await permissions(event, who.user, thread),
          people: await people(who.runtime, who.user, [thread]),
        }))
      }
      if (method === "PATCH" && action === "comments" && messageId) {
        const parsed = v.safeParse(editBody, await readJson(event))
        if (!parsed.success) return invalid(parsed.issues)
        return await act(event, "write", who => commentActions.edit({ ...parsed.output, threadId, messageId }, who), (thread, who) => threadResponse(event, who, thread))
      }
      if (method === "POST" && (action === "resolve" || action === "reopen") && !messageId) {
        return await act(event, "resolve", who => commentActions.setStatus({ threadId }, who, action === "resolve" ? "resolved" : "open"), (thread, who) => threadResponse(event, who, thread))
      }
      if (method === "DELETE" && (action === "comments" ? messageId : !action)) {
        // Authors delete their own messages with `write`; deleting anything else needs `delete`, which the action checks.
        return await act(event, "delete", who => commentActions.delete({ threadId, ...(messageId ? { messageId } : {}) }, who), (thread, who) => threadResponse(event, who, thread))
      }
    }

    if (path === "/attachments" && method === "POST") {
      const parsed = v.safeParse(commentInputSchemas.upload, await readJson(event))
      if (!parsed.success) return invalid(parsed.issues)
      return await act(event, "write", who => commentActions.upload(parsed.output, who), attachment => json({ data: attachment }))
    }

    if (parts[0] === "attachments" && parts.length > 1 && method === "GET") {
      const key = parts.slice(1).map(part => decodeURIComponent(part)).join("/")
      return await act(event, "read", who => commentActions.attachment({ key }, who), file => new Response(file.data.stream(), { headers: attachmentHeaders(file) }))
    }

    if (method === "GET" && path === "/people") {
      const threadId = url.searchParams.get("thread")
      const [missing, current] = threadId ? await comments.get(threadId) : [undefined, undefined]
      if (missing) return failure(missing)
      const target = current?.subject ?? subject
      const [denied, allowed] = await access(event, "read", current, target)
      if (denied) return failure(denied)
      const limit = Number(url.searchParams.get("limit") ?? 20)
      return respond(await comments.people({ query: url.searchParams.get("q") ?? "", user: allowed.user, gate, ...(Number.isFinite(limit) ? { limit } : {}), ...(current ? { thread: current } : {}), ...(target ? { subject: target } : {}) }))
    }

    if (path === "/fields") {
      if (!subject || subject.kind !== "page") return failure(commentsErrors.COMMENTS_INVALID_INPUT({ issue: "page: Give the current page for a field edit." }))
      if (method === "GET") return await readField(event, url.searchParams.get("field") ?? "", subject)
      if (method === "POST") return await saveField(event, subject)
    }

    return json({ error: { code: "COMMENTS_NOT_FOUND", why: `No Comments route ${method} ${path}.` } }, { status: 404 })
  }
}
