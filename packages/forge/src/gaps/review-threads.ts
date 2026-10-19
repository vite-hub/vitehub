import type { BaseOptions, ForgeProvider, ThreadRef } from "forges"

import { forgeDiagnostics } from "../error-diagnostics.ts"
import { isRecord, requireGitHub } from "./github.ts"

// Gap: forges resolves review threads but cannot list or look them up (danielroe/forges#151).

/** A resolvable review conversation on a pull request. */
export interface ReviewThread {
  /** The id that `threads.resolveReviewThread()` takes. */
  id: string
  resolved: boolean
  outdated: boolean
  path?: string
  line?: number
  startLine?: number
  originalLine?: number
  originalStartLine?: number
  /** Every comment in the conversation: its GraphQL id and its REST id. */
  comments: Array<{ id: string, restId?: string }>
  /** The GraphQL node without its comment connection. */
  raw: Record<string, unknown>
}

/** A review conversation and the pull request it belongs to. */
export interface ReviewThreadOwner {
  id: string
  resolved: boolean
  /** The GraphQL id of the pull request. */
  pullRequestId: string
}

const THREADS = `query ForgeReviewThreads($owner:String!,$name:String!,$number:Int!,$after:String) {
  repository(owner:$owner,name:$name) { pullRequest(number:$number) { reviewThreads(first:100,after:$after) {
    nodes { id isResolved isOutdated path line originalLine startLine originalStartLine
      comments(first:100) { nodes { id databaseId } pageInfo { hasNextPage endCursor } }
    } pageInfo { hasNextPage endCursor }
  } } }
}`

const THREAD_COMMENTS = `query ForgeReviewThreadComments($id:ID!,$after:String!) {
  node(id:$id) { ... on PullRequestReviewThread { comments(first:100,after:$after) {
    nodes { id databaseId } pageInfo { hasNextPage endCursor }
  } } }
}`

const THREAD = `query ForgeReviewThread($id:ID!) {
  node(id:$id) { ... on PullRequestReviewThread { id isResolved pullRequest { id } } }
}`

async function graphql(provider: ForgeProvider, query: string, variables: Record<string, unknown>, options?: BaseOptions): Promise<unknown> {
  const operationName = /\b(?:query|mutation)\s+([A-Za-z0-9_]+)/.exec(query)?.[1]
  const response = await provider.request<unknown>("POST", "/graphql", { body: { query, variables, ...(operationName ? { operationName } : {}) }, signal: options?.signal })
  const payload = isRecord(response.data) ? response.data : undefined
  const errors = payload?.errors
  if (Array.isArray(errors) && errors.length) throw incomplete(`GitHub review thread query failed: ${errors.map(error => isRecord(error) && typeof error.message === "string" ? error.message : String(error)).join("; ")}`)
  return payload?.data ?? response.data
}

interface Connection { nodes: unknown[], hasNextPage: boolean, endCursor?: string }

function incomplete(message: string): Error {
  return forgeDiagnostics.FORGE_R0008({ message })
}

function field(value: unknown, ...path: string[]): unknown {
  let current = value
  for (const key of path) current = isRecord(current) ? current[key] : undefined
  return current
}

function connection(value: unknown): Connection {
  const page = field(value, "pageInfo")
  const nodes = field(value, "nodes")
  if (!Array.isArray(nodes) || !isRecord(page) || typeof page.hasNextPage !== "boolean") throw incomplete("GitHub returned an incomplete review thread page.")
  const endCursor = typeof page.endCursor === "string" && page.endCursor ? page.endCursor : undefined
  if (page.hasNextPage && !endCursor) throw incomplete("GitHub omitted a review thread cursor.")
  return { nodes, hasNextPage: page.hasNextPage, ...(endCursor ? { endCursor } : {}) }
}

function advance(page: Connection, seen: Set<string>): string | undefined {
  if (!page.hasNextPage) return undefined
  if (seen.has(page.endCursor!)) throw incomplete("GitHub repeated a review thread cursor.")
  seen.add(page.endCursor!)
  return page.endCursor
}

function comment(value: unknown): { id: string, restId?: string } {
  if (!isRecord(value) || typeof value.id !== "string") throw incomplete("GitHub returned an incomplete review comment.")
  return { id: value.id, ...(typeof value.databaseId === "number" ? { restId: String(value.databaseId) } : {}) }
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined
}

/** List every review conversation of a GitHub pull request, with the identity of every comment in it. */
export async function listReviewThreads(provider: ForgeProvider, thread: ThreadRef, options?: BaseOptions): Promise<ReviewThread[]> {
  requireGitHub(provider, "listReviewThreads()")
  if (thread.kind !== "pull_request" || !thread.number) throw forgeDiagnostics.FORGE_R0009({ message: "Review threads belong to a pull request with a number." })
  const threads: ReviewThread[] = []
  const pages = new Set<string>()
  let after: string | undefined
  do {
    const data = await graphql(provider, THREADS, { owner: thread.repo.owner, name: thread.repo.name, number: Number(thread.number), after: after ?? null }, options)
    const page = connection(field(data, "repository", "pullRequest", "reviewThreads"))
    after = advance(page, pages)
    for (const node of page.nodes) {
      if (!isRecord(node) || typeof node.id !== "string" || typeof node.isResolved !== "boolean") throw incomplete("GitHub returned incomplete review thread metadata.")
      const first = connection(node.comments)
      const comments = first.nodes.map(comment)
      const commentPages = new Set<string>()
      let commentAfter = advance(first, commentPages)
      while (commentAfter) {
        const more = connection(field(await graphql(provider, THREAD_COMMENTS, { id: node.id, after: commentAfter }, options), "node", "comments"))
        comments.push(...more.nodes.map(comment))
        commentAfter = advance(more, commentPages)
      }
      const { comments: _comments, ...raw } = node
      threads.push({
        id: node.id,
        resolved: node.isResolved,
        outdated: node.isOutdated === true,
        path: typeof node.path === "string" ? node.path : undefined,
        line: optionalNumber(node.line),
        startLine: optionalNumber(node.startLine),
        originalLine: optionalNumber(node.originalLine),
        originalStartLine: optionalNumber(node.originalStartLine),
        comments,
        raw,
      })
    }
  } while (after)
  return threads
}

/** Look up one review conversation by its id. Returns undefined when the id names no review conversation. */
export async function getReviewThread(provider: ForgeProvider, id: string, options?: BaseOptions): Promise<ReviewThreadOwner | undefined> {
  requireGitHub(provider, "getReviewThread()")
  const node = field(await graphql(provider, THREAD, { id }, options), "node")
  if (node === null || (isRecord(node) && Object.keys(node).length === 0)) return undefined
  const pullRequestId = field(node, "pullRequest", "id")
  if (!isRecord(node) || typeof node.id !== "string" || typeof node.isResolved !== "boolean" || typeof pullRequestId !== "string") {
    throw incomplete("GitHub returned an incomplete review thread.")
  }
  return { id: node.id, resolved: node.isResolved, pullRequestId }
}
