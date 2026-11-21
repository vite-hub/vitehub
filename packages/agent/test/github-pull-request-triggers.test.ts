import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sendChannelTrigger } from "@vite-hub/channels"
import { afterEach, describe, expect, it, vi } from "vitest"

import { github, githubPullRequestTrigger, ignored } from "../src/channels.ts"
import type { GitHubPullRequestTriggerEvent } from "../src/channels.ts"
import { defineAgent } from "../src/index.ts"
import { readAgentChannelDeliveries } from "../src/internal/channel-delivery.ts"
import { createChannelWebhookRouteHandler } from "../src/server/internal.ts"
import { createLibsqlAgentState } from "../src/state/sqlite.ts"

const cleanups: Array<() => Promise<void>> = []

/** The Channel delivery journal events of the delivery with this `x-github-delivery`, without timestamps and IDs. */
async function journal(state: Awaited<ReturnType<typeof stateFile>>, deliveryId: string) {
  const deliveries = await readAgentChannelDeliveries(state)
  const delivery = deliveries.find(item => item.sourceId === deliveryId)
  return delivery?.events.map(({ at: _at, deliveryId: _deliveryId, id: _id, ...event }) => event) ?? []
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

type Invoke = (event: GitHubPullRequestTriggerEvent) => Response | { input: { prompt?: string } }

async function stateFile() {
  const directory = await mkdtemp(join(tmpdir(), "vitehub-github-pr-triggers-"))
  const state = createLibsqlAgentState({ url: `file:${join(directory, "state.sqlite")}` })
  cleanups.push(async () => {
    await state.disconnect()
    await rm(directory, { force: true, recursive: true })
  })
  return state
}

function reviewerAgent(invoke: Invoke, options: { debounceMs?: number, state?: "open" | "closed" } = {}) {
  const fetcher = vi.fn(async (url: string | URL | Request) => Response.json(String(url).endsWith("/pulls/42") ? {
    base: { ref: "main", repo: { full_name: "acme/app" }, sha: "base-sha" },
    head: { ref: "feature", repo: { full_name: "acme/app" }, sha: "head-sha" },
    html_url: "https://github.test/acme/app/pull/42",
    number: 42,
    state: options.state ?? "open",
    title: "Improve app",
    url: "https://api.github.test/repos/acme/app/pulls/42",
    user: { login: "onmax", type: "User" },
  } : []))
  const calls = vi.fn(invoke)
  const run = vi.fn(async (_context: { prompt?: string }) => "ok")
  const agent = defineAgent({
    channels: {
      github: github({
        // SAFETY: This fixture supplies the Fetch-compatible mock used for GitHub requests.
        app: { apiBaseUrl: "https://api.github.test", fetch: fetcher as typeof fetch, token: "app-token" },
        pullRequest: { reconcile: { events: [] }, reply: false, workspace: false },
        triggers: {
          reviewFeedback: githubPullRequestTrigger({
            events: ["pull_request_review", "issue_comment"],
            filter: { actor: { deny: ["onmax"] }, author: { allow: ["onmax"] } },
            reviewStates: ["approved", "changes_requested", "commented"],
            ...(options.debounceMs === undefined ? {} : { debounceMs: options.debounceMs }),
            invoke: (_context, event) => calls(event),
          }),
        },
        webhooks: { secret: false },
      }),
    },
    driver: { run },
  })
  return { agent, calls, run }
}

function serve(agent: unknown, state: Awaited<ReturnType<typeof stateFile>>) {
  // SAFETY: The route fixture uses this Agent's declared GitHub webhook.
  const handler = createChannelWebhookRouteHandler(agent as never)
  const routeOptions = { agentName: "reviewer", webhookState: state }
  const stop = handler.resume(routeOptions)
  cleanups.push(stop)
  const send = (deliveryId: string, event: string, body: unknown) => handler(new Request("https://example.com/api/github/webhook", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", "x-github-delivery": deliveryId, "x-github-event": event },
    method: "POST",
  }), "github", routeOptions)
  const complete = vi.spyOn(state, "completeWebhookDelivery")
  const completed = (deliveryId: string) => complete.mock.calls.some(call => call[1] === deliveryId)
  return { completed, send, stop }
}

const pullRequest = (author = "onmax") => ({
  author_association: "OWNER",
  head: { ref: "feature", repo: { full_name: "acme/app" }, sha: "head-sha" },
  html_url: "https://github.test/acme/app/pull/42",
  number: 42,
  title: "Improve app",
  url: "https://api.github.test/repos/acme/app/pulls/42",
  user: { login: author, type: "User" },
})

const review = (id: number, options: { actor?: string, author?: string, state?: string, body?: string } = {}) => {
  const user = { id: 7, login: options.actor ?? "christoffer", type: "User" }
  return {
    action: "submitted",
    installation: { id: 123 },
    number: 42,
    pull_request: pullRequest(options.author),
    repository: { full_name: "acme/app" },
    review: {
      body: options.body ?? "Please rename this.",
      html_url: `https://github.test/acme/app/pull/42#pullrequestreview-${id}`,
      id,
      state: options.state ?? "changes_requested",
      user,
    },
    sender: user,
  }
}

const comment = (id: number, actor = "christoffer") => {
  const user = { id: 7, login: actor, type: "User" }
  return {
    action: "created",
    comment: { body: "One more thing.", html_url: `https://github.test/acme/app/pull/42#issuecomment-${id}`, id, user },
    installation: { id: 123 },
    issue: {
      author_association: "OWNER",
      number: 42,
      pull_request: { html_url: "https://github.test/acme/app/pull/42", url: "https://api.github.test/repos/acme/app/pulls/42" },
      title: "Improve app",
      user: { login: "onmax" },
    },
    repository: { full_name: "acme/app" },
    sender: user,
  }
}

describe("GitHub pull request triggers", { timeout: 30_000 }, () => {
  it("runs invoke with the typed delivery and starts no Invocation when it answers ignored()", async () => {
    const state = await stateFile()
    const { agent, calls, run } = reviewerAgent(() => ignored("sent to T3"))
    const { completed, send } = serve(agent, state)

    await expect((await send("review-1", "pull_request_review", review(55))).json()).resolves.toMatchObject({ accepted: true, queued: true })
    await vi.waitFor(() => expect(completed("review-1")).toBe(true))

    expect(calls).toHaveBeenCalledOnce()
    const event = calls.mock.calls[0]![0]
    expect(event).toMatchObject({
      actor: { login: "christoffer", type: "User" },
      body: "Please rename this.",
      deliveryId: "review-1",
      event: "pull_request_review",
      pullRequest: { author: "onmax", headSha: "head-sha", number: 42, repository: "acme/app", title: "Improve app", url: "https://github.test/acme/app/pull/42" },
      reviewState: "changes_requested",
      url: "https://github.test/acme/app/pull/42#pullrequestreview-55",
    })
    expect(event.payload.review?.id).toBe(55)
    expect(run).not.toHaveBeenCalled()
    await vi.waitFor(async () => expect(await journal(state, "review-1")).toEqual(expect.arrayContaining([
      { trigger: "reviewFeedback", type: "trigger.started" },
      { outcome: "response", reason: "sent to T3", status: 200, trigger: "reviewFeedback", type: "trigger.completed" },
      expect.objectContaining({ reason: "sent to T3", type: "completed" }),
    ])))
  })

  it("does not run invoke for a delivery that the trigger does not match", async () => {
    const state = await stateFile()
    const { agent, calls } = reviewerAgent(() => ignored("sent to T3"))
    const { send } = serve(agent, state)

    // The PR author's own review, a PR by someone else, and a review state the trigger does not list.
    await expect((await send("own", "pull_request_review", review(56, { actor: "onmax" }))).json()).resolves.toMatchObject({ reason: "not_command" })
    await send("other-author", "pull_request_review", review(57, { author: "mona" }))
    await send("dismissed", "pull_request_review", review(58, { state: "dismissed" }))
    await send("match", "issue_comment", comment(59))

    await vi.waitFor(() => expect(calls).toHaveBeenCalledOnce())
    expect(calls.mock.calls[0]![0]).toMatchObject({ deliveryId: "match", event: "issue_comment", url: "https://github.test/acme/app/pull/42#issuecomment-59" })
    expect(await journal(state, "own")).toEqual(expect.arrayContaining([expect.objectContaining({ reason: "not_command", type: "completed" })]))
    expect((await journal(state, "own")).some(event => event.type.startsWith("trigger."))).toBe(false)
  })

  it("runs invoke once for a burst on one pull request with debounceMs", async () => {
    const state = await stateFile()
    const { agent, calls } = reviewerAgent(() => ignored("sent to T3"), { debounceMs: 500 })
    const { completed, send } = serve(agent, state)

    await send("review-1", "pull_request_review", review(60))
    await send("comment-1", "issue_comment", comment(61))
    await vi.waitFor(() => expect(completed("comment-1")).toBe(true), { timeout: 5_000 })

    expect(calls).toHaveBeenCalledOnce()
    expect(calls.mock.calls[0]![0]).toMatchObject({ deliveryId: "comment-1", event: "issue_comment" })
  })

  it("runs invoke once when GitHub sends the same delivery again", async () => {
    const state = await stateFile()
    const { agent, calls } = reviewerAgent(() => ignored("sent to T3"))
    const { completed, send } = serve(agent, state)

    await send("review-1", "pull_request_review", review(62))
    await vi.waitFor(() => expect(completed("review-1")).toBe(true))
    await expect((await send("review-1", "pull_request_review", review(62))).json()).resolves.toMatchObject({ duplicate: true })
    await send("review-2", "pull_request_review", review(63))
    await vi.waitFor(() => expect(completed("review-2")).toBe(true))

    expect(calls.mock.calls.map(([event]) => event.deliveryId)).toEqual(["review-1", "review-2"])
  })

  it("runs invoke again when it throws", async () => {
    const state = await stateFile()
    let attempts = 0
    const { agent, calls } = reviewerAgent(() => {
      attempts += 1
      if (attempts === 1) throw new Error("hook unavailable")
      return ignored("sent to T3")
    })
    const { completed, send } = serve(agent, state)

    await send("review-1", "pull_request_review", review(66))
    await vi.waitFor(() => expect(completed("review-1")).toBe(true), { timeout: 20_000 })
    expect(calls).toHaveBeenCalledTimes(2)
    await vi.waitFor(async () => expect(await journal(state, "review-1")).toEqual(expect.arrayContaining([
      { error: "hook unavailable", trigger: "reviewFeedback", type: "trigger.failed" },
      expect.objectContaining({ type: "retrying" }),
      expect.objectContaining({ outcome: "response", reason: "sent to T3", type: "trigger.completed" }),
    ])))
  })

  it("keeps a debounced delivery across a restart and runs invoke in the next process", async () => {
    const state = await stateFile()
    const first = reviewerAgent(() => ignored("sent to T3"), { debounceMs: 1_000 })
    const firstServer = serve(first.agent, state)

    await firstServer.send("review-1", "pull_request_review", review(64))
    await firstServer.stop()
    expect(first.calls).not.toHaveBeenCalled()

    const second = reviewerAgent(() => ignored("sent to T3"))
    serve(second.agent, state)
    await vi.waitFor(() => expect(second.calls).toHaveBeenCalledOnce(), { timeout: 5_000 })
    expect(second.calls.mock.calls[0]![0]).toMatchObject({ deliveryId: "review-1" })
  })

  it("starts the Agent on the pull request when invoke returns input", async () => {
    const state = await stateFile()
    const { agent, calls, run } = reviewerAgent(event => ({ input: { prompt: `Address the review by ${event.actor.login}.` } }))
    const { completed, send } = serve(agent, state)

    await send("review-1", "pull_request_review", review(65))
    await vi.waitFor(() => expect(completed("review-1")).toBe(true))

    expect(calls).toHaveBeenCalledOnce()
    expect(run).toHaveBeenCalledOnce()
    const prompt = run.mock.calls[0]![0].prompt ?? ""
    expect(prompt).toContain("Work on PR #42 in acme/app")
    expect(prompt).toContain("The pull request head is commit head-sha")
    expect(prompt).toContain("Request: Address the review by christoffer.")
    await vi.waitFor(async () => expect(await journal(state, "review-1")).toEqual(expect.arrayContaining([
      { outcome: "input", trigger: "reviewFeedback", type: "trigger.completed" },
      expect.objectContaining({ type: "invocation.started" }),
    ])))
  })

  it("runs a trigger sent from server code in the pull request's queue slot", async () => {
    const state = await stateFile()
    const { agent, calls, run } = reviewerAgent(event => ({ input: { prompt: `Handle: ${event.body ?? event.actor.login}` } }))
    const { completed, send } = serve(agent, state)
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    cleanups.push(async () => release())
    run.mockImplementationOnce(async () => {
      await blocked
      return "ok"
    })

    await send("review-1", "pull_request_review", review(67))
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce(), { timeout: 5_000 })

    const input = { pullRequest: { repository: "Acme/App", number: 42 }, id: "wake-1", body: "Rebase on main." }
    await expect(sendChannelTrigger("github", "reviewFeedback", input)).resolves.toEqual([undefined, { deliveryId: "reviewFeedback:wake-1", queued: true }])
    await expect(sendChannelTrigger("github", "reviewFeedback", input)).resolves.toEqual([undefined, { deliveryId: "reviewFeedback:wake-1", queued: false }])
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(calls).toHaveBeenCalledOnce()

    release()
    await vi.waitFor(() => expect(completed("reviewFeedback:wake-1")).toBe(true), { timeout: 10_000 })
    expect(calls).toHaveBeenCalledTimes(2)
    expect(calls.mock.calls[1]![0]).toMatchObject({
      body: "Rebase on main.",
      deliveryId: "reviewFeedback:wake-1",
      event: "server",
      pullRequest: { author: "onmax", headRef: "feature", headSha: "head-sha", number: 42, repository: "acme/app", title: "Improve app", url: "https://github.test/acme/app/pull/42" },
    })
    expect(run).toHaveBeenCalledTimes(2)
    const prompt = run.mock.calls[1]![0].prompt ?? ""
    expect(prompt).toContain("Work on PR #42 in acme/app.")
    expect(prompt).toContain("The pull request head is commit head-sha")
    expect(prompt).toContain("Request: Handle: Rebase on main.")
    await vi.waitFor(async () => expect(await journal(state, "dispatch:reviewFeedback:wake-1")).toEqual(expect.arrayContaining([
      { outcome: "input", trigger: "reviewFeedback", type: "trigger.completed" },
      expect.objectContaining({ type: "invocation.started" }),
    ])))
  })

  it("rejects a server send without a pull request and skips a closed pull request", async () => {
    const state = await stateFile()
    const open = reviewerAgent(() => ignored("unused"))
    const openServer = serve(open.agent, state)
    const [error] = await sendChannelTrigger("github", "reviewFeedback", { pullRequest: { repository: "acme", number: 42 } })
    expect(error).toMatchObject({ code: "CHANNEL_TRIGGER_FAILED", cause: { code: "AGENT_GITHUB_PULL_REQUEST_TRIGGER_INPUT_INVALID" } })
    await openServer.stop()

    const closedState = await stateFile()
    const closed = reviewerAgent(() => ignored("unused"), { state: "closed" })
    serve(closed.agent, closedState)
    const [closedError, receipt] = await sendChannelTrigger("github", "reviewFeedback", { pullRequest: { repository: "acme/app", number: 42 } })
    expect(closedError).toBeUndefined()
    expect(receipt).toMatchObject({ queued: false })
    expect(closed.calls).not.toHaveBeenCalled()
  })

  it("runs invoke for a teammate's approval with Quiver's GitHub Channel", async () => {
    const state = await stateFile()
    const events: GitHubPullRequestTriggerEvent[] = []
    const run = vi.fn(async () => "ok")
    const feedbackEvents = ["issue_comment", "pull_request_review_comment", "pull_request_review"] as const
    const agent = defineAgent({
      channels: {
        github: github({
          activity: true,
          // SAFETY: This fixture supplies the Fetch-compatible mock used for GitHub requests.
          app: { apiBaseUrl: "https://api.github.test", fetch: (async () => Response.json([])) as typeof fetch, identity: { login: "quiver-bot[bot]" }, token: "app-token" },
          pullRequest: {
            workspace: { mount: "portal" },
            reconcile: {
              concurrencyLimit: 1,
              triggers: [
                {
                  events: ["pull_request_review"],
                  filter: { actor: { allow: ["pullfrog[bot]", "chatgpt-codex-connector[bot]"] }, author: { allow: ["onmax", "quiver-bot[bot]"] } },
                  debounceMs: 60_000,
                  noFindingsReviews: ["> ✅ No new issues found."],
                  prompt: "Independently fix and resolve actionable feedback on this pull request",
                  reviewStates: ["commented", "changes_requested"],
                },
                {
                  events: [...feedbackEvents],
                  filter: { actor: { allow: ["onmax"] }, author: { allow: ["onmax", "quiver-bot[bot]"] } },
                  prompt: "Independently fix and resolve actionable feedback on this pull request",
                  reviewStates: ["commented", "changes_requested"],
                },
                { events: [...feedbackEvents], mentions: ["@bot-dev", "@quiver-bot-dev"] },
              ],
              events: [],
            },
            reply: false,
          },
          triggers: {
            reviewFeedbackToT3: githubPullRequestTrigger({
              events: ["pull_request_review", "issue_comment"],
              filter: { author: { allow: ["onmax", "quiver-bot[bot]"] }, actor: { deny: ["onmax"] } },
              reviewStates: ["commented", "changes_requested", "approved"],
              debounceMs: 200,
              invoke(_context, event) {
                events.push(event)
                return ignored("sent to T3")
              },
            }),
          },
          webhooks: { secret: false },
        }),
      },
      driver: { run },
    })
    const { completed, send } = serve(agent, state)
    const pr = {
      base: { ref: "main", repo: { full_name: "quiverdk/portal" } },
      draft: false,
      head: { ref: "unknown", repo: { fork: false, full_name: "quiverdk/portal" }, sha: "abc123" },
      html_url: "https://github.com/quiverdk/portal/pull/1580",
      labels: [],
      number: 1580,
      state: "open",
      title: "portal#1580",
      url: "https://api.github.test/repos/quiverdk/portal/pulls/1580",
      user: { login: "onmax", type: "User" },
    }
    await send("approval", "pull_request_review", {
      action: "submitted",
      installation: { id: 5 },
      pull_request: pr,
      repository: { full_name: "quiverdk/portal", name: "portal", owner: { login: "quiverdk" }, private: true },
      review: { author_association: "MEMBER", body: "", commit_id: "abc123", html_url: `${pr.html_url}#pullrequestreview-1`, id: 1, node_id: "review", state: "approved", submitted_at: "2026-11-16T09:02:36Z", user: { login: "Christoffersn", type: "User" } },
      sender: { login: "Christoffersn", type: "User" },
    })
    await vi.waitFor(() => expect(completed("approval")).toBe(true), { timeout: 5_000 })

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ actor: { login: "Christoffersn" }, pullRequest: { author: "onmax", headSha: "abc123", number: 1580, repository: "quiverdk/portal" }, reviewState: "approved" })
    expect(run).not.toHaveBeenCalled()
    await vi.waitFor(async () => expect(await journal(state, "approval")).toEqual(expect.arrayContaining([
      { outcome: "response", reason: "sent to T3", status: 200, trigger: "reviewFeedbackToT3", type: "trigger.completed" },
    ])))
  })
})
