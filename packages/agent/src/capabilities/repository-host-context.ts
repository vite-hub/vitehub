import { defineCapability } from "../capability-runtime.ts"
import { requirePrimitive } from "./storage/shared.ts"

import type {
  AgentCapabilityContext,
  AgentCapabilityDefinition,
  AgentCapabilityTypeContract,
  AgentRuntimeConfig,
  AgentTriggerDefinition,
  MaybePromise,
} from "../types.ts"
import type { RepositoryHostClient, RepositoryHostProvider, RepositoryHostTarget } from "./repository-host.ts"
import type { WorkspaceName } from "@vite-hub/workspace"

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[]

export interface JsonObject {
  [key: string]: JsonValue | undefined
}

export interface AsyncRecord<T extends { [K in keyof T]: JsonValue | undefined }> {
  keys(): Promise<readonly (keyof T & string)[]>
  has<K extends keyof T & string>(key: K): Promise<boolean>
  has(key: string): Promise<boolean>
  get<K extends keyof T & string>(key: K): Promise<T[K] | undefined>
  get(key: string): Promise<T[keyof T] | undefined>
  pick<const K extends readonly (keyof T & string)[]>(keys: K): Promise<Partial<Pick<T, K[number]>>>
  pick(keys: readonly string[]): Promise<Partial<T>>
  entries(keys?: readonly (keyof T & string)[]): AsyncIterable<readonly [keyof T & string, T[keyof T & string]]>
  entries(keys?: readonly string[]): AsyncIterable<readonly [keyof T & string, T[keyof T & string]]>
  resolveAll(): Promise<Partial<T>>
  toJSON(): never
}

export interface PullRequestContextUser extends JsonObject {
  id?: number | string
  login?: string
  type?: string
}

export interface PullRequestContextComment extends JsonObject {
  authorAssociation?: string
  body?: string
  createdAt?: string
  htmlUrl?: string
  id?: number | string
  nodeId?: string
  updatedAt?: string
  user?: PullRequestContextUser
}

export interface PullRequestContextFile extends JsonObject {
  additions?: number | string
  deletions?: number | string
  filename?: string
  status?: string
}

export interface PullRequestContextRef extends JsonObject {
  ref?: string
  repo?: string
  sha?: string
}

export interface PullRequestContextMetadata extends JsonObject {
  omittedComments?: number | string
  omittedFiles?: number | string
  unavailable?: string
}

export interface PullRequestContextValue extends JsonObject {
  actor?: string
  apiUrl?: string
  base?: PullRequestContextRef
  baseRef?: string
  body?: string
  comments?: PullRequestContextComment[]
  deliveryId?: string
  files?: PullRequestContextFile[]
  head?: PullRequestContextRef
  headRef?: string
  htmlUrl?: string
  id?: number | string
  labels?: string[]
  metadata?: PullRequestContextMetadata
  number: number | string
  provider?: string
  repository: string
  run?: JsonObject & {
    messageId?: string
    origin?: string
    runId?: string
    threadId?: string
  }
  source?: JsonObject & {
    mount?: string
    ref?: string
    repo?: string
  }
  title?: string
  trigger?: JsonObject & {
    action?: string
    actor?: PullRequestContextUser
    args?: string
    command?: string
    comment?: PullRequestContextComment
    deliveryId?: string
    event?: string
    installationId?: number | string
    sender?: PullRequestContextUser
  }
}

export interface RepositoryHostIssueContext extends JsonObject {
  apiUrl?: string
  body?: string
  htmlUrl?: string
  id?: number | string
  labels?: string[]
  nodeId?: string
  number: number | string
  pullRequest?: JsonObject & {
    apiUrl?: string
    htmlUrl?: string
  }
  repository?: string
  state?: string
  title?: string
  user?: PullRequestContextUser
}

export interface RepositoryHostContextValue {
  body?: string
  comments?: PullRequestContextComment[]
  files?: PullRequestContextFile[]
  issue?: RepositoryHostIssueContext
  labels?: string[]
  pullRequest?: PullRequestContextValue
}

interface RepositoryHostIssueContextInput extends Omit<RepositoryHostIssueContext, "labels"> {
  labels?: JsonValue[]
}

type RepositoryHostContextStaticInput = Partial<Omit<RepositoryHostContextValue, "issue" | "labels"> & {
  issue?: RepositoryHostIssueContextInput
  labels?: JsonValue[]
}>

export type RepositoryHostContextInput = RepositoryHostContextStaticInput | PullRequestContextValue

export type RepositoryHostContextTargetValue = number | string | RepositoryHostTarget | (JsonObject & {
  number?: number | string
})

export interface RepositoryHostContextTarget {
  host?: string
  issue?: RepositoryHostContextTargetValue
  number?: number | string
  owner?: string
  pullRequest?: RepositoryHostContextTargetValue
  repo?: string
  repository?: string
}

export type RepositoryHostContextResolver<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> = (context: AgentCapabilityContext<TRuntimeConfig, Name>) => MaybePromise<RepositoryHostContextInput | false | null | undefined>

export type RepositoryHostContextTargetResolver<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> = (context: AgentCapabilityContext<TRuntimeConfig, Name>) => MaybePromise<RepositoryHostContextTarget | false | null | undefined>

export interface RepositoryHostContextOptions<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> {
  client?: RepositoryHostClient | ((context: AgentCapabilityContext<TRuntimeConfig, Name>) => MaybePromise<RepositoryHostClient>)
  context?: RepositoryHostContextInput | RepositoryHostContextResolver<TRuntimeConfig, Name>
  contextKey?: string
  id?: string
  provider?: RepositoryHostProvider
  target?: RepositoryHostContextTarget | RepositoryHostContextTargetResolver<TRuntimeConfig, Name>
  triggers?: Record<string, AgentTriggerDefinition<TRuntimeConfig, Name, any, any>>
}

type RepositoryHostContextCapabilityTypeContract<
  TContextKey extends string = "repositoryHost",
> = AgentCapabilityTypeContract & {
  invocationContext: Record<TContextKey, AsyncRecord<RepositoryHostContextValue>>
}

const defaultRepositoryHostContextId = "repository-host-context"
const defaultRepositoryHostContextKey = "repositoryHost"
const repositoryHostContextKeys = ["issue", "pullRequest", "body", "labels", "comments", "files"] as const

type RepositoryHostContextKey = typeof repositoryHostContextKeys[number]
type ContextReader = {
  get: (key: string) => unknown
  has?: (key: string) => boolean
}

async function resolveMaybeFunction<TValue, TRuntimeConfig extends AgentRuntimeConfig, Name extends WorkspaceName>(
  value: TValue | ((context: AgentCapabilityContext<TRuntimeConfig, Name>) => MaybePromise<TValue | false | null | undefined>) | undefined,
  context: AgentCapabilityContext<TRuntimeConfig, Name>,
): Promise<TValue | false | null | undefined> {
  const resolved = typeof value === "function"
    ? await (value as (context: AgentCapabilityContext<TRuntimeConfig, Name>) => MaybePromise<TValue | false | null | undefined>)(context)
    : value
  return resolved
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function maybeString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}

function maybeContextValue(value: unknown): number | string | undefined {
  return typeof value === "number" || typeof value === "string" ? value : undefined
}

function maybeStrings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return
  const items = value.filter((item): item is string => typeof item === "string" && !!item)
  return items.length ? items : undefined
}

function normalizedLabelNames(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return
  const labels = value.flatMap((item) => {
    if (typeof item === "string" && item) return [item]
    if (isRecord(item) && maybeString(item.name)) return [maybeString(item.name)!]
    return []
  })
  return labels.length ? labels : value.length === 0 ? [] : undefined
}

function isPresent<T>(value: T | undefined): value is T {
  return value !== undefined
}

function normalizedRepositoryFullName(value: unknown): string | undefined {
  if (typeof value === "string" && value) return value
  return isRecord(value) ? maybeString(value.fullName) || maybeString(value.full_name) : undefined
}

function normalizedRef(value: unknown): PullRequestContextRef | undefined {
  if (!isRecord(value)) return
  const ref = maybeString(value.ref)
  const repo = normalizedRepositoryFullName(value.repo) || maybeString(value.repo)
  const sha = maybeString(value.sha)
  if (!ref && !repo && !sha) return
  return {
    ...(ref ? { ref } : {}),
    ...(repo ? { repo } : {}),
    ...(sha ? { sha } : {}),
  }
}

function normalizedFlatRef(value: unknown, fallbackRef: string | undefined): PullRequestContextRef | undefined {
  return normalizedRef(value) || (fallbackRef ? { ref: fallbackRef } : undefined)
}

function normalizedUser(value: unknown): PullRequestContextUser | undefined {
  if (!isRecord(value)) return
  const id = maybeContextValue(value.id)
  const login = maybeString(value.login)
  const type = maybeString(value.type)
  if (id === undefined && !login && !type) return
  return {
    ...(id !== undefined ? { id } : {}),
    ...(login ? { login } : {}),
    ...(type ? { type } : {}),
  }
}

function normalizedComment(value: unknown): PullRequestContextComment | undefined {
  if (!isRecord(value)) return
  const id = maybeContextValue(value.id)
  const body = maybeString(value.body)
  const user = normalizedUser(value.user)
  if (id === undefined && !body && !user) return
  return {
    ...(maybeString(value.authorAssociation) ? { authorAssociation: maybeString(value.authorAssociation) } : {}),
    ...(maybeString(value.author_association) ? { authorAssociation: maybeString(value.author_association) } : {}),
    ...(body ? { body } : {}),
    ...(maybeString(value.createdAt) ? { createdAt: maybeString(value.createdAt) } : {}),
    ...(maybeString(value.created_at) ? { createdAt: maybeString(value.created_at) } : {}),
    ...(maybeString(value.htmlUrl) ? { htmlUrl: maybeString(value.htmlUrl) } : {}),
    ...(maybeString(value.html_url) ? { htmlUrl: maybeString(value.html_url) } : {}),
    ...(id !== undefined ? { id } : {}),
    ...(maybeString(value.nodeId) ? { nodeId: maybeString(value.nodeId) } : {}),
    ...(maybeString(value.node_id) ? { nodeId: maybeString(value.node_id) } : {}),
    ...(maybeString(value.updatedAt) ? { updatedAt: maybeString(value.updatedAt) } : {}),
    ...(maybeString(value.updated_at) ? { updatedAt: maybeString(value.updated_at) } : {}),
    ...(user ? { user } : {}),
  }
}

function normalizedComments(value: unknown): PullRequestContextComment[] | undefined {
  if (!Array.isArray(value)) return
  const comments = value.map(normalizedComment).filter(isPresent)
  return comments.length ? comments : []
}

function normalizedFile(value: unknown): PullRequestContextFile | undefined {
  if (!isRecord(value)) return
  const filename = maybeString(value.filename)
  if (!filename) return
  return {
    ...(maybeContextValue(value.additions) !== undefined ? { additions: maybeContextValue(value.additions) } : {}),
    ...(maybeContextValue(value.deletions) !== undefined ? { deletions: maybeContextValue(value.deletions) } : {}),
    filename,
    ...(maybeString(value.status) ? { status: maybeString(value.status) } : {}),
  }
}

function normalizedFiles(value: unknown): PullRequestContextFile[] | undefined {
  if (!Array.isArray(value)) return
  const files = value.map(normalizedFile).filter(isPresent)
  return files.length ? files : []
}

function normalizedMetadata(value: unknown): PullRequestContextMetadata | undefined {
  if (!isRecord(value)) return
  const omittedComments = maybeContextValue(value.omittedComments)
  const omittedFiles = maybeContextValue(value.omittedFiles)
  const unavailable = maybeString(value.unavailable)
  if (omittedComments === undefined && omittedFiles === undefined && !unavailable) return
  return {
    ...(omittedComments !== undefined ? { omittedComments } : {}),
    ...(omittedFiles !== undefined ? { omittedFiles } : {}),
    ...(unavailable ? { unavailable } : {}),
  }
}

function normalizedRun(value: unknown): PullRequestContextValue["run"] | undefined {
  if (!isRecord(value)) return
  const messageId = maybeString(value.messageId)
  const origin = maybeString(value.origin)
  const runId = maybeString(value.runId)
  const threadId = maybeString(value.threadId)
  if (!messageId && !origin && !runId && !threadId) return
  return {
    ...(messageId ? { messageId } : {}),
    ...(origin ? { origin } : {}),
    ...(runId ? { runId } : {}),
    ...(threadId ? { threadId } : {}),
  }
}

function normalizedSource(value: unknown): PullRequestContextValue["source"] | undefined {
  if (!isRecord(value)) return
  const mount = maybeString(value.mount)
  const ref = maybeString(value.ref)
  const repo = maybeString(value.repo)
  if (!mount && !ref && !repo) return
  return {
    ...(mount ? { mount } : {}),
    ...(ref ? { ref } : {}),
    ...(repo ? { repo } : {}),
  }
}

function normalizedTrigger(value: unknown): PullRequestContextValue["trigger"] | undefined {
  if (!isRecord(value)) return
  const action = maybeString(value.action)
  const actor = normalizedUser(value.actor)
  const args = maybeString(value.args)
  const command = maybeString(value.command)
  const comment = normalizedComment(value.comment)
  const deliveryId = maybeString(value.deliveryId)
  const event = maybeString(value.event)
  const installationId = maybeContextValue(value.installationId)
  const sender = normalizedUser(value.sender)
  if (!action && !actor && !args && !command && !comment && !deliveryId && !event && installationId === undefined && !sender) return
  return {
    ...(action ? { action } : {}),
    ...(actor ? { actor } : {}),
    ...(args ? { args } : {}),
    ...(command ? { command } : {}),
    ...(comment ? { comment } : {}),
    ...(deliveryId ? { deliveryId } : {}),
    ...(event ? { event } : {}),
    ...(installationId !== undefined ? { installationId } : {}),
    ...(sender ? { sender } : {}),
  }
}

function normalizePullRequestContext(value: unknown): PullRequestContextValue | undefined {
  if (!isRecord(value)) return

  const pullRequest = isRecord(value.pullRequest)
    ? value.pullRequest
    : isRecord(value.pull_request)
      ? value.pull_request
      : undefined
  const repository = isRecord(value.repository) ? value.repository : undefined
  const number = maybeContextValue(pullRequest?.number)
  const repositoryName = normalizedRepositoryFullName(repository)
  if (pullRequest && number !== undefined && repositoryName) {
    const comments = normalizedComments(pullRequest.comments)
    const files = normalizedFiles(pullRequest.files)
    const labels = normalizedLabelNames(pullRequest.labels) || maybeStrings(pullRequest.labels)
    const metadata = normalizedMetadata(pullRequest.metadata)
    const base = normalizedRef(pullRequest.base)
    const head = normalizedRef(pullRequest.head)
    const source = normalizedSource(pullRequest.source)
    const trigger = normalizedTrigger(value.trigger)
    const actor = trigger?.actor?.login
    const deliveryId = trigger?.deliveryId

    return {
      ...(actor ? { actor } : {}),
      ...(maybeString(pullRequest.apiUrl) ? { apiUrl: maybeString(pullRequest.apiUrl) } : {}),
      ...(maybeString(pullRequest.url) ? { apiUrl: maybeString(pullRequest.url) } : {}),
      ...(base ? { base } : {}),
      ...(base?.ref ? { baseRef: base.ref } : {}),
      ...(maybeString(pullRequest.body) ? { body: maybeString(pullRequest.body) } : {}),
      ...(comments !== undefined ? { comments } : {}),
      ...(deliveryId ? { deliveryId } : {}),
      ...(files !== undefined ? { files } : {}),
      ...(head ? { head } : {}),
      ...(source?.ref || head?.ref ? { headRef: source?.ref || head?.ref } : {}),
      ...(maybeString(pullRequest.htmlUrl) ? { htmlUrl: maybeString(pullRequest.htmlUrl) } : {}),
      ...(maybeString(pullRequest.html_url) ? { htmlUrl: maybeString(pullRequest.html_url) } : {}),
      ...(maybeContextValue(pullRequest.id) !== undefined ? { id: maybeContextValue(pullRequest.id) } : {}),
      ...(labels ? { labels } : {}),
      ...(metadata ? { metadata } : {}),
      number,
      provider: maybeString(value.provider) || "github",
      repository: repositoryName,
      ...(normalizedRun(value.run) ? { run: normalizedRun(value.run) } : {}),
      ...(source ? { source } : {}),
      ...(maybeString(pullRequest.title) ? { title: maybeString(pullRequest.title) } : {}),
      ...(trigger ? { trigger } : {}),
    }
  }

  const flatNumber = maybeContextValue(value.number)
  const flatRepository = normalizedRepositoryFullName(value.repository)
  if (flatNumber !== undefined && flatRepository) {
    const base = normalizedFlatRef(value.base, maybeString(value.baseRef))
    const comments = normalizedComments(value.comments)
    const files = normalizedFiles(value.files)
    const head = normalizedFlatRef(value.head, maybeString(value.headRef))
    const labels = normalizedLabelNames(value.labels) || maybeStrings(value.labels)
    const metadata = normalizedMetadata(value.metadata)
    const run = normalizedRun(value.run)
    const source = normalizedSource(value.source)
    const trigger = {
      ...(normalizedTrigger(value.trigger) || {}),
      ...(maybeString(value.actor) ? { actor: { login: maybeString(value.actor) } } : {}),
      ...(maybeString(value.deliveryId) ? { deliveryId: maybeString(value.deliveryId) } : {}),
    }
    const actor = trigger.actor?.login
    const deliveryId = trigger.deliveryId
    return {
      ...(actor ? { actor } : {}),
      ...(maybeString(value.apiUrl) ? { apiUrl: maybeString(value.apiUrl) } : {}),
      ...(maybeString(value.url) ? { apiUrl: maybeString(value.url) } : {}),
      ...(base ? { base } : {}),
      ...(base?.ref ? { baseRef: base.ref } : {}),
      ...(maybeString(value.body) ? { body: maybeString(value.body) } : {}),
      ...(comments !== undefined ? { comments } : {}),
      ...(deliveryId ? { deliveryId } : {}),
      ...(files !== undefined ? { files } : {}),
      ...(head ? { head } : {}),
      ...(source?.ref || head?.ref ? { headRef: source?.ref || head?.ref } : {}),
      ...(maybeString(value.htmlUrl) ? { htmlUrl: maybeString(value.htmlUrl) } : {}),
      ...(maybeString(value.html_url) ? { htmlUrl: maybeString(value.html_url) } : {}),
      ...(maybeContextValue(value.id) !== undefined ? { id: maybeContextValue(value.id) } : {}),
      ...(labels ? { labels } : {}),
      ...(metadata ? { metadata } : {}),
      number: flatNumber,
      ...(maybeString(value.provider) ? { provider: maybeString(value.provider) } : {}),
      repository: flatRepository,
      ...(run ? { run } : {}),
      ...(source ? { source } : {}),
      ...(maybeString(value.title) ? { title: maybeString(value.title) } : {}),
      ...(Object.keys(trigger).length ? { trigger } : {}),
    }
  }

}

function normalizeHostIssue(value: unknown, fallback: { number?: number | string, repository?: string } = {}): RepositoryHostIssueContext | undefined {
  if (!isRecord(value)) return
  const number = maybeContextValue(value.number) ?? fallback.number
  if (number === undefined) return
  const pullRequest = isRecord(value.pullRequest)
    ? value.pullRequest
    : isRecord(value.pull_request)
      ? value.pull_request
      : undefined
  const repository = normalizedRepositoryFullName(value.repository) || fallback.repository
  return {
    ...(maybeString(value.apiUrl) ? { apiUrl: maybeString(value.apiUrl) } : {}),
    ...(maybeString(value.url) ? { apiUrl: maybeString(value.url) } : {}),
    ...(maybeString(value.body) ? { body: maybeString(value.body) } : {}),
    ...(maybeString(value.htmlUrl) ? { htmlUrl: maybeString(value.htmlUrl) } : {}),
    ...(maybeString(value.html_url) ? { htmlUrl: maybeString(value.html_url) } : {}),
    ...(maybeContextValue(value.id) !== undefined ? { id: maybeContextValue(value.id) } : {}),
    ...(normalizedLabelNames(value.labels) ? { labels: normalizedLabelNames(value.labels) } : {}),
    ...(maybeString(value.nodeId) ? { nodeId: maybeString(value.nodeId) } : {}),
    ...(maybeString(value.node_id) ? { nodeId: maybeString(value.node_id) } : {}),
    number,
    ...(pullRequest ? {
      pullRequest: {
        ...(maybeString(pullRequest.apiUrl) ? { apiUrl: maybeString(pullRequest.apiUrl) } : {}),
        ...(maybeString(pullRequest.url) ? { apiUrl: maybeString(pullRequest.url) } : {}),
        ...(maybeString(pullRequest.htmlUrl) ? { htmlUrl: maybeString(pullRequest.htmlUrl) } : {}),
        ...(maybeString(pullRequest.html_url) ? { htmlUrl: maybeString(pullRequest.html_url) } : {}),
      },
    } : {}),
    ...(repository ? { repository } : {}),
    ...(maybeString(value.state) ? { state: maybeString(value.state) } : {}),
    ...(maybeString(value.title) ? { title: maybeString(value.title) } : {}),
    ...(normalizedUser(value.user) ? { user: normalizedUser(value.user) } : {}),
  }
}

function normalizeHostPullRequest(value: unknown, fallback: { issue?: RepositoryHostIssueContext, number?: number | string, repository?: string }): PullRequestContextValue | undefined {
  const normalized = normalizePullRequestContext(value)
  if (normalized) return normalized
  if (!isRecord(value)) {
    if (!fallback.issue?.pullRequest || fallback.number === undefined || !fallback.repository) return
    return {
      ...(fallback.issue.pullRequest.apiUrl ? { apiUrl: fallback.issue.pullRequest.apiUrl } : {}),
      ...(fallback.issue.body ? { body: fallback.issue.body } : {}),
      ...(fallback.issue.pullRequest.htmlUrl || fallback.issue.htmlUrl ? { htmlUrl: fallback.issue.pullRequest.htmlUrl || fallback.issue.htmlUrl } : {}),
      ...(fallback.issue.labels ? { labels: fallback.issue.labels } : {}),
      number: fallback.number,
      provider: "github",
      repository: fallback.repository,
      ...(fallback.issue.title ? { title: fallback.issue.title } : {}),
    }
  }
  const number = maybeContextValue(value.number) ?? fallback.number
  const repository = normalizedRepositoryFullName(value.repository) || fallback.repository
  if (number === undefined || !repository) return
  const base = normalizedRef(value.base)
  const head = normalizedRef(value.head)
  const source = normalizedSource(value.source) || (head?.repo
    ? {
        ...(head.ref ? { ref: head.ref } : {}),
        repo: head.repo,
      }
    : undefined)
  const labels = normalizedLabelNames(value.labels) || fallback.issue?.labels
  return {
    ...(maybeString(value.apiUrl) ? { apiUrl: maybeString(value.apiUrl) } : {}),
    ...(maybeString(value.url) ? { apiUrl: maybeString(value.url) } : {}),
    ...(!maybeString(value.apiUrl) && !maybeString(value.url) && fallback.issue?.pullRequest?.apiUrl ? { apiUrl: fallback.issue.pullRequest.apiUrl } : {}),
    ...(base ? { base } : {}),
    ...(base?.ref ? { baseRef: base.ref } : {}),
    ...(maybeString(value.body) || fallback.issue?.body ? { body: maybeString(value.body) || fallback.issue!.body! } : {}),
    ...(head ? { head } : {}),
    ...(source?.ref || head?.ref ? { headRef: source?.ref || head?.ref } : {}),
    ...(maybeString(value.htmlUrl) ? { htmlUrl: maybeString(value.htmlUrl) } : {}),
    ...(maybeString(value.html_url) || fallback.issue?.pullRequest?.htmlUrl ? { htmlUrl: maybeString(value.html_url) || fallback.issue!.pullRequest!.htmlUrl! } : {}),
    ...(maybeContextValue(value.id) !== undefined ? { id: maybeContextValue(value.id) } : {}),
    ...(labels ? { labels } : {}),
    number,
    provider: "github",
    repository,
    ...(source ? { source } : {}),
    ...(maybeString(value.title) || fallback.issue?.title ? { title: maybeString(value.title) || fallback.issue!.title! } : {}),
  }
}

export function readPullRequestContext(context: unknown, contextKey = "pullRequest"): PullRequestContextValue | undefined {
  if (isRecord(context) && isRecord(context.context) && typeof context.context.get === "function") {
    return normalizePullRequestContext(context.context.get(contextKey))
  }
  if (isRecord(context) && typeof context.get === "function") {
    return normalizePullRequestContext(context.get(contextKey))
  }
  return normalizePullRequestContext(context)
}

function isAsyncRecord(value: unknown): value is AsyncRecord<RepositoryHostContextValue> {
  return isRecord(value)
    && typeof value.keys === "function"
    && typeof value.get === "function"
    && typeof value.pick === "function"
    && typeof value.entries === "function"
    && typeof value.resolveAll === "function"
}

function createAsyncRecord<T extends { [K in keyof T]: JsonValue | undefined }, K extends keyof T & string>(
  label: string,
  knownKeys: readonly K[],
  resolveKeys: () => MaybePromise<readonly K[]>,
  loaders: Record<K, () => MaybePromise<T[K] | undefined>>,
): AsyncRecord<T> {
  const known = new Set<string>(knownKeys)
  const loads = new Map<K, Promise<T[K] | undefined>>()
  let keysPromise: Promise<readonly K[]> | undefined

  function assertKey(key: string): K {
    if (!known.has(key)) {
      throw new Error(`[vitehub] Unknown ${label} key "${key}". Known keys: ${knownKeys.join(", ")}.`)
    }
    return key as K
  }

  async function load(key: K): Promise<T[K] | undefined> {
    let promise = loads.get(key)
    if (!promise) {
      promise = Promise.resolve().then(() => loaders[key]()).catch((error) => {
        loads.delete(key)
        throw error
      })
      loads.set(key, promise)
    }
    return promise
  }

  const record = {
    async keys() {
      keysPromise ??= Promise.resolve().then(resolveKeys).then(keys => keys.map(assertKey)).catch((error) => {
        keysPromise = undefined
        throw error
      })
      return keysPromise
    },
    async has(key: string) {
      return await record.get(key) !== undefined
    },
    async get(key: string) {
      return load(assertKey(key))
    },
    async pick(keys: readonly string[]) {
      const result: Partial<T> = {}
      for (const key of keys) {
        const knownKey = assertKey(key)
        const value = await load(knownKey)
        if (value !== undefined) result[knownKey] = value
      }
      return result
    },
    async *entries(keys?: readonly string[]) {
      const selected = keys || await record.keys()
      for (const key of selected) {
        const knownKey = assertKey(key)
        const value = await load(knownKey)
        if (value !== undefined) yield [knownKey, value] as const
      }
    },
    async resolveAll() {
      return record.pick(await record.keys())
    },
    toJSON(): never {
      throw new Error("[vitehub] AsyncRecord values are async. Call resolveAll() before JSON.stringify().")
    },
  }
  return record as AsyncRecord<T>
}

function contextReader(input: unknown): ContextReader | undefined {
  if (isRecord(input) && isRecord(input.context) && typeof input.context.get === "function") return input.context as ContextReader
  if (isRecord(input) && typeof input.get === "function") return input as ContextReader
}

function repositoryHostContextValues(input: unknown): Partial<RepositoryHostContextValue> {
  const store = contextReader(input)
  const record = isRecord(input) ? input : undefined
  const rootRepository = normalizedRepositoryFullName(record?.repository)
  const rawIssue = record?.issue ?? store?.get("issue")
  const rawPullRequest = record?.pullRequest ?? record?.pull_request ?? store?.get("pullRequest") ?? (record?.issue ? undefined : input)
  const directPullRequest = readPullRequestContext(rawPullRequest)
  const issue = normalizeHostIssue(rawIssue, {
    number: directPullRequest?.number,
    repository: directPullRequest?.repository || rootRepository,
  }) || (directPullRequest ? normalizeHostIssue({
    body: directPullRequest.body,
    htmlUrl: directPullRequest.htmlUrl,
    labels: directPullRequest.labels,
    number: directPullRequest.number,
    pullRequest: { htmlUrl: directPullRequest.htmlUrl, url: directPullRequest.apiUrl },
    title: directPullRequest.title,
  }, { number: directPullRequest.number, repository: directPullRequest.repository }) : undefined)
  const pullRequest = directPullRequest || normalizeHostPullRequest(rawPullRequest, {
    issue,
    number: issue?.number,
    repository: issue?.repository || rootRepository,
  })

  return {
    ...(issue ? { issue } : {}),
    ...(pullRequest ? { pullRequest } : {}),
    ...(record?.body !== undefined ? { body: maybeString(record.body) } : issue?.body || pullRequest?.body ? { body: issue?.body || pullRequest?.body } : {}),
    ...(record?.labels !== undefined ? { labels: normalizedLabelNames(record.labels) || maybeStrings(record.labels) } : issue?.labels || pullRequest?.labels ? { labels: issue?.labels || pullRequest?.labels } : {}),
    ...(record?.comments !== undefined ? { comments: normalizedComments(record.comments) } : pullRequest?.comments !== undefined ? { comments: pullRequest.comments } : {}),
    ...(record?.files !== undefined ? { files: normalizedFiles(record.files) } : pullRequest?.files !== undefined ? { files: pullRequest.files } : {}),
  }
}

function staticRepositoryHostRecord(input: unknown): AsyncRecord<RepositoryHostContextValue> {
  const values = repositoryHostContextValues(input)
  return createAsyncRecord<RepositoryHostContextValue, RepositoryHostContextKey>(
    "repositoryHostContext()",
    repositoryHostContextKeys,
    () => repositoryHostContextKeys.filter(key => values[key] !== undefined),
    {
      body: () => values.body,
      comments: () => values.comments,
      files: () => values.files,
      issue: () => values.issue,
      labels: () => values.labels,
      pullRequest: () => values.pullRequest,
    },
  )
}

function repositoryParts(target: RepositoryHostContextTarget, nested?: Record<string, unknown>) {
  const rawRepo = maybeString(nested?.repository) || maybeString(target.repository) || maybeString(target.repo)
  const owner = maybeString(nested?.owner) || maybeString(target.owner)
  if (!rawRepo) throw new TypeError("[vitehub] repositoryHostContext() target requires repo or repository.")
  if (rawRepo.includes("/") && !owner) {
    const [repoOwner, repoName] = rawRepo.split("/", 2)
    return { owner: repoOwner, repository: repoName!, repositoryFullName: rawRepo }
  }
  return {
    ...(owner ? { owner } : {}),
    repository: rawRepo,
    repositoryFullName: owner ? `${owner}/${rawRepo}` : rawRepo,
  }
}

function targetValueRecord(value: RepositoryHostContextTargetValue | undefined): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

function targetValueId(value: RepositoryHostContextTargetValue | undefined): number | string | undefined {
  if (typeof value === "number" || typeof value === "string") return value
  if (!isRecord(value)) return
  return maybeContextValue(value.id) ?? maybeContextValue(value.number)
}

function normalizedTarget(input: RepositoryHostContextTarget) {
  const raw = input.pullRequest ?? input.issue ?? input.number
  const nested = targetValueRecord(raw)
  const id = targetValueId(raw)
  if (id === undefined) throw new TypeError("[vitehub] repositoryHostContext() target requires number, issue, or pullRequest.")
  const repository = repositoryParts(input, nested)
  const { repositoryFullName, ...repositoryTarget } = repository
  const base = {
    ...(maybeString(nested?.host) || input.host ? { host: maybeString(nested?.host) || input.host } : {}),
    id,
    ...repositoryTarget,
  }
  return {
    explicitPullRequest: input.pullRequest !== undefined,
    issue: { ...base, kind: "issue" as const },
    number: id,
    pullRequest: { ...base, kind: "changeRequest" as const },
    repositoryFullName,
  }
}

async function resolveRepositoryHostContextClient<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(options: RepositoryHostContextOptions<TRuntimeConfig, Name>, context: AgentCapabilityContext<TRuntimeConfig, Name>): Promise<RepositoryHostClient> {
  const client = options.client
    ? typeof options.client === "function" ? await options.client(context) : options.client
    : requirePrimitive(context, "repository-host")
  if (!client || typeof client !== "object" || typeof (client as RepositoryHostClient).read !== "function") {
    throw new Error("[vitehub] repositoryHostContext() requires a Repository Host client with read().")
  }
  const provider = options.provider || (client as RepositoryHostClient).provider
  if (provider && provider !== "github") {
    throw new Error("[vitehub] repositoryHostContext() supports GitHub targets in V1.")
  }
  return client as RepositoryHostClient
}

function targetRepositoryHostRecord(client: RepositoryHostClient, target: RepositoryHostContextTarget): AsyncRecord<RepositoryHostContextValue> {
  const normalized = normalizedTarget(target)
  let issuePromise: Promise<RepositoryHostIssueContext | undefined> | undefined
  let pullRequestPromise: Promise<PullRequestContextValue | undefined> | undefined

  function loadIssue() {
    issuePromise ??= Promise.resolve(client.read({
      operation: "issue",
      target: normalized.issue,
    })).then(value => normalizeHostIssue(value, {
      number: normalized.number,
      repository: normalized.repositoryFullName,
    })).catch((error) => {
      issuePromise = undefined
      throw error
    })
    return issuePromise
  }

  async function loadPullRequest() {
    if (!pullRequestPromise) {
      pullRequestPromise = (async () => {
        const issue = await loadIssue()
        if (!normalized.explicitPullRequest && !issue?.pullRequest) return
        const value = await client.read({
          operation: "changeRequest",
          target: normalized.pullRequest,
        })
        return normalizeHostPullRequest(value, {
          issue,
          number: normalized.number,
          repository: normalized.repositoryFullName,
        })
      })().catch((error) => {
        pullRequestPromise = undefined
        throw error
      })
    }
    return pullRequestPromise
  }

  return createAsyncRecord<RepositoryHostContextValue, RepositoryHostContextKey>(
    "repositoryHostContext()",
    repositoryHostContextKeys,
    async () => {
      const issue = await loadIssue()
      return [
        "issue",
        "body",
        "labels",
        "comments",
        ...(normalized.explicitPullRequest || issue?.pullRequest ? ["pullRequest", "files"] as const : []),
      ]
    },
    {
      body: async () => (await loadIssue())?.body ?? (await loadPullRequest())?.body,
      comments: async () => normalizedComments(await client.read({
        operation: "comments",
        target: normalized.issue,
      })),
      files: async () => {
        if (!await loadPullRequest()) return
        return normalizedFiles(await client.read({
          operation: "changeRequestFiles",
          target: normalized.pullRequest,
        }))
      },
      issue: loadIssue,
      labels: async () => (await loadIssue())?.labels ?? (await loadPullRequest())?.labels,
      pullRequest: loadPullRequest,
    },
  )
}

export function readRepositoryHostContext(input: unknown, contextKey: string = defaultRepositoryHostContextKey): AsyncRecord<RepositoryHostContextValue> {
  if (isAsyncRecord(input)) return input
  const store = contextReader(input)
  if (store) {
    const value = store.get(contextKey)
    if (isAsyncRecord(value)) return value
    return staticRepositoryHostRecord(value ?? (contextKey === defaultRepositoryHostContextKey ? input : undefined))
  }
  const value = isRecord(input) ? input[contextKey] : undefined
  if (isAsyncRecord(value)) return value
  return staticRepositoryHostRecord(value ?? (contextKey === defaultRepositoryHostContextKey ? input : undefined))
}

export interface RepositoryHostContextCapabilityFactory {
  <
    TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
    Name extends WorkspaceName = WorkspaceName,
    const TContextKey extends string = "repositoryHost",
  >(
    options?: RepositoryHostContextOptions<TRuntimeConfig, Name> & { contextKey?: TContextKey },
  ): AgentCapabilityDefinition<TRuntimeConfig, Name, RepositoryHostContextCapabilityTypeContract<TContextKey>>
  read(input: unknown, contextKey?: string): AsyncRecord<RepositoryHostContextValue>
}

function createRepositoryHostContext<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
  const TContextKey extends string = "repositoryHost",
>(
  options: RepositoryHostContextOptions<TRuntimeConfig, Name> & { contextKey?: TContextKey } = {},
): AgentCapabilityDefinition<TRuntimeConfig, Name, RepositoryHostContextCapabilityTypeContract<TContextKey>> {
  const capabilityId = options.id || defaultRepositoryHostContextId
  const contextKey = options.contextKey || defaultRepositoryHostContextKey
  const recordedContexts = new WeakSet<AgentCapabilityContext<TRuntimeConfig, Name>["context"]>()

  async function recordContext(context: AgentCapabilityContext<TRuntimeConfig, Name>) {
    if (recordedContexts.has(context.context)) return
    const hasContextOption = "context" in options
    const hasTargetOption = "target" in options
    const input = await resolveMaybeFunction(options.context, context)
    const target = await resolveMaybeFunction(options.target, context)
    const existing = context.context.get(contextKey)
    if (existing !== undefined) {
      if (!isAsyncRecord(existing)) {
        context.context.set(contextKey, staticRepositoryHostRecord(existing), { overwrite: true })
      }
      recordedContexts.add(context.context)
      return
    }
    if (target === false || target === null || target === undefined) {
      if ((hasContextOption || hasTargetOption) && (input === false || input === null || input === undefined)) {
        return
      }
    }
    const value = target
      ? targetRepositoryHostRecord(await resolveRepositoryHostContextClient(options, context), target)
      : staticRepositoryHostRecord(input ?? context)
    context.context.set(contextKey, value)
    recordedContexts.add(context.context)
  }

  return defineCapability({
    id: capabilityId,
    metadata: {
      contextKey,
      kind: "repository-host-context",
    },
    prepare: recordContext,
    requires: options.target && !options.client ? [{ primitive: "repository-host" }] : undefined,
    triggers: options.triggers,
  })
}

export const repositoryHostContext = Object.assign(createRepositoryHostContext, {
  read: readRepositoryHostContext,
}) as RepositoryHostContextCapabilityFactory
