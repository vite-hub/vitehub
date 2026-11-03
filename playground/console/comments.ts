import type { CommentThread, CommentUser } from "../../packages/comments/src/operations-core/types.ts"
import type { ConsoleRpcResult } from "../../packages/vite-hub/src/console/runtime/rpc.ts"

/**
 * Synthetic comment threads for the Comments page. They answer the `comments.*` operations in memory, as the operations
 * of `@vite-hub/comments` do for a signed-in person who may read and write everything. A restart resets them.
 */

const people: CommentUser[] = [
  { id: "user_maxi", name: "Maxi" },
  { id: "user_ana", name: "Ana Ruiz" },
  { id: "user_sofia", name: "Sofía Benítez" },
  { id: "user_lee", name: "Lee Chen" },
]
const [maxi, ana, sofia, lee] = people as [CommentUser, CommentUser, CommentUser, CommentUser]
const minute = 60_000
const start = Date.UTC(2026, 10, 3, 9, 0)

function message(threadId: string, index: number, author: CommentUser, body: string, at: number, mentions: string[] = []) {
  return { attachments: [], author, body, createdAt: at, id: `${threadId}_m${index}`, mentions, threadId }
}

function seed(): CommentThread[] {
  return [
    {
      anchor: { exact: "Start free, upgrade when your team grows", kind: "text", prefix: "", selector: "main h1", suffix: "" },
      author: ana,
      createdAt: start,
      id: "thread_pricing_hero",
      messages: [
        message("thread_pricing_hero", 0, ana, "The hero says *free*, but the table below starts at $9. @Maxi can we say \"Free for two people\" here?", start, [maxi.id]),
        message("thread_pricing_hero", 1, maxi, "Good catch. @Sofía Benítez wrote the pricing copy, so she should pick the words.", start + 12 * minute, [sofia.id]),
        message("thread_pricing_hero", 2, sofia, "\"Free for up to two people\" works. I'll update the Content draft today.", start + 40 * minute),
      ],
      n: 12,
      scope: "page",
      status: "open",
      subject: { id: "/pricing", kind: "page" },
      updatedAt: start + 40 * minute,
    },
    {
      anchor: { kind: "element", selector: "#signup", x: 480, y: 520 },
      author: lee,
      createdAt: start + 60 * minute,
      id: "thread_signup_button",
      messages: [message("thread_signup_button", 0, lee, "The Sign up button overlaps the cookie banner on a 375 px screen.", start + 60 * minute)],
      n: 13,
      scope: "page",
      status: "open",
      subject: { id: "/", kind: "page" },
      updatedAt: start + 60 * minute,
    },
    {
      anchor: { kind: "page" },
      author: maxi,
      createdAt: start - 26 * 60 * minute,
      id: "thread_docs_install",
      messages: [
        message("thread_docs_install", 0, maxi, "The install command still uses `npm i vite-hub@beta`.", start - 26 * 60 * minute),
        message("thread_docs_install", 1, ana, "Fixed in the docs PR, it says `pnpm add vite-hub` now.", start - 25 * 60 * minute),
      ],
      n: 9,
      resolvedAt: start - 25 * 60 * minute,
      resolvedBy: ana,
      scope: "page",
      status: "resolved",
      subject: { id: "/docs/getting-started", kind: "page" },
      updatedAt: start - 25 * 60 * minute,
    },
  ]
}

let threads = seed()
let counter = 0

const fail = (status: number, code: string, message: string): ConsoleRpcResult => ({ code, message, ok: false, status })
const ok = (value: unknown): ConsoleRpcResult => ({ ok: true, value: structuredClone(value) })

function find(input: Record<string, unknown>): CommentThread | undefined {
  return threads.find(thread => thread.id === input.threadId || thread.id === input.id)
}

function mentionsOf(input: Record<string, unknown>): string[] {
  return Array.isArray(input.mentions) ? input.mentions.filter((id): id is string => typeof id === "string") : []
}

function save(next: CommentThread): ConsoleRpcResult {
  threads = threads.map(thread => thread.id === next.id ? next : thread)
  return ok(next)
}

/** Answers one `comments.*` operation, or `undefined` for another operation. */
export function callCommentsFixture(operation: string, input: Record<string, unknown>): ConsoleRpcResult | undefined {
  if (!operation.startsWith("comments.")) return undefined
  const now = Date.now()
  switch (operation) {
    case "comments.list": {
      const listed = threads
        .filter(thread => !input.status || thread.status === input.status)
        .filter(thread => !input.mine || thread.author.id === maxi.id)
        .filter(thread => !input.mentions || thread.messages.some(entry => entry.mentions.includes(maxi.id)))
      return ok([...listed].sort((a, b) => b.updatedAt - a.updatedAt))
    }
    case "comments.get":
      return ok(find(input) ?? null)
    case "comments.session":
      return ok({ canRead: true, canWrite: true, user: maxi })
    case "comments.users": {
      const query = String(input.query ?? "").trim().toLowerCase()
      return ok(query.length < 2 ? [] : people.filter(person => person.name?.toLowerCase().includes(query)))
    }
  }
  const thread = find(input)
  if (!thread) return fail(404, "COMMENTS_R0002", `The comment thread ${JSON.stringify(input.threadId)} does not exist.`)
  switch (operation) {
    case "comments.reply": {
      const body = String(input.body ?? "").trim()
      if (!body) return fail(400, "COMMENTS_R0005", "A comment needs text.")
      return save({ ...thread, messages: [...thread.messages, message(thread.id, ++counter + thread.messages.length, maxi, body, now, mentionsOf(input))], updatedAt: now })
    }
    case "comments.edit":
      return save({ ...thread, messages: thread.messages.map(entry => entry.id === input.messageId ? { ...entry, body: String(input.body ?? ""), editedAt: now, mentions: mentionsOf(input) } : entry), updatedAt: now })
    case "comments.resolve":
      return save({ ...thread, resolvedAt: now, resolvedBy: maxi, status: "resolved", updatedAt: now })
    case "comments.reopen": {
      const { resolvedAt: _at, resolvedBy: _by, ...rest } = thread
      return save({ ...rest, status: "open", updatedAt: now })
    }
    case "comments.delete": {
      if (!input.messageId || input.messageId === thread.messages[0]?.id) {
        threads = threads.filter(entry => entry.id !== thread.id)
        return ok(null)
      }
      return save({ ...thread, messages: thread.messages.filter(entry => entry.id !== input.messageId), updatedAt: now })
    }
  }
  return fail(404, "CONSOLE_REQUEST_INVALID", `The playground has no fixture for ${operation}.`)
}
