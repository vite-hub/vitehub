import type { EventKind, ForgeOptionsBase, ForgeProvider, WebhookInput, WebhookUpdate } from "forges"
import { fake } from "forges/fake"
import { createRuntimeContext } from "@vite-hub/runtime"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { forgejo, gitlab } from "../src/channels.ts"
import type { ForgejoChannelOptions } from "../src/channels.ts"
import type { AgentCallbackContext } from "../src/types.ts"
import { getAgentChannelSyncDefinition } from "../src/internal/channel-sync.ts"
import { runAgentChannelSyncCli } from "../src/internal/channel-sync-cli.ts"

const hosts = ["gitlab", "forgejo"] as const
const stores = new Map<string, ReturnType<typeof fake>>()
const calls: Array<{ host: string, input: WebhookInput | WebhookUpdate }> = []
let realRequests = false
let failedRequest: Error | undefined
let unsupported = false
const connections: Array<{ host: string, options: ForgeOptionsBase }> = []

const subscriptions = {
  gitlab: {
    comment: ["note_events", "confidential_note_events"],
    review: ["merge_requests_events"], review_comment: ["note_events"],
    state_change: ["issues_events", "confidential_issues_events", "merge_requests_events"],
  },
  forgejo: {
    comment: ["issue_comment", "pull_request_comment"],
    review: ["pull_request_review_approved", "pull_request_review_rejected", "pull_request_review_comment"],
    review_comment: ["pull_request_review_approved", "pull_request_review_rejected", "pull_request_review_comment"], state_change: ["issues", "issue_assign", "issue_label", "issue_milestone", "issue_comment", "pull_request", "pull_request_assign", "pull_request_label", "pull_request_milestone", "pull_request_sync", "pull_request_comment", "pull_request_review_approved", "pull_request_review_rejected", "pull_request_review_comment", "pull_request_review_request"],
  },
}

function translated(host: typeof hosts[number], events: EventKind[] = []) {
  return [...new Set(events.flatMap(event => subscriptions[host][event as keyof typeof subscriptions.gitlab] || [event]))].sort()
}

function expandForgejo(events: readonly string[]) {
  return [...new Set(events.flatMap(event => {
    if (event === "pull_request_review") return subscriptions.forgejo.review
    if (event === "issues") return ["issues", "issue_assign", "issue_label", "issue_milestone", "issue_comment"]
    if (event === "pull_request") return ["pull_request", "pull_request_assign", "pull_request_label", "pull_request_milestone", "pull_request_sync", "pull_request_comment", "pull_request_review_approved", "pull_request_review_rejected", "pull_request_review_comment", "pull_request_review_request"]
    return [event]
  }))].sort()
}

function storedInput<T extends WebhookUpdate>(host: typeof hosts[number], input: T) {
  const nativeEvents = host === "forgejo" ? expandForgejo(input.nativeEvents ?? translated(host, input.events)) : input.nativeEvents ?? translated(host, input.events)
  const events = Object.entries(subscriptions[host]).filter(([, names]) => names.some(name => nativeEvents.includes(name))).map(([kind]) => kind as EventKind).sort()
  return { ...input, nativeEvents, events }
}

async function mockHost(host: typeof hosts[number], options: ForgeOptionsBase) {
  const actual = await vi.importActual<Record<typeof host, (input: ForgeOptionsBase) => { create: () => ForgeProvider }>>(`forges/${host}`)
  connections.push({ host, options })
  if (realRequests) return actual[host](options).create()
  const previous = stores.get(host)
  if (previous) return previous.create()
  const factory = fake({ kind: host, instance: new URL(options.baseUrl || (host === "gitlab" ? "https://gitlab.com" : "https://codeberg.org")).host })
  const provider = factory.create()
  const create = provider.webhooks.create
  const update = provider.webhooks.update
  provider.webhooks.create = async (target, input) => {
    calls.push({ host, input })
    return await create(target, storedInput(host, input))
  }
  provider.webhooks.update = async (ref, input) => {
    calls.push({ host, input })
    return await update(ref, storedInput(host, input))
  }
  const list = provider.webhooks.list
  provider.webhooks.list = (target, options) => {
    if (failedRequest) throw failedRequest
    return list(target, options)
  }
  if (unsupported) provider.can = () => false
  stores.set(host, { ...factory, create: () => provider })
  return provider
}
vi.mock("forges/gitlab", () => ({ gitlab: (options: ForgeOptionsBase) => ({ create: () => mockHost("gitlab", options) }) }))
vi.mock("forges/forgejo", () => ({ forgejo: (options: ForgeOptionsBase) => ({ create: () => mockHost("forgejo", options) }) }))

const token = "private-access-token"
const secret = "private-hook-secret"
const url = "https://app.example.com/api/_vitehub/agents/reviewer/webhooks/code"
const fetcher = vi.fn<typeof fetch>(async () => { throw new Error("Unexpected network request") })
// SAFETY: Sync resolution needs only runtime settings and request-scoped memoization in this fixture.
const context = createRuntimeContext({ capabilities: {}, runtime: "unknown", runtimeConfig: {} }) as AgentCallbackContext
const events: EventKind[] = ["comment", "review", "review_comment", "state_change"]
// Forgejo options are the subset that both Channels accept.
const options: ForgejoChannelOptions = {
  token, webhookSecret: secret, sync: { repositories: ["platform/api", "platform/web"] },
  pullRequest: { reconcile: { mentions: ["@review-bot"] } },
}

async function sync(host: typeof hosts[number], input: ForgejoChannelOptions = options) {
  const channel = host === "gitlab" ? gitlab(input) : forgejo(input)
  const definition = getAgentChannelSyncDefinition(channel)!
  expect(definition.provider).toBe(host)
  return (await definition.resolve(context, channel))!
}
function planInput(force = false) { return { desiredUrl: url, fetch: fetcher, force } }
function output() {
  const chunks: string[] = []
  return { write: (value: string | Uint8Array) => chunks.push(String(value)), text: () => chunks.join("") }
}

beforeEach(() => {
  stores.clear(); calls.length = 0; connections.length = 0
  realRequests = false; failedRequest = undefined; unsupported = false
  vi.stubEnv("GITLAB_TOKEN", ""); vi.stubEnv("FORGEJO_TOKEN", "")
  vi.stubEnv("GITLAB_WEBHOOK_SECRET", ""); vi.stubEnv("FORGEJO_WEBHOOK_SECRET", "")
})
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks() })

for (const host of hosts) describe(`${host} webhook sync`, () => {
  it("reports sync.repositories without credentials or a network request", async () => {
    const provider = await sync(host, {})
    const plan = await provider.plan(planInput())
    expect(plan.action).toBe("none")
    expect(plan.unverifiable?.join(" ")).toContain("sync.repositories")
    expect(connections).toEqual([])
    expect(await provider.apply(plan, fetcher)).toEqual(plan.current)
  })

  it("creates one active JSON hook per repository and then plans no change", async () => {
    const provider = await sync(host)
    const plan = await provider.plan(planInput())
    expect(plan.action).toBe("create")
    expect(plan.current.url).toBe("")
    expect(plan.desired.url).toBe(url)
    expect(plan.changes).toHaveLength(2)
    const result = await provider.apply(plan, fetcher)
    expect(result.url).toBe(url)
    expect(stores.get(host)!.store.webhooks).toHaveLength(2)
    for (const hook of stores.get(host)!.store.webhooks) {
      expect(hook).toMatchObject({ url, events, nativeEvents: translated(host, events), active: true, contentType: "json" })
    }
    expect(calls.every(call => call.input.secret === secret)).toBe(true)
    expect(connections[0]!.options).toMatchObject({ auth: { type: "token", token }, fetch: fetcher })
    expect((await provider.plan(planInput())).action).toBe("none")
    const serialized = JSON.stringify({ plan, result })
    expect(serialized).not.toContain(token)
    expect(serialized).not.toContain(secret)
    expect(plan.unverifiable).toContain("webhookSecret")
  })

  it("updates events and active state, preserves other URLs, and resends the secret with force", async () => {
    const provider = await sync(host)
    await provider.apply(await provider.plan(planInput()), fetcher)
    const factory = stores.get(host)!
    const first = factory.store.webhooks[0]!
    const other = await factory.create().webhooks.create(first.ref.target, { url: "https://other.example.com/hook", events: ["push"], secret: "other-secret" })
    const previous = JSON.stringify(other)
    first.events = ["push"]; first.nativeEvents = ["push"]; first.active = host === "gitlab"
    const plan = await provider.plan(planInput())
    expect(plan.action).toBe("update")
    expect(plan.current.url).toBe(url)
    expect(plan.changes).toEqual(["platform/api: update events.", ...(host === "forgejo" ? ["platform/api: activate webhook."] : [])])
    await provider.apply(plan, fetcher)
    expect(first.active).toBe(true)
    expect(first.events).toEqual(events)
    expect(JSON.stringify(other)).toBe(previous)
    const forced = await provider.plan(planInput(true))
    expect(forced.action).toBe("update")
    expect(forced.changes).toHaveLength(2)
    await provider.apply(forced, fetcher)
    expect(calls.slice(-2).every(call => call.input.secret === secret)).toBe(true)
  })

  it("reports an update when one repository exists and another needs a hook", async () => {
    const provider = await sync(host)
    await provider.apply(await provider.plan(planInput()), fetcher)
    stores.get(host)!.store.webhooks.pop()
    stores.get(host)!.store.webhooks[0]!.nativeEvents = ["push"]
    const plan = await provider.plan(planInput())
    expect(plan.action).toBe("update")
    await provider.apply(plan, fetcher)
    expect(stores.get(host)!.store.webhooks).toHaveLength(2)
  })

  it("fails on duplicate target URLs without changing hooks", async () => {
    const provider = await sync(host)
    await provider.apply(await provider.plan(planInput()), fetcher)
    const factory = stores.get(host)!
    const hook = factory.store.webhooks[0]!
    await factory.create().webhooks.create(hook.ref.target, { url, events })
    const previous = JSON.stringify(factory.store.webhooks)
    await expect(provider.plan(planInput())).rejects.toThrow("duplicate hooks")
    expect(JSON.stringify(factory.store.webhooks)).toBe(previous)
  })

  it.each([
    ["token", { ...options, token: undefined }, `${host.toUpperCase()}_TOKEN`],
    ["webhookSecret", { ...options, webhookSecret: undefined }, `${host.toUpperCase()}_WEBHOOK_SECRET`],
  ])("names the missing %s option and env variable", async (field, input, env) => {
    await expect(sync(host, input)).rejects.toThrow(`${field} or ${env}`)
  })

  it.each([[], ["api"], ["owner//api"], [" owner/api"], ["owner/../api"], ["https://host/repo"]].map(repositories => [repositories]))("rejects invalid repositories %j", async repositories => {
    await expect(sync(host, { ...options, sync: { repositories } })).rejects.toThrow("sync.repositories")
  })

  it("uses callbacks and Server Env, with explicit options first", async () => {
    vi.stubEnv(`${host.toUpperCase()}_TOKEN`, "env-token")
    vi.stubEnv(`${host.toUpperCase()}_WEBHOOK_SECRET`, "env-secret")
    vi.stubEnv(`${host.toUpperCase()}_BASE_URL`, "https://custom.example.com")
    const provider = await sync(host, { ...options, token: () => ({ unseal: () => token }), webhookSecret: undefined })
    await provider.apply(await provider.plan(planInput()), fetcher)
    expect(connections[0]!.options).toMatchObject({ baseUrl: "https://custom.example.com", auth: { token } })
    expect(calls[0]!.input.secret).toBe("env-secret")
  })

  it("uses a stable resource key with no credentials", async () => {
    const first = await sync(host)
    const second = await sync(host, { ...options, token: "different", webhookSecret: "different", sync: { repositories: [...options.sync!.repositories].reverse() } })
    expect(first.resourceKeys?.(url)).toEqual(second.resourceKeys?.(url))
    expect(first.resourceKeys?.(url)).not.toEqual(second.resourceKeys?.(`${url}-other`))
    expect(JSON.stringify(first.resourceKeys?.(url))).not.toContain(token)
    expect(JSON.stringify(first.resourceKeys?.(url))).not.toContain(secret)
  })

  it("fails clearly if hooks cannot be managed", async () => {
    unsupported = true
    const provider = await sync(host)
    await expect(provider.plan(planInput())).rejects.toThrow("cannot manage hooks")
  })

  it("redacts failed request messages and serialized errors", async () => {
    const provider = await sync(host)
    const plan = await provider.plan(planInput())
    const result = await provider.apply(plan, fetcher)
    failedRequest = new Error(`Request failed: ${token} ${secret}`)
    const error = await provider.plan(planInput()).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(Error)
    const serialized = error instanceof Error ? JSON.stringify({ plan, result, error: { ...error, message: error.message, stack: error.stack, cause: error.cause } }) : String(error)
    expect(serialized).toContain("[redacted]")
    expect(serialized).not.toContain(token)
    expect(serialized).not.toContain(secret)
  })

  it("lists a Channel without sync.repositories in the CLI plan", async () => {
    const provider = await sync(host, {})
    const stdout = output(); const stderr = output()
    const status = await runAgentChannelSyncCli([
      "--stage", "test", "--channel", host, "--url", "https://app.example.com", "--apply", "--confirm-origin", "https://app.example.com",
    ], { cwd: "/repo", rootDir: "/repo", env: {}, stdout, stderr }, {
      fetch: async () => new Response(null, { status: 204, headers: { "x-vitehub-channel-provider": host } }),
      loadTargets: async () => [{ agent: "reviewer", channel: host, mode: "webhook", provider: host, registration: { id: "code" }, sync: provider }],
    })
    expect(stderr.text()).toBe("")
    expect(status).toBe(0)
    expect(stdout.text()).toContain(`reviewer/${host} (${host}): none`)
    expect(stdout.text()).toContain("Current URL: <none>")
    expect(stdout.text()).toContain("Set sync.repositories to manage Code Host webhooks.")
    expect(connections).toEqual([])
  })

  it("passes CLI URL checks for create, no change, and force update", async () => {
    const provider = await sync(host)
    for (const args of [[], [], ["--force"]]) {
      const stdout = output(); const stderr = output()
      const status = await runAgentChannelSyncCli([
        "--stage", "test", "--channel", host, "--url", "https://app.example.com", "--apply", "--confirm-origin", "https://app.example.com", "--json", ...args,
      ], { cwd: "/repo", rootDir: "/repo", env: {}, stdout, stderr }, {
        fetch: async (_input, init) => {
          expect(init?.method).toBe("HEAD")
          return new Response(null, { status: 204, headers: { "x-vitehub-channel-provider": host } })
        },
        loadTargets: async () => [{ agent: "reviewer", channel: host, mode: "webhook", provider: host, registration: { id: "code" }, sync: provider }],
      })
      expect(stderr.text()).toBe("")
      expect(status).toBe(0)
      expect(stdout.text()).toContain('"url":"https://app.example.com/api/_vitehub/agents/reviewer/webhooks/code"')
      expect(stdout.text()).not.toContain(token)
      expect(stdout.text()).not.toContain(secret)
    }
  })
})

it("keeps nested GitLab groups in the repository reference", async () => {
  const provider = await sync("gitlab", { ...options, sync: { repositories: ["platform/team/api"] } })
  await provider.apply(await provider.plan(planInput()), fetcher)
  expect(stores.get("gitlab")!.store.webhooks[0]!.ref.target).toMatchObject({ owner: "platform/team", name: "api" })
  await expect(sync("forgejo", { ...options, sync: { repositories: ["platform/team/api"] } })).rejects.toThrow("sync.repositories")
})

const featureCases: Array<[ForgejoChannelOptions, EventKind[]]> = [
  [{ pullRequest: true }, ["comment"]],
  [{ activity: true }, ["state_change"]],
  [{ pullRequest: { reconcile: { events: [], triggers: [{ events: ["review"] }] } } }, ["comment", "review"]],
  [{ pullRequest: { reconcile: { comments: { events: ["review_comment"] } } } }, ["comment", "review_comment", "state_change"]],
  [{ pullRequest: { reconcile: true } }, ["comment", "state_change"]],
]
it.each(featureCases)("derives subscriptions from enabled features %j", async (features, expected) => {
  const provider = await sync("forgejo", { ...options, ...features, pullRequest: features.pullRequest })
  await provider.apply(await provider.plan(planInput()), fetcher)
  expect(stores.get("forgejo")!.store.webhooks[0]!.nativeEvents).toEqual(translated("forgejo", expected))
})

it.each(hosts)("round trips %s subscriptions through the real client and CLI transport", async host => {
  realRequests = true
  let stored: Record<string, unknown> | undefined
  const requests: Request[] = []
  const transport: typeof fetch = async (input, init) => {
    const request = new Request(input, init)
    requests.push(request.clone())
    if (request.method === "GET") return Response.json(stored ? [stored] : [])
    // SAFETY: The client sends a JSON webhook object to this fixture transport.
    const body = await request.json() as Record<string, unknown>
    // GitLab enables push events by default when the create request does not set the flag.
    const defaults = host === "gitlab" && request.method === "POST" ? { push_events: true } : {}
    if (host === "forgejo") {
      const requested = body.events as string[]
      // The host accepts a review group, not individual review delivery names.
      body.events = expandForgejo(requested.filter(event => !subscriptions.forgejo.review.includes(event)))
    }
    stored = { id: 1, ...defaults, ...stored, ...body }
    return Response.json(stored)
  }
  const provider = await sync(host, { ...options, sync: { repositories: ["platform/api"] } })
  const input = { desiredUrl: url, fetch: transport, force: false }
  await provider.apply(await provider.plan(input), transport)
  expect((await provider.plan(input)).action).toBe("none")
  const create = requests.find(request => request.method === "POST")!
  expect(create.url).toContain(host === "gitlab" ? "/api/v4/projects/platform%2Fapi/hooks" : "/api/v1/repos/platform/api/hooks")
  const body: unknown = await create.json()
  expect(body).toMatchObject(host === "gitlab" ? { token: secret, note_events: true, merge_requests_events: true, push_events: false } : {
    active: true, events: expect.arrayContaining(["pull_request_review", "pull_request"]), config: { url, content_type: "json", secret },
  })
  if (host === "gitlab") stored = { ...stored, push_events: true }
  else stored = { ...stored, events: ["push"] }
  const update = await provider.plan(input)
  expect(update.action).toBe("update")
  await provider.apply(update, transport)
  expect((await provider.plan(input)).action).toBe("none")
  if (host === "gitlab") {
    const put = requests.find(request => request.method === "PUT")!
    expect(await put.json()).toMatchObject({ push_events: false, note_events: true, merge_requests_events: true, token: secret })
  }
})

it.each(hosts)("redacts %s HTTP error bodies from the real client", async host => {
  realRequests = true
  const provider = await sync(host)
  const transport: typeof fetch = async () => Response.json({ message: `${token} and ${secret} are invalid` }, { status: 401 })
  const error = await provider.plan({ desiredUrl: url, fetch: transport, force: false }).catch((error: unknown) => error)
  expect(error).toBeInstanceOf(Error)
  expect(error instanceof Error && error.message).toContain("HTTP 401")
  const serialized = error instanceof Error ? JSON.stringify({ ...error, message: error.message, cause: error.cause }) : String(error)
  expect(serialized).not.toContain(token)
  expect(serialized).not.toContain(secret)
})

it("rejects auto-disabled GitLab hooks before attempting writes", async () => {
  const provider = await sync("gitlab")
  await provider.apply(await provider.plan(planInput()), fetcher)
  stores.get("gitlab")!.store.webhooks[0]!.active = false
  calls.length = 0
  await expect(provider.plan(planInput())).rejects.toThrow("Re-enable it with a successful test request")
  expect(calls).toEqual([])
})

it("repairs Forgejo form hooks and verifies the content type after applying", async () => {
  const provider = await sync("forgejo")
  await provider.apply(await provider.plan(planInput()), fetcher)
  const factory = stores.get("forgejo")!
  factory.store.webhooks[0]!.contentType = "form"
  const plan = await provider.plan(planInput())
  expect(plan.changes).toContain("platform/api: use JSON content type.")
  await provider.apply(plan, fetcher)
  expect((await provider.plan(planInput())).action).toBe("none")
  factory.store.webhooks[0]!.contentType = "form"
  const update = factory.create().webhooks.update
  factory.create().webhooks.update = async (ref, input) => {
    const hook = await update(ref, input)
    hook.contentType = "form"
    return hook
  }
  await expect(provider.apply(await provider.plan(planInput()), fetcher)).rejects.toThrow("content type")
})

it.each(hosts)("does not register sync for disabled %s webhooks", async host => {
  const channel = host === "gitlab" ? gitlab({ ...options, webhooks: false }) : forgejo({ ...options, webhooks: false })
  expect(getAgentChannelSyncDefinition(channel)).toBeUndefined()
})

it.each(hosts)("updates %s through the CLI when a credential occurs in the hostname", async host => {
  const provider = await sync(host, { ...options, webhookSecret: "example" })
  await provider.apply(await provider.plan(planInput()), fetcher)
  const stdout = output(); const stderr = output()
  const status = await runAgentChannelSyncCli([
    "--stage", "test", "--url", "https://app.example.com", "--apply", "--force", "--confirm-origin", "https://app.example.com", "--json",
  ], { cwd: "/repo", rootDir: "/repo", env: {}, stdout, stderr }, {
    fetch: async () => new Response(null, { status: 204, headers: { "x-vitehub-channel-provider": host } }),
    loadTargets: async () => [{ agent: "reviewer", channel: host, mode: "webhook", provider: host, registration: { id: "code" }, sync: provider }],
  })
  expect(stderr.text()).toBe("")
  expect(status).toBe(0)
  expect(stdout.text()).toContain("[redacted]")
})

it.each([false, true])("checks overlapping repository resources by deployed URL (same URL: %s)", async sameUrl => {
  const first = await sync("forgejo")
  const second = await sync("forgejo", { ...options, sync: { repositories: ["platform/api"] } })
  const stdout = output(); const stderr = output()
  const status = await runAgentChannelSyncCli([
    "--stage", "test", "--url", "https://app.example.com", "--apply", "--confirm-origin", "https://app.example.com", "--json",
  ], { cwd: "/repo", rootDir: "/repo", env: {}, stdout, stderr }, {
    fetch: async () => new Response(null, { status: 204, headers: { "x-vitehub-channel-provider": "forgejo" } }),
    loadTargets: async () => [first, second].map((sync, index) => ({
      agent: sameUrl ? "reviewer" : `agent${index}`, channel: `code${index}`, mode: "webhook" as const,
      provider: "forgejo", registration: { id: "code" }, sync,
    })),
  })
  expect(status).toBe(sameUrl ? 1 : 0)
  if (sameUrl) {
    expect(stderr.text()).toContain("same forgejo resource")
    expect(calls).toEqual([])
  }
  else expect(stores.get("forgejo")!.store.webhooks).toHaveLength(3)
})

it("recognizes GitLab disabled_until through the real client without writing", async () => {
  realRequests = true
  const transport = vi.fn<typeof fetch>(async (input, init) => {
    expect(new Request(input, init).method).toBe("GET")
    return Response.json([{ id: 1, url, disabled_until: "2099-01-01T00:00:00Z", note_events: true }])
  })
  const provider = await sync("gitlab")
  await expect(provider.plan({ desiredUrl: url, fetch: transport, force: true })).rejects.toThrow("Re-enable it with a successful test request")
  expect(transport).toHaveBeenCalledTimes(1)
})
