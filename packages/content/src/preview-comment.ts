import { contentErrorDiagnostics } from "./error-diagnostics.ts"

import type { ContentDevPreviewsResult } from "./results.ts"

/** The HTML comment that marks the preview comment of a pull request, so a new run updates it instead of adding one. */
export const contentPreviewCommentMarker = "<!-- vitehub-content-previews -->"

/** GitHub lists at most this many pages of 100 comments here. A pull request with more gets a new comment. */
const commentPages = 30

/** A Markdown link text that shows the path as it is. */
function linkText(path: string): string {
  return path.replace(/[\\[\]`]/g, character => `\\${character}`)
}

/** What a reader of the pull request needs to know to open the links. Empty for public links. */
function accessNote(result: ContentDevPreviewsResult, command: string): string {
  switch (result.access) {
    case "token":
      return `The pull request is private, so each link has a signed token. Anyone with a link can open the preview until ${result.expiresAt}. Run \`${command}\` again for new links.`
    case "fork":
      return "This pull request comes from a fork. The links open after a maintainer adds the `preview:enabled` label."
    case "closed":
      return "This pull request was closed without a merge, so the links do not open."
    case "unpublished":
      return "The links do not open: the pull request does not make its commit public."
    default:
      return ""
  }
}

/**
 * The Markdown comment with the preview links of a pull request: one link per changed page, and a note when the links
 * are signed or do not open yet. It starts with `contentPreviewCommentMarker`.
 */
export function contentPreviewComment(result: ContentDevPreviewsResult): string {
  const command = `vitehub content previews comment --pr ${result.pull.number}`
  const lines = [contentPreviewCommentMarker, `**Preview** of commit \`${result.sha.slice(0, 7)}\``, ""]
  if (!result.pages.length) lines.push("This pull request changes no pages.")
  else lines.push(...result.pages.map(page => `- [${linkText(page.path)}](${page.url})`))
  const note = accessNote(result, command)
  if (note) lines.push("", note)
  return `${lines.join("\n")}\n`
}

/** The fetch and token of `postContentPreviewComment()`. */
export interface ContentPreviewCommentTarget {
  /** The repository, such as `acme/docs`. */
  repo: string
  pull: number
  token: string
  fetch?: typeof fetch
}

/** The comment that `postContentPreviewComment()` wrote. */
export interface ContentPreviewCommentPosted {
  action: "created" | "updated"
  id: number
  url: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function postedComment(data: unknown, repo: string, pull: number, action: "created" | "updated"): ContentPreviewCommentPosted {
  if (!isRecord(data) || typeof data.id !== "number" || typeof data.html_url !== "string") {
    throw contentErrorDiagnostics.CONTENT_R0078({ repo, pull, status: 200, action: action === "created" ? "create" : "update" })
  }
  return { action, id: data.id, url: data.html_url }
}

/**
 * Create the preview comment of a pull request, or update the one that has `contentPreviewCommentMarker`, through the
 * GitHub REST API. The token needs to write issues and pull requests. Throws `CONTENT_R0078` when GitHub refuses.
 */
export async function postContentPreviewComment(body: string, target: ContentPreviewCommentTarget): Promise<ContentPreviewCommentPosted> {
  const { repo, pull, token } = target
  const request = target.fetch ?? globalThis.fetch
  const api = `https://api.github.com/repos/${repo.split("/").map(encodeURIComponent).join("/")}`
  const headers = {
    "accept": "application/vnd.github+json",
    "authorization": `Bearer ${token}`,
    "content-type": "application/json",
    "user-agent": "vitehub-content",
    "x-github-api-version": "2022-11-28",
  }
  const send = async (action: string, url: string, init: RequestInit = {}): Promise<unknown> => {
    const response = await request(url, { ...init, headers })
    if (!response.ok) throw contentErrorDiagnostics.CONTENT_R0078({ repo, pull, status: response.status, action })
    return await response.json()
  }
  let existing: number | undefined
  for (let page = 1; page <= commentPages && existing === undefined; page++) {
    const comments = await send("list", `${api}/issues/${pull}/comments?per_page=100&page=${page}`)
    if (!Array.isArray(comments)) throw contentErrorDiagnostics.CONTENT_R0078({ repo, pull, status: 200, action: "list" })
    const found = comments.find(comment => isRecord(comment) && typeof comment.body === "string" && comment.body.startsWith(contentPreviewCommentMarker))
    if (isRecord(found) && typeof found.id === "number") existing = found.id
    if (comments.length < 100) break
  }
  const payload = JSON.stringify({ body })
  if (existing !== undefined) {
    return postedComment(await send("update", `${api}/issues/comments/${existing}`, { method: "PATCH", body: payload }), repo, pull, "updated")
  }
  return postedComment(await send("create", `${api}/issues/${pull}/comments`, { method: "POST", body: payload }), repo, pull, "created")
}
