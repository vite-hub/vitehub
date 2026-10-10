import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fixtureFetch, signDelivery } from "forges/testing"
import { afterEach, describe, expect, it, vi } from "vitest"
import { defineAgent } from "../src/index.ts"
import { forgejo, gitlab, pullRequest } from "../src/channels.ts"
import type { ForgejoChannelOptions, GitHubPullRequestRunContext } from "../src/channels.ts"
import type { AgentChannelDeliveryEffectContext, AgentRunInput } from "../src/types.ts"
import { defineCapability } from "../src/capability-runtime.ts"
import { createChannelWebhookRouteHandler } from "../src/server/internal.ts"
import { createLibsqlAgentState } from "../src/state/sqlite.ts"
import { codeHostActivityComments, codeHostDeliveryEffects } from "../src/internal/code-host-channel.ts"
import { hasRuntimeType, isRuntimeRecord } from "../src/internal/runtime-type.ts"
import { codeHostProvider } from "../src/internal/code-host.ts"
import { createAgentRuntimeContext } from "../src/runtime/context.ts"

const fixtures: Array<{ directory: string, state: ReturnType<typeof createLibsqlAgentState> }> = []
afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  for (const { directory, state } of fixtures.splice(0)) {
    await state.disconnect()
    await rm(directory, { recursive: true, force: true })
  }
})

const kinds = ["gitlab", "forgejo"] as const
const repository = { gitlab: "acme/platform/app", forgejo: "acme/app" }
const api = { gitlab: "https://gitlab.test/api/v4", forgejo: "https://codeberg.test/api/v1" }
const baseUrl = { gitlab: "https://gitlab.test", forgejo: "https://codeberg.test" }
const project = (kind: typeof kinds[number]) => kind === "gitlab" ? `/projects/${encodeURIComponent(repository[kind])}` : `/repos/${repository[kind]}`
const notes = (kind: typeof kinds[number]) => `${project(kind)}${kind === "gitlab" ? "/merge_requests/42/notes" : "/issues/42/comments"}`
const threadPath = (kind: typeof kinds[number]) => `${project(kind)}${kind === "gitlab" ? "/merge_requests/42" : "/pulls/42"}`

// These payloads are hand-authored from the native webhook contracts.
function payload(kind: typeof kinds[number], body = "@review-bot inspect this") {
  return kind === "gitlab" ? {
    object_kind: "note", event_type: "note",
    user: { id: 1, username: "maxi" }, project: { id: 10, path_with_namespace: repository.gitlab },
    object_attributes: { id: 99, note: body, noteable_type: "MergeRequest", created_at: "2026-10-01T12:00:00Z" },
    merge_request: { iid: 42, title: "Fix app", description: "Please review", author_id: 1, labels: [{ title: "review" }] },
  } : {
    action: "created", is_pull: true,
    sender: { id: 1, login: "maxi" },
    repository: { id: 10, full_name: repository.forgejo, name: "app", owner: { login: "acme" } },
    issue: { number: 42, title: "Fix app" },
    comment: { id: 99, body, user: { id: 1, login: "maxi" }, created_at: "2026-10-01T12:00:00Z" },
  }
}

async function request(kind: typeof kinds[number], value: unknown, id = "delivery-1", secret = "secret", event?: string, deliveryHeader?: string) {
  const body = JSON.stringify(value)
  const headers = kind === "gitlab"
    ? { "x-gitlab-event": event || "Note Hook", [deliveryHeader || "x-gitlab-event-uuid"]: id }
    : { "x-forgejo-event": event || "issue_comment", [deliveryHeader || "x-forgejo-delivery"]: id }
  return new Request(`https://agent.test/webhooks/${kind}`, {
    method: "POST", body, headers: { "content-type": "application/json", ...await signDelivery(kind, body, secret, headers) },
  })
}

function transport(kind: typeof kinds[number]) {
  const user = kind === "gitlab" ? { id: 2, username: "review-bot" } : { id: 2, login: "review-bot" }
  const comment = { id: 7, body: "written", author: user, user }
  const readThread = kind === "gitlab" ? {
    iid: 42, title: "Fix app", description: "Full body", state: "opened", draft: false,
    author: { id: 1, username: "maxi" }, labels: ["review"],
    source_branch: "feature", target_branch: "main", source_project_id: 10, target_project_id: 10,
    diff_refs: { head_sha: "head-sha", base_sha: "base-sha" }, web_url: `${baseUrl[kind]}/${repository[kind]}/-/merge_requests/42`,
  } : {
    number: 42, title: "Fix app", body: "Full body", state: "open", draft: false,
    user: { id: 1, login: "maxi" }, labels: [{ name: "review" }],
    head: { ref: "feature", sha: "head-sha", repo: { full_name: repository[kind], owner: { login: "acme" }, name: "app" } },
    base: { ref: "main", sha: "base-sha" }, html_url: `${baseUrl[kind]}/${repository[kind]}/pulls/42`,
  }
  const overrides: Record<string, { status: number, body: unknown }> = {
    [`GET ${api[kind]}${threadPath(kind)}`]: { status: 200, body: readThread },
    [`GET ${api[kind]}/user`]: { status: 200, body: user },
    [`GET ${api[kind]}${notes(kind)}?${kind === "gitlab" ? "per_page" : "limit"}=100${kind === "gitlab" ? "&sort=asc&order_by=created_at" : ""}`]: { status: 200, body: [] },
    [`POST ${api[kind]}${notes(kind)}`]: { status: 201, body: comment },
    [`POST ${api[kind]}${project(kind)}/statuses/head-sha`]: { status: 201, body: { id: 11, status: "success", state: "success", name: "Agent", context: "Agent", sha: "head-sha" } },
    [`GET ${api[kind]}${threadPath(kind)}${kind === "gitlab" ? "/diffs" : "/files"}?${kind === "gitlab" ? "per_page" : "limit"}=100`]: { status: 200, body: [] },
    [`GET ${api[kind]}${project(kind)}/commits/head-sha/status`]: { status: 200, body: { statuses: [] } },
  }
  const fetcher = fixtureFetch([], overrides)
  vi.stubGlobal("fetch", fetcher.fetch)
  return { ...fetcher, comment, overrides, user }
}

// Forgejo options are the subset that both Channels accept.
async function harness(kind: typeof kinds[number], options: ForgejoChannelOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), "vitehub-code-host-channels-"))
  const state = createLibsqlAgentState({ url: `file:${join(directory, "state.db")}` })
  fixtures.push({ directory, state })
  const inputs: AgentRunInput[] = []
  const run = vi.fn(({ input }: { input: AgentRunInput }) => { inputs.push(input); return { text: "Reviewed" } })
  const settings: ForgejoChannelOptions = {
    baseUrl: baseUrl[kind], token: "token", webhookSecret: "secret",
    pullRequest: { reconcile: { mentions: ["@review-bot"] } }, ...options,
  }
  const channel = kind === "gitlab" ? gitlab(settings) : forgejo(settings)
  const agent = defineAgent({
    name: `review-${kind}`, channels: { [kind]: channel }, driver: { run },
    capabilities: [defineCapability({ id: "status", prepare(context) { context.delivery.effect({ kind: "status", payload: { state: "success" } }) } })],
  })
  // SAFETY: The route owns this Agent runtime boundary, as in the existing webhook route fixtures.
  const handler = createChannelWebhookRouteHandler(agent as never)
  const send = async (delivery: Request) => {
    const tasks: Promise<unknown>[] = []
    const response = await handler(delivery, kind, { agentName: `review-${kind}`, webhookState: () => state, waitUntil: task => tasks.push(task) })
    while (tasks.length) await Promise.all(tasks.splice(0))
    return response
  }
  return { channel, inputs, run, send }
}

describe("Code Host Channels through the webhook route", { timeout: 20_000 }, () => {
  it.each(kinds)("runs one signed %s comment, parses its mention, and delivers replies and statuses", async kind => {
    const fetcher = transport(kind)
    const { inputs, run, send } = await harness(kind)
    expect((await send(await request(kind, payload(kind)))).status).toBe(200)
    expect(run).toHaveBeenCalledOnce()
    const context = inputs[0]!.context?.pullRequest
    const value = pullRequest.read({ context: { get: () => context } })
    expect(value).toMatchObject({ provider: kind, instance: new URL(baseUrl[kind]).host, repository: repository[kind], number: 42,
      body: "Full body", head: { sha: "head-sha" }, trigger: { event: "comment", command: "@review-bot", args: "inspect this" }, source: { checkout: false } })
    expect(inputs[0]!.context?.github).toBeUndefined()
    expect(fetcher.calls).toContainEqual(expect.objectContaining({ method: "POST", url: `${api[kind]}${notes(kind)}`, body: JSON.stringify({ body: "Reviewed" }) }))
    expect(fetcher.calls).toContainEqual(expect.objectContaining({ method: "POST", url: `${api[kind]}${project(kind)}/statuses/head-sha`,
      body: JSON.stringify(kind === "gitlab" ? { state: "success", name: "ViteHub Agent" } : { state: "success", context: "ViteHub Agent" }),
    }))
    expect(fetcher.calls.every(call => call.authorization === (kind === "gitlab" ? "Bearer token" : "token token"))).toBe(true)
    expect((await send(await request(kind, payload(kind)))).status).toBe(200)
    expect(run).toHaveBeenCalledOnce()
  })

  it("uses the Gitea delivery header for Forgejo deduplication", async () => {
    transport("forgejo")
    const { run, send } = await harness("forgejo")
    for (let index = 0; index < 2; index++) {
      expect((await send(await request("forgejo", payload("forgejo"), "gitea-delivery", "secret", undefined, "x-gitea-delivery"))).status).toBe(200)
    }
    expect(run).toHaveBeenCalledOnce()
  })

  it.each(kinds)("rejects a wrong %s signature before running the Agent", async kind => {
    transport(kind)
    const { run, send } = await harness(kind)
    expect((await send(await request(kind, payload(kind), "wrong", "wrong"))).status).toBe(401)
    expect(run).not.toHaveBeenCalled()
  })

  it.each(kinds)("names the option and env when the %s secret is missing", async kind => {
    vi.stubEnv(`${kind.toUpperCase()}_WEBHOOK_SECRET`, "")
    vi.stubEnv(`VITEHUB_${kind.toUpperCase()}_WEBHOOK_SECRET`, "")
    const { send } = await harness(kind, { webhookSecret: undefined })
    await expect(send(await request(kind, payload(kind)))).rejects.toMatchObject({ code: "AGENT_R0946", message: expect.stringContaining(`${kind}() requires webhookSecret or ${kind.toUpperCase()}_WEBHOOK_SECRET`) })
  })

  it.each(kinds)("does not run %s issue comments or unmatched mentions", async kind => {
    transport(kind)
    const { run, send } = await harness(kind)
    const issue = kind === "gitlab" ? { ...payload(kind), merge_request: undefined, issue: { iid: 42 } } : { ...payload(kind), is_pull: false }
    expect((await send(await request(kind, issue, "issue"))).status).toBe(200)
    expect((await send(await request(kind, payload(kind, "ordinary comment"), "ordinary"))).status).toBe(200)
    expect(run).not.toHaveBeenCalled()
  })

  it.each(kinds)("uses shared filters and metadata limits on %s", async kind => {
    const fetcher = transport(kind)
    const commentUrl = `${api[kind]}${notes(kind)}?${kind === "gitlab" ? "per_page" : "limit"}=100${kind === "gitlab" ? "&sort=asc&order_by=created_at" : ""}`
    const fileUrl = `${api[kind]}${threadPath(kind)}${kind === "gitlab" ? "/diffs" : "/files"}?${kind === "gitlab" ? "per_page" : "limit"}=100`
    const comment = kind === "gitlab" ? { id: 100, body: "Long comment body", author: { id: 1, username: "maxi" } } : { id: 100, body: "Long comment body", user: { id: 1, login: "maxi" } }
    const file = kind === "gitlab" ? { new_path: "src/app.ts", old_path: "src/app.ts", diff: "", new_file: false, deleted_file: false, renamed_file: false } : { filename: "src/app.ts", status: "modified", additions: 1, deletions: 0 }
    const expanded = fixtureFetch([], { ...fetcher.overrides, [`GET ${commentUrl}`]: { status: 200, body: [comment, { ...comment, id: 101 }] }, [`GET ${fileUrl}`]: { status: 200, body: [file, file] } })
    vi.stubGlobal("fetch", expanded.fetch)
    const { inputs, run, send } = await harness(kind, { pullRequest: {
      maxBodyLength: 4, maxCommentBodyLength: 4, maxComments: 1, maxFiles: 1,
      filter: { repository: { allow: [repository[kind]] }, base: { allow: ["main"] }, draft: { deny: ["true"] } },
      reconcile: { mentions: ["@review-bot"] },
    } })
    expect((await send(await request(kind, payload(kind)))).status).toBe(200)
    expect(run).toHaveBeenCalledOnce()
    expect(inputs[0]?.context?.pullRequest).toMatchObject({ pullRequest: {
      body: expect.stringMatching(/^Full\n\[truncated /), comments: [{ body: expect.stringMatching(/^Long\n\[truncated /), id: 100, user: { login: "maxi" } }], files: [{ filename: "src/app.ts" }], metadata: { omittedComments: 1, omittedFiles: 1 },
    } })
  })

  it("applies the GitLab fork filter with native project IDs", async () => {
    const fetcher = transport("gitlab")
    const threadUrl = `GET ${api.gitlab}${threadPath("gitlab")}`
    const raw = fetcher.overrides[threadUrl]!.body
    if (!isRuntimeRecord(raw)) throw new Error("Missing thread fixture.")
    const forked = fixtureFetch([], { ...fetcher.overrides, [threadUrl]: { status: 200, body: { ...raw, source_project_id: 20, target_project_id: 10 } } })
    vi.stubGlobal("fetch", forked.fetch)
    const { run, send } = await harness("gitlab", { pullRequest: { filter: { fork: { deny: ["true"] } }, reconcile: { mentions: ["@review-bot"] } } })
    expect((await send(await request("gitlab", payload("gitlab")))).status).toBe(200)
    expect(run).not.toHaveBeenCalled()
  })

  // Forgejo sends no draft to ready event, so only GitLab covers ready_for_review.
  it.each(kinds.flatMap(kind => ["opened", "reopened", "synchronize", "ready_for_review"].map(action => ({ kind, action })))
    .filter(({ kind, action }) => kind === "gitlab" || action !== "ready_for_review"))("maps $kind $action into a pull request reconcile run", async ({ kind, action }) => {
    transport(kind)
    const { inputs, send } = await harness(kind, { pullRequest: { reconcile: true } })
    const value = kind === "gitlab" ? {
      object_kind: "merge_request", user: { id: 1, username: "maxi" }, project: { id: 10, path_with_namespace: repository[kind] },
      object_attributes: { iid: 42, id: 420, title: "Fix app", action: action === "opened" ? "open" : action === "reopened" ? "reopen" : "update", ...(action === "synchronize" ? { oldrev: "old-sha" } : {}) },
      ...(action === "ready_for_review" ? { changes: { draft: { previous: true, current: false } } } : {}),
    } : { ...payload(kind), action, pull_request: { number: 42, id: 420, title: "Fix app" } }
    expect((await send(await request(kind, value, action, "secret", kind === "gitlab" ? "Merge Request Hook" : "pull_request"))).status).toBe(200)
    expect(inputs.at(-1)?.context?.pullRequest).toMatchObject({ host: { kind }, trigger: { event: "pull_request", action } })
    expect(inputs).toHaveLength(1)
  })

  it.each(kinds)("maps %s reviews and review comments into neutral triggers", async kind => {
    transport(kind)
    const { inputs, send } = await harness(kind, { pullRequest: { reconcile: { comments: true } } })
    const review = kind === "gitlab" ? {
      object_kind: "merge_request", user: { id: 1, username: "maxi" }, project: { id: 10, path_with_namespace: repository[kind] },
      object_attributes: { iid: 42, id: 420, title: "Fix app", action: "approved" },
    } : { ...payload(kind), pull_request: { number: 42, title: "Fix app" }, action: "submitted", review: { id: 420, content: "Please inspect this", type: "approved" } }
    expect((await send(await request(kind, review, "review", "secret", kind === "gitlab" ? "Merge Request Hook" : "pull_request_review_approved"))).status).toBe(200)
    expect(inputs.at(-1)?.context?.pullRequest).toMatchObject({ trigger: { event: "review" } })
    const note = kind === "gitlab" ? { ...payload(kind), object_attributes: { id: 99, note: "Inspect this line", type: "DiffNote", noteable_type: "MergeRequest" } } : { ...payload(kind, "Inspect this line"), pull_request: { number: 42, title: "Fix app" } }
    expect((await send(await request(kind, note, "review-comment", "secret", kind === "gitlab" ? "Note Hook" : "pull_request_review_comment"))).status).toBe(200)
    expect(inputs.at(-1)?.context?.pullRequest).toMatchObject({ trigger: { event: "review_comment" } })
    expect(inputs).toHaveLength(2)
  })

  it.each(kinds)("keeps rotating %s webhook settings stable through authentication and invocation", async kind => {
    transport(kind)
    const settings = {
      baseUrl: vi.fn().mockResolvedValueOnce(baseUrl[kind]).mockResolvedValue("https://changed.invalid"),
      token: vi.fn().mockResolvedValueOnce("token").mockResolvedValue("changed-token"),
      webhookSecret: vi.fn().mockResolvedValueOnce("secret").mockResolvedValue("changed-secret"),
    }
    const { send, channel } = await harness(kind, settings)
    const trigger = channel.triggers?.webhook
    if (!trigger) throw new Error("Missing webhook trigger.")
    const invoke = trigger.invoke
    let invocation: unknown
    vi.spyOn(trigger, "invoke").mockImplementation(async (context, input) => {
      invocation = await invoke(context, input)
      // Inspect authenticated translation before its separate durable execution.
      return Response.json({ accepted: true })
    })
    expect((await send(await request(kind, payload(kind), "rotating-settings"))).status).toBe(200)
    expect(invocation).toMatchObject({ input: { context: { pullRequest: { host: { kind, instance: new URL(baseUrl[kind]).hostname } } } } })
    for (const setting of Object.values(settings)) expect(setting).toHaveBeenCalledOnce()
  })

  it.each(kinds)("retains authenticated %s translation when the webhook secret rotates before durable execution", async kind => {
    const fixture = transport(kind)
    const webhookSecret = vi.fn().mockResolvedValueOnce("secret").mockResolvedValue("rotated-secret")
    const { send, run } = await harness(kind, { webhookSecret })
    expect((await send(await request(kind, payload(kind), "authenticated-queue"))).status).toBe(200)
    expect(run).toHaveBeenCalledOnce()
    expect(webhookSecret).toHaveBeenCalledOnce()
    expect(fixture.calls.some(call => call.method === "POST" && call.url.startsWith(`${api[kind]}${notes(kind)}`) && call.body?.includes("Reviewed"))).toBe(true)
  })

  it.each(kinds.flatMap(kind => (["baseUrl", "token"] as const).map(field => ({ kind, field }))))("reserves $kind activity order before a delayed $field callback", async ({ kind, field }) => {
    const fixture = transport(kind)
    let stored = fixture.comment
    let created = false
    const recorded = fixture.fetch
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      const url = new URL(input)
      const method = init?.method || "GET"
      if (url.pathname === new URL(`${api[kind]}${notes(kind)}`).pathname) {
        if (method === "GET") return Response.json(created ? [stored] : [])
        if (method === "POST") { created = true; stored = { ...stored, ...JSON.parse(String(init?.body)) }; return Response.json(stored, { status: 201 }) }
      }
      const edit = kind === "gitlab" ? `${notes(kind)}/7` : `${project(kind)}/issues/comments/7`
      if (url.pathname === new URL(`${api[kind]}${edit}`).pathname && method !== "GET") { stored = { ...stored, ...JSON.parse(String(init?.body)) }; return Response.json(stored) }
      return recorded(input, init)
    })
    let release!: (value: string) => void
    const firstSetting = new Promise<string>(resolve => { release = resolve })
    const setting = vi.fn().mockImplementationOnce(() => firstSetting).mockResolvedValue(field === "baseUrl" ? baseUrl[kind] : "rotated-token")
    const { channel } = await harness(kind, { activity: true, [field]: setting })
    const update = channel.activity?.update
    if (!update) throw new Error("Missing activity.")
    const context = () => ({ ...createAgentRuntimeContext({ runtime: "unknown", waitUntil: vi.fn() }), capabilities: {}, channel, target: { repository: repository[kind], issue: 42 },
      activity: { agentName: "reviewer", runId: `ordered-${field}`, status: "running" as const, tasks: [], links: [] } })
    const first = update(context())
    await vi.waitFor(() => expect(setting).toHaveBeenCalledOnce())
    const lastContext = context()
    const last = update({ ...lastContext, activity: { ...lastContext.activity, status: "completed", summary: "Latest completed update" } })
    try {
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(setting).toHaveBeenCalledOnce()
    } finally {
      release(field === "baseUrl" ? baseUrl[kind] : "first-token")
      await Promise.all([first, last])
    }
    expect(stored.body).toContain("Latest completed update")
    expect(setting).toHaveBeenCalledTimes(2)
  })

  it.each(kinds)("creates then edits one owned %s activity comment", async kind => {
    const fetcher = transport(kind)
    let stored = fetcher.comment
    let created = false
    const recorded = fetcher.fetch
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      const url = new URL(input)
      const method = init?.method || "GET"
      if (url.pathname === new URL(`${api[kind]}${notes(kind)}`).pathname) {
        if (method === "GET") return Response.json(created ? [stored] : [])
        if (method === "POST") { created = true; stored = { ...stored, ...JSON.parse(String(init?.body)) }; return Response.json(stored, { status: 201 }) }
      }
      const edit = kind === "gitlab" ? `${notes(kind)}/7` : `${project(kind)}/issues/comments/7`
      if (url.pathname === new URL(`${api[kind]}${edit}`).pathname && method !== "GET") { stored = { ...stored, ...JSON.parse(String(init?.body)) }; return Response.json(stored) }
      return recorded(input, init)
    })
    const { channel } = await harness(kind, { activity: true })
    const update = channel.activity?.update
    if (!update) throw new Error("Missing activity.")
    const context = { ...createAgentRuntimeContext({ runtime: "unknown", waitUntil: vi.fn() }), capabilities: {}, channel, target: { repository: repository[kind], issue: 42 },
      activity: { agentName: "reviewer", runId: "activity-run", status: "running" as const, tasks: [], links: [] } }
    await update(context)
    expect(stored.body).toContain("<!-- vitehub-agent-activity:")
    const initial = stored.body
    await update({ ...context, activity: { ...context.activity, status: "completed", summary: "Done" } })
    expect(stored.body).not.toBe(initial)
    expect(stored.body).toContain("Done")
  })

  it.each(kinds)("publishes one %s activity comment across webhook runs", async kind => {
    const fetcher = transport(kind)
    const store: { comment?: { id: number, body: string, author: typeof fetcher.user, user: typeof fetcher.user } } = {}
    const writes: string[] = []
    const recorded = fetcher.fetch
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      const url = new URL(input)
      const method = init?.method || "GET"
      const commentsPath = new URL(`${api[kind]}${notes(kind)}`).pathname
      const editPath = new URL(`${api[kind]}${kind === "gitlab" ? `${notes(kind)}/7` : `${project(kind)}/issues/comments/7`}`).pathname
      if (url.pathname === commentsPath && method === "GET") return Response.json(store.comment ? [store.comment] : [])
      if ((url.pathname === commentsPath && method === "POST") || url.pathname === editPath) {
        const parsed: unknown = JSON.parse(String(init?.body))
        if (!isRuntimeRecord(parsed) || !hasRuntimeType(parsed.body, "string")) throw new Error("Missing comment body.")
        if (parsed.body.startsWith("<!-- vitehub-agent-activity:")) {
          writes.push(method)
          store.comment = { ...fetcher.comment, body: parsed.body }
          return Response.json(store.comment, { status: method === "POST" ? 201 : 200 })
        }
      }
      return recorded(input, init)
    })
    const { run, send } = await harness(kind, { activity: true })
    for (const id of ["activity-first", "activity-second"]) {
      expect((await send(await request(kind, payload(kind), id))).status).toBe(200)
    }
    expect(run).toHaveBeenCalledTimes(2)
    expect(writes.filter(method => method === "POST")).toHaveLength(1)
    expect(writes).toContain(kind === "gitlab" ? "PUT" : "PATCH")
    expect(store.comment?.body).toContain("<!-- vitehub-agent-activity:")
  })

  it.each(kinds)("looks up an owned %s activity comment by its host path", async kind => {
    const path = kind === "gitlab" ? `${notes(kind)}/7` : `${project(kind)}/issues/comments/7`
    const fixture = fixtureFetch([], { [`GET ${api[kind]}${path}`]: { status: 200, body: { id: 7, body: "owned" } } })
    const provider = await codeHostProvider({ host: kind, baseUrl: baseUrl[kind], token: "token", fetch: fixture.fetch as typeof fetch })
    const comments = codeHostActivityComments(provider, { host: kind, instance: provider.instance, repository: repository[kind], number: 42 }, 100)
    expect((await comments.get(7))?.body).toBe("owned")
    expect(fixture.calls).toHaveLength(1)
  })

  it.each(kinds)("filters %s comments by pull request author and labels", async kind => {
    transport(kind)
    const value = kind === "gitlab" ? { ...payload(kind), user: { id: 3, username: "commenter" } } : { ...payload(kind), issue: { number: 42, title: "Fix app", user: { id: 1, login: "maxi" }, labels: [{ name: "review" }] } }
    const allowed = await harness(kind, { pullRequest: { filter: { author: { allow: ["maxi"] }, labels: { allow: ["review"] } }, reconcile: { mentions: ["@review-bot"] } } })
    expect((await allowed.send(await request(kind, value, "allowed"))).status).toBe(200)
    expect(allowed.run).toHaveBeenCalledOnce()
    const denied = await harness(kind, { pullRequest: { filter: { author: { deny: ["maxi"] } }, reconcile: { mentions: ["@review-bot"] } } })
    expect((await denied.send(await request(kind, value, "denied"))).status).toBe(200)
    expect(denied.run).not.toHaveBeenCalled()
  })

  it.each(["note", "merge_request"])("filters GitLab %s deliveries using the MR author and native label titles", async event => {
    transport("gitlab")
    const value = event === "note" ? { ...payload("gitlab"), user: { id: 3, username: "commenter" } } : {
      object_kind: "merge_request", user: { id: 3, username: "commenter" },
      project: { id: 10, path_with_namespace: repository.gitlab },
      object_attributes: { iid: 42, id: 420, title: "Fix app", action: "open", author_id: 1, labels: [{ title: "review" }] },
    }
    for (const [filter, accepted] of [
      [{ author: { allow: ["maxi"] }, labels: { allow: ["review"] } }, true],
      [{ author: { deny: ["maxi"] } }, false],
      [{ author: { allow: ["commenter"] } }, false],
      [{ labels: { deny: ["review"] } }, false],
    ] as const) {
      const channel = await harness("gitlab", { pullRequest: { filter, reconcile: { events: ["opened"], mentions: ["@review-bot"] } } })
      expect((await channel.send(await request("gitlab", value, "filter", "secret", event === "note" ? "Note Hook" : "Merge Request Hook"))).status).toBe(200)
      expect(channel.run).toHaveBeenCalledTimes(accepted ? 1 : 0)
    }
  })

  it("lists the newest GitLab notes first for the activity lookup", async () => {
    const page = (number: number) => `GET ${api.gitlab}${notes("gitlab")}?sort=desc&order_by=created_at&per_page=100&page=${number}`
    const fixture = fixtureFetch([], {
      [page(1)]: { status: 200, body: Array.from({ length: 100 }, (_, index) => ({ id: 700 - index, body: `note ${700 - index}` })) },
      [page(2)]: { status: 200, body: Array.from({ length: 100 }, (_, index) => ({ id: 600 - index, body: `note ${600 - index}` })) },
    })
    const provider = await codeHostProvider({ host: "gitlab", baseUrl: baseUrl.gitlab, token: "token", fetch: fixture.fetch as typeof fetch })
    const comments = await codeHostActivityComments(provider, { host: "gitlab", instance: provider.instance, repository: repository.gitlab, number: 42 }, 150).list()
    expect(comments).toHaveLength(150)
    expect(comments[0]?.body).toBe("note 700")
    expect(comments.at(-1)?.body).toBe("note 551")
    expect(fixture.calls).toHaveLength(2)
  })

  it.each([
    ["Link rel=last", (last: number) => ({ link: `<${api.forgejo}${notes("forgejo")}?limit=50&page=${last}>; rel="last"` })],
    ["x-total-count", (last: number) => ({ "x-total-count": String(last * 50) })],
  ] as const)("reads the newest Forgejo comments first from the %s page", async (_name, headers) => {
    const comment = (id: number) => ({ id, body: `comment ${id}`, user: { login: "maxi" } })
    const page = (number: number) => Array.from({ length: 50 }, (_, index) => comment((number - 1) * 50 + index + 1))
    const url = (query: string) => `GET ${api.forgejo}${notes("forgejo")}?${query}`
    const fixture = fixtureFetch([], {
      [url("limit=100")]: { status: 200, body: page(1), headers: headers(20) },
      ...Object.fromEntries([20, 19, 18].map(number => [url(`limit=100&page=${number}`), { status: 200, body: page(number) }])),
    })
    const provider = await codeHostProvider({ host: "forgejo", baseUrl: baseUrl.forgejo, token: "token", fetch: fixture.fetch as typeof fetch })
    const comments = await codeHostActivityComments(provider, { host: "forgejo", instance: provider.instance, repository: repository.forgejo, number: 42 }, 120).list()
    expect(comments).toHaveLength(120)
    expect(comments[0]?.body).toBe("comment 1000")
    expect(comments.at(-1)?.body).toBe("comment 881")
  })

  it("approves a GitLab merge request without a body and posts the review text as a note", async () => {
    const approve = `POST ${api.gitlab}${threadPath("gitlab")}/approve`
    const fixture = fixtureFetch([], {
      [approve]: { status: 201, body: { approved_by: [{ user: { id: 2, username: "review-bot" } }] } },
      [`GET ${api.gitlab}/user`]: { status: 200, body: { id: 2, username: "review-bot" } },
      [`POST ${api.gitlab}${notes("gitlab")}`]: { status: 201, body: { id: 8, body: "Looks good", author: { username: "review-bot" } } },
    })
    const provider = await codeHostProvider({ host: "gitlab", baseUrl: baseUrl.gitlab, token: "token", fetch: fixture.fetch as typeof fetch })
    const effects = codeHostDeliveryEffects({ provider: async () => provider, target: () => ({ host: "gitlab", instance: provider.instance, repository: repository.gitlab, number: 42 }), statusContext: "Agent", reactions: "content" })
    if (typeof effects.review !== "function") throw new Error("Missing review effect.")
    // SAFETY: These fixtures supply all callback fields that the review effect uses.
    const context = (payload: unknown) => ({ effect: { kind: "review", payload }, input: { context: {} } }) as AgentChannelDeliveryEffectContext
    await effects.review(context({ body: "Looks good", event: "APPROVE" }))
    expect(fixture.calls.filter(call => call.method === "POST").map(call => [call.url, call.body])).toEqual([
      [`${api.gitlab}${threadPath("gitlab")}/approve`, undefined],
      [`${api.gitlab}${notes("gitlab")}`, JSON.stringify({ body: "Looks good" })],
    ])
    fixture.calls.splice(0)
    await effects.review(context({ event: "APPROVE" }))
    expect(fixture.calls.filter(call => call.method === "POST").map(call => call.url)).toEqual([`${api.gitlab}${threadPath("gitlab")}/approve`])
    fixture.calls.splice(0)
    await effects.review(context({ body: "Please look", event: "COMMENT" }))
    expect(fixture.calls.filter(call => call.method === "POST").map(call => call.url)).toEqual([`${api.gitlab}${notes("gitlab")}`])
    await expect(effects.review(context({ body: "Fix it", event: "REQUEST_CHANGES" }))).rejects.toMatchObject({ code: "AGENT_R0946" })
  })

  it("keeps the GitHub default when reading existing pull request context", () => {
    const context: GitHubPullRequestRunContext = { pullRequest: { apiUrl: "https://api.github.com/repos/acme/app/pulls/42", number: 42, source: { mount: "", ref: "", repo: "acme/app" } },
      repository: { fullName: "acme/app", owner: "acme", name: "app" }, run: { messageId: "99", origin: "github", threadId: "42", runId: "legacy" },
      trigger: { action: "created", actor: { login: "maxi" }, args: "", command: "/review", comment: { id: 99 }, event: "issue_comment" } }
    expect(pullRequest.read({ context: { get: () => context } })).toMatchObject({ provider: "github", instance: "github.com" })
    const enterprise = { ...context, pullRequest: { ...context.pullRequest, htmlUrl: "https://github.example.com/acme/app/pull/42" } }
    expect(pullRequest.read({ context: { get: () => enterprise } }).instance).toBe("github.example.com")
  })
})
