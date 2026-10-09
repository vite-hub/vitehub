import type { ForgeProvider, RepoRef, Webhook, WebhookInput } from "forges"
import type { PullRequestOptions } from "../channels.ts"
import type { AgentChannelSyncPlan, AgentChannelSyncProvider } from "./channel-sync.ts"
import { agentDiagnostics } from "../agent-diagnostics.ts"
import { CodeHostResponseError, codeHostErrorStatus, codeHostProvider } from "./code-host.ts"
import { hasRuntimeType, isRuntimeRecord } from "./runtime-type.ts"

interface CodeHostChannelSyncOptions {
  host: "gitlab" | "forgejo"
  baseUrl?: string
  token?: string
  webhookSecret?: string
  repositories?: readonly string[]
  pullRequest?: boolean | PullRequestOptions
  activity?: boolean
}

// The pinned client's subscription tables also enable related issue events.
// Compare native subscriptions, since their normalized kinds overlap.
const nativeEvents = {
  gitlab: {
    comment: ["note_events", "confidential_note_events"],
    review: ["merge_requests_events"],
    review_comment: ["note_events"],
    state_change: ["issues_events", "confidential_issues_events", "merge_requests_events"],
  },
  forgejo: {
    comment: ["issue_comment", "pull_request_comment"],
    review: ["pull_request_review"],
    review_comment: ["pull_request_review"],
    state_change: ["issues", "pull_request", "pull_request_sync"],
  },
} as const

type ChannelEvent = keyof typeof nativeEvents.gitlab

function channelEvents(options: CodeHostChannelSyncOptions): ChannelEvent[] {
  const events = new Set<ChannelEvent>()
  if (options.activity) events.add("state_change")
  if (options.pullRequest) {
    events.add("comment") // Slash commands remain available with reconcile enabled.
    const reconcile = options.pullRequest === true ? undefined : options.pullRequest.reconcile
    if (reconcile) {
      if (reconcile === true || reconcile.events === undefined || reconcile.events.length) events.add("state_change")
      if (reconcile !== true) {
        const triggers = reconcile.triggers ?? [
          ...(reconcile.comments ? [{ events: reconcile.comments === true ? undefined : reconcile.comments.events }] : []),
          ...(reconcile.mentions?.length ? [{ events: undefined }] : []),
        ]
        for (const trigger of triggers) {
          for (const event of trigger.events ?? ["comment", "review", "review_comment"]) events.add(event)
        }
      }
    }
  }
  return [...events].sort()
}

// Forgejo accepts grouped subscriptions and returns the expanded delivery names.
function canonicalForgejoEvents(values: readonly string[]): string[] {
  const groups = new Map([
    ["issues", ["issues", "issue_assign", "issue_label", "issue_milestone", "issue_comment"]],
    ["pull_request", ["pull_request", "pull_request_assign", "pull_request_label", "pull_request_milestone", "pull_request_sync", "pull_request_comment", "pull_request_review_approved", "pull_request_review_rejected", "pull_request_review_comment", "pull_request_review_request"]],
    ["pull_request_review", ["pull_request_review_approved", "pull_request_review_rejected", "pull_request_review_comment"]],
  ])
  return sorted(values.flatMap(value => groups.get(value) ?? [value]))
}

function sorted(values: readonly string[]): string[] { return [...new Set(values)].sort() }
function same(values: readonly string[], expected: readonly string[]): boolean {
  return JSON.stringify(sorted(values)) === JSON.stringify(sorted(expected))
}

function repositoryNames(options: CodeHostChannelSyncOptions): string[] | undefined {
  if (options.repositories === undefined) return
  if (!Array.isArray(options.repositories) || options.repositories.length === 0) {
    throw agentDiagnostics.AGENT_R0991({ message: "Code Host sync.repositories must be a non-empty repository list." })
  }
  for (const repository of options.repositories) {
    if (!hasRuntimeType(repository, "string") || !/^[A-Za-z0-9_][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_][A-Za-z0-9_.-]*)+$/.test(repository)
      || repository.split("/").some(part => part === "." || part === ".." || part.endsWith(".git"))
      || (options.host === "forgejo" && repository.split("/").length !== 2)) {
      throw agentDiagnostics.AGENT_R0991({ message: "Code Host sync.repositories requires owner/name paths. GitLab paths can include nested groups." })
    }
  }
  return sorted(options.repositories)
}

function redact(value: string, options: CodeHostChannelSyncOptions): string {
  let result = value
  for (const secret of [options.token, options.webhookSecret]) {
    if (secret) result = result.split(secret).join("[redacted]")
  }
  return result
}

function state(hook: Webhook, options: CodeHostChannelSyncOptions) {
  return {
    id: redact(hook.ref.id, options), url: redact(hook.url, options),
    events: sorted(hook.events).map(value => redact(value, options)),
    nativeEvents: sorted(hook.nativeEvents).map(value => redact(value, options)),
    active: hook.active, contentType: hook.contentType,
  }
}

function repoRef(provider: ForgeProvider, repository: string): RepoRef {
  const parts = repository.split("/")
  return { forge: provider.kind, instance: provider.instance, name: parts.pop()!, owner: parts.join("/") }
}

async function matchingHook(provider: ForgeProvider, repository: string, url: string): Promise<Webhook | undefined> {
  const hooks: Webhook[] = []
  for await (const hook of provider.webhooks.list(repoRef(provider, repository))) {
    if (hook.url === url) hooks.push(hook)
  }
  if (hooks.length > 1) {
    throw agentDiagnostics.AGENT_R0995({ message: `Code Host webhook sync found duplicate hooks for ${repository} at the desired URL. Remove the duplicates before sync.` })
  }
  return hooks[0]
}

interface RepositoryChange {
  repository: string
  hook?: Webhook
  reasons: string[]
}

interface SyncOperation {
  url: string
  changes: RepositoryChange[]
}

/**
 * The client sends only enabled GitLab flags. GitLab enables push events by default on create
 * and keeps old flags on update, so send false for those flags unless the Channel needs them.
 */
function gitlabHookFetch(fetchImpl: typeof fetch, enabled: readonly string[]): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init)
    if (request.method !== "POST" && request.method !== "PUT") return await fetchImpl(input, init)
    const body: unknown = await request.json()
    if (!isRuntimeRecord(body)) throw new CodeHostResponseError("Invalid Code Host webhook request body.")
    const flags = Object.fromEntries(["push_events", ...enabled].map(event => [event, false]))
    return await fetchImpl(new Request(request, { method: request.method, body: JSON.stringify({ ...flags, ...body }) }))
  }
}

export function createCodeHostChannelSyncProvider(options: CodeHostChannelSyncOptions): AgentChannelSyncProvider {
  const repositories = repositoryNames(options)
  if (repositories && !options.token) {
    throw agentDiagnostics.AGENT_R0992({ message: `Code Host webhook sync requires token or ${options.host.toUpperCase()}_TOKEN.` })
  }
  if (repositories && !options.webhookSecret) {
    throw agentDiagnostics.AGENT_R0993({ message: `Code Host webhook sync requires webhookSecret or ${options.host.toUpperCase()}_WEBHOOK_SECRET.` })
  }
  let instance: string | undefined
  if (repositories) {
    try {
      const url = new URL(options.baseUrl || (options.host === "gitlab" ? "https://gitlab.com" : "https://codeberg.org"))
      if (url.username || url.password || url.search || url.hash) throw new Error("Invalid instance URL")
      instance = url.href.replace(/\/+$/, "")
    }
    catch {
      throw agentDiagnostics.AGENT_R0997({ message: "Code Host baseUrl must be an instance URL without credentials, query, or fragment." })
    }
  }
  const events = channelEvents(options)
  const subscriptions = sorted(events.flatMap(event => [...nativeEvents[options.host][event]]))
  const expectedSubscriptions = options.host === "forgejo" ? canonicalForgejoEvents(subscriptions) : subscriptions
  const operations = new WeakMap<AgentChannelSyncPlan, SyncOperation>()
  async function provider(fetchImpl: typeof fetch) {
    const value = await codeHostProvider({ host: options.host, baseUrl: options.baseUrl, token: options.token, fetch: fetchImpl })
    for (const verb of ["webhooks.list", "webhooks.create", "webhooks.update"] as const) {
      if (!value.can(verb)) throw agentDiagnostics.AGENT_R0994({ message: `Code Host cannot manage hooks with ${verb}.` })
    }
    return value
  }
  async function request<T>(run: () => Promise<T>): Promise<T> {
    try { return await run() }
    catch (error) {
      const status = codeHostErrorStatus(error)
      const message = redact(error instanceof Error ? error.message : "Unknown request error.", options).replace(/\bforges?\b/gi, "Code Host")
      throw agentDiagnostics.AGENT_R0996({ message: `Code Host webhook sync failed${status ? ` with HTTP ${status}` : ""}: ${message}` })
    }
  }
  const syncProvider: AgentChannelSyncProvider = {
    mode: "webhook",
    currentWebhookUrl: plan => operations.get(plan)?.url,
    async plan({ desiredUrl, fetch, force }) {
      if (!repositories) return {
        // No hook is read without repositories, so the plan does not claim a current or desired URL.
        action: "none", current: { repositories: [] }, desired: { repositories: [] },
        unverifiable: ["Set sync.repositories to manage Code Host webhooks.", "webhookSecret"],
      }
      if (!desiredUrl) throw agentDiagnostics.AGENT_R0997({ message: "Code Host webhook sync requires a desired URL." })
      return await request(async () => {
        const client = await provider(fetch)
        const changes: RepositoryChange[] = []
        for (const repository of repositories) {
          const hook = await matchingHook(client, repository, desiredUrl)
          if (hook && !hook.active && options.host === "gitlab") {
            throw new CodeHostResponseError("GitLab webhook is auto-disabled. Re-enable it with a successful test request in GitLab, then run sync again.")
          }
          const reasons = !hook ? ["create webhook"] : [
            ...(!same(hook.nativeEvents, expectedSubscriptions) ? ["update events"] : []),
            ...(!hook.active ? ["activate webhook"] : []),
            ...(options.host === "forgejo" && hook.contentType !== "json" ? ["use JSON content type"] : []),
            ...(force ? ["resend webhookSecret"] : []),
          ]
          changes.push({ repository, hook, reasons })
        }
        const modified = changes.filter(change => change.reasons.length)
        const plan: AgentChannelSyncPlan = {
          action: modified.some(change => change.hook) ? "update" : modified.length ? "create" : "none",
          current: {
            url: changes.some(change => change.hook) ? redact(desiredUrl, options) : "",
            repositories: changes.map(change => ({ repository: redact(change.repository, options), hook: change.hook ? state(change.hook, options) : null })),
          },
          desired: {
            url: redact(desiredUrl, options), token: "configured", webhookSecret: "configured",
            repositories: changes.map(change => ({ repository: redact(change.repository, options), hook: {
              id: change.hook ? redact(change.hook.ref.id, options) : null, url: redact(desiredUrl, options),
              events, nativeEvents: expectedSubscriptions, active: true, contentType: "json",
            } })),
          },
          changes: modified.flatMap(change => change.reasons.map(reason => `${redact(change.repository, options)}: ${reason}.`)),
          unverifiable: ["webhookSecret"],
        }
        operations.set(plan, { url: desiredUrl, changes })
        return plan
      })
    },
    async apply(plan, fetchImpl) {
      if (plan.action === "none") return plan.current
      const operation = operations.get(plan)
      if (!operation) throw agentDiagnostics.AGENT_R0997({ message: "Code Host webhook sync requires a plan from this Channel." })
      return await request(async () => {
        const client = await provider(fetchImpl)
        const input: WebhookInput = { url: operation.url, nativeEvents: subscriptions, active: true, contentType: "json", secret: options.webhookSecret }
        for (const change of operation.changes) {
          if (!change.reasons.length) continue
          const writer = options.host === "gitlab" ? await provider(gitlabHookFetch(fetchImpl, change.hook?.nativeEvents ?? [])) : client
          if (change.hook) await writer.webhooks.update(change.hook.ref, input)
          else await writer.webhooks.create(repoRef(writer, change.repository), input)
        }
        const results = []
        for (const change of operation.changes) {
          const hook = await matchingHook(client, change.repository, operation.url)
          if (!hook || !hook.active || (options.host === "forgejo" && hook.contentType !== "json") || !same(hook.nativeEvents, expectedSubscriptions)) {
            throw new CodeHostResponseError("Code Host did not return the desired webhook events, content type, and active state.")
          }
          results.push({ repository: redact(change.repository, options), hook: state(hook, options) })
        }
        return { url: redact(operation.url, options), repositories: results, webhookSecret: "configured" }
      })
    },
  }
  if (repositories) syncProvider.resourceKeys = desiredUrl => repositories.map(repository => JSON.stringify([options.host, instance, repository, desiredUrl]))
  return syncProvider
}
