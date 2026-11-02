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
  vi.restoreAllMocks()
})

async function setup(online: boolean) {
  const directory = await mkdtemp(join(tmpdir(), "vitehub-github-metadata-"))
  const state = createLibsqlAgentState({ url: `file:${join(directory, "state.sqlite")}` })
  const cause = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })
  const fetcher = vi.fn(async (url: string | URL | Request) => {
    if (!online) throw new TypeError("fetch failed", { cause })
    return Response.json(String(url).endsWith("/pulls/42") ? {
      base: { ref: "main", repo: { full_name: "acme/app" }, sha: "base-sha" },
      head: { ref: "feature", repo: { full_name: "acme/app" }, sha: "head-sha" },
    } : [])
  })
  const run = vi.fn(() => "ok")
  const agent = defineAgent({
    channels: {
      github: github({
        // SAFETY: This fixture supplies the Fetch-compatible mock used for GitHub requests.
        app: { apiBaseUrl: "https://api.github.test", fetch: fetcher as typeof fetch, token: "app-token" },
        pullRequest: { reconcile: true, reply: false },
        webhooks: { secretToken: false },
      }),
    },
    driver: { run },
  })
  const enqueueDelivery = state.enqueueWebhookDelivery.bind(state)
  const enqueue = vi.spyOn(state, "enqueueWebhookDelivery")
  const retry = vi.spyOn(state, "retryWebhookDelivery")
  const complete = vi.spyOn(state, "completeWebhookDelivery")
  // SAFETY: The route fixture uses this Agent's declared GitHub webhook.
  const handler = createChannelWebhookRouteHandler(agent as never)
  const routeOptions = { agentName: "metadata", webhookState: state }
  const stop = handler.resume(routeOptions)
  cleanups.push(async () => {
    await stop()
    await state.disconnect()
    await rm(directory, { force: true, recursive: true })
  })
  const send = () => handler(new Request("https://example.com/api/github/webhook", {
    body: JSON.stringify({
      action: "opened",
      installation: { id: 123 },
      number: 42,
      pull_request: {
        html_url: "https://github.test/acme/app/pull/42",
        number: 42,
        title: "Improve app",
        url: "https://api.github.test/repos/acme/app/pulls/42",
        user: { login: "mona", type: "User" },
      },
      repository: { full_name: "acme/app" },
      sender: { login: "mona", type: "User" },
    }),
    headers: { "content-type": "application/json", "x-github-delivery": "delivery-1", "x-github-event": "pull_request" },
    method: "POST",
  }), "github", routeOptions)
  return { complete, enqueue, enqueueDelivery, fetcher, retry, run, send, setOnline: (value: boolean) => { online = value } }
}

describe("GitHub pull request metadata admission", () => {
  it("fails the initial delivery before queue admission and recovers on redelivery", async () => {
    const { complete, enqueue, retry, run, send, setOnline } = await setup(false)

    await expect(send()).rejects.toMatchObject({ code: "AGENT_R0370", message: expect.stringContaining("ECONNRESET") })
    expect(enqueue).not.toHaveBeenCalled()
    expect(retry).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()

    setOnline(true)
    await expect(send()).resolves.toMatchObject({ status: 200 })
    expect(enqueue).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce())
    expect(run).toHaveBeenCalledOnce()
  })

  it("retries a metadata failure after the route has admitted the delivery", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const { complete, enqueue, enqueueDelivery, fetcher, retry, run, send, setOnline } = await setup(true)
    enqueue.mockImplementation(async (...args) => {
      const accepted = await enqueueDelivery(...args)
      setOnline(false)
      return accepted
    })

    await expect(send()).resolves.toMatchObject({ status: 200 })
    expect(enqueue).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(retry).toHaveBeenCalledOnce())
    expect(run).not.toHaveBeenCalled()
    expect(complete).not.toHaveBeenCalled()
    const failedReads = fetcher.mock.calls.length

    setOnline(true)
    await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce(), { timeout: 5_000 })
    expect(fetcher.mock.calls.length).toBeGreaterThan(failedReads)
    expect(run).toHaveBeenCalledOnce()
    expect(enqueue).toHaveBeenCalledOnce()
  })
})
