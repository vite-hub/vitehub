import { createMessage } from "../src/messages.ts"
import { describe, expect, it, vi } from "vitest"
import * as v from "valibot"
import { agentInvocationCallerAbortSignal, markAgentInvocationCallerAbortSignal } from "../src/internal/invocation-input.ts"
import { portableResolvedAgentInvokerInput, restoreResolvedAgentInvokerInput, withResolvedAgentInvokerInput } from "../src/invoker.ts"

import { agentInvocationRerunInput, defineAgent, defineCapability, runAgent, startAgentInvocation } from "../src/index.ts"
import { AGENT_INVOCATION_OBSERVATION_TRUNCATED_ATTRIBUTE, createMemoryAgentInvocationStore, defineAgentInvocations } from "../src/server.ts"

import type { AgentInvocationsOptions } from "../src/server.ts"
import type { TraceEventLogEntry } from "@vite-hub/runtime"

function runtime(runId: string) {
  return {
    memo: vi.fn(),
    run: { runId },
    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    runtime: "unknown" as const,
    waitUntil: vi.fn(),
  }
}

async function journaled(input: Parameters<typeof runAgent>[2], options: Partial<AgentInvocationsOptions> = {}, resolve?: () => { id: string, kind: "user", label: string }, profileId = "reviewer", runMetadata: Partial<NonNullable<Parameters<typeof runAgent>[1]["run"]>> = {}) {
  const invocations = defineAgentInvocations({ metadataContent: ["input.messages", "input.prompt"], ...options, store: createMemoryAgentInvocationStore() })
  const agent = defineAgent({
    data: v.unknown(),
    driver: { run: async () => "done" },
    invocations,
    invoker: { profiles: [{ id: profileId, kind: "user", label: "Reviewer" }], resolve },
    runtime: false,
  })
  const runId = `rerun-${Math.random().toString(36).slice(2)}`
  await runAgent(agent, { ...runtime(runId), run: { runId, ...runMetadata } }, input)
  await vi.waitFor(async () => {
    expect(await invocations.getByRunId(runId)).toMatchObject({ status: "completed" })
  })
  return (await invocations.getByRunId(runId))!
}

const start = (attributes: Record<string, unknown>): TraceEventLogEntry => ({
  attributes: { "input.replay.version": 5, "input.promptChanged": false, "input.hasContext": false, "input.hasRunMetadata": false, "input.hasTimeout": false, "input.hasAbortSignal": false, "input.hasDryRun": false, "input.hasInvoker": false, "input.hasResolvedInvoker": false, "input.hasData": false, "input.hasOptions": false, "input.hasMessages": false, ...attributes },
  name: "agent.invocation.start",
  sequence: 1,
  timestamp: new Date(0).toISOString(),
  type: "run",
})

describe("agentInvocationRerunInput", () => {
  it("rejects an explicitly supplied empty messages array", async () => {
    const record = await journaled({ messages: [], prompt: "Hi" })
    expect(record.observations.find(observation => observation.name === "agent.invocation.start")?.attributes).toMatchObject({
      "input.hasMessages": true,
    })
    expect(agentInvocationRerunInput(record)).toEqual({ available: false, reason: "input-has-messages" })
  })


  it("rejects an explicitly empty messages array alongside a prompt", async () => {
    const record = await journaled({ messages: [], prompt: "Hi" }, { metadataContent: ["input.prompt"] })
    expect(record.observations.find(observation => observation.name === "agent.invocation.start")?.attributes)
      .toMatchObject({ "input.hasMessages": true })
    expect(agentInvocationRerunInput(record)).toEqual({ available: false, reason: "input-has-messages" })
  })

  it.each([
    "different text",
    createMessage({ role: "user", text: "attached message", parts: [{ type: "file", mediaType: "text/plain", data: "attachment" }] }),
  ])("rejects singular message input alongside a prompt: %s", async (message) => {
    const record = await journaled({ message, prompt: "Hi" })
    expect(agentInvocationRerunInput(record)).toEqual({ available: false, reason: "input-has-messages" })
  })

  it.each([false, true])("preserves dry-run provenance: %s", async (dryRun) => {
    const record = await journaled({ dryRun, prompt: "Hi" })
    expect(agentInvocationRerunInput(record)).toEqual(dryRun
      ? { available: false, reason: "input-has-dry-run" }
      : { available: true, prompt: "Hi" })
  })

  it.each(["capability", "hook"] as const)("rejects prompts rewritten by an input %s", async (source) => {
    const invocations = defineAgentInvocations({ metadataContent: ["input.prompt"], store: createMemoryAgentInvocationStore() })
    const run = vi.fn(({ prompt }: { prompt?: string }) => prompt)
    const agent = source === "capability"
      ? defineAgent({
          capabilities: [defineCapability({
            id: "rewrite-prompt",
            prepare(context) { context.input.set({ ...context.input.get(), prompt: `wrapped:${context.input.get().prompt}` }) },
          })],
          driver: { run },
          invocations,
          runtime: false,
        })
      : defineAgent({
          driver: { run },
          hooks: { "agent:input": ({ input }) => { input.prompt = `wrapped:${input.prompt}` } },
          invocations,
          runtime: false,
        })
    const runId = `rewrite-${source}`
    await runAgent(agent, runtime(runId), { prompt: "original" })
    await vi.waitFor(async () => { expect(await invocations.getByRunId(runId)).toMatchObject({ status: "completed" }) })
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ prompt: "wrapped:original" }))
    expect(agentInvocationRerunInput((await invocations.getByRunId(runId))!)).toEqual({ available: false, reason: "input-prompt-changed" })
  })

  it("rejects input commands whose handlers replace the caller prompt", async () => {
    const { inputCommands } = await import("../src/capabilities.ts")
    const invocations = defineAgentInvocations({ metadataContent: ["input.prompt"], store: createMemoryAgentInvocationStore() })
    const call = vi.fn(() => "Review this: changes")
    const run = vi.fn(({ prompt }: { prompt?: string }) => prompt)
    const agent = defineAgent({
      capabilities: [inputCommands({ commands: { review: { call } } })],
      driver: { run },
      invocations,
      runtime: false,
    })
    await runAgent(agent, runtime("command-replay"), { prompt: "/review changes" })
    await vi.waitFor(async () => { expect(await invocations.getByRunId("command-replay")).toMatchObject({ status: "completed" }) })
    expect(call).toHaveBeenCalledOnce()
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ prompt: "Review this: changes" }))
    expect(agentInvocationRerunInput((await invocations.getByRunId("command-replay"))!)).toEqual({ available: false, reason: "input-prompt-changed" })
  })

  it("retains a profile selector's original context fields after in-place preparation", async () => {
    const invocations = defineAgentInvocations({ metadataContent: ["input.prompt"], store: createMemoryAgentInvocationStore() })
    const profile = { id: "reviewer", trustedScope: "customer-a" }
    const agent = defineAgent({
      capabilities: [defineCapability({
        id: "mutate-profile",
        prepare() { Reflect.deleteProperty(profile, "trustedScope") },
      })],
      driver: { run: () => "done" },
      invocations,
      invoker: { profiles: [{ id: "reviewer", kind: "person" }] },
      runtime: false,
    })
    await runAgent(agent, runtime("mutated-profile"), { context: { invokerProfile: profile }, prompt: "original" })
    await vi.waitFor(async () => { expect(await invocations.getByRunId("mutated-profile")).toMatchObject({ status: "completed" }) })
    expect(profile).toEqual({ id: "reviewer" })
    expect(agentInvocationRerunInput((await invocations.getByRunId("mutated-profile"))!)).toEqual({ available: false, reason: "input-has-context" })
  })

  it.each([
    { input: { context: { trustedScope: "customer-a" }, prompt: "original" }, reason: "input-has-context" },
    { input: { data: { trustedScope: "customer-a" }, prompt: "original" }, reason: "input-has-data" },
  ])("keeps original replay blockers when preparation replaces input: $reason", async ({ input, reason }) => {
    const invocations = defineAgentInvocations({ metadataContent: ["input.prompt"], store: createMemoryAgentInvocationStore() })
    const agent = defineAgent({
      capabilities: [defineCapability({ id: "replace-input", prepare(context) { context.input.set({ prompt: context.input.get().prompt }) } })],
      data: v.unknown(),
      driver: { run: () => "done" },
      invocations,
      runtime: false,
    })
    const runId = `replace-${reason}`
    await runAgent(agent, runtime(runId), input)
    await vi.waitFor(async () => { expect(await invocations.getByRunId(runId)).toMatchObject({ status: "completed" }) })
    expect(agentInvocationRerunInput((await invocations.getByRunId(runId))!)).toEqual({ available: false, reason })
  })

  it.each(["invoker.profileId", "invokerProfileId", "invoker.profile", "invokerProfile"])("replays the supported %s profile selector", async (key) => {
    for (const value of ["reviewer", { id: "reviewer" }]) {
      const record = await journaled({ context: { [key]: value }, prompt: "Hi" })
      expect(agentInvocationRerunInput(record)).toEqual({ available: true, invokerProfileId: "reviewer", prompt: "Hi" })
    }
  })

  it("does not discard extra fields supplied with a profile selector", async () => {
    const record = await journaled({ context: { invokerProfile: { id: "reviewer", trustedScope: "customer-a" } }, prompt: "Hi" })
    expect(agentInvocationRerunInput(record)).toEqual({ available: false, reason: "input-has-context" })
  })

  it("rejects replay that drops trusted input context", async () => {
    const record = await journaled({ context: { trustedScope: "customer-a" }, prompt: "Hi" })
    expect(agentInvocationRerunInput(record)).toEqual({ available: false, reason: "input-has-context" })
  })

  it.each([{ channelId: "telegram" }, { origin: "trigger" }, { threadId: "customer-a" }, { annotations: { scope: "customer-a" } }])("rejects replay that drops semantic run metadata %j", async (runMetadata) => {
    const record = await journaled({ prompt: "Hi" }, {}, undefined, "reviewer", runMetadata)
    expect(agentInvocationRerunInput(record)).toEqual({ available: false, reason: "input-has-run-metadata" })
  })

  it.each(["controller", "deadline"])("rejects a direct %s abort signal", async (source) => {
    const abortSignal = source === "deadline" ? AbortSignal.timeout(60_000) : new AbortController().signal
    const record = await journaled({ abortSignal, prompt: "Hi" })
    expect(agentInvocationRerunInput(record)).toEqual({ available: false, reason: "input-has-abort-signal" })
  })

  it.each([false, true])("distinguishes controller-owned cancellation from a caller abort signal: %s", async (direct) => {
    const invocations = defineAgentInvocations({ metadataContent: ["input.prompt"], store: createMemoryAgentInvocationStore() })
    const agent = defineAgent({ driver: { run: () => "done" }, invocations, runtime: false })
    const runId = `controlled-signal-${direct}`
    await startAgentInvocation(agent, runtime(runId), {
      ...(direct ? { abortSignal: new AbortController().signal } : {}),
      prompt: "Hi",
    }, { runId })
    await vi.waitFor(async () => { expect(await invocations.getByRunId(runId)).toMatchObject({ status: "completed" }) })
    expect(agentInvocationRerunInput((await invocations.getByRunId(runId))!)).toEqual(direct
      ? { available: false, reason: "input-has-abort-signal" }
      : { available: true, prompt: "Hi" })
  })

  it("preserves controller provenance through optional data and message normalization", async () => {
    const invocations = defineAgentInvocations({ metadataContent: ["input.prompt"], store: createMemoryAgentInvocationStore() })
    const run = vi.fn(({ input }: { input: { abortSignal?: AbortSignal, data?: unknown } }) => {
      expect(input.data).toBeUndefined()
      expect(input.abortSignal).toBeDefined()
      expect(agentInvocationCallerAbortSignal(input)).toBe(false)
      return "done"
    })
    const agent = defineAgent({
      capabilities: [defineCapability({
        id: "normalize-messages",
        prepare(context) { context.input.setMessages([createMessage({ role: "user", text: "Prepared message." })]) },
      })],
      data: v.optional(v.object({ count: v.number() })),
      driver: { run },
      invocations,
      runtime: false,
    })
    await startAgentInvocation(agent, runtime("normalized-controller-signal"), { prompt: "Hi" }, { runId: "normalized-controller-signal" })
    await vi.waitFor(async () => { expect(await invocations.getByRunId("normalized-controller-signal")).toMatchObject({ status: "completed" }) })
    expect(run).toHaveBeenCalledOnce()
    const record = (await invocations.getByRunId("normalized-controller-signal"))!
    expect(record.observations.find(observation => observation.name === "agent.invocation.start")?.attributes?.["input.hasAbortSignal"]).toBe(false)
    expect(agentInvocationRerunInput(record)).toEqual({ available: true, prompt: "Hi" })
  })

  it("blocks replay when preparation installs a different cancellation signal", async () => {
    const invocations = defineAgentInvocations({ metadataContent: ["input.prompt"], store: createMemoryAgentInvocationStore() })
    const abortSignal = new AbortController().signal
    const agent = defineAgent({
      capabilities: [defineCapability({
        id: "replace-cancellation",
        prepare(context) { context.input.set({ ...context.input.get(), abortSignal }) },
      })],
      driver: { run: ({ input }) => { expect(input.abortSignal).toBe(abortSignal); return "done" } },
      invocations,
      runtime: false,
    })
    await runAgent(agent, runtime("replacement-signal"), { prompt: "Hi" })
    await vi.waitFor(async () => { expect(await invocations.getByRunId("replacement-signal")).toMatchObject({ status: "completed" }) })
    expect(agentInvocationRerunInput((await invocations.getByRunId("replacement-signal"))!)).toEqual({ available: false, reason: "input-has-abort-signal" })
  })

  it.each([false, true])("inherits trusted caller-signal provenance in an inline controller: %s", async (supplied) => {
    const invocations = defineAgentInvocations({ metadataContent: ["input.prompt"], store: createMemoryAgentInvocationStore() })
    const agent = defineAgent({ driver: { run: () => "done" }, invocations, runtime: false })
    const input = { ...(supplied ? {} : { abortSignal: new AbortController().signal }), prompt: "Hi" }
    markAgentInvocationCallerAbortSignal(input, supplied)
    const runId = `restored-controlled-signal-${supplied}`
    await startAgentInvocation(agent, runtime(runId), input, { runId })
    await vi.waitFor(async () => { expect(await invocations.getByRunId(runId)).toMatchObject({ status: "completed" }) })
    expect(agentInvocationRerunInput((await invocations.getByRunId(runId))!)).toEqual(supplied
      ? { available: false, reason: "input-has-abort-signal" }
      : { available: true, prompt: "Hi" })
  })

  it("rejects replay that drops the Invocation timeout", async () => {
    const record = await journaled({ prompt: "Hi", timeout: 1_000 })
    expect(agentInvocationRerunInput(record)).toEqual({ available: false, reason: "input-has-timeout" })
  })

  it("keeps replay provenance when observation bounds remove other metadata", async () => {
    for (const direct of [false, true]) {
      const record = await journaled({ ...(direct ? { context: { invoker: { id: "direct-owner", kind: "person" } } } : {}), prompt: "Hi" }, {
        redact: observation => observation.name === "agent.invocation.start"
          ? { ...observation, attributes: { ...Object.fromEntries(Array.from({ length: 70 }, (_, index) => [`custom_${index}`, index])), ...observation.attributes } }
          : observation,
      })
      const attributes = record.observations.find(observation => observation.name === "agent.invocation.start")?.attributes
      expect(attributes).toMatchObject({ "input.replay.version": 5, "input.promptChanged": false, "input.hasInvoker": direct, "input.hasData": false, "input.hasOptions": false, "input.hasMessages": false })
      expect(agentInvocationRerunInput(record).available).toBe(false)
    }
  })

  it("returns the captured prompt and selected Invoker Profile", async () => {
    const record = await journaled({ context: { invokerProfileId: "reviewer" }, prompt: "Summarize the release notes." })
    expect(agentInvocationRerunInput(record)).toEqual({ available: true, invokerProfileId: "reviewer", prompt: "Summarize the release notes." })
  })

  it("keeps prompt replay available when unrelated metadata is bounded", async () => {
    const record = await journaled({ context: { invokerProfileId: "reviewer" }, prompt: "Complete prompt." }, {}, () => ({ id: "resolved", kind: "user", label: "x".repeat(2_000) }))
    expect(agentInvocationRerunInput(record)).toEqual({ available: true, invokerProfileId: "reviewer", prompt: "Complete prompt." })
  })

  it("rejects an unprofiled invoker derived by the inline resolver", async () => {
    const record = await journaled({ prompt: "Hi" }, {}, () => ({ id: "request-owner", kind: "user", label: "Request owner" }))
    expect(record.observations.find(observation => observation.name === "agent.invocation.start")?.attributes)
      .toMatchObject({ "input.hasInvoker": false, "input.hasResolvedInvoker": true, "agent.invoker.id": "request-owner" })
    expect(agentInvocationRerunInput(record)).toEqual({ available: false, reason: "input-has-invoker" })
  })

  it("rejects replay when bounding changes the selected profile ID", async () => {
    const profileId = "reviewer".repeat(200)
    const record = await journaled({ context: { invokerProfileId: profileId }, prompt: "Hi" }, { observations: { maxStringLength: 1_000 } }, undefined, profileId)
    expect(agentInvocationRerunInput(record)).toEqual({ available: false, reason: "input-truncated" })
  })

  it("preserves a selected profile when its resolver changes invoker identity", async () => {
    const record = await journaled({ context: { invokerProfileId: "reviewer" }, prompt: "Hi" }, {}, () => ({ id: "resolved", kind: "user", label: "Resolved" }))
    expect(agentInvocationRerunInput(record)).toEqual({ available: true, invokerProfileId: "reviewer", prompt: "Hi" })
  })

  it.each([false, true])("preserves request-derived invoker replay authority with selected profile %s", async (selectedProfile) => {
    const invocations = defineAgentInvocations({ metadataContent: ["input.prompt"], store: createMemoryAgentInvocationStore() })
    const resolve = vi.fn(({ request }: { request?: Request }) => ({ id: request?.headers.get("x-actor") || "console-actor", kind: "user" }))
    const agent = defineAgent({
      driver: { run: () => "done" },
      invocations,
      invoker: { profiles: [{ id: "reviewer", kind: "user" }], resolve },
      runtime: false,
    })
    const runId = `request-derived-${selectedProfile}`
    await runAgent(agent, { ...runtime(runId), request: new Request("https://consumer.test/run", { headers: { "x-actor": "request-actor" } }) }, {
      prompt: "Hi",
      ...(selectedProfile ? { context: { invokerProfileId: "reviewer" } } : {}),
    })
    await vi.waitFor(async () => { expect(await invocations.getByRunId(runId)).toMatchObject({ status: "completed" }) })
    const record = (await invocations.getByRunId(runId))!
    expect(resolve).toHaveBeenCalledOnce()
    expect(record.observations.find(observation => observation.name === "agent.invocation.start")?.attributes)
      .toMatchObject({ "agent.invoker.id": "request-actor", "input.hasInvoker": false, "input.hasResolvedInvoker": !selectedProfile })
    const rerun = agentInvocationRerunInput(record)
    expect(rerun).toEqual(selectedProfile
      ? { available: true, invokerProfileId: "reviewer", prompt: "Hi" }
      : { available: false, reason: "input-has-invoker" })
    if (selectedProfile && rerun.available) {
      const rerunId = `${runId}-rerun`
      await runAgent(agent, { ...runtime(rerunId), request: new Request("https://console.test/rerun") }, {
        prompt: rerun.prompt, context: { invokerProfileId: rerun.invokerProfileId },
      })
      await vi.waitFor(async () => { expect(await invocations.getByRunId(rerunId)).toMatchObject({ status: "completed" }) })
      expect(resolve).toHaveBeenCalledTimes(2)
      expect(resolve.mock.calls[1]?.[0]).toMatchObject({ selectedProfile: { id: "reviewer" } })
      expect((await invocations.getByRunId(rerunId))?.observations.find(observation => observation.name === "agent.invocation.start")?.attributes)
        .toMatchObject({ "agent.invoker.id": "console-actor", "agent.invoker.profile.id": "reviewer" })
    }
  })

  it("does not trust an injected profile observation context", async () => {
    const record = await journaled({ context: { "agent.invoker.profile.id": "reviewer" }, prompt: "Hi" })
    expect(agentInvocationRerunInput(record)).toEqual({ available: false, reason: "input-has-context" })
  })

  it("does not treat resolved invoker identities as profile selectors", () => {
    expect(agentInvocationRerunInput({ observations: [start({ "input.prompt": "Hi", "agent.invoker.id": "reviewer" })] }))
      .toEqual({ available: true, prompt: "Hi" })
    expect(agentInvocationRerunInput({ observations: [start({ "input.prompt": "Hi", "agent.invoker.id": "resolved", "agent.invoker.profile.id": "reviewer" })] }))
      .toEqual({ available: true, invokerProfileId: "reviewer", prompt: "Hi" })
  })

  it.each(["invoker", "actor"])("rejects a direct %s even with a profile", async (key) => {
    for (const invokerProfileId of [undefined, "reviewer"]) {
      const record = await journaled({ context: { [key]: { id: "direct-user", kind: "user" }, invokerProfileId }, prompt: "Hi" })
      expect(agentInvocationRerunInput(record)).toEqual({ available: false, reason: "input-has-invoker" })
    }
  })

  it("rejects persisted records without the replay schema", () => {
    for (const attributes of [
      { "input.prompt": "Hi", "agent.invoker.id": "reviewer" },
      { "input.prompt": "Hi", "input.hasOptions": false },
      { "input.prompt": "Hi", "input.replay.version": 1 },
      { "input.prompt": "Hi", "input.replay.version": 2 },
      { "input.prompt": "Hi", "input.replay.version": 3 },
      { "input.prompt": "Hi", "input.replay.version": 4 },
      { "input.prompt": "Hi", "input.promptChanged": undefined },
      { "input.prompt": "Hi", "input.hasAbortSignal": undefined },
    ]) {
      expect(agentInvocationRerunInput({ observations: [{ ...start({}), attributes }] }))
        .toEqual({ available: false, reason: "replay-metadata-unavailable" })
    }
  })

  it.each(["input.hasInvoker", "input.hasResolvedInvoker", "input.hasData", "input.hasOptions", "input.hasMessages", "input.hasDryRun"])("rejects replay metadata missing %s", (key) => {
    const observation = start({ "input.prompt": "Hi" })
    delete observation.attributes![key]
    expect(agentInvocationRerunInput({ observations: [observation] }))
      .toEqual({ available: false, reason: "replay-metadata-unavailable" })
  })

  it("retains restored invokers after the selected profile is removed", async () => {
    const input = restoreResolvedAgentInvokerInput(portableResolvedAgentInvokerInput(withResolvedAgentInvokerInput(
      { context: { invokerProfileId: "removed-profile" }, prompt: "Hi" },
      { id: "resolved-user", kind: "user" },
    )))
    const record = await journaled(input)
    expect(record.observations.find(observation => observation.name === "agent.invocation.start")?.attributes)
      .toMatchObject({ "agent.invoker.id": "resolved-user", "agent.invoker.profile.id": "removed-profile" })
    expect(agentInvocationRerunInput(record)).toEqual({ available: false, reason: "input-has-context" })
  })

  it("disables rerun when a redactor rewrites the captured prompt", async () => {
    const record = await journaled({ prompt: "Original prompt" }, {
      redact: observation => observation.name === "agent.invocation.start"
        ? { ...observation, attributes: { ...observation.attributes, "input.prompt": "Redacted prompt" } }
        : observation,
    })
    expect(agentInvocationRerunInput(record)).toEqual({ available: false, reason: "input-redacted" })
  })

  it.each(["input.replay.version", "input.promptChanged", "input.hasInvoker", "input.hasResolvedInvoker", "agent.invoker.profile.id", "input.hasData", "input.hasOptions", "input.hasMessages", "input.hasPrompt", "input.hasContext", "input.hasRunMetadata", "input.hasTimeout", "input.hasAbortSignal", "input.hasDryRun"])("rejects replay when redaction changes %s", async (key) => {
    for (const replacement of [undefined, key === "agent.invoker.profile.id" ? "other-profile" : key === "input.replay.version" ? 1 : key !== "input.hasPrompt"]) {
      const record = await journaled({ context: { invokerProfileId: "reviewer" }, prompt: "Original prompt" }, {
        redact: observation => observation.name === "agent.invocation.start"
          ? { ...observation, attributes: { ...observation.attributes, [key]: replacement } }
          : observation,
      })
      expect(agentInvocationRerunInput(record)).toEqual({ available: false, reason: "input-redacted" })
    }
  })

  it("rejects replay when redaction hides additional input", async () => {
    for (const input of [
      { data: { subject: "Release notes" }, prompt: "Summarize this." },
      { options: { temperature: 0.2 }, prompt: "Summarize this." },
      { messages: [createMessage({ role: "user", text: "Earlier turn" })], prompt: "Continue." },
    ]) {
      const record = await journaled(input, {
        redact: observation => observation.name === "agent.invocation.start"
          ? { ...observation, attributes: { ...observation.attributes, "input.hasData": false, "input.hasOptions": false, "input.hasMessages": false } }
          : observation,
      })
      expect(agentInvocationRerunInput(record)).toEqual({ available: false, reason: "input-redacted" })
    }
  })

  it("reports input that the journal does not keep for replay", async () => {
    const withData = await journaled({ data: { subject: "Release notes" }, prompt: "Summarize this." })
    expect(withData.observations.find(observation => observation.name === "agent.invocation.start")?.attributes?.["input.hasData"]).toBe(true)
    expect(agentInvocationRerunInput(withData)).toEqual({ available: false, reason: "input-has-data" })

    const withOptions = await journaled({ options: { temperature: 0.2 }, prompt: "Use the configured model." })
    expect(withOptions.observations.find(observation => observation.name === "agent.invocation.start")?.attributes?.["input.hasOptions"]).toBe(true)
    expect(agentInvocationRerunInput(withOptions)).toEqual({ available: false, reason: "input-has-options" })

    const withMessages = await journaled({ messages: [createMessage({ role: "user", text: "Earlier turn" })], prompt: "Continue." })
    expect(agentInvocationRerunInput(withMessages)).toEqual({ available: false, reason: "input-has-messages" })

    const metadataOnly = await journaled({ prompt: "Private prompt." }, { metadataContent: [] })
    expect(agentInvocationRerunInput(metadataOnly)).toEqual({ available: false, reason: "input-not-captured" })

    const bounded = await journaled({ prompt: "x".repeat(2_000) }, { observations: { maxStringLength: 1_000 } })
    expect(agentInvocationRerunInput(bounded)).toEqual({ available: false, reason: "input-truncated" })
  })

  it.each(["pending", "running", "completed", "failed", "cancelled"] as const)("checks record status before rerun: %s", (status) => {
    expect(agentInvocationRerunInput({ status, observations: [start({ "input.prompt": "Hi" })] })).toEqual(status === "pending" || status === "running"
      ? { available: false, reason: "invocation-not-terminal" }
      : { available: true, prompt: "Hi" })
  })

  it("requires a complete start observation with a text prompt", () => {
    expect(agentInvocationRerunInput({ observations: [] })).toEqual({ available: false, reason: "input-not-captured" })
    expect(agentInvocationRerunInput({ observations: [start({ "input.prompt": "  " })] })).toEqual({ available: false, reason: "input-not-captured" })
    expect(agentInvocationRerunInput({ observations: [start({ "input.prompt": "Hi", [AGENT_INVOCATION_OBSERVATION_TRUNCATED_ATTRIBUTE]: true })] }))
      .toEqual({ available: false, reason: "input-truncated" })
    expect(agentInvocationRerunInput({ observations: [start({ "input.prompt": "Hi" })] })).toEqual({ available: true, prompt: "Hi" })
  })
})
