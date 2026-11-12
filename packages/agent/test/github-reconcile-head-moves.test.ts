import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import { github } from "../src/channels.ts"
import { defineAgent } from "../src/index.ts"
import { createChannelWebhookRouteHandler } from "../src/server/internal.ts"
import { createLibsqlAgentState } from "../src/state/sqlite.ts"

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

interface Run {
  prompt: string
  signal: AbortSignal | undefined
  finish: () => void
}

async function setup(headMoves?: "notify" | "cancel", events: readonly string[] = []) {
  const directory = await mkdtemp(join(tmpdir(), "vitehub-reconcile-head-moves-"))
  const state = createLibsqlAgentState({ url: `file:${join(directory, "state.sqlite")}` })
  let headSha = "author-sha"
  const fetcher = async (url: string | URL | Request) => Response.json(String(url).endsWith("/pulls/42") ? {
    base: { ref: "main", repo: { full_name: "acme/app" }, sha: "base-sha" },
    head: { ref: "feature", repo: { full_name: "acme/app" }, sha: headSha },
    state: "open",
  } : [])
  const runs: Run[] = []
  const run = vi.fn(async (context: { input: { abortSignal?: AbortSignal }, prompt?: string }) => {
    const signal = context.input.abortSignal
    let finish!: () => void
    const finished = new Promise<void>((resolve) => { finish = resolve })
    runs.push({ finish, prompt: context.prompt ?? "", signal })
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason)
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
      void finished.then(resolve)
    })
    return "ok"
  })
  const agent = defineAgent({
    channels: {
      github: github({
        // SAFETY: This fixture supplies the Fetch-compatible mock used for GitHub requests.
        app: { apiBaseUrl: "https://api.github.test", fetch: fetcher as typeof fetch, token: "app-token" },
        pullRequest: {
          reconcile: {
            concurrencyLimit: 1,
            events,
            ...(headMoves ? { headMoves } : {}),
            triggers: [{ events: ["issue_comment"], mentions: ["@bot"] }],
          },
          reply: false,
        },
        webhooks: { secretToken: false },
      }),
    },
    driver: { run },
  })
  const complete = vi.spyOn(state, "completeWebhookDelivery")
  // SAFETY: The route fixture uses this Agent's declared GitHub webhook.
  const handler = createChannelWebhookRouteHandler(agent as never)
  const routeOptions = { agentName: "reviewer", webhookState: state }
  const stop = handler.resume(routeOptions)
  cleanups.push(async () => {
    for (const item of runs) item.finish()
    await stop()
    await state.disconnect()
    await rm(directory, { force: true, recursive: true })
  })
  const send = (deliveryId: string, event: string, body: unknown) => handler(new Request("https://example.com/api/github/webhook", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", "x-github-delivery": deliveryId, "x-github-event": event },
    method: "POST",
  }), "github", routeOptions)
  const comment = (deliveryId: string, id: number) => send(deliveryId, "issue_comment", {
    action: "created",
    comment: { body: "@bot fix the review finding", html_url: `https://github.test/acme/app/pull/42#issuecomment-${id}`, id, user: { id: 1, login: "onmax", type: "User" } },
    installation: { id: 123 },
    issue: {
      number: 42,
      pull_request: { html_url: "https://github.test/acme/app/pull/42", url: "https://api.github.test/repos/acme/app/pulls/42" },
      title: "Improve app",
      user: { login: "mona" },
    },
    repository: { full_name: "acme/app" },
  })
  const pullRequestEvent = (deliveryId: string, action: "synchronize" | "closed", sender: { login: string, type: string }, sha = headSha) => send(deliveryId, "pull_request", {
    action,
    after: sha,
    installation: { id: 123 },
    number: 42,
    pull_request: {
      head: { ref: "feature", sha },
      html_url: "https://github.test/acme/app/pull/42",
      id: 420,
      number: 42,
      title: "Improve app",
      url: "https://api.github.test/repos/acme/app/pulls/42",
      user: { login: "mona", type: "User" },
    },
    repository: { full_name: "acme/app" },
    sender,
  })
  const push = async (deliveryId: string, sender: { login: string, type: string }, sha: string) => {
    headSha = sha
    return await pullRequestEvent(deliveryId, "synchronize", sender, sha)
  }
  // The first comment runs and blocks; the second waits in the queue behind it.
  const runAndQueue = async () => {
    await expect(comment("comment-1", 1)).resolves.toMatchObject({ status: 200 })
    await vi.waitFor(() => expect(runs).toHaveLength(1), { timeout: 10_000 })
    await expect((await comment("comment-2", 2)).json()).resolves.toMatchObject({ queued: true })
  }
  const completed = (deliveryId: string) => complete.mock.calls.some(call => call[1] === deliveryId)
  return { comment, completed, pullRequestEvent, push, run, runAndQueue, runs }
}

const author = { login: "mona", type: "User" }
const agentApp = { login: "reviewer[bot]", type: "Bot" }

describe("GitHub reconcile runs when the pull request branch moves", () => {
  it("starts a queued run on the new head with a notice after the author pushes", async () => {
    const { completed, push, runAndQueue, runs } = await setup()
    await runAndQueue()

    await expect(push("push-1", author, "pushed-sha")).resolves.toMatchObject({ status: 200 })
    runs[0]!.finish()

    await vi.waitFor(() => expect(runs).toHaveLength(2), { timeout: 10_000 })
    expect(runs[1]!.prompt).toContain("While this request waited, mona pushed commit pushed-sha to the pull request branch.")
    expect(runs[1]!.prompt).toContain("The pull request head is commit pushed-sha")
    expect(runs[0]!.prompt).not.toContain("While this request waited")
    runs[1]!.finish()
    await vi.waitFor(() => expect(completed("comment-2")).toBe(true), { timeout: 10_000 })
  }, 30_000)

  it("drops a queued run after the author pushes with headMoves: \"cancel\"", async () => {
    const { completed, push, run, runAndQueue, runs } = await setup("cancel")
    await runAndQueue()

    await push("push-1", author, "pushed-sha")
    await vi.waitFor(() => expect(runs[0]!.signal?.aborted).toBe(true), { timeout: 10_000 })

    await vi.waitFor(() => expect(completed("comment-2")).toBe(true), { timeout: 10_000 })
    expect(run).toHaveBeenCalledOnce()
  }, 30_000)

  it("cancels a running run after the author pushes with headMoves: \"cancel\"", async () => {
    const { comment, completed, push, run, runs } = await setup("cancel")
    await comment("comment-1", 1)
    await vi.waitFor(() => expect(runs).toHaveLength(1), { timeout: 10_000 })

    await expect(push("push-1", author, "pushed-sha")).resolves.toMatchObject({ status: 200 })
    await vi.waitFor(() => expect(runs[0]!.signal?.aborted).toBe(true), { timeout: 10_000 })

    // A cancelled run is final: the queue settles it and does not run it again.
    await vi.waitFor(() => expect(completed("comment-1")).toBe(true), { timeout: 10_000 })
    expect(run).toHaveBeenCalledOnce()
  }, 30_000)

  it("ignores the Agent's own push", async () => {
    const { push, runAndQueue, runs } = await setup("cancel")
    await runAndQueue()

    await expect(push("push-1", agentApp, "agent-sha")).resolves.toMatchObject({ status: 200 })
    expect(runs[0]!.signal?.aborted).toBe(false)
    runs[0]!.finish()

    await vi.waitFor(() => expect(runs).toHaveLength(2), { timeout: 10_000 })
    expect(runs[1]!.prompt).not.toContain("While this request waited")
  }, 30_000)

  it("runs the synchronize delivery of the push itself with headMoves: \"cancel\"", async () => {
    const { completed, push, run, runs } = await setup("cancel", ["synchronize"])

    await expect(push("push-1", author, "pushed-sha")).resolves.toMatchObject({ status: 200 })
    await vi.waitFor(() => expect(runs).toHaveLength(1), { timeout: 10_000 })
    expect(runs[0]!.prompt).not.toContain("While this request waited")
    runs[0]!.finish()
    await vi.waitFor(() => expect(completed("push-1")).toBe(true), { timeout: 10_000 })
    expect(run).toHaveBeenCalledOnce()
  }, 30_000)

  it("cancels the running run and drops queued runs when the pull request closes", async () => {
    const { completed, pullRequestEvent, run, runAndQueue, runs } = await setup()
    await runAndQueue()

    await expect(pullRequestEvent("closed-1", "closed", author)).resolves.toMatchObject({ status: 200 })
    await vi.waitFor(() => expect(runs[0]!.signal?.aborted).toBe(true), { timeout: 10_000 })

    await vi.waitFor(() => expect(completed("comment-1") && completed("comment-2")).toBe(true), { timeout: 10_000 })
    expect(run).toHaveBeenCalledOnce()
  }, 30_000)
})
