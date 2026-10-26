import { describeCommentContext } from "../context.ts"
import { commentsPageScope, normalizeCommentPage } from "../page.ts"

import type { ViteHubMcpTool, ViteHubMcpToolResult } from "@vite-hub/internal/runtime/mcp-tools"
import type { Comments } from "../index.ts"
import type { CommentAuthor, CommentsAction, CommentsUser, CommentThread } from "../types.ts"

function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}

/** The Console user as a Comments user. A Console without accounts acts as its guest, like the overlay. */
function commentsUser(user: Record<string, unknown> | null): CommentsUser {
  const id = text(user?.id) ?? text(user?.email)
  return user && id ? { ...user, id } : { id: "guest:console", name: "Guest", guest: true }
}

function authorOf(user: CommentsUser): CommentAuthor {
  const author: CommentAuthor = { id: user.id, name: (text(user.name) ?? text(user.email) ?? "Someone").slice(0, 256) }
  const image = text(user.image)
  if (image) author.image = image
  if (user.guest === true) author.guest = true
  return author
}

function failure(why: string): ViteHubMcpToolResult {
  return { text: why, isError: true }
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
 * The Comments tools of the ViteHub MCP server. Each call checks `authorize` for the Console user of the request,
 * as the overlay does. Replies and resolves show that user as the author.
 */
export function commentsMcpTools(comments: Comments): ViteHubMcpTool[] {
  async function allowed(user: CommentsUser, action: CommentsAction, thread?: CommentThread): Promise<boolean> {
    return await comments.can({ user, action, thread })
  }

  async function threadFor(input: Record<string, unknown>, user: CommentsUser, action: CommentsAction): Promise<CommentThread | ViteHubMcpToolResult> {
    const id = text(input.id)
    if (!id) return failure("Give the thread id from comments_list_threads.")
    const [error, thread] = await comments.get(id)
    if (error) return failure(error.why)
    if (thread.scope !== commentsPageScope) return failure(`No thread ${id} on the app's pages.`)
    if (!await allowed(user, action, thread)) return failure(`Comments authorize does not allow ${action} for this user.`)
    return thread
  }

  return [
    {
      name: "comments_list_threads",
      title: "List comment threads",
      description: "List the comment threads that the team left on the app's pages, newest activity first. Each has the page, the first comment, and the Vue components where it was left. Read one with comments_get_thread.",
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
        const user = commentsUser(context.user)
        if (!await allowed(user, "read")) return failure("Comments authorize does not allow read for this user.")
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
        const thread = await threadFor(input, commentsUser(context.user), "read")
        if (!("comments" in thread)) return thread
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
        const user = commentsUser(context.user)
        const thread = await threadFor(input, user, "comment")
        if (!("comments" in thread)) return thread
        const [error, comment] = await comments.reply(thread.id, { body: text(input.body) ?? "", author: authorOf(user) })
        if (error) return failure(error.why)
        return { text: `Replied to thread ${thread.id}.`, structured: { comment: { ...comment } } }
      },
    },
    {
      name: "comments_resolve_thread",
      title: "Resolve or reopen a comment thread",
      description: "Resolve a thread after the change it asks for is done, or reopen it. Resolved threads leave the page.",
      section: "comments",
      annotations: { idempotentHint: true },
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "The thread id." }, resolved: { type: "boolean", description: "Default true. False reopens the thread." } },
        required: ["id"],
        additionalProperties: false,
      },
      async call(input, context) {
        const user = commentsUser(context.user)
        const thread = await threadFor(input, user, "resolve")
        if (!("comments" in thread)) return thread
        const [error, updated] = input.resolved === false ? await comments.reopen(thread.id) : await comments.resolve(thread.id, { by: authorOf(user) })
        if (error) return failure(error.why)
        return { text: `Thread ${updated.id} is ${updated.status}.`, structured: { thread: summary(updated) } }
      },
    },
  ]
}
