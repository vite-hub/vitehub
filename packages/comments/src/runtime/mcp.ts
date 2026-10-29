import { toEventRequest } from "@vite-hub/internal/runtime/h3-v1-request"
import { defineGrant } from "@vite-hub/runtime/internal/grant"

import { describeCommentContext } from "../context.ts"
import { commentsErrors } from "../errors.ts"
import { authorOf, guestFromHeaders, text } from "../identity.ts"
import { commentsPageScope, normalizeCommentPage } from "../page.ts"
import { resolveCommentsUser } from "./session.ts"

import type { ViteHubMcpTool, ViteHubMcpToolContext, ViteHubMcpToolResult } from "@vite-hub/internal/runtime/mcp-tools"
import type { H3Event } from "h3"
import type { Comments } from "../index.ts"
import type { CommentsAction, CommentsUser, CommentThread } from "../types.ts"
import type { CommentsSessionOptions } from "./session.ts"

/** A user supplied by an app's own MCP server. Missing identities remain anonymous. */
function commentsUser(user: Record<string, unknown> | null): CommentsUser | null {
  const id = text(user?.id) ?? text(user?.email)
  return user && id ? { ...user, id } : null
}

function guestFor(context: ViteHubMcpToolContext) {
  return context.event instanceof Object ? guestFromHeaders(toEventRequest(context.event).headers) : undefined
}

function failure(why: string): ViteHubMcpToolResult {
  return { text: why, isError: true }
}

/** The catalog's COMMENTS_FORBIDDEN, as the overlay API answers it. */
function forbidden(action: CommentsAction): ViteHubMcpToolResult {
  const error = commentsErrors.COMMENTS_FORBIDDEN({ action })
  return failure(`${error.why} ${error.fix}`)
}

/** Issued after `authorize` allows a tool's action on a thread. The reply and resolve writes need it. */
const toolGrant = defineGrant("vitehub.comments.mcp-action", (input: { action: CommentsAction, threadId: string }) => Object.freeze({ ...input }))

type ToolGrant = ReturnType<typeof toolGrant.issue>

function spend(grant: ToolGrant, action: CommentsAction, threadId: string): void {
  const allowed = toolGrant.consume(grant)
  if (allowed.action !== action || allowed.threadId !== threadId) throw new TypeError(`[vitehub] A Comments tool wrote ${action} with the grant of ${allowed.action}.`)
}

/** One thread as text an Agent reads: where it is, what the person saw, and the conversation. */
function describeThread(thread: CommentThread): string {
  const lines = [
    `Thread #${thread.number} ${thread.id} (${thread.status}) on ${thread.page}`,
    ...(thread.anchor ? [`Anchor: ${thread.anchor.field ? `Content field ${thread.anchor.field}` : thread.anchor.label} (${thread.anchor.selector})`] : []),
    ...describeCommentContext(thread.context).map(field => `${field.label}: ${field.value}`),
    "",
    ...thread.comments.map(comment => `${comment.author.name}${comment.author.guest ? " (guest)" : ""}, ${comment.createdAt}: ${comment.body}`),
  ]
  if (thread.resolvedBy) lines.push("", `Resolved by ${thread.resolvedBy.name} at ${thread.resolvedAt}`)
  return lines.join("\n")
}

function summary(thread: CommentThread): Record<string, unknown> {
  return {
    id: thread.id,
    page: thread.page,
    status: thread.status,
    comment: thread.comments[0]?.body ?? "",
    author: thread.createdBy.name,
    replies: Math.max(0, thread.comments.length - 1),
    components: thread.context?.components?.map(component => component.name) ?? [],
    updatedAt: thread.updatedAt,
  }
}

/**
 * The Comments tools of the ViteHub MCP server. Each call resolves the Comments identity and checks `authorize`,
 * as the overlay does. Pass the overlay's session reader; an app's own MCP server can instead supply `context.user`.
 * With a request event, Console denial is final; otherwise `identify` takes precedence over the session user.
 * Without an event, the tools use the checked `context.user` directly. Replies and resolves show that user as the author.
 */
export function commentsMcpTools(comments: Comments, options: CommentsSessionOptions = {}): ViteHubMcpTool[] {
  async function userFor(context: ViteHubMcpToolContext, action: CommentsAction): Promise<CommentsUser | null | false> {
    if (context.event === undefined || context.event === null) return commentsUser(context.user)
    // SAFETY: The MCP transport passes its request event to owner identity readers.
    return resolveCommentsUser(comments, context.event as H3Event, { ...options, session: options.session ?? (async () => commentsUser(context.user)) }, action)
  }

  async function threadFor(input: Record<string, unknown>, user: CommentsUser | null | false, action: CommentsAction): Promise<{ thread: CommentThread, grant: ToolGrant } | ViteHubMcpToolResult> {
    if (user === false) return forbidden(action)
    const id = text(input.id)
    if (!id) return failure("Give the thread id from comments_list_threads.")
    const [error, thread] = await comments.get(id)
    if (error) return failure(error.why)
    if (thread.scope !== commentsPageScope) return failure(`No thread ${id} on the app's pages.`)
    if (!await comments.can({ user, action, thread })) return forbidden(action)
    return { thread, grant: toolGrant.issue({ action, threadId: thread.id }) }
  }

  return [
    {
      name: "comments_list_threads",
      title: "List comment threads",
      description: "List the comment threads that the team left on the app's pages, newest activity first. Each has the page, the first comment, and the Vue components where it was left. Read one with comments_get_thread; after you change the code, reply with comments_reply and resolve it with comments_resolve_thread.",
      section: "comments",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        properties: {
          page: { type: "string", description: "Only threads of this pathname, such as /pricing." },
          status: { type: "string", enum: ["open", "resolved"], description: "Default: open." },
          search: { type: "string", description: "Only threads whose comments contain this text." },
          limit: { type: "integer", minimum: 1, maximum: 100, description: "Default 25." },
        },
        additionalProperties: false,
      },
      async call(input, context) {
        const user = await userFor(context, "read")
        if (user === false || !await comments.can({ user, action: "read" })) return forbidden("read")
        const status = input.status === "resolved" ? "resolved" : "open"
        const page = text(input.page)
        const search = text(input.search)?.toLowerCase()
        const limit = Math.min(Math.max(Number(input.limit) || 25, 1), 100)
        const [error, threads] = await comments.list({ scope: commentsPageScope, status, limit: search ? 500 : limit, ...(page ? { page: normalizeCommentPage(page) } : {}) })
        if (error) return failure(error.why)
        const found = (search ? threads.filter(thread => thread.comments.some(comment => comment.body.toLowerCase().includes(search))) : threads).slice(0, limit)
        const line = (thread: CommentThread) => {
          const components = thread.context?.components?.map(component => component.name) ?? []
          const replies = Math.max(0, thread.comments.length - 1)
          return `- ${thread.id} ${thread.page}: ${(thread.comments[0]?.body ?? "").slice(0, 120)} (${thread.createdBy.name}, ${replies} replies${components.length ? `, in ${components.join(" › ")}` : ""})`
        }
        return {
          text: found.length ? found.map(line).join("\n") : `No ${status} threads.`,
          structured: { threads: found.map(summary) },
        }
      },
    },
    {
      name: "comments_get_thread",
      title: "Read a comment thread",
      description: "Read one thread: its page, the element and Vue components with their source files, the browser and build, and every comment. Use it to find the code to change.",
      section: "comments",
      annotations: { readOnlyHint: true },
      inputSchema: { type: "object", properties: { id: { type: "string", description: "The thread id." } }, required: ["id"], additionalProperties: false },
      async call(input, context) {
        const found = await threadFor(input, await userFor(context, "read"), "read")
        if (!("thread" in found)) return found
        const { thread } = found
        return { text: describeThread(thread), structured: { thread: { ...thread } } }
      },
    },
    {
      name: "comments_reply",
      title: "Reply to a comment thread",
      description: "Reply to an open thread, for example to say what you changed. The reply shows the signed-in Console user as its author.",
      section: "comments",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "The thread id." }, body: { type: "string", description: "Plain text, at most 4,000 characters." } },
        required: ["id", "body"],
        additionalProperties: false,
      },
      async call(input, context) {
        const user = await userFor(context, "comment")
        const found = await threadFor(input, user, "comment")
        if (!("thread" in found)) return found
        const { thread, grant } = found
        const author = user ? authorOf(user) : guestFor(context)
        if (!author) return forbidden("comment")
        spend(grant, "comment", thread.id)
        const [error, comment] = await comments.reply(thread.id, { body: text(input.body) ?? "", author })
        if (error) return failure(error.why)
        return { text: `Replied to thread ${thread.id}.`, structured: { comment: { ...comment } } }
      },
    },
    {
      name: "comments_resolve_thread",
      title: "Resolve or reopen a comment thread",
      description: "Resolve a thread after the change it asks for is done, or reopen it. Resolved threads leave the page.",
      section: "comments",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "The thread id." }, resolved: { type: "boolean", description: "Default true. False reopens the thread." } },
        required: ["id"],
        additionalProperties: false,
      },
      async call(input, context) {
        const user = await userFor(context, "resolve")
        const found = await threadFor(input, user, "resolve")
        if (!("thread" in found)) return found
        const { thread, grant } = found
        spend(grant, "resolve", thread.id)
        const author = user ? authorOf(user) : guestFor(context) ?? { id: "anonymous", name: "Someone" }
        const [error, updated] = input.resolved === false ? await comments.reopen(thread.id) : await comments.resolve(thread.id, { by: author })
        if (error) return failure(error.why)
        return { text: `Thread ${updated.id} is ${updated.status}.`, structured: { thread: summary(updated) } }
      },
    },
  ]
}
