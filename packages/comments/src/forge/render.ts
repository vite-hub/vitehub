import { describeCommentContext } from "../context.ts"

import type { Comment, CommentThread } from "../types.ts"

/** The `<!-- -->` marker that ends every comment the sync posts, so people and tools can tell them apart. */
export const forgeMarker = "vitehub-comments"

export const summaryMarker = `<!-- ${forgeMarker} summary -->`

export function commentMarker(threadId: string, commentId: string): string {
  return `<!-- ${forgeMarker} thread=${threadId} comment=${commentId} -->`
}

/**
 * Text that GitHub must not link: `@name` notifies a GitHub user, and `#3` links issue 3. Comment mentions and thread
 * numbers belong to the app, so a word joiner breaks both without changing how they read.
 */
export function unlinked(text: string): string {
  return text.replace(/@(?=[\w-])/g, "@\u2060").replace(/#(?=\d)/g, "#\u2060")
}

/** A thread number as people say it, "#3", that GitHub does not link to issue 3. */
function number(thread: CommentThread): string {
  return `#\u2060${thread.number}`
}

function quote(text: string): string {
  return text.split("\n").map(line => `> ${line}`).join("\n")
}

/** Comment text is plain text in the preview; keep it literal in GitHub Markdown too. */
function plainText(text: string): string {
  return unlinked(text).replace(/&/g, "&amp;").replace(/[\\`*_{}[\]<>#+=!|~-]/g, "\\$&")
    .replace(/^(\s*\d+)([.)])(?=\s)/gm, "$1\\$2")
}

/** One line for a Markdown table cell. */
function cell(text: string): string {
  return plainText(text).replace(/\s+/g, " ").trim()
}

/** A code span for a Markdown table cell. GitHub shows `&lt;` in a code span as typed, so only pipes are escaped. */
function code(text: string): string {
  return `\`${text.replace(/\s+/g, " ").replace(/\|/g, "\\|").replace(/`/g, "'").trim()}\``
}

/** The first sentence of a comment, at most 100 characters. */
function headline(body: string): string {
  const first = body.trim().split(/(?<=[.!?])\s/, 1)[0] ?? ""
  return first.length > 100 ? `${first.slice(0, 99).trimEnd()}…` : first
}

function authorName(comment: Comment): string {
  return unlinked(`${comment.author.name}${comment.author.guest ? " (guest)" : ""}`)
}

/** The page of a thread in comment mode, with its thread open: the Console's **Open on page** link. */
export function previewUrl(thread: CommentThread): string | undefined {
  if (!thread.context?.url) return
  try {
    const url = new URL(thread.context.url)
    url.hash = ""
    return `${url.href}${url.search ? "&" : "?"}comments#comment-${thread.id}`
  }
  catch {
    return
  }
}

function pageLink(thread: CommentThread): string {
  const url = previewUrl(thread)
  return url ? `[\`${thread.page}\`](${url})` : `\`${thread.page}\``
}

function where(thread: CommentThread): string {
  const element = thread.context?.element
  const name = element?.name ? ` “${cell(element.name).slice(0, 60)}”` : ""
  return `**${number(thread)}** on ${pageLink(thread)}${element ? ` · \`${element.tag}\`${name}` : ""}`
}

function details(thread: CommentThread): string {
  const fields = describeCommentContext(thread.context)
  if (!fields.length) return ""
  const rows = fields.map(({ label, value }) => {
    const shown = label === "URL" ? cell(value) : label === "Files" ? value.split(", ").map(code).join("<br>") : code(value)
    return `| ${label} | ${shown} |`
  })
  return ["<details><summary>What they were looking at</summary>", "", "| | |", "| --- | --- |", ...rows, "", "</details>"].join("\n")
}

/**
 * The pull request comment of one comment. `author` posts with the person's own token, so the text is theirs; `app`
 * posts for them, so it names them and quotes them.
 */
export function renderComment(thread: CommentThread, comment: Comment, postedAs: "author" | "app"): string {
  const first = thread.comments[0]?.id === comment.id
  const body = plainText(comment.body)
  const lines: string[] = []
  if (postedAs === "app") lines.push(first ? `**${plainText(authorName(comment))}** commented on the preview:` : `**${plainText(authorName(comment))}** replied on ${number(thread)}:`, "", quote(body))
  else lines.push(body)
  lines.push("")
  if (first) {
    lines.push(where(thread))
    const context = details(thread)
    if (context) lines.push("", context)
  }
  else {
    lines.push(`<sub>Reply on ${number(thread)} · ${pageLink(thread)}</sub>`)
  }
  lines.push("", commentMarker(thread.id, comment.id))
  return lines.join("\n")
}

/** The summary comment of a pull request: every thread posted to it, by number, with its state. */
export function renderSummary(input: { title: string, threads: ReadonlyArray<{ thread: CommentThread, url?: string, failed: boolean }> }): string {
  const threads = [...input.threads].sort((a, b) => a.thread.number - b.thread.number)
  const open = threads.filter(({ thread }) => thread.status === "open").length
  const site = threads.map(({ thread }) => thread.context?.url).find(Boolean)
  let origin: URL | undefined
  try {
    origin = site ? new URL(site) : undefined
  }
  catch {}
  const rows = threads.map(({ thread, url, failed }) => {
    const first = thread.comments[0]
    const text = cell(unlinked(headline(first?.body ?? "")))
    const comment = url ? `[${text}](${url})` : text
    const shown = thread.status === "resolved" ? `~~${comment}~~` : comment
    const preview = previewUrl(thread)
    const label = preview ? `[${number(thread)}](${preview})` : number(thread)
    const state = thread.status === "resolved" ? "Resolved" : failed ? "Open, not posted yet" : "Open"
    return `| ${label} | ${shown}<br><sub>${code(thread.page)} · ${cell(first ? authorName(first) : unlinked(thread.createdBy.name))}</sub> | ${state} |`
  })
  return [
    `### ${input.title}`,
    "",
    `**${open} open**, ${threads.length - open} resolved${origin ? ` on [${origin.host}](${origin.origin})` : ""}.`,
    "",
    "| # | Comment | State |",
    "| --- | --- | --- |",
    ...rows,
    "",
    "<sub>ViteHub Comments keeps this comment up to date. Each thread is also its own comment below; reply on the page to keep the thread together.</sub>",
    "",
    summaryMarker,
  ].join("\n")
}
