import { describe, expect, it, vi } from "vitest"
import { title } from "../src/capabilities/title.ts"
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

  it("uses the first user message when a prompt is also supplied", async () => {
    const execute = vi.fn(() => "First topic")
    await runAgent(defineAgent({
      capabilities: [title({ execute })],
      driver: { run: () => "Done." },
      invocations: journal(),
    }), runtime("existing-message"), {
      messages: [createMessage({ role: "user", text: "Original topic" })],
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
