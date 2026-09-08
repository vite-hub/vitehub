import { describe, expect, it, vi } from "vitest"
import { createTraceEventLog, deriveTraceRuns } from "@vite-hub/runtime"
import { title } from "../src/capabilities/title.ts"
import { usage } from "../src/capabilities/usage.ts"
import { defineAgent, runAgent, streamAgent } from "../src/index.ts"
import { createMessage } from "../src/messages.ts"
import { createMemoryAgentInvocationStore, defineAgentInvocations } from "../src/server.ts"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function journal() {
  return defineAgentInvocations({ metadataContent: ["vitehub.session.title"], store: createMemoryAgentInvocationStore() })
}
const runtime = (runId: string) => ({ memo: vi.fn(), run: { runId }, runtime: "unknown" as const, waitUntil: vi.fn() })

describe("title journal ownership", () => {
  it.each(["text", "stream"] as const)("prices auxiliary title calls before finish consumers and terminal usage for %s output", async (mode) => {
    const invocations = journal()
    const finish = vi.fn()
    const pricing = vi.fn(() => ({ usd: "0.01", estimated: true, source: "custom" as const }))
    const titleUsage = { model: "title-model", usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } }
    const primaryUsage = { model: "answer-model", usage: { inputTokens: 10, outputTokens: 7, totalTokens: 17 } }
    const agent = defineAgent({
      capabilities: [title({ driver: { run: () => mode === "text"
        ? { text: "Usage accounting", usageRecord: titleUsage }
        : (async function* () {
            yield { text: "Usage accounting", type: "text-delta" as const }
            yield { type: "usage" as const, usageRecord: titleUsage }
            yield { type: "finish" as const }
          })(),
      } }), usage({ pricing })],
      hooks: { "agent:finish": finish },
      driver: { run: () => mode === "text"
        ? { text: "Done.", usageRecord: primaryUsage }
        : (async function* () {
            yield { text: "Done.", type: "text-delta" as const }
            yield { type: "usage" as const, usageRecord: primaryUsage }
            yield { type: "finish" as const }
          })(),
      },
      invocations,
    })
    const runId = `title-usage-${mode}`
    if (mode === "text") await runAgent(agent, runtime(runId), { prompt: "Explain usage accounting" })
    else {
      const stream = await streamAgent(agent, runtime(runId), { prompt: "Explain usage accounting" })
      for await (const _event of stream as AsyncIterable<unknown>) {}
    }
    const invocation = (await invocations.getByRunId(runId))!
    expect(pricing).toHaveBeenCalledTimes(2)
    expect(pricing).toHaveBeenCalledWith(expect.objectContaining({ model: "answer-model" }))
    expect(pricing).toHaveBeenCalledWith(expect.objectContaining({ model: "title-model" }))
    expect(finish).toHaveBeenCalledOnce()
    const finishEvent = finish.mock.calls[0]![0]
    expect(finishEvent.extensions.get("usage")).toBe(finishEvent.invocation.usage)
    expect(finishEvent.invocation.usage).toMatchObject({
      calls: [primaryUsage, titleUsage],
      usage: { inputTokens: 13, outputTokens: 9, totalTokens: 22 },
      cost: { usd: "0.02", source: "custom" },
    })
    const terminal = invocation.observations.filter(entry => entry.name === "agent.invocation.finish")
    expect(terminal).toHaveLength(1)
    expect(terminal[0]?.attributes?.["usage.record"]).toMatchObject({
      calls: [primaryUsage, titleUsage],
      usage: { inputTokens: 13, outputTokens: 9, totalTokens: 22 },
      cost: { usd: "0.02", source: "custom" },
    })
  })

  it("retains recoverable title diagnostics without exporting title deltas", async () => {
    const traceLog = createTraceEventLog({ content: "content" })
    const invocations = journal()
    await runAgent(defineAgent({
      capabilities: [title({ driver: { async run(context) {
        await context.traceLog?.append({ name: "agent.message.delta", type: "run", attributes: { "message.content": "Private title draft" } })
        await context.traceLog?.append({ name: "agent.stream.error", type: "run", attributes: { "error.recoverable": true, "error.message": "Retrying title provider" } })
        await context.traceLog?.append({ name: "agent.stream.error", type: "run", attributes: { "error.recoverable": false, "error.message": "Title provider failed" } })
        return "Separate title"
      } } })],
      driver: { run: () => "Done." }, invocations,
    }), { ...runtime("title-diagnostics"), traceLog }, { prompt: "Explain title ownership" })
    const auxiliary = traceLog.entries().filter(entry => entry.attributes?.["vitehub.auxiliary.kind"] === "title")
    expect(auxiliary.some(entry => entry.name === "agent.message.delta")).toBe(false)
    expect(JSON.stringify(traceLog.entries())).not.toContain("Private title draft")
    expect(auxiliary.filter(entry => entry.name === "agent.stream.error")).toEqual([
      expect.objectContaining({ attributes: expect.objectContaining({ "error.recoverable": true, "error.message": "Retrying title provider" }) }),
    ])
    const invocation = (await invocations.getByRunId("title-diagnostics"))!
    expect(invocation.observations.filter(entry => entry.name === "agent.stream.error")).toEqual([
      expect.objectContaining({ attributes: expect.objectContaining({ "error.recoverable": true }) }),
    ])
    expect(invocation.status).toBe("completed")
  })

  it.each(["run.error", "agent.invocation.error", "agent.stream.error", "agent.invocation.cancelled"])("preserves title trace order around %s", async (failure) => {
    const invocations = journal()
    let checked = false
    await runAgent(defineAgent({
      capabilities: [title({ driver: { async run(context) {
        const names = ["agent.invocation.start", "agent.model.request", failure]
        for (const name of names) {
          await context.traceLog?.append({ name, type: "run", attributes: { "agent.run.id": "title-sequence" } })
        }
        const entries = context.traceLog!.entries().filter(entry => entry.attributes?.["agent.run.id"] === "title-sequence")
        expect(entries.map(entry => entry.name)).toEqual(names)
        const sequences = entries.map(entry => entry.sequence)
        expect(new Set(sequences).size).toBe(entries.length)
        expect(sequences).toEqual([...sequences].sort((a, b) => a - b))
        expect(deriveTraceRuns(entries)[0]?.events.map(entry => entry.name)).toEqual(names)
        checked = true
        return "Ordered title"
      } } })],
      driver: { run: () => "Done." }, invocations,
    }), runtime("title-sequence-primary"), { prompt: "Explain trace ordering" })
    expect(checked).toBe(true)
    expect((await invocations.getByRunId("title-sequence-primary"))?.observations.some(entry => entry.name === failure)).toBe(false)
  })

  it.each(["text", "stream", "failure"] as const)("records prompt-only titles for %s invocations without finish hooks", async (mode) => {
    const invocations = journal()
    const execute = vi.fn(() => "Safety stock")
    const agent = defineAgent({
      capabilities: [title({ execute })],
      driver: { run: () => {
        if (mode === "failure") throw new Error("Driver failed")
        if (mode === "text") return "Done."
        return (async function* () {
          yield { text: "Done.", type: "text-delta" as const }
          yield { type: "finish" as const }
        })()
      } },
      invocations,
    })
    if (mode === "failure") await expect(runAgent(agent, runtime(mode), { prompt: "Explain safety stock." })).rejects.toThrow("Driver failed")
    else if (mode === "text") await runAgent(agent, runtime(mode), { prompt: "Explain safety stock." })
    else {
      const stream = await streamAgent(agent, runtime(mode), { prompt: "Explain safety stock." })
      for await (const _event of stream as AsyncIterable<unknown>) {}
    }
    expect(execute).toHaveBeenCalledOnce()
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.objectContaining({ role: "user", parts: [expect.objectContaining({ text: "Explain safety stock." })] }),
      messages: [expect.objectContaining({ role: "user" })],
    }))
    expect((await invocations.getByRunId(mode))?.observations).toContainEqual(expect.objectContaining({
      name: "agent.title.recorded",
      attributes: expect.objectContaining({ "vitehub.session.title": "Safety stock" }),
    }))
  })

  it("uses the T3 editorial prompt and normalizes a structured title", async () => {
    const invocations = journal()
    const generate = vi.fn((_context: unknown) => '{"title":"Resolve snapshot mismatch"}')
    await runAgent(defineAgent({
      capabilities: [title({ driver: { run: generate } })],
      driver: { run: () => "Done." }, invocations,
    }), runtime("compact-title"), { prompt: "Company: Back II Basic. Latest customer message: Why do these snapshots disagree?" })
    expect(generate.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      prompt: expect.stringContaining("3-8 words, fewer than 40 characters"),
      messages: [],
    }))
    expect((await invocations.getByRunId("compact-title"))?.title).toBe("Resolve snapshot mismatch")
  })

  it("keeps a short fallback when the title provider has no capacity", async () => {
    const invocations = journal()
    await runAgent(defineAgent({
      capabilities: [title({ fallback: "New conversation", driver: { run: () => { throw new Error("Spend cap reached") } } })],
      driver: { run: () => "Done." }, invocations,
    }), runtime("title-cap"), { prompt: "Company: Back II Basic. Latest customer message: a long wrapped question" })
    expect((await invocations.getByRunId("title-cap"))?.title).toBe("New conversation")
  })

  it("bounds generated titles and strips multiline commentary", async () => {
    const invocations = journal()
    await runAgent(defineAgent({
      capabilities: [title({ execute: () => "A very long customer snapshot investigation title that overflows\nMore commentary" })],
      driver: { run: () => "Done." }, invocations,
    }), runtime("bounded-title"), { prompt: "Snapshot mismatch" })
    const generated = (await invocations.getByRunId("bounded-title"))?.title
    expect(generated?.length).toBeLessThan(40)
    expect(generated).not.toContain("commentary")
  })

  it("starts the main answer while the title is pending and joins it before journal completion", async () => {
    const generated = deferred<string>()
    const main = deferred<void>()
    const invocations = journal()
    const agent = defineAgent({
      capabilities: [title({ execute: () => generated.promise })],
      driver: { run: () => { main.resolve(); return "Done." } },
      invocations,
    })
    const run = runAgent(agent, runtime("overlap"), { prompt: "Explain safety stock." })
    try {
      await main.promise
      expect((await invocations.getByRunId("overlap"))?.status).toBe("running")
    }
    finally {
      generated.resolve("Safety stock")
      await run
    }
    expect((await invocations.getByRunId("overlap"))?.observations).toContainEqual(expect.objectContaining({
      name: "agent.title.recorded",
      attributes: expect.objectContaining({ "vitehub.session.title": "Safety stock" }),
    }))
  })

  it.each(["run.finish", "agent.invocation.finish"])("keeps auxiliary %s out of the primary trace", async (name) => {
    const main = deferred<string>()
    const invocations = journal()
    const run = runAgent(defineAgent({
      capabilities: [title({ driver: { async run(context) {
        await context.traceLog?.append({ name, type: "run" })
        expect(context.traceLog?.entries().some(entry => entry.name === name)).toBe(true)
        return "Separate title"
      } } })],
      driver: { run: () => main.promise },
      invocations,
    }), runtime("auxiliary-finish"), { prompt: "Explain title ownership" })
    try {
      await vi.waitFor(async () => {
        expect((await invocations.getByRunId("auxiliary-finish"))?.title).toBe("Separate title")
      })
      const pending = (await invocations.getByRunId("auxiliary-finish"))!
      expect(pending.status).toBe("running")
      expect(pending.observations.some(entry => entry.name === name)).toBe(false)
    }
    finally {
      main.resolve("Done.")
      await run
    }
    const completed = (await invocations.getByRunId("auxiliary-finish"))!
    expect(completed.observations.filter(entry => entry.name === "agent.invocation.finish")).toHaveLength(1)
  })

  it("uses the first user message with multi-turn history and a prompt", async () => {
    const execute = vi.fn(() => "First topic")
    await runAgent(defineAgent({
      capabilities: [title({ execute })],
      driver: { run: () => "Done." },
      invocations: journal(),
    }), runtime("existing-message"), {
      messages: [
        createMessage({ role: "user", text: "Original topic" }),
        createMessage({ role: "assistant", text: "Earlier reply" }),
        createMessage({ role: "user", text: "Later topic" }),
      ],
      prompt: "Follow up",
    })
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ text: "Original topic" }))
  })

  it("releases pending title work on invocation abort", async () => {
    const controller = new AbortController()
    const main = deferred<void>()
    const invocations = journal()
    const run = runAgent(defineAgent({
      capabilities: [title({ execute: () => new Promise<string>(() => {}) })],
      driver: { run: () => { main.resolve(); return "Done." } },
      invocations,
    }), runtime("abort-title"), { abortSignal: controller.signal, prompt: "Explain safety stock." })
    await main.promise
    controller.abort()
    await run.catch(() => undefined)
    expect((await invocations.getByRunId("abort-title"))?.observations.some(event => event.name === "agent.title.recorded")).toBe(false)
  })
})
