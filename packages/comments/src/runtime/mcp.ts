import { getStandardContext } from "@vite-hub/runtime/internal/h3"
import { defineGrant } from "@vite-hub/runtime/internal/grant"

import { commentsErrors } from "../errors.ts"
import { authorOf, guestFromHeaders, text } from "../identity.ts"
import { commentsPageScope, normalizeCommentPage } from "../page.ts"
import { commentThreadSummary as summary, commentThreadsText, describeCommentThread as describeThread, hiddenThreadsNote } from "../thread-text.ts"

import type { ViteHubMcpTool, ViteHubMcpToolContext, ViteHubMcpToolResult } from "@vite-hub/internal/runtime/mcp-tools"
import type { Comments } from "../index.ts"
import type { CommentAction, CommentListCursor, CommentsRequestEvent, CommentsUser, CommentThread } from "../types.ts"
import type { CommentsIdentity } from "./session.ts"

export interface CommentsMcpToolsOptions {
  /**
   * The caller passed the Console access check of the `comments` section, as the comment operations do. `authorize`
   * then gets `console: true`. Without `identify`, the default policy also trusts `context.user`, as it does for the
   * comment operations. Default `false`.
   */
  console?: boolean
}

/** A user supplied by an app's own MCP server. Missing identities remain anonymous. */
function commentsUser(user: Record<string, unknown> | null): CommentsUser | null {
  const id = text(user?.id) ?? text(user?.email)
  return user && id ? { ...user, id } : null
}

function guestFor(context: ViteHubMcpToolContext) {
  return context.event ? guestFromHeaders(context.event["~standard"].req.headers) : undefined
}

function failure(why: string): ViteHubMcpToolResult {
  return { text: why, isError: true }
}

/** The catalog's COMMENTS_FORBIDDEN, as the overlay API answers it. */
function forbidden(action: CommentAction): ViteHubMcpToolResult {
  const error = commentsErrors.COMMENTS_FORBIDDEN({ action })
  return failure(`${error.why} ${error.fix}`)
}

/** Issued after `authorize` allows a tool's action on a thread. The reply and resolve writes need it. */
const toolGrant = defineGrant("vitehub.comments.mcp-action", (input: { action: CommentAction, threadId: string }) => Object.freeze({ ...input }))

type ToolGrant = ReturnType<typeof toolGrant.issue>

function spend(grant: ToolGrant, action: CommentAction, threadId: string): void {
  const allowed = toolGrant.consume(grant)
  if (allowed.action !== action || allowed.threadId !== threadId) throw new TypeError(`[vitehub] A Comments tool wrote ${action} with the grant of ${allowed.action}.`)
}

/**
 * The Comments tools for an app's own MCP server. Each call resolves the Comments identity and checks `authorize`,
 * as the overlay does. The server supplies the checked `context.user`. ViteHub MCP offers the comment operations instead.
 * With `identify` and a request event, `identify` names the user, as in the overlay API. Otherwise the tools use the
 * checked `context.user`. Replies and resolves show that user as the author.
 */
export function commentsMcpTools(comments: Comments, options: CommentsMcpToolsOptions = {}): ViteHubMcpTool[] {
  const admitted = options.console === true

  async function identityFor(context: ViteHubMcpToolContext): Promise<CommentsIdentity> {
    const { identify } = comments.options
    if (identify && context.event) {
      // SAFETY: The MCP transport passes its request event, or its Request, to owner identity readers.
      const event = context.event as CommentsRequestEvent
      // `identify` reads `event["~standard"]`. Set it when the transport did not.
      getStandardContext(event)
      return { user: await identify({ event }) ?? null, gate: {} }
    }
    return { user: commentsUser(context.user), gate: options.console && !identify ? { console: true } : {} }
  }

  async function threadFor(input: Record<string, unknown>, { user, gate }: CommentsIdentity, action: CommentAction): Promise<{ thread: CommentThread, grant: ToolGrant } | ViteHubMcpToolResult> {
    const id = text(input.id)
    if (!id) return failure("Give the thread id from comments_list_threads.")
    const [error, thread] = await comments.get(id)
    if (error) return failure(error.why)
    if (thread.subject.kind !== "page") return failure(`No thread ${id} on the app's pages.`)
    if (!await comments.can({ user, action, thread, console: admitted }, gate)) return forbidden(action)
    return { thread, grant: toolGrant.issue({ action, threadId: thread.id }) }
  }

  return [
    {
      name: "comments_list_threads",
      title: "List ViteHub Comments threads",
      description: "ViteHub Comments: threads people left with the Comments toolbar on the app's pages, newest activity first. Each line has the page, what the comment points at, the time, the first comment, and the Vue component. Says how many threads `authorize` hid. Read one with comments_get_thread. After you change the code, reply with comments_reply and resolve it with comments_resolve_thread.",
      section: "comments",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        properties: {
          page: { type: "string", description: "Only threads of this page: a path such as /pricing, or a full URL of the page." },
          status: { type: "string", enum: ["open", "resolved"], description: "Default: open." },
          search: { type: "string", description: "Only threads whose comments contain this text." },
          limit: { type: "integer", minimum: 1, maximum: 100, description: "Default 25." },
        },
        additionalProperties: false,
      },
      async call(input, context) {
        const identity = await identityFor(context)
        const { user, gate } = identity
        const page = text(input.page)
        const subject = page ? { kind: "page", id: normalizeCommentPage(page) } : undefined
        if (!await comments.can({ user, action: "read", console: admitted, ...(subject ? { subject } : {}) }, gate)) return forbidden("read")
        const status = input.status === "resolved" ? "resolved" : "open"
        const search = text(input.search)?.toLowerCase()
        const limit = Math.min(Math.max(Number(input.limit) || 25, 1), 100)
        const found: CommentThread[] = []
        let hidden = 0
        const batchSize = search ? 500 : limit
        let before: CommentListCursor | undefined
        while (found.length < limit) {
          const [error, listed] = await comments.list({ scope: commentsPageScope, subjectKind: "page", status, limit: batchSize, ...(subject ? { subject } : {}), ...(before ? { before } : {}) })
          if (error) return failure(error.why)
          for (const thread of listed) {
            if (!await comments.can({ user, action: "read", thread, console: admitted }, gate)) hidden++
            else if (!search || thread.messages.some(message => message.body.toLowerCase().includes(search))) found.push(thread)
            if (found.length === limit) break
          }
          if (listed.length < batchSize) break
          const last = listed.at(-1)!
          before = { id: last.id, updatedAt: last.updatedAt }
        }
        const threads = found.map(summary)
        const note = hiddenThreadsNote(hidden, { authorize: Boolean(comments.options.authorize), identify: Boolean(comments.options.identify), user: user !== null, console: admitted })
        return {
          text: commentThreadsText(threads, status, note),
          structured: { threads: threads.map(thread => ({ ...thread })), hidden },
        }
      },
    },
    {
      name: "comments_get_thread",
      title: "Read a ViteHub Comments thread",
      description: "ViteHub Comments: read one thread that people left with the Comments toolbar: its page, the element and Vue components with their source files, the browser and build, and every comment with its time. Use it to find the code to change.",
      section: "comments",
      annotations: { readOnlyHint: true },
      inputSchema: { type: "object", properties: { id: { type: "string", description: "The thread id." } }, required: ["id"], additionalProperties: false },
      async call(input, context) {
        const identity = await identityFor(context)
        const found = await threadFor(input, identity, "read")
        if (!("thread" in found)) return found
        const { thread } = found
        return { text: describeThread(thread), structured: { thread: { ...thread } } }
      },
    },
    {
      name: "comments_reply",
      title: "Reply to a ViteHub Comments thread",
      description: "ViteHub Comments: reply to a thread that people left with the Comments toolbar, for example to say what you changed. The reply shows the signed-in Console user as its author.",
      section: "comments",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "The thread id." }, body: { type: "string", description: "Markdown, at most 10,000 characters." } },
        required: ["id", "body"],
        additionalProperties: false,
      },
      async call(input, context) {
        const identity = await identityFor(context)
        const found = await threadFor(input, identity, "write")
        if (!("thread" in found)) return found
        const { thread, grant } = found
        const author = identity.user ? authorOf(identity.user) : guestFor(context)
        if (!author) return forbidden("write")
        spend(grant, "write", thread.id)
        const [error, message] = await comments.reply(thread.id, { body: text(input.body) ?? "", author })
        if (error) return failure(error.why)
        await comments.flush()
        return { text: `Replied to thread ${thread.id}.`, structured: { message: { ...message } } }
      },
    },
    {
      name: "comments_resolve_thread",
      title: "Resolve or reopen a ViteHub Comments thread",
      description: "ViteHub Comments: resolve a thread that people left with the Comments toolbar after the change it asks for is done, or reopen it. Resolved threads leave the page.",
      section: "comments",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "The thread id." }, resolved: { type: "boolean", description: "Default true. False reopens the thread." } },
        required: ["id"],
        additionalProperties: false,
      },
      async call(input, context) {
        const identity = await identityFor(context)
        const found = await threadFor(input, identity, "resolve")
        if (!("thread" in found)) return found
        const { thread, grant } = found
        spend(grant, "resolve", thread.id)
        const author = identity.user ? authorOf(identity.user) : guestFor(context) ?? { id: "anonymous", name: "Someone" }
        const [error, updated] = input.resolved === false ? await comments.reopen(thread.id) : await comments.resolve(thread.id, { by: author })
        if (error) return failure(error.why)
        await comments.flush()
        return { text: `Thread ${updated.id} is ${updated.status}.`, structured: { thread: { ...summary(updated) } } }
      },
    },
  ]
}
