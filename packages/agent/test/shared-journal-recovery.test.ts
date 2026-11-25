import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createMemoryLeaseStore } from "@vite-hub/runtime"
import { Chat, Message } from "chat"
import { afterEach, describe, expect, it, vi } from "vitest"

import { defineChatCapability } from "../src/chat-trigger.ts"
import { agentWorkflow, defineAgent, runAgent, startAgentInvocation } from "../src/index.ts"
import { setAgentWorkflowRuntimeLoaders } from "../src/internal/workflow-runtime-loaders.ts"
import { agentInvocationId, defineAgentInvocations } from "../src/invocations.ts"
import { createLibsqlAgentInvocationStore } from "../src/invocations/sqlite.ts"
import { createChannelWebhookRouteHandler, drainInlineChatInvocations } from "../src/server/internal.ts"
import { createLibsqlAgentState } from "../src/state/sqlite.ts"

import type { LeaseStore } from "@vite-hub/runtime"
import type { Adapter, ChatInstance, WebhookOptions } from "chat"

// Each test opens libSQL files and runs Chat turns, which takes a moment.
vi.setConfig({ testTimeout: 30_000 })

const indexKey = "chat:support:telegram:vitehub:interrupted-chat"
const webhookUrl = "https://example.com/_vitehub/agents/support/webhooks/telegram"

/** A Telegram-shaped adapter that processes each message in the background, like a deployed webhook. */
function telegramAdapter() {
  let chat: ChatInstance | undefined
  let sent = 0
  const adapter = {
    channelIdFromThreadId: (threadId: string) => threadId,
    editMessage: vi.fn(async (threadId: string, messageId: string, message: unknown) => ({ id: messageId, raw: { message }, threadId })),
    fetchMessages: vi.fn(async () => ({ messages: [] })),
    handleWebhook: vi.fn(async (request: Request, webhookOptions?: WebhookOptions) => {
      // SAFETY: The test sends the Telegram update shape that this fake reads.
      const body = await request.json() as { message?: { chat: { id: number }, message_id: number, text: string } }
      if (!body.message || !chat) return Response.json({ ok: true })
      const message = telegramMessage(body.message.message_id, body.message.chat.id, body.message.text)
      // SAFETY: The fake implements the adapter methods that ChatInstance calls.
      chat.processMessage(adapter as unknown as Adapter, message.threadId, message, webhookOptions).catch(() => undefined)
      return Response.json({ ok: true })
    }),
    initialize: vi.fn(async (instance: ChatInstance) => {
      chat = instance
    }),
    isDM: () => true,
    name: "telegram",
    postMessage: vi.fn(async (threadId: string, message: unknown) => ({ id: `sent-${++sent}`, raw: { message }, threadId })),
    startTyping: vi.fn(async () => {}),
    userName: "vitehub",
  }
  return adapter
}

function telegramMessage(id: number, chatId: number, text: string): Message {
  return new Message({
    attachments: [],
    author: { fullName: "Maxi", isBot: false, isMe: false, userId: String(chatId), userName: "maxi" },
    formatted: { children: [], type: "root" },
    id: String(id),
    isMention: false,
    metadata: { dateSent: new Date(), edited: false },
    raw: {},
    text,
    threadId: `telegram:${chatId}`,
  })
}

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  setAgentWorkflowRuntimeLoaders({
    state: () => import("@vite-hub/workflow/runtime/state"),
    workflow: () => import("@vite-hub/workflow"),
  })
  vi.restoreAllMocks()
  // Release a run that a failed assertion left blocked, so it cannot hold the thread lock for later tests.
  await drainInlineChatInvocations({ timeoutMs: 0 })
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** The State file and the journal file that every process of one test shares. */
async function sharedFiles() {
  const directory = await mkdtemp(join(tmpdir(), "vitehub-shared-journal-recovery-"))
  cleanups.push(() => rm(directory, { force: true, recursive: true }))
  return { journal: `file:${join(directory, "journal.sqlite")}`, state: `file:${join(directory, "state.sqlite")}` }
}

/**
 * One server process: its own State client, journal client, Chat adapter, and Agent, like a Node instance on a shared database.
 * `prompts` collects the input of every Driver run of every process in the test.
 */
async function startProcess(files: Awaited<ReturnType<typeof sharedFiles>>, prompts: string[], options: { blockFirstRun?: boolean; storeTimeoutMs?: number; workflow?: boolean } = {}) {
  const state = createLibsqlAgentState({ url: files.state })
  const store = createLibsqlAgentInvocationStore({ url: files.journal })
  // A recovery that finds a claim it cannot take waits one claim lease (30 s) for the owner to renew it.
  // Without a claim token it does not wait. The claim checks below do not depend on that wait.
  const journal = { ...store, getClaimToken: async () => undefined }
  const adapter = telegramAdapter()
  const agent = defineAgent({
    capabilities: [
      defineChatCapability({
        // SAFETY: The fake implements the Adapter methods that the chat route calls.
        platforms: { telegram: () => adapter as unknown as Adapter },
        webhooks: { telegram: {} },
      }),
    ],
    driver: {
      run: async ({ input }: { input: { abortSignal?: AbortSignal } }) => {
        prompts.push(JSON.stringify(input))
        // The first run of the test continues until its process stops.
        if (options.blockFirstRun && prompts.length === 1) {
          await new Promise<never>((_resolve, reject) => {
            input.abortSignal?.addEventListener("abort", () => reject(input.abortSignal?.reason), { once: true })
          })
        }
        return "done"
      },
    },
    invocations: defineAgentInvocations({ store: journal, storeTimeoutMs: options.storeTimeoutMs }),
    name: "support",
    runtime: options.workflow ? agentWorkflow("support") : false,
  })
  // SAFETY: The test Agent supplies the route contract through defineAgent.
  const handler = createChannelWebhookRouteHandler(agent as never)
  await state.connect()
  const stops: (() => Promise<void>)[] = []
  cleanups.push(async () => {
    await Promise.all(stops.map(stop => stop()))
    await state.disconnect()
  })
  const routeOptions = { agentIdentity: { name: "support" }, state, webhookState: state }
  return {
    adapter,
    state,
    store: journal,
    /** Admits one Telegram message. The turn continues in the background. */
    async say(id: number, text: string) {
      const response = await handler(new Request(webhookUrl, {
        body: JSON.stringify({ message: { chat: { id: 456 }, date: Math.floor(Date.now() / 1000), from: { id: 456 }, message_id: id, text }, update_id: id }),
        method: "POST",
      }), "telegram", { ...routeOptions, waitUntil: () => undefined })
      expect(response.status).toBe(200)
    },
    /** Starts the webhook queue like the server plugin does when this process starts, with its recovery. */
    boot(options: { recoverySweep?: { leases: LeaseStore, intervalMs?: number, withoutQueue?: boolean }, discoveredJournalNames?: string[] } = {}) {
      stops.push(handler.resume({ ...routeOptions, ...options, recoverInterruptedBefore: Date.now() }))
    },
  }
}

/** Writes what a process leaves when it stops during a chat turn: the restart record and a running Invocation. */
async function writeInterruptedTurn(files: Awaited<ReturnType<typeof sharedFiles>>, runId: string, messageId = 3001, chatId = 456) {
  const state = createLibsqlAgentState({ url: files.state })
  const store = createLibsqlAgentInvocationStore({ url: files.journal })
  await state.connect()
  const startedAt = new Date(Date.now() - 60_000).toISOString()
  const message = telegramMessage(messageId, chatId, "review the pull request")
  await state.set(indexKey, {
    ...await state.get<Record<string, unknown>>(indexKey),
    [runId]: { agentName: "support", message: message.toJSON(), runId, startedAt, threadId: message.threadId, transcriptUserKey: null },
  })
  const id = await agentInvocationId(runId, "support")
  await store.create({ agentName: "support", createdAt: startedAt, id, observations: [], startedAt, status: "running", traceId: runId, updatedAt: startedAt })
  // The stopped process held the claim. It does not renew it, so the claim expires.
  expect(await store.claim(id, "stopped-process", 1)).toBe(true)
  await new Promise(resolve => setTimeout(resolve, 10))
  await state.disconnect()
}

// Each boot recovers interrupted Invocations first and interrupted chat turns after them, as the server plugin does.
describe("recovery at boot on processes that share one journal and one State", () => {
  it("does not fail or run again a live chat turn of another process", async () => {
    const files = await sharedFiles()
    const prompts: string[] = []
    const first = await startProcess(files, prompts, { blockFirstRun: true })
    await first.say(2001, "review the pull request")
    await vi.waitFor(() => expect(prompts).toHaveLength(1), { timeout: 10_000 })
    const records = await first.state.get<Record<string, { runId: string }>>(indexKey)
    const runId = Object.values(records ?? {})[0]?.runId
    expect(runId).toBeDefined()
    const id = await agentInvocationId(runId!, "support")
    await vi.waitFor(async () => expect(await first.store.getSummary(id)).toMatchObject({ status: "running" }))

    // A second instance starts while the first one still runs the turn and renews its journal claim.
    const dispatch = vi.spyOn(Chat.prototype, "processMessage")
    const second = await startProcess(files, prompts)
    const claim = vi.spyOn(second.store, "claim")
    second.boot()
    await vi.waitFor(() => expect(dispatch.mock.calls.length + claim.mock.calls.filter(([claimed, claimId]) => claimed === id && claimId.startsWith("probe_")).length).toBeGreaterThan(0), { timeout: 10_000 })
    await new Promise(resolve => setTimeout(resolve, 300))

    expect(dispatch).not.toHaveBeenCalled()
    expect(prompts).toHaveLength(1)
    expect(second.adapter.postMessage).not.toHaveBeenCalled()
    expect(Object.keys(await second.state.get<Record<string, unknown>>(indexKey) ?? {})).toEqual([runId])
    expect(await second.store.getSummary(id)).toMatchObject({ status: "running" })
  })

  it.each([1, 2])("runs a chat turn whose claim expired again exactly once when %i processes start", async (count) => {
    const files = await sharedFiles()
    await writeInterruptedTurn(files, "stopped-turn")
    const prompts: string[] = []
    const processes = await Promise.all(Array.from({ length: count }, () => startProcess(files, prompts)))
    for (const instance of processes) instance.boot()

    await vi.waitFor(() => expect(prompts).toHaveLength(1), { timeout: 10_000 })
    await vi.waitFor(async () => expect(await processes[0]!.state.get(indexKey)).toBeNull(), { timeout: 5_000 })
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain("[Retry after interruption]")
    expect(prompts[0]).toContain("review the pull request")
    const notices = processes.flatMap(instance => [...instance.adapter.postMessage.mock.calls, ...instance.adapter.editMessage.mock.calls]).flat()
    expect(notices.filter(value => typeof value === "string" && value.includes("The server restarted"))).toHaveLength(1)
    expect(await processes[0]!.store.getSummary(await agentInvocationId("stopped-turn", "support"))).toMatchObject({ status: "failed" })
  })

  it("keeps the start time test when the journal check fails", async () => {
    const files = await sharedFiles()
    await writeInterruptedTurn(files, "stopped-turn")
    const prompts: string[] = []
    const restarted = await startProcess(files, prompts)
    const id = await agentInvocationId("stopped-turn", "support")
    const getSummary = restarted.store.getSummary
    vi.spyOn(restarted.store, "getSummary").mockImplementation(async (summaryId: string) => {
      const summary = await getSummary(summaryId)
      if (summaryId === id && summary?.status === "failed") throw new Error("journal unavailable")
      return summary
    })
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined)
    restarted.boot()

    await vi.waitFor(() => expect(prompts).toHaveLength(1), { timeout: 10_000 })
    expect(prompts[0]).toContain("[Retry after interruption]")
    expect(logged.mock.calls.some(([message]) => typeof message === "string" && message.includes("claim check failed"))).toBe(true)
    await vi.waitFor(async () => expect(await restarted.state.get(indexKey)).toBeNull(), { timeout: 5_000 })
  })

  it.each(["getSummary", "claim", "release"] as const)("recovers all interrupted turns when a probe's %s stays pending", async (operation) => {
    const files = await sharedFiles()
    await writeInterruptedTurn(files, "stalled-turn")
    await writeInterruptedTurn(files, "other-turn", 3002, 789)
    const prompts: string[] = []
    const restarted = await startProcess(files, prompts, { storeTimeoutMs: 100 })
    const id = await agentInvocationId("stalled-turn", "support")
    // Stall only the Chat probe, after Invocation recovery marks the record failed.
    if (operation === "getSummary") {
      const getSummary = restarted.store.getSummary
      vi.spyOn(restarted.store, "getSummary").mockImplementation(async (summaryId) => {
        const summary = await getSummary(summaryId)
        return summaryId === id && summary?.status === "failed" ? new Promise<never>(() => {}) : summary
      })
    }
    else if (operation === "claim") {
      const claim = restarted.store.claim
      vi.spyOn(restarted.store, "claim").mockImplementation((claimedId, claimId, ...args) => claimedId === id && claimId.startsWith("probe_")
        ? new Promise<never>(() => {}) : claim(claimedId, claimId, ...args))
    }
    else {
      const release = restarted.store.release
      vi.spyOn(restarted.store, "release").mockImplementation((claimedId, claimId) => claimedId === id && claimId.startsWith("probe_")
        ? new Promise<never>(() => {}) : release(claimedId, claimId))
    }
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined)
    restarted.boot()

    await vi.waitFor(() => expect(prompts).toHaveLength(2), { timeout: 10_000 })
    expect(prompts.every(prompt => prompt.includes("[Retry after interruption]"))).toBe(true)
    expect(logged.mock.calls.some(([message]) => typeof message === "string" && message.includes("claim check failed"))).toBe(true)
    await vi.waitFor(async () => expect(await restarted.state.get(indexKey)).toBeNull(), { timeout: 5_000 })
  })

  it("runs a chat turn again after the same process stops and starts", async () => {
    const files = await sharedFiles()
    const prompts: string[] = []
    const first = await startProcess(files, prompts, { blockFirstRun: true })
    await first.say(2101, "review the pull request")
    await vi.waitFor(() => expect(prompts).toHaveLength(1), { timeout: 10_000 })
    await expect(drainInlineChatInvocations({ timeoutMs: 0 })).resolves.toMatchObject({ interrupted: 1 })

    const restarted = await startProcess(files, prompts)
    restarted.boot()
    await vi.waitFor(() => expect(prompts).toHaveLength(2), { timeout: 10_000 })
    expect(prompts[1]).toContain("[Retry after interruption]")
    await vi.waitFor(async () => expect(await restarted.state.get(indexKey)).toBeNull(), { timeout: 5_000 })
  })

  it.each([false, true])("fails an Invocation that another process left running under a recovery Lease (without queue: %s)", async (withoutQueue) => {
    const files = await sharedFiles()
    const prompts: string[] = []
    const leases = createMemoryLeaseStore()
    const processes = await Promise.all([startProcess(files, prompts), startProcess(files, prompts)])
    for (const instance of processes) instance.boot({ recoverySweep: { intervalMs: 100, leases, withoutQueue } })
    await new Promise(resolve => setTimeout(resolve, 300))
    const sweeps = processes.map(instance => vi.spyOn(instance.store, "list"))

    const startedAt = new Date(Date.now() - 60_000).toISOString()
    const id = await agentInvocationId("crashed-run", "support")
    await processes[0]!.store.create({ agentName: "support", createdAt: startedAt, id, observations: [], startedAt, status: "running", traceId: "crashed-run", updatedAt: startedAt })
    expect(await processes[0]!.store.claim(id, "crashed-process", 1)).toBe(true)

    await vi.waitFor(async () => expect(await processes[1]!.store.getSummary(id)).toMatchObject({ status: "failed" }), { timeout: 2_000 })
    expect(sweeps.filter(list => list.mock.calls.length > 0)).toHaveLength(1)
  })

  it.each([false, true])("recovers named and unnamed inline runs without taking Workflow custody (Workflow route: %s)", async (workflow) => {
    const files = await sharedFiles()
    const prompts: string[] = []
    const restarted = await startProcess(files, prompts, { workflow })
    const runtime = { memo: vi.fn(), runtime: "unknown" as const, waitUntil: vi.fn() }
    setAgentWorkflowRuntimeLoaders({
      state: async () => ({
        ...await import("@vite-hub/workflow/runtime/state"),
        getWorkflowRuntimeConfig: () => ({ driver: "openworkflow" as const }),
        getWorkflowRuntimeRegistry: () => ({}),
      }),
      workflow: async () => ({
        ...await import("@vite-hub/workflow"),
        createWorkflow: ((name: string) => ({
          name,
          start: async () => [undefined, { id: name, provider: "openworkflow", status: "queued" }],
        })) as never,
      }),
    })
    const invocations = defineAgentInvocations({ store: restarted.store })
    const driver = { run: () => "done" }
    await runAgent(defineAgent({ driver, invocations, name: "inline-probe", runtime: false }), { prompt: "summarize" }, { runtimeContext: runtime })
    const inlineRun = (await restarted.store.list({ agentName: "inline-probe" })).invocations[0]!
    expect(inlineRun).toMatchObject({ status: "completed", executionMode: "inline" })
    const startedAt = new Date(Date.now() - 60_000).toISOString()
    const running = async (runId: string, agentName: string | undefined, claim: { id: string, leaseMs: number }) => {
      const id = await agentInvocationId(runId, agentName)
      await restarted.store.create({ agentName, createdAt: startedAt, executionMode: inlineRun.executionMode, id, observations: [], startedAt, status: "running", traceId: runId, updatedAt: startedAt })
      expect(await restarted.store.claim(id, claim.id, claim.leaseMs)).toBe(true)
      return id
    }
    const stoppedInlineRun = await running("stopped-summary", "summaries", { id: "stopped-process", leaseMs: 1 })
    const stoppedUnnamedRun = await running("stopped-unnamed", undefined, { id: "stopped-process", leaseMs: 1 })
    const inlineRunInOtherProcess = await running("live-summary", "summaries", { id: "other-process", leaseMs: 60_000 })
    const otherRouteAgentRun = await running("other-route", "billing", { id: "stopped-process", leaseMs: 1 })
    const queuedInlineRun = await running("queued-summary", "summaries", { id: "stopped-process", leaseMs: 1 })
    const legacyRun = await agentInvocationId("legacy-run", "legacy")
    await restarted.store.create({ agentName: "legacy", createdAt: startedAt, id: legacyRun, observations: [], startedAt, status: "running", traceId: "legacy-run", updatedAt: startedAt })
    const workflowIds = await Promise.all(["billing", "undiscovered"].map(async (name) => {
      const agent = defineAgent({ driver, invocations, name, runtime: agentWorkflow(name === "billing" ? "finance" : name) })
      const started = await startAgentInvocation(agent, runtime, { prompt: "summarize" })
      const id = await agentInvocationId(started.id, name)
      expect(await restarted.store.getSummary(id)).toMatchObject({ status: "pending" })
      return id
    }))
    await restarted.state.enqueueWebhookDelivery({
      concurrencyGroup: "billing:default",
      concurrencyLimit: 1,
      deliveryId: "queued-summary",
      enqueuedAt: Date.now(),
      invocation: { agentName: "summaries", input: { prompt: "summarize" }, run: { runId: "queued-summary" } },
      leaseTtlMs: 30_000,
      request: { body: "{}", headers: {}, method: "POST", url: "https://example.com/api/github/webhook" },
      scope: "webhook:billing:github:github:",
      webhookId: "github",
    })
    await new Promise(resolve => setTimeout(resolve, 10))

    restarted.boot({ discoveredJournalNames: ["support", "billing"] })

    await vi.waitFor(async () => expect(await restarted.store.getSummary(stoppedInlineRun)).toMatchObject({ status: "failed" }), { timeout: 5_000 })
    expect(await restarted.store.getSummary(stoppedUnnamedRun)).toMatchObject({ status: "failed" })
    for (const id of workflowIds) expect(await restarted.store.getSummary(id)).toMatchObject({ status: "pending", executionMode: "workflow" })
    expect(await restarted.store.getSummary(inlineRunInOtherProcess)).toMatchObject({ status: "running" })
    expect(await restarted.store.getSummary(otherRouteAgentRun)).toMatchObject({ status: "running" })
    expect(await restarted.store.getSummary(queuedInlineRun)).toMatchObject({ status: "running" })
    expect(await restarted.store.getSummary(legacyRun)).toMatchObject({ status: "running" })
  })
})
