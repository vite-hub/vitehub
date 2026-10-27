import { and, eq, inArray, isNotNull, isNull, like } from "drizzle-orm"

import { commentsSchema } from "../database.ts"
import { createGitHubClient, GitHubRequestError } from "./github.ts"
import { commentMarker, renderComment, renderSummary, summaryMarker } from "./render.ts"
import { recentGitHubToken } from "./tokens.ts"

import type { CommentsDatabase, CommentsStore } from "../store.ts"
import type { Comment, CommentForgeLink, CommentsForgeOptions, CommentsForgeTarget, CommentThread } from "../types.ts"
import type { GitHubClient, GitHubComment } from "./github.ts"

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

function linkOf(thread: CommentThread, byId: ReadonlyMap<string, LinkRow>): CommentForgeLink | null {
  const rows = thread.comments.map(comment => byId.get(comment.id))
  const first = rows[0]
  const target = first ?? rows.find(row => row !== undefined)
  if (!target) return null
  const error = rows.find(row => row?.error)?.error
  return {
    repository: target.repository,
    pullRequest: target.pullRequest,
    state: error ? "failed" : rows.some(row => !row?.remoteId) ? "pending" : "posted",
    ...(first?.url ? { url: first.url } : {}),
    ...(error ? { error } : {}),
    ...(first?.postedAs ? { postedAs: first.postedAs } : {}),
  }
}

function authorizationFailed(error: unknown): boolean {
  return error instanceof GitHubRequestError && (error.status === 401 || error.status === 403 || error.status === 404)
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

  /** Pending writes are fenced by the claim's timestamp, including retries within the same millisecond. */
  async function savePending(id: string, claimedAt: number, values: Partial<Omit<LinkRow, "id">>): Promise<void> {
    await database.update(links).set(values)
      .where(and(eq(links.id, id), isNull(links.remoteId), eq(links.updatedAt, claimedAt)))
  }

  /** Claims a create. An expired owner may still finish; recordPosted reconciles its response. */
  async function claim(id: string, existing: LinkRow | undefined, values: { threadId: string | null } & CommentsForgeTarget): Promise<number | undefined> {
    const now = Math.max(Date.now(), (existing?.updatedAt ?? 0) + 1)
    if (!existing) {
      const inserted = await database.insert(links).values({ id, ...values, minimized: false, updatedAt: now }).onConflictDoNothing().returning({ id: links.id })
      return inserted.length ? now : undefined
    }
    if (existing.remoteId || (!existing.error && existing.updatedAt > Date.now() - claimTimeout)) return
    const claimed = await database.update(links).set({ error: null, updatedAt: now })
      .where(and(eq(links.id, id), isNull(links.remoteId), eq(links.updatedAt, existing.updatedAt))).returning({ id: links.id })
    return claimed.length ? now : undefined
  }

  /** Retain the remote identity before removing its link, so a failed DELETE can be retried without the thread. */
  async function deletePosted(at: CommentsForgeTarget, remoteId: string, token: () => Promise<string>, existing?: LinkRow): Promise<void> {
    const id = `cleanup:${at.repository}#${remoteId}`
    await database.insert(links).values({ id, threadId: null, repository: at.repository, pullRequest: at.pullRequest, remoteId, updatedAt: Date.now() }).onConflictDoNothing()
    if (existing && existing.id !== id) {
      await database.delete(links).where(and(eq(links.id, existing.id), eq(links.remoteId, remoteId)))
    }
    await github.deleteComment(await token(), at.repository, remoteId)
    await database.delete(links).where(eq(links.id, id))
  }

  /**
   * The first saved remote identity wins, even if its POST outlived its lease. A late creator cannot overwrite
   * the winner, and queues deletion of its own extra comment before trying it. Cleanup survives a failed DELETE,
   * even when the original thread and link have already been removed.
   */
  async function recordPosted(id: string, at: CommentsForgeTarget, posted: GitHubComment, body: string, token: () => Promise<string>, postedAs?: "author" | "app"): Promise<LinkRow | undefined> {
    const [saved] = await database.update(links).set({
      remoteId: posted.id, nodeId: posted.nodeId, url: posted.url, digest: digest(body), error: null, updatedAt: Date.now(),
      ...(postedAs ? { postedAs } : {}),
    }).where(and(eq(links.id, id), isNull(links.remoteId))).returning()
    if (saved) return saved
    const current = await row(id)
    if (current?.remoteId !== posted.id) await deletePosted(at, posted.id, token)
    return current
  }

  /** Cleanup rows are independent of thread membership, so even a deleted thread can retry its remote deletions. */
  async function retryCleanup(): Promise<void> {
    const pending = await database.select().from(links).where(like(links.id, "cleanup:%"))
    for (const existing of pending) {
      try {
        await removeLink(existing, () => github.appToken(existing.repository))
      }
      catch (error) {
        await save(existing.id, { error: message(error) })
        console.warn("[vitehub] Comments could not delete a pull request comment:", error)
      }
    }
  }

  /** A claimed row may have reached GitHub before its creator died or lost the response. Never blindly repost it. */
  async function recover(existing: LinkRow, token: () => Promise<string>): Promise<LinkRow | undefined> {
    const marker = existing.threadId === null ? summaryMarker : commentMarker(existing.threadId, existing.id)
    const posted = await github.findComment(await token(), existing.repository, existing.pullRequest, marker)
    if (!posted) return
    return await recordPosted(existing.id, existing, posted, posted.body, token)
  }

  async function removeLink(existing: LinkRow, token: () => Promise<string>): Promise<void> {
    let current = await row(existing.id)
    if (!current) return
    if (!current.remoteId) {
      // Keep an active creator's row until it can observe deletion itself.
      const claimedAt = await claim(current.id, current, current)
      if (claimedAt === undefined) return
      try {
        await recover(current, token)
      }
      catch (error) {
        await savePending(current.id, claimedAt, { error: message(error) })
        throw error
      }
      // Either delete an empty row atomically, or consume the identity a late creator just saved.
      const removed = await database.delete(links).where(and(eq(links.id, current.id), isNull(links.remoteId))).returning({ id: links.id })
      if (removed.length) return
      current = await row(current.id)
    }
    if (current?.remoteId) {
      await deletePosted(current, current.remoteId, token, current)
    }
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
      try {
        if (existing.digest !== hash) {
          const own = existing.postedAs === "author" ? await authorToken(comment) : undefined
          try {
            await github.updateComment(own ?? await appToken(), at.repository, existing.remoteId, body)
          }
          catch (error) {
            if (!own || !authorizationFailed(error)) throw error
            await github.updateComment(await appToken(), at.repository, existing.remoteId, body)
          }
          await save(comment.id, { digest: hash, error: null })
        }
        else if (existing.error) await save(comment.id, { error: null })
      }
      catch (error) {
        await save(comment.id, { error: message(error) })
        return
      }
      // A PATCH from an older isolate may finish last. Repair from the database before finishing this sync.
      const latest = await store.get(thread.id)
      const edited = latest?.comments.find(item => item.id === comment.id)
      if (latest && edited && renderComment(latest, edited, existing.postedAs ?? "app") !== body) {
        await syncComment(latest, edited, await row(comment.id), at, appToken)
      }
      return
    }
    const claimedAt = await claim(comment.id, existing, { threadId: thread.id, ...at })
    if (claimedAt === undefined) return
    try {
      const recovered = existing ? await recover(existing, appToken) : undefined
      if (recovered?.remoteId) {
        await syncComment(thread, comment, recovered, at, appToken)
        return
      }
      const own = await authorToken(comment)
      let postedAs: "author" | "app" = own ? "author" : "app"
      let body = renderComment(thread, comment, postedAs)
      let token = own ?? await appToken()
      let posted
      try {
        await savePending(comment.id, claimedAt, { postedAs })
        posted = await github.createComment(token, at.repository, at.pullRequest, body)
      }
      catch (error) {
        // A revoked or narrow user token: post for them instead.
        if (!own || !authorizationFailed(error)) throw error
        postedAs = "app"
        body = renderComment(thread, comment, postedAs)
        token = await appToken()
        await savePending(comment.id, claimedAt, { postedAs })
        posted = await github.createComment(token, at.repository, at.pullRequest, body)
      }
      const saved = await recordPosted(comment.id, at, posted, body, async () => token, postedAs)
      const latest = await store.get(thread.id)
      const edited = latest?.comments.find(item => item.id === comment.id)
      if (saved?.remoteId && latest && edited) await syncComment(latest, edited, saved, at, appToken)
    }
    catch (error) {
      await savePending(comment.id, claimedAt, { error: message(error) })
    }
  }

  async function summaryBody(at: CommentsForgeTarget, extraId?: string): Promise<string | undefined> {
    const rows = await database.select().from(links)
      .where(and(eq(links.repository, at.repository), eq(links.pullRequest, at.pullRequest), isNotNull(links.threadId)))
    const ids = new Set(rows.map(item => item.threadId!))
    if (extraId) ids.add(extraId)
    const threads = (await Promise.all([...ids].map(threadId => store.get(threadId)))).filter(thread => thread !== undefined)
    if (!threads.length) return
    const byId = new Map(rows.map(item => [item.id, item]))
    return renderSummary({
      title,
      threads: threads.map((thread) => {
        const link = linkOf(thread, byId)
        return { thread, ...(link?.url ? { url: link.url } : {}), failed: link?.state !== "posted" }
      }),
    })
  }

  async function syncSummary(at: CommentsForgeTarget, extra?: CommentThread): Promise<void> {
    await inOrder(`summary:${at.repository}#${at.pullRequest}`, async () => {
      const id = `summary:${at.repository}#${at.pullRequest}`
      let appToken: string | undefined
      const token = async () => appToken ??= await github.appToken(at.repository)
      // Recompute after each request so an overlapping, older PATCH cannot leave a stale summary either.
      while (true) {
        const existing = await row(id)
        const body = await summaryBody(at, extra?.id)
        if (body === undefined) {
          if (existing) await removeLink(existing, token)
          return
        }
        const hash = digest(body)
        if (existing?.remoteId) {
          if (existing.digest === hash) return
          try {
            await github.updateComment(await token(), at.repository, existing.remoteId, body)
            await save(id, { digest: hash, error: null })
          }
          catch (error) {
            await save(id, { error: message(error) })
            throw error
          }
          continue
        }
        const claimedAt = await claim(id, existing, { threadId: null, ...at })
        if (claimedAt === undefined) return
        try {
          const recovered = existing ? await recover(existing, token) : undefined
          if (recovered?.remoteId) continue
          const posted = await github.createComment(await token(), at.repository, at.pullRequest, body)
          const saved = await recordPosted(id, at, posted, body, token, "app")
          if (!saved) return
        }
        catch (error) {
          await savePending(id, claimedAt, { error: message(error) })
          throw error
        }
      }
    })
  }

  async function syncThread(threadId: string): Promise<void> {
    await retryCleanup()
    let thread = await store.get(threadId)
    const rows = await rowsOfThread(threadId)
    const at = rows[0] ? { repository: rows[0].repository, pullRequest: rows[0].pullRequest } : thread ? await target(thread) : undefined
    if (!at) return
    let appToken: string | undefined
    const token = async () => appToken ??= await github.appToken(at.repository)

    // A failed or in-flight initial summary must never let a thread take its place above it.
    let delay = 10
    try {
      while (thread && !(await row(`summary:${at.repository}#${at.pullRequest}`))?.remoteId) {
        await syncSummary(at, thread)
        if ((await row(`summary:${at.repository}#${at.pullRequest}`))?.remoteId) break
        thread = await store.get(threadId)
        if (!thread) break
        await new Promise(resolve => setTimeout(resolve, delay))
        delay = Math.min(delay * 2, 1000)
      }
    }
    catch (error) {
      const first = (await store.get(threadId))?.comments[0]
      if (first) {
        await database.insert(links).values({ id: first.id, threadId, ...at, error: message(error), updatedAt: Date.now() }).onConflictDoNothing()
      }
      console.warn("[vitehub] Comments could not post the pull request summary:", error)
      return
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
          await save(first.id, { error: message(error) })
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
      const rows = await database.select().from(links).where(inArray(links.threadId, threads.map(thread => thread.id)))
      const byId = new Map(rows.map(item => [item.id, item]))
      return threads.map((thread) => {
        return { ...thread, forge: linkOf(thread, byId) }
      })
    },
  }
}
