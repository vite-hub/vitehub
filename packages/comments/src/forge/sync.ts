import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm"

import { commentsSchema } from "../database.ts"
import { createGitHubClient, GitHubRequestError } from "./github.ts"
import { commentMarker, renderComment, renderSummary, summaryMarker } from "./render.ts"
import { recentGitHubToken } from "./tokens.ts"

import type { CommentsDatabase, CommentsStore } from "../store.ts"
import type { Comment, CommentForgeLink, CommentsForgeOptions, CommentsForgeTarget, CommentThread } from "../types.ts"
import type { GitHubClient } from "./github.ts"

const { vitehubCommentForge: links } = commentsSchema

type LinkRow = typeof links.$inferSelect

/** How long a row that is being posted stays claimed, so a sync that died does not block the comment for good. */
const claimTimeout = 60_000

export interface ForgeSync {
  /** Brings the pull request in line with the thread: posts, edits, hides, and deletes its comments, then the summary. */
  sync(threadId: string): Promise<void>
  /** The threads with their `forge` link. */
  attach(threads: CommentThread[]): Promise<CommentThread[]>
}

/** Change detection only: two FNV-1a passes, as `commentRoom()` hashes pages. */
function digest(text: string): string {
  let a = 0x811C9DC5
  let b = 0x01000193 ^ 0x5BD1E995
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    a = Math.imul(a ^ code, 0x01000193) >>> 0
    b = Math.imul(b ^ code, 0x01000193 + 0x9E3779B9) >>> 0
  }
  return `${a.toString(16).padStart(8, "0")}${b.toString(16).padStart(8, "0")}`
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500)
}

function linkOf(row: LinkRow): CommentForgeLink {
  return {
    repository: row.repository,
    pullRequest: row.pullRequest,
    state: row.remoteId ? "posted" : row.error ? "failed" : "pending",
    ...(row.url ? { url: row.url } : {}),
    ...(row.error && !row.remoteId ? { error: row.error } : {}),
    ...(row.postedAs ? { postedAs: row.postedAs } : {}),
  }
}

/** Runs tasks with the same key one after another, so two syncs of a thread or a pull request never interleave. */
function serial(): <T>(key: string, task: () => Promise<T>) => Promise<T> {
  const tails = new Map<string, Promise<unknown>>()
  return (key, task) => {
    const run = (tails.get(key) ?? Promise.resolve()).catch(() => {}).then(task)
    tails.set(key, run)
    void run.catch(() => {}).finally(() => {
      if (tails.get(key) === run) tails.delete(key)
    })
    return run
  }
}

export function createForgeSync(options: CommentsForgeOptions, input: { database: CommentsDatabase, store: CommentsStore, github?: GitHubClient }): ForgeSync {
  const { database, store } = input
  const github = input.github ?? createGitHubClient({ ...(options.apiUrl ? { apiUrl: options.apiUrl } : {}), ...(options.fetch ? { fetch: options.fetch } : {}) })
  const title = options.title ?? "Preview comments"
  const inOrder = serial()

  async function rowsOfThread(threadId: string): Promise<LinkRow[]> {
    return await database.select().from(links).where(eq(links.threadId, threadId))
  }

  async function row(id: string): Promise<LinkRow | undefined> {
    const [found] = await database.select().from(links).where(eq(links.id, id)).limit(1)
    return found
  }

  async function save(id: string, values: Partial<Omit<LinkRow, "id">>): Promise<void> {
    await database.update(links).set({ ...values, updatedAt: Date.now() }).where(eq(links.id, id))
  }

  /**
   * Claims a row before posting its comment, so a second sync does not post it twice. A new row is inserted; a row
   * that failed, or whose claim timed out, is claimed again.
   */
  async function claim(id: string, existing: LinkRow | undefined, values: { threadId: string | null } & CommentsForgeTarget): Promise<boolean> {
    const now = Date.now()
    if (!existing) {
      const inserted = await database.insert(links).values({ id, ...values, minimized: false, updatedAt: now }).onConflictDoNothing().returning({ id: links.id })
      return inserted.length > 0
    }
    if (!existing.error && existing.updatedAt > now - claimTimeout) return false
    const claimed = await database.update(links).set({ error: null, updatedAt: now })
      .where(and(eq(links.id, id), isNull(links.remoteId), eq(links.updatedAt, existing.updatedAt))).returning({ id: links.id })
    return claimed.length > 0
  }

  /** A claimed row may have reached GitHub before its creator died or lost the response. Never blindly repost it. */
  async function recover(existing: LinkRow, token: () => Promise<string>): Promise<(LinkRow & { remoteId: string }) | undefined> {
    const marker = existing.threadId === null ? summaryMarker : commentMarker(existing.threadId, existing.id)
    const posted = await github.findComment(await token(), existing.repository, existing.pullRequest, marker)
    if (!posted) return
    const values = { remoteId: posted.id, nodeId: posted.nodeId, url: posted.url, digest: digest(posted.body), error: null }
    await save(existing.id, values)
    return { ...existing, ...values }
  }

  async function removeLink(existing: LinkRow, token: () => Promise<string>): Promise<void> {
    let current = existing
    if (!current.remoteId) {
      // Keep an active creator's row until it can save the remote identity and observe the deletion itself.
      if (!await claim(current.id, current, current)) return
      try {
        current = await recover(current, token) ?? current
      }
      catch (error) {
        await save(current.id, { error: message(error) })
        throw error
      }
    }
    if (current.remoteId) await github.deleteComment(await token(), current.repository, current.remoteId)
    await database.delete(links).where(eq(links.id, current.id))
  }

  async function target(thread: CommentThread): Promise<CommentsForgeTarget | undefined> {
    const build = thread.context?.build
    const repository = options.repository ?? build?.repository
    if (!repository) return
    let pullRequest = options.pullRequest ? await options.pullRequest(thread) : build?.pullRequest
    if (!options.pullRequest && pullRequest === undefined && build?.branch) pullRequest = await github.findPullRequest(repository, build.branch)
    return pullRequest ? { repository, pullRequest } : undefined
  }

  /** The person's own GitHub token: `token(author)`, else the token of their GitHub sign-in to Comments. */
  async function authorToken(comment: Comment): Promise<string | undefined> {
    if (comment.author.guest) return
    if (!options.token) return recentGitHubToken(comment.author.id)
    try {
      return await options.token(comment.author) || undefined
    }
    catch (error) {
      console.warn(`[vitehub] Comments forge token for ${comment.author.id} failed:`, error)
      return
    }
  }

  async function syncComment(thread: CommentThread, comment: Comment, existing: LinkRow | undefined, at: CommentsForgeTarget, appToken: () => Promise<string>): Promise<void> {
    if (existing?.remoteId) {
      const body = renderComment(thread, comment, existing.postedAs ?? "app")
      const hash = digest(body)
      if (existing.digest === hash) return
      const token = existing.postedAs === "author" ? await authorToken(comment) ?? await appToken() : await appToken()
      await github.updateComment(token, at.repository, existing.remoteId, body)
      await save(comment.id, { digest: hash, error: null })
      return
    }
    if (!await claim(comment.id, existing, { threadId: thread.id, ...at })) return
    try {
      const recovered = existing ? await recover(existing, appToken) : undefined
      if (recovered) {
        await syncComment(thread, comment, recovered, at, appToken)
        return
      }
      const own = await authorToken(comment)
      let postedAs: "author" | "app" = own ? "author" : "app"
      let body = renderComment(thread, comment, postedAs)
      let posted
      try {
        await save(comment.id, { postedAs })
        posted = await github.createComment(own ?? await appToken(), at.repository, at.pullRequest, body)
      }
      catch (error) {
        // A revoked or narrow user token: post for them instead.
        if (!own || !(error instanceof GitHubRequestError && (error.status === 401 || error.status === 403 || error.status === 404))) throw error
        postedAs = "app"
        body = renderComment(thread, comment, postedAs)
        await save(comment.id, { postedAs })
        posted = await github.createComment(await appToken(), at.repository, at.pullRequest, body)
      }
      await save(comment.id, { remoteId: posted.id, nodeId: posted.nodeId, url: posted.url, digest: digest(body), postedAs, error: null })
    }
    catch (error) {
      await save(comment.id, { error: message(error) })
    }
  }

  async function syncSummary(at: CommentsForgeTarget, extra?: CommentThread): Promise<void> {
    await inOrder(`summary:${at.repository}#${at.pullRequest}`, async () => {
      const id = `summary:${at.repository}#${at.pullRequest}`
      const rows = await database.select().from(links)
        .where(and(eq(links.repository, at.repository), eq(links.pullRequest, at.pullRequest), isNotNull(links.threadId)))
      const ids = [...new Set(rows.map(item => item.threadId!))]
      const threads = (await Promise.all(ids.map(threadId => store.get(threadId)))).filter(thread => thread !== undefined)
      if (extra && !ids.includes(extra.id)) threads.push(extra)
      const existing = await row(id)
      let appToken: string | undefined
      const token = async () => appToken ??= await github.appToken(at.repository)
      if (!threads.length) {
        if (existing) await removeLink(existing, token)
        return
      }
      const body = renderSummary({
        title,
        threads: threads.map((thread) => {
          const first = rows.find(item => item.id === thread.comments[0]?.id)
          return { thread, ...(first?.url ? { url: first.url } : {}), failed: Boolean(first?.error && !first.remoteId) }
        }),
      })
      const hash = digest(body)
      if (existing?.remoteId) {
        if (existing.digest === hash) return
        await github.updateComment(await token(), at.repository, existing.remoteId, body)
        await save(id, { digest: hash, error: null })
        return
      }
      if (!await claim(id, existing, { threadId: null, ...at })) return
      try {
        const recovered = existing ? await recover(existing, token) : undefined
        if (recovered) {
          if (recovered.digest !== hash) {
            await github.updateComment(await token(), at.repository, recovered.remoteId, body)
            await save(id, { digest: hash, error: null })
          }
          return
        }
        const posted = await github.createComment(await token(), at.repository, at.pullRequest, body)
        await save(id, { remoteId: posted.id, nodeId: posted.nodeId, url: posted.url, digest: hash, postedAs: "app", error: null })
      }
      catch (error) {
        await save(id, { error: message(error) })
        throw error
      }
    })
  }

  async function syncThread(threadId: string): Promise<void> {
    let thread = await store.get(threadId)
    const rows = await rowsOfThread(threadId)
    const at = rows[0] ? { repository: rows[0].repository, pullRequest: rows[0].pullRequest } : thread ? await target(thread) : undefined
    if (!at) return
    let appToken: string | undefined
    const token = async () => appToken ??= await github.appToken(at.repository)

    // The summary goes first on a new pull request, so it sits above the threads.
    if (thread && !(await row(`summary:${at.repository}#${at.pullRequest}`))?.remoteId) {
      await syncSummary(at, thread).catch(error => console.warn("[vitehub] Comments could not post the pull request summary:", error))
    }

    // Another isolate may have removed the thread while the summary was being posted.
    thread = await store.get(threadId)
    const live = new Set(thread?.comments.map(comment => comment.id) ?? [])
    for (const gone of rows.filter(item => !live.has(item.id))) {
      await removeLink(gone, token)
    }
    if (thread) {
      for (const comment of thread.comments) {
        if (await store.threadOf(comment.id) !== threadId) continue
        await syncComment(thread, comment, rows.find(item => item.id === comment.id), at, token)
      }
      // GitHub has no resolved state for a pull request comment, so a resolved thread hides its first comment.
      const first = await row(thread.comments[0]?.id ?? "")
      const resolved = thread.status === "resolved"
      if (first?.nodeId && first.minimized !== resolved) {
        try {
          await github.minimize(await token(), first.nodeId, resolved)
          await save(first.id, { minimized: resolved })
        }
        catch (error) {
          console.warn(`[vitehub] Comments could not ${resolved ? "hide" : "show"} the comment of thread ${thread.id}:`, error)
        }
      }
    }
    // A deletion in another isolate can arrive while a comment POST is in flight. Its claim was retained above.
    const latest = await store.get(threadId)
    const remaining = new Set(latest?.comments.map(comment => comment.id) ?? [])
    for (const gone of (await rowsOfThread(threadId)).filter(item => !remaining.has(item.id))) {
      await removeLink(gone, token)
    }
    await syncSummary(at)
  }

  return {
    async sync(threadId) {
      await inOrder(`thread:${threadId}`, () => syncThread(threadId))
    },
    async attach(threads) {
      if (!threads.length) return threads
      const firstIds = threads.map(thread => thread.comments[0]?.id).filter(id => id !== undefined)
      const rows = firstIds.length ? await database.select().from(links).where(inArray(links.id, firstIds)) : []
      const byId = new Map(rows.map(item => [item.id, item]))
      return threads.map((thread) => {
        const found = byId.get(thread.comments[0]?.id ?? "")
        return { ...thread, forge: found ? linkOf(found) : null }
      })
    },
  }
}
