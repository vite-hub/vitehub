import { resolveWaitUntil } from "@vite-hub/internal/runtime/cloudflare-env"
import { forwardedRequestOrigin } from "@vite-hub/internal/runtime/request-origin"
import { defineGrant } from "@vite-hub/runtime/internal/grant"
import { defineHandler } from "h3"
import * as v from "valibot"

import { commentsErrors } from "../errors.ts"
import { authorOf, guestFromHeaders } from "../identity.ts"
import { commentsHintCookie, commentsPageScope, commentsRoute, normalizeCommentPage } from "../page.ts"
import { anchorSchema, bodySchema, contextSchema, describeIssue, mentionsSchema, pageSchema } from "../schema.ts"

import type { Result, ResultError } from "@vite-hub/runtime"
import type { H3Event } from "h3"
import type { Comments } from "../index.ts"
import type { CommentAuthor, CommentContext, CommentsAction, CommentsUser, CommentThread } from "../types.ts"

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

export interface CommentsHandlerOptions {
  comments: Comments
  /**
   * Reads the user of a request: the Console user when the app has the Console, else the ViteHub Auth session user.
   * Omitted when the app has neither.
   */
  session?: (event: H3Event) => Promise<CommentsUser | null | undefined>
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

const hintMaxAge = 60 * 60 * 24 * 30

/** Issued by `access()` after `authorize` allows an action, for that action on that thread. Each write needs one. */
const actionGrant = defineGrant("vitehub.comments.action", (input: { action: CommentsAction, threadId: string | undefined }) => Object.freeze({ ...input }))

type ActionGrant = ReturnType<typeof actionGrant.issue>

/** Spends a grant for one of `actions` on `threadId`. A grant for another action or thread is a bug, so it throws. */
function spend(grant: ActionGrant, actions: readonly CommentsAction[], threadId?: string): void {
  const allowed = actionGrant.consume(grant)
  if (!actions.includes(allowed.action) || allowed.threadId !== threadId) {
    throw new TypeError(`[vitehub] A Comments write for ${actions.join(" or ")} ran with the grant of ${allowed.action}.`)
  }
}

const fieldEditGrant = defineGrant("vitehub.comments.field-edit", (input: { collection: ContentCollectionLike, id: string, field: string, user: CommentAuthor }) => input)

const createBody = v.object({ page: pageSchema, anchor: anchorSchema, context: v.optional(contextSchema), body: bodySchema, mentions: mentionsSchema })
const replyBody = v.object({ body: bodySchema, mentions: mentionsSchema })
const fieldBody = v.object({ field: v.pipe(v.string(), v.maxLength(512)), value: v.pipe(v.string(), v.maxLength(20_000)), ifDigest: v.string() })

function status(code: string): number {
  switch (code) {
    case "COMMENTS_NOT_FOUND":
    case "COMMENTS_CONTENT_MISSING":
      return 404
    case "COMMENTS_FORBIDDEN":
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
export function createCommentsHandler(options: CommentsHandlerOptions): ReturnType<typeof defineHandler> {
  const { comments } = options

  async function resolveUser(event: H3Event): Promise<CommentsUser | null> {
    if (comments.options.identify) return await comments.options.identify({ event }) ?? null
    if (!options.session) return null
    try {
      return await options.session(event) ?? null
    }
    catch {
      return null
    }
  }

  async function access(event: H3Event, action: CommentsAction, thread?: CommentThread): Promise<Result<{ user: CommentsUser | null, author: CommentAuthor | undefined, grant: ActionGrant }, "COMMENTS_FORBIDDEN">> {
    const user = await resolveUser(event)
    if (!await comments.can({ user, action, thread })) return [commentsErrors.COMMENTS_FORBIDDEN({ action }), undefined]
    // A user writes as itself; without one, a guest that named itself, when the policy lets anonymous people act.
    const author = user ? authorOf(user) : guestFromHeaders(event.req.headers)
    return [undefined, { user, author, grant: actionGrant.issue({ action, threadId: thread?.id }) }]
  }

  /** The writes of this API. Each one needs the grant of the `access()` check that allowed it. */
  const writes = {
    create: (grant: ActionGrant, input: Parameters<Comments["create"]>[0]) => {
      spend(grant, ["comment"])
      return comments.create(input)
    },
    reply: (grant: ActionGrant, threadId: string, input: Parameters<Comments["reply"]>[1]) => {
      spend(grant, ["comment"], threadId)
      return comments.reply(threadId, input)
    },
    resolve: (grant: ActionGrant, threadId: string, by: CommentAuthor) => {
      spend(grant, ["resolve"], threadId)
      return comments.resolve(threadId, { by })
    },
    reopen: (grant: ActionGrant, threadId: string) => {
      spend(grant, ["resolve"], threadId)
      return comments.reopen(threadId)
    },
    remove: (grant: ActionGrant, threadId: string) => {
      spend(grant, ["resolve"], threadId)
      return comments.remove(threadId)
    },
    // Authors delete their own comments with `comment`; people who may resolve delete any with `resolve`.
    removeComment: (grant: ActionGrant, threadId: string, commentId: string) => {
      spend(grant, ["comment", "resolve"], threadId)
      return comments.removeComment(commentId)
    },
  }

  /** Adds the build, and the source files of each component, to the context that the overlay read. */
  function completeContext(context: CommentContext): CommentContext {
    // Keep the app's own components: names without a project file, such as RouterView or a UI library's, are noise.
    // Without a file map, or when none matches, keep the three innermost names.
    const named = context.components?.map((component) => {
      const files = options.components?.[component.name]
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
      return await event.req.json()
    }
    catch {
      return undefined
    }
  }

  function invalid(issues: readonly v.BaseIssue<unknown>[]): Response {
    return failure(commentsErrors.COMMENTS_INVALID_INPUT({ issue: describeIssue(issues) }))
  }

  async function session(event: H3Event): Promise<Response> {
    const user = await resolveUser(event)
    const [read, comment, resolve] = await Promise.all((["read", "comment", "resolve"] as const).map(action => comments.can({ user, action })))
    const headers = new Headers()
    headers.append("set-cookie", read
      ? `${commentsHintCookie}=1; Path=/; Max-Age=${hintMaxAge}; SameSite=Lax`
      : `${commentsHintCookie}=; Path=/; Max-Age=0; SameSite=Lax`)
    return json({
      data: {
        user: user ? authorOf(user) : null,
        can: { read, comment, resolve },
        realtime: options.realtime,
        content: Boolean(options.content),
      },
    }, { headers })
  }

  /** A page thread. Threads of other scopes belong to the app's own UI, so this API does not show or change them. */
  async function thread(id: string): Promise<Result<CommentThread, "COMMENTS_NOT_FOUND" | "COMMENTS_NOT_INSTALLED">> {
    const [error, found] = await comments.get(id)
    if (error) return [error, undefined]
    return found.scope === commentsPageScope ? [undefined, found] : [commentsErrors.COMMENTS_NOT_FOUND({ id }), undefined]
  }

  async function fieldTarget(event: H3Event, address: string): Promise<Result<{ collection: ContentCollectionLike, id: string, path: string[], document: ContentDocumentLike, author: CommentAuthor, user: CommentsUser | null }, "COMMENTS_CONTENT_MISSING" | "COMMENTS_FIELD_INVALID" | "COMMENTS_FIELD_FORBIDDEN" | "COMMENTS_FORBIDDEN">> {
    if (!options.content) return [commentsErrors.COMMENTS_CONTENT_MISSING(), undefined]
    const [denied, allowed] = await access(event, "comment")
    if (denied) return [denied, undefined]
    const parsed = options.content.parseField(address)
    const collection = parsed && options.content.runtime.collections().find(candidate => candidate.name === parsed.collection)
    const id = collection?.kind === "singleton" ? collection.id : parsed?.id
    if (!parsed || !collection || !id) return [commentsErrors.COMMENTS_FIELD_INVALID({ field: address }), undefined]
    if (!allowed.author) return [commentsErrors.COMMENTS_FORBIDDEN({ action: "comment" }), undefined]
    if (!await options.content.runtime.can({ user: allowed.user ?? undefined, collection: collection.name, action: "write", id })) {
      return [commentsErrors.COMMENTS_FIELD_FORBIDDEN({ field: address }), undefined]
    }
    const document = await collection.get(id, { ref: "draft" })
    if (!document) return [commentsErrors.COMMENTS_FIELD_INVALID({ field: address }), undefined]
    return [undefined, { collection, id, path: parsed.field.split("."), document, author: allowed.author, user: allowed.user }]
  }

  async function readField(event: H3Event, address: string): Promise<Response> {
    const [error, target] = await fieldTarget(event, address)
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

  async function saveField(event: H3Event): Promise<Response> {
    const parsed = v.safeParse(fieldBody, await readJson(event))
    if (!parsed.success) return invalid(parsed.issues)
    const [error, target] = await fieldTarget(event, parsed.output.field)
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
        metadata: { source: "comments", author: user.name },
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

  return defineHandler(async (event) => {
    const response = await route(event)
    // A change starts its pull request sync. Hosts that end work with the response keep it running until it ends.
    if (event.req.method !== "GET" && comments.options.forge) resolveWaitUntil(event, { preferHost: true })?.(comments.flush())
    return response
  })

  async function route(event: H3Event): Promise<Response> {
    const request = event.req
    const url = new URL(request.url)
    const path = url.pathname.slice(url.pathname.indexOf(commentsRoute) + commentsRoute.length).replace(/\/+$/, "") || "/"
    const parts = path.split("/").filter(Boolean)
    const method = request.method
    if (method !== "GET" && !sameOrigin(request)) return json({ error: { code: "COMMENTS_FORBIDDEN", why: "Comments requests must come from the site's own pages." } }, { status: 403 })

    if (method === "GET" && path === "/session") return await session(event)

    if (path === "/threads") {
      if (method === "GET") {
        const [denied] = await access(event, "read")
        if (denied) return failure(denied)
        const page = url.searchParams.get("page")
        const state = url.searchParams.get("status")
        return respond(await comments.list({
          scope: commentsPageScope,
          page: page ? normalizeCommentPage(page) : undefined,
          status: state === "open" || state === "resolved" ? state : undefined,
        }))
      }
      if (method === "POST") {
        const parsed = v.safeParse(createBody, await readJson(event))
        if (!parsed.success) return invalid(parsed.issues)
        const [denied, allowed] = await access(event, "comment")
        if (denied) return failure(denied)
        if (!allowed.author) return failure(commentsErrors.COMMENTS_FORBIDDEN({ action: "comment" }))
        const { context, ...input } = parsed.output
        return respond(await writes.create(allowed.grant, { ...input, ...(context ? { context: completeContext(context) } : {}), author: allowed.author }))
      }
    }

    if (parts[0] === "threads" && parts[1]) {
      const id = decodeURIComponent(parts[1])
      const [missing, current] = await thread(id)
      if (missing) return failure(missing)
      const action = parts[2]
      if (method === "POST" && action === "comments") {
        const parsed = v.safeParse(replyBody, await readJson(event))
        if (!parsed.success) return invalid(parsed.issues)
        const [denied, allowed] = await access(event, "comment", current)
        if (denied) return failure(denied)
        if (!allowed.author) return failure(commentsErrors.COMMENTS_FORBIDDEN({ action: "comment" }))
        return respond(await writes.reply(allowed.grant, id, { ...parsed.output, author: allowed.author }))
      }
      if (method === "POST" && (action === "resolve" || action === "reopen")) {
        const [denied, allowed] = await access(event, "resolve", current)
        if (denied) return failure(denied)
        if (action === "reopen") return respond(await writes.reopen(allowed.grant, id))
        return respond(await writes.resolve(allowed.grant, id, allowed.author ?? { id: "anonymous", name: "Someone" }))
      }
      if (method === "DELETE" && action === "comments" && parts[3]) {
        const commentId = decodeURIComponent(parts[3])
        const comment = current.comments.find(candidate => candidate.id === commentId)
        if (!comment) return failure(commentsErrors.COMMENTS_NOT_FOUND({ id: commentId }))
        const [denied, allowed] = await access(event, "comment", current)
        if (denied) return failure(denied)
        if (comment.author.id === allowed.author?.id) return respond(await writes.removeComment(allowed.grant, id, commentId))
        // Someone else's comment: only people who may resolve delete it.
        const [cannot, resolver] = await access(event, "resolve", current)
        if (cannot) return failure(cannot)
        return respond(await writes.removeComment(resolver.grant, id, commentId))
      }
      if (method === "DELETE" && !action) {
        const [denied, allowed] = await access(event, "resolve", current)
        if (denied) return failure(denied)
        return respond(await writes.remove(allowed.grant, id))
      }
    }

    if (method === "GET" && path === "/people") {
      const [denied, allowed] = await access(event, "read")
      if (denied) return failure(denied)
      return respond(await comments.people({ query: url.searchParams.get("q") ?? "", user: allowed.user }))
    }

    if (path === "/fields") {
      if (method === "GET") return await readField(event, url.searchParams.get("field") ?? "")
      if (method === "POST") return await saveField(event)
    }

    return json({ error: { code: "COMMENTS_NOT_FOUND", why: `No Comments route ${method} ${path}.` } }, { status: 404 })
  }
}
