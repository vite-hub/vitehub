import type { Comment, Cursor, ForgeProvider, Page, ReactionContent, Thread, ThreadRef } from "forges"
import type { AgentChannelDeliveryEffectContext, AgentChannelDeliveryEffects, AgentRunInput, AgentRuntimeConfig } from "../types.ts"
import { agentDiagnostics } from "../agent-diagnostics.ts"
import { forgeErrorStatus } from "@vite-hub/forge"
import type { ForgeKind } from "@vite-hub/forge"
import { hasRuntimeType, isRuntimeRecord as isRecord } from "./runtime-type.ts"
import { messageChannelReplyBody, setMessageChannelDeliveredReplyBody } from "./message-channel-delivery-body.ts"

/** Keep the custom fetch callback shape of Channels: a plain headers record and an explicit method. */
export function forgeChannelFetch(fetcher: typeof fetch): typeof fetch {
  return async (input, init) => await fetcher(input, { ...init, method: init?.method || "GET", headers: Object.fromEntries(new Headers(init?.headers).entries()) })
}

export interface ForgeTarget {
  forge: ForgeKind
  instance: string
  repository: string
  number: number
  commentId?: number
  installationId?: number
}

export function forgeThreadRef(provider: ForgeProvider, target: ForgeTarget): ThreadRef {
  const parts = target.repository.split("/")
  const name = parts.pop()!
  const origin = { forge: provider.forge, instance: provider.instance }
  return { ...origin, repo: { ...origin, owner: parts.join("/"), name }, kind: "pull_request", number: String(target.number) }
}

type MetadataCode = "AGENT_R0351" | "AGENT_R0352" | "AGENT_R0353" | "AGENT_R0354" | "AGENT_R0360"

export async function forgeChannelRead<T>(provider: ForgeProvider, code: MetadataCode, read: () => Promise<T>): Promise<T> {
  try {
    return await read()
  }
  catch (error) {
    const status = forgeErrorStatus(error)
    if (provider.forge !== "github" && status !== undefined) throw agentDiagnostics.AGENT_R0946({ message: `[vitehub] Forge metadata request failed with ${status}.`, cause: error })
    if (provider.forge === "github" && status !== undefined) {
      throw agentDiagnostics[code]({ message: `[vitehub] GitHub metadata request failed with ${status}.`, cause: error })
    }
    throw error
  }
}

export async function forgeChannelWrite<T>(provider: ForgeProvider, write: () => Promise<T>): Promise<T> {
  try {
    return await write()
  }
  catch (error) {
    const status = forgeErrorStatus(error)
    if (provider.forge !== "github" && status !== undefined) throw agentDiagnostics.AGENT_R0946({ message: `[vitehub] Forge delivery effect failed with ${status}.`, cause: error })
    if (provider.forge === "github" && status !== undefined) {
      throw agentDiagnostics.AGENT_R0350({ message: `[vitehub] GitHub delivery effect failed with ${status}.`, cause: error })
    }
    throw error
  }
}

export async function forgeChannelRequest(provider: ForgeProvider, method: string, path: string, body?: unknown): Promise<unknown> {
  return await forgeChannelWrite(provider, async () => (await provider.request(method, path, { body })).data)
}

async function limitedPages<T>(read: (cursor?: Cursor) => Promise<Page<T>>, limit: number): Promise<T[]> {
  const items: T[] = []
  let cursor: Cursor | undefined
  do {
    const page = await read(cursor)
    items.push(...page.items)
    cursor = page.cursor
  } while (cursor && items.length < limit)
  return items.slice(0, limit)
}

async function githubFilePages(provider: ForgeProvider, target: ForgeTarget, limit: number): Promise<unknown[]> {
  const path = `/repos/${target.repository}/pulls/${target.number}/files`
  let pageNumber = 1
  return await limitedPages(async cursor => {
    const response = await provider.request<unknown[]>("GET", cursor?.nextUrl || path, { query: cursor?.nextUrl ? undefined : { per_page: 100 } })
    const items = Array.isArray(response.data) ? response.data : []
    if (!items.length) return { items }
    const link = response.headers.get("link")
    const nextUrl = link === null
      ? `${provider.baseUrl.replace(/\/$/, "")}${path}?per_page=100&page=${++pageNumber}`
      : link.split(",").map(part => part.trim()).find(part => part.endsWith('rel="next"'))?.match(/^<([^>]+)>/)?.[1]
    return { items, cursor: nextUrl ? { nextUrl } : undefined }
  }, limit)
}

function shaOf(value: unknown): string | undefined {
  return isRecord(value) && hasRuntimeType(value.sha, "string") && value.sha ? value.sha : undefined
}

/**
 * Read one pull request. GitHub reads only the pull request: `threads.get` also reads
 * check runs and statuses, which costs two more requests per call.
 */
export async function forgePullRequest(provider: ForgeProvider, target: ForgeTarget): Promise<{ raw: unknown, headSha?: string, baseSha?: string, model?: Thread }> {
  if (provider.forge === "github") {
    const { data } = await provider.request<unknown>("GET", `/repos/${target.repository}/pulls/${target.number}`)
    return { raw: data, headSha: shaOf(isRecord(data) ? data.head : undefined), baseSha: shaOf(isRecord(data) ? data.base : undefined) }
  }
  const thread = await provider.threads.get(forgeThreadRef(provider, target))
  return { raw: thread.raw, model: thread, headSha: thread.branches?.head.sha, baseSha: thread.branches?.base.sha }
}

export async function forgePullRequestMetadata(
  provider: ForgeProvider,
  target: ForgeTarget,
  limits: { maxComments: number, maxFiles: number, authenticated?: boolean },
) {
  const ref = forgeThreadRef(provider, target)
  const [thread, comments, files] = await Promise.all([
    forgeChannelRead(provider, "AGENT_R0351", async () => await forgePullRequest(provider, target)),
    limits.authenticated === false ? [] : forgeChannelRead(provider, "AGENT_R0352", async () => await limitedPages(
      async cursor => await provider.threads.commentsPage(ref, { perPage: 100, cursor }), limits.maxComments + 1)),
    limits.authenticated === false ? [] : forgeChannelRead(provider, "AGENT_R0352", async () => provider.forge === "github"
      // Changed files have no raw field in the pinned client. Keep native GitHub fields.
      ? await githubFilePages(provider, target, limits.maxFiles + 1)
      : await limitedPages(async cursor => await provider.threads.filesPage(ref, { perPage: 100, cursor }), limits.maxFiles + 1)),
  ])
  return { thread, comments: comments.map(comment => comment.raw), files,
    omittedComments: Math.max(0, comments.length - limits.maxComments), omittedFiles: Math.max(0, files.length - limits.maxFiles) }
}

function commentRef(provider: ForgeProvider, target: ForgeTarget, id: number) {
  return { forge: provider.forge, instance: provider.instance, thread: forgeThreadRef(provider, target), id: String(id) }
}

function rawComment(provider: ForgeProvider, target: ForgeTarget, raw: unknown): Comment {
  return { ref: commentRef(provider, target, isRecord(raw) && hasRuntimeType(raw.id, "number") ? raw.id : 0),
    body: isRecord(raw) && hasRuntimeType(raw.body, "string") ? raw.body : "", raw }
}

export function forgeActivityComments(provider: ForgeProvider, target: ForgeTarget, limit: number) {
  const ref = forgeThreadRef(provider, target)
  const path = `/repos/${target.repository}/issues/${target.number}/comments`
  return {
    /** Newest comments first, so a restart finds the managed activity comment on long threads. */
    async list(): Promise<Comment[]> {
      if (provider.forge === "gitlab") {
        const notesPath = `/projects/${encodeURIComponent(target.repository)}/merge_requests/${target.number}/notes`
        const items: unknown[] = []
        for (let page = 1; items.length < limit; page++) {
          const response = await forgeChannelRead(provider, "AGENT_R0353", async () => await provider.request<unknown[]>("GET", notesPath, {
            query: { sort: "desc", order_by: "created_at", per_page: 100, page },
          }))
          if (!Array.isArray(response.data) || !response.data.length) break
          items.push(...response.data)
          if (response.data.length < 100) break
        }
        return items.slice(0, limit).map(raw => rawComment(provider, target, raw))
      }
      // GitHub and Forgejo have no reverse comments order. Read the pages from the last page.
      const sizeParameter = provider.forge === "github" ? "per_page" : "limit"
      const first = await forgeChannelRead(provider, "AGENT_R0353", async () => await provider.request<unknown[]>("GET", path, { query: { [sizeParameter]: 100 } }))
      if (!Array.isArray(first.data) || !first.data.length) return []
      const lastUrl = first.headers.get("link")?.split(",").map(part => part.trim()).find(part => part.endsWith('rel="last"'))?.match(/^<([^>]+)>/)?.[1]
      const total = provider.forge === "github" ? undefined : Number(first.headers.get("x-total-count"))
      const lastPage = lastUrl
        ? Number(new URL(lastUrl).searchParams.get("page"))
        : total && Number.isSafeInteger(total) ? Math.ceil(total / first.data.length) : undefined
      if (!lastPage || !Number.isSafeInteger(lastPage) || lastPage <= 1) return first.data.slice(-limit).reverse().map(raw => rawComment(provider, target, raw))
      const items: unknown[] = []
      // A Forge can cap the page size below 100. Count pages with the size it returned.
      const pageLimit = Math.ceil(limit / first.data.length) + 1
      for (let page = lastPage; page > Math.max(1, lastPage - pageLimit) && items.length < limit; page--) {
        const response = await forgeChannelRead(provider, "AGENT_R0354", async () => await provider.request<unknown[]>("GET", path, { query: { [sizeParameter]: 100, page } }))
        if (!Array.isArray(response.data)) break
        items.push(...response.data.reverse())
      }
      if (items.length < limit && lastPage <= pageLimit) items.push(...first.data.reverse())
      return items.slice(0, limit).map(raw => rawComment(provider, target, raw))
    },
    async get(id: number): Promise<Comment | undefined> {
      try {
        const path = provider.forge === "gitlab"
          ? `/projects/${encodeURIComponent(target.repository)}/merge_requests/${target.number}/notes/${id}`
          : `/repos/${target.repository}/issues/comments/${id}`
        const response = await provider.request("GET", path)
        return rawComment(provider, target, response.data)
      }
      catch (error) {
        const status = forgeErrorStatus(error)
        if (status === 404) return undefined
        if (status !== undefined && provider.forge !== "github") throw agentDiagnostics.AGENT_R0946({ message: `[vitehub] Forge metadata request failed with ${status}.`, cause: error })
        if (status !== undefined && provider.forge === "github") throw agentDiagnostics.AGENT_R0360({ message: `[vitehub] GitHub metadata request failed with ${status}.`, cause: error })
        throw error
      }
    },
    async create(body: string) { return await forgeChannelWrite(provider, async () => await provider.threads.comment(ref, body)) },
    async edit(id: number, body: string) { return await forgeChannelWrite(provider, async () => await provider.threads.editComment(commentRef(provider, target, id), body)) },
  }
}

export async function forgeIdentity(provider: ForgeProvider, credential: { kind: "app", login: string } | { kind: "token" }): Promise<{ login: string }> {
  if (credential.kind === "app") return { login: credential.login }
  const { data } = await provider.request("GET", "/user")
  if (provider.forge === "gitlab" && isRecord(data) && hasRuntimeType(data.username, "string") && data.username) return { login: data.username }
  if (isRecord(data) && hasRuntimeType(data.login, "string") && data.login) return { login: data.login }
  if (provider.forge !== "github") throw agentDiagnostics.AGENT_R0946({ message: "[vitehub] Forge Agent activity could not resolve the authenticated identity." })
  throw agentDiagnostics.AGENT_R0356({ message: "[vitehub] GitHub Agent activity could not resolve the authenticated identity." })
}

function maybeString(value: unknown): string | undefined { return hasRuntimeType(value, "string") && value ? value : undefined }
function reactionContent<TRuntimeConfig extends AgentRuntimeConfig>(
  context: AgentChannelDeliveryEffectContext<TRuntimeConfig>,
): string {
  if (hasRuntimeType(context.effect.payload, "string")) return context.effect.payload
  if (isRecord(context.effect.payload) && hasRuntimeType(context.effect.payload.content, "string")) return context.effect.payload.content
  if (isRecord(context.effect.payload) && hasRuntimeType(context.effect.payload.emoji, "string")) return context.effect.payload.emoji
  if (context.effect.intent === "completed") return "hooray"
  if (context.effect.intent === "failed") return "confused"
  return "eyes"
}

const reactionContents: ReadonlySet<string> = new Set<ReactionContent>(["+1", "-1", "laugh", "confused", "heart", "hooray", "rocket", "eyes"])

function isReactionContent(value: string): value is ReactionContent {
  return reactionContents.has(value)
}

function reactionAction<TRuntimeConfig extends AgentRuntimeConfig>(
  context: AgentChannelDeliveryEffectContext<TRuntimeConfig>,
): string | undefined {
  return isRecord(context.effect.payload) ? maybeString(context.effect.payload.action) : undefined
}

function transientReactionKey<TRuntimeConfig extends AgentRuntimeConfig>(
  context: AgentChannelDeliveryEffectContext<TRuntimeConfig>,
): string | undefined {
  return maybeString(context.effect.metadata?.transientKey)
}

type ForgeTransientReaction = {
  id: number
}

function transientReactionStore(input: AgentRunInput): Record<string, ForgeTransientReaction> {
  // SAFETY: Transient reaction state is stored only on the invocation context record.
  const context = input.context as Record<string, unknown> | undefined
  if (!context) return {}
  const key = "github.delivery.transientReactions"
  if (!isRecord(context[key])) context[key] = {}
  // SAFETY: The branch above initializes this key as the transient-reaction record.
  return context[key] as Record<string, ForgeTransientReaction>
}

function statusPayload<TRuntimeConfig extends AgentRuntimeConfig>(
  context: AgentChannelDeliveryEffectContext<TRuntimeConfig>,
  defaultContext: string,
) {
  const payload = isRecord(context.effect.payload)
    ? context.effect.payload
    : hasRuntimeType(context.effect.payload, "string")
      ? { state: context.effect.payload }
      : {}
  return {
    context: payload.context || context.effect.metadata?.context || defaultContext,
    description: payload.description || context.effect.metadata?.description,
    sha: payload.sha || context.effect.metadata?.sha,
    state: payload.state || context.effect.metadata?.state || (context.effect.intent === "failed" ? "failure" : context.effect.intent === "completed" ? "success" : "pending"),
    target_url: payload.target_url || context.effect.metadata?.target_url,
  }
}

export interface ForgeDeliveryEffectsOptions<TRuntimeConfig extends AgentRuntimeConfig> {
  provider: (context: AgentChannelDeliveryEffectContext<TRuntimeConfig>) => Promise<ForgeProvider>
  target: (context: AgentChannelDeliveryEffectContext<TRuntimeConfig>) => ForgeTarget | undefined
  statusContext: string
  /** "id": add and delete GitHub reactions by id. "content": use the shared react and unreact verbs. */
  reactions: "id" | "content"
  publishArtifacts?: (context: AgentChannelDeliveryEffectContext<TRuntimeConfig>, body: string | undefined, provider: ForgeProvider) => Promise<string | undefined>
}

export function forgeDeliveryEffects<TRuntimeConfig extends AgentRuntimeConfig>(
  options: ForgeDeliveryEffectsOptions<TRuntimeConfig>,
): AgentChannelDeliveryEffects<TRuntimeConfig> {
  const bodyFor = async (context: AgentChannelDeliveryEffectContext<TRuntimeConfig>, provider: ForgeProvider) => {
    const body = messageChannelReplyBody(context)
    const published = options.publishArtifacts ? await options.publishArtifacts(context, body, provider) : body
    if (published) setMessageChannelDeliveredReplyBody(context, published)
    return published
  }
  return {
    async reaction(context) {
      const target = options.target(context)
      if (!target) return
      const provider = await options.provider(context)
      const content = reactionContent(context)
      if (options.reactions === "content") {
        if (!isReactionContent(content)) return
        const ref = target.commentId ? commentRef(provider, target, target.commentId) : forgeThreadRef(provider, target)
        await forgeChannelWrite(provider, async () => reactionAction(context) === "remove"
          ? await provider.threads.unreact(ref, content) : await provider.threads.react(ref, content))
        return
      }
      const path = target.commentId ? `/repos/${target.repository}/issues/comments/${target.commentId}/reactions` : `/repos/${target.repository}/issues/${target.number}/reactions`
      const key = transientReactionKey(context)
      if (reactionAction(context) === "remove") {
        const id = key ? transientReactionStore(context.input)[key]?.id : undefined
        if (!id) return
        await forgeChannelRequest(provider, "DELETE", `${path}/${id}`)
        delete transientReactionStore(context.input)[key!]
        return
      }
      const result = await forgeChannelRequest(provider, "POST", path, { content })
      if (key && isRecord(result) && hasRuntimeType(result.id, "number") && result.id) transientReactionStore(context.input)[key] = { id: result.id }
    },
    async reply(context) {
      const target = options.target(context)
      if (!target) return
      const provider = await options.provider(context)
      const body = await bodyFor(context, provider)
      if (body) await forgeChannelWrite(provider, async () => await provider.threads.comment(forgeThreadRef(provider, target), body))
    },
    async update(context) {
      const target = options.target(context)
      if (!target) return
      if (!target.commentId && target.forge !== "github") throw agentDiagnostics.AGENT_R0946({ message: "[vitehub] Forge pull request lifecycle invocations cannot update a triggering comment." })
      if (!target.commentId) throw agentDiagnostics.AGENT_R0364({ message: "[vitehub] GitHub pull request lifecycle invocations cannot update a triggering comment." })
      const provider = await options.provider(context)
      const body = await bodyFor(context, provider)
      if (body) await forgeChannelWrite(provider, async () => await provider.threads.editComment(commentRef(provider, target, target.commentId!), body))
    },
    async review(context) {
      const target = options.target(context)
      if (!target) return
      const provider = await options.provider(context)
      const body = await bodyFor(context, provider)
      const payload = isRecord(context.effect.payload) ? context.effect.payload : {}
      const event = maybeString(payload.event) || maybeString(context.effect.metadata?.event) || "COMMENT"
      const review = event === "APPROVE" || event === "approve" ? "approve" : event === "REQUEST_CHANGES" || event === "request_changes" ? "request_changes" : "comment"
      const ref = forgeThreadRef(provider, target)
      if (provider.forge === "gitlab") {
        // GitLab has approvals, not reviews. An approval has no body, so the review text is a note.
        if (review === "request_changes") throw agentDiagnostics.AGENT_R0946({ message: "[vitehub] GitLab has no request changes review. Use an approve or comment review." })
        if (review === "approve") await forgeChannelWrite(provider, async () => await provider.threads.createReview(ref, { event: "approve" }))
        if (body) await forgeChannelWrite(provider, async () => await provider.threads.comment(ref, body))
        return
      }
      if (!body) return
      await forgeChannelWrite(provider, async () => await provider.threads.createReview(ref, { body, event: review }))
    },
    async status(context) {
      const target = options.target(context)
      if (!target) return
      const provider = await options.provider(context)
      const ref = forgeThreadRef(provider, target)
      const payload = statusPayload(context, options.statusContext)
      const sha = maybeString(payload.sha) || (await forgeChannelWrite(provider, async () => await forgePullRequest(provider, target))).headSha
      if (!sha) return
      // The shared check model has no GitHub error state. Keep that native status.
      if (provider.forge === "github" && payload.state === "error") {
        await forgeChannelRequest(provider, "POST", `/repos/${target.repository}/statuses/${sha}`, { ...payload, sha: undefined })
        return
      }
      await forgeChannelWrite(provider, async () => await provider.checks.report(ref.repo, sha, {
        name: maybeString(payload.context) || options.statusContext,
        state: payload.state === "success" ? "success" : payload.state === "failure" ? "failure" : "pending",
        description: maybeString(payload.description), url: maybeString(payload.target_url),
      }))
    },
  }
}
