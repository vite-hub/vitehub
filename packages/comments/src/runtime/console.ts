import { commentsRuntime } from "../server.ts"

import type { ViteHubConsoleRecord } from "@vite-hub/internal/console"
import type { CommentThread } from "../types.ts"

const missingPolicy: ViteHubConsoleRecord = {
  cells: { author: "", comment: "Add authorize to defineComments() in server/comments.ts. Without it nobody can read or write comments.", number: "!", status: "No policy", subject: "", updated: "" },
  fields: [
    { label: "Problem", value: "server/comments.ts defines no authorize policy, so nobody can read or write comments." },
    { label: "Fix", value: "Write `export default defineComments({ authorize: ({ user }) => Boolean(user) })`, or a policy that fits your team." },
  ],
  id: "comments:no-policy",
}

function excerpt(text: string, length = 80): string {
  const line = text.replaceAll(/\s+/g, " ").trim()
  return line.length > length ? `${line.slice(0, length - 1)}…` : line
}

/** The page link of a thread: `<page>?comment=<n>` for a page subject. */
export function commentThreadLink(thread: Pick<CommentThread, "n" | "subject">): string | undefined {
  return thread.subject.kind === "page" ? `${thread.subject.id}${thread.subject.id.includes("?") ? "&" : "?"}comment=${thread.n}` : undefined
}

function record(thread: CommentThread): ViteHubConsoleRecord {
  const first = thread.messages[0]
  const link = commentThreadLink(thread)
  const subject = thread.subject.kind === "page" ? thread.subject.id : `${thread.subject.kind}: ${thread.subject.id}`
  return {
    cells: {
      author: thread.author.name ?? thread.author.id,
      comment: excerpt(first?.body ?? ""),
      number: String(thread.n),
      status: thread.status,
      subject,
      updated: new Date(thread.updatedAt).toISOString(),
    },
    fields: [
      { label: "Subject", value: subject },
      ...(link ? [{ label: "Link", value: link }] : []),
      { label: "Scope", value: thread.scope },
      { label: "Number", value: String(thread.n) },
      { label: "Status", value: thread.resolvedBy ? `resolved by ${thread.resolvedBy.name ?? thread.resolvedBy.id}` : thread.status },
      { label: "Messages", value: String(thread.messages.length) },
      ...thread.messages.map((message, index) => ({ label: `${index === 0 ? "Comment" : "Reply"} by ${message.author.name ?? message.author.id}`, value: message.body })),
    ],
    id: `comments:${thread.id}`,
  }
}

/** Console records for the comment inbox. It runs on each Console request. */
export async function readCommentsConsoleRecords(): Promise<ViteHubConsoleRecord[]> {
  let runtime
  try {
    runtime = await commentsRuntime()
  }
  catch {
    return [missingPolicy]
  }
  const threads = await runtime.store.list({})
  const ordered = [...threads].sort((a, b) => (a.status === b.status ? b.updatedAt - a.updatedAt : a.status === "open" ? -1 : 1))
  return [...(runtime.definition.authorize ? [] : [missingPolicy]), ...ordered.map(record)]
}
