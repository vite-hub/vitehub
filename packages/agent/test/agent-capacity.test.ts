import { describe, expect, it, vi } from "vitest"

import { agentWithColocatedInstructions, defineAgent, runAgentInline, streamAgentInline } from "../src/index.ts"

import type { AgentRuntimeContext } from "../src/index.ts"

function runtime(): AgentRuntimeContext {
  return {
    memo: (_key, create) => create(),
    runtime: "unknown",
    waitUntil: promise => void Promise.resolve(promise).catch(() => {}),
  }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function uiMessageStream(id: string, gate: Promise<void>): ReadableStream<unknown> {
  return new ReadableStream({
    async start(controller) {
      controller.enqueue({ messageId: id, type: "start" })
      controller.enqueue({ id, type: "text-start" })
      controller.enqueue({ delta: id, id, type: "text-delta" })
      await gate
      controller.enqueue({ id, type: "text-end" })
      controller.enqueue({ finishReason: "stop", type: "finish" })
      controller.close()
    },
  })
}

describe("Agent Driver capacity", () => {
  it("runs at the configured concurrency and starts queued invocations in FIFO order", async () => {
    const starts: string[] = []
    const gates = Object.fromEntries(["1", "2", "3", "4"].map(id => [id, deferred()]))
    const agent = defineAgent({
      driver: {
        capacity: { concurrency: 2, queue: { maxPending: 20, timeout: 300_000 } },
        async run({ input }) {
          const id = input.prompt as string
          starts.push(id)
          await gates[id]!.promise
          return id
        },
      },
      runtime: false,
    })

    const results = ["1", "2", "3", "4"].map(prompt => runAgentInline(agent, runtime(), { prompt }))
    await vi.waitFor(() => expect(starts).toEqual(["1", "2"]))

    gates["1"]!.resolve()
    await vi.waitFor(() => expect(starts).toEqual(["1", "2", "3"]))
    gates["2"]!.resolve()
    await vi.waitFor(() => expect(starts).toEqual(["1", "2", "3", "4"]))
    gates["3"]!.resolve()
    gates["4"]!.resolve()

    await expect(Promise.all(results)).resolves.toEqual(["1", "2", "3", "4"])
  })

  it("shares capacity across Agent Definition descriptor clones", async () => {
    const starts: string[] = []
    const firstGate = deferred()
    const agent = defineAgent({
      driver: {
        capacity: { concurrency: 1, queue: { maxPending: 1 } },
        async run({ input }) {
          starts.push(input.prompt as string)
          if (input.prompt === "first") await firstGate.promise
          return input.prompt
        },
      },
      runtime: false,
    })
    const clone = Object.create(Object.getPrototypeOf(agent)) as typeof agent
    Object.defineProperties(clone, Object.getOwnPropertyDescriptors(agent))

    const first = runAgentInline(agent, runtime(), { prompt: "first" })
    await vi.waitFor(() => expect(starts).toEqual(["first"]))
    const second = runAgentInline(clone, runtime(), { prompt: "second" })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(starts).toEqual(["first"])

    firstGate.resolve()
    await expect(first).resolves.toBe("first")
    await expect(second).resolves.toBe("second")
    expect(starts).toEqual(["first", "second"])
  })

  it("shares capacity when colocated instructions decorate a model Agent", () => {
    const agent = defineAgent({
      driver: {
        capacity: { concurrency: 2 },
        model: {} as never,
      },
      runtime: false,
    })
    const capacitySymbol = Object.getOwnPropertySymbols(agent)
      .find(symbol => symbol.description === "vitehub.agentCapacityScope")!

    const decorated = agentWithColocatedInstructions(agent, "Use the colocated instructions.")

    expect(decorated).not.toBe(agent)
    expect(Object.getOwnPropertyDescriptor(decorated, capacitySymbol)?.value)
      .toBe(Object.getOwnPropertyDescriptor(agent, capacitySymbol)?.value)
  })

  it("rejects invocations beyond the bounded queue", async () => {
    const gates = { first: deferred(), second: deferred() }
    const agent = defineAgent({
      driver: {
        capacity: { concurrency: 1, queue: { maxPending: 1 } },
        async run({ input }) {
          await gates[input.prompt as keyof typeof gates].promise
          return input.prompt
        },
      },
      runtime: false,
    })

    const first = runAgentInline(agent, runtime(), { prompt: "first" })
    const second = runAgentInline(agent, runtime(), { prompt: "second" })
    await expect(runAgentInline(agent, runtime(), { prompt: "overflow" })).rejects.toMatchObject({
      code: "AGENT_CAPACITY_QUEUE_FULL",
      message: "[vitehub] Agent driver capacity is full (1 active, 1 queued).",
    })

    gates.first.resolve()
    await expect(first).resolves.toBe("first")
    gates.second.resolve()
    await expect(second).resolves.toBe("second")
  })

  it("times out while waiting for capacity and frees its queue position", async () => {
    const gate = deferred()
    let starts = 0
    const agent = defineAgent({
      driver: {
        capacity: { concurrency: 1, queue: { maxPending: 1, timeout: 10 } },
        async run() {
          starts++
          await gate.promise
          return "done"
        },
      },
      runtime: false,
    })

    const first = runAgentInline(agent, runtime(), {})
    await vi.waitFor(() => expect(starts).toBe(1))
    await expect(runAgentInline(agent, runtime(), {})).rejects.toMatchObject({
      code: "AGENT_CAPACITY_QUEUE_TIMEOUT",
      name: "TimeoutError",
    })

    gate.resolve()
    await expect(first).resolves.toBe("done")
  })

  it("removes aborted invocations from the queue", async () => {
    const firstGate = deferred()
    const starts: string[] = []
    const agent = defineAgent({
      driver: {
        capacity: { concurrency: 1, queue: { maxPending: 1 } },
        async run({ input }) {
          starts.push(input.prompt as string)
          if (input.prompt === "first") await firstGate.promise
          return input.prompt
        },
      },
      runtime: false,
    })
    const controller = new AbortController()
    const first = runAgentInline(agent, runtime(), { prompt: "first" })
    await vi.waitFor(() => expect(starts).toEqual(["first"]))
    const aborted = runAgentInline(agent, runtime(), { abortSignal: controller.signal, prompt: "aborted" })
    controller.abort()

    await expect(aborted).rejects.toMatchObject({ name: "AbortError" })
    const next = runAgentInline(agent, runtime(), { prompt: "next" })
    firstGate.resolve()
    await expect(first).resolves.toBe("first")
    await expect(next).resolves.toBe("next")
    expect(starts).toEqual(["first", "next"])
  })

  it("holds capacity until an async iterable finishes", async () => {
    const starts: string[] = []
    const gates = { first: deferred(), second: deferred() }
    const agent = defineAgent({
      driver: {
        capacity: { concurrency: 1, queue: { maxPending: 1 } },
        run({ input }) {
          const id = input.prompt as keyof typeof gates
          starts.push(id)
          return (async function* () {
            yield id
            await gates[id].promise
          })()
        },
      },
      runtime: false,
    })

    const first = await runAgentInline(agent, runtime(), { prompt: "first" }) as AsyncIterable<string>
    const secondResult = runAgentInline(agent, runtime(), { prompt: "second" })
    const firstIterator = first[Symbol.asyncIterator]()
    await expect(firstIterator.next()).resolves.toEqual({ done: false, value: "first" })
    expect(starts).toEqual(["first"])

    gates.first.resolve()
    await expect(firstIterator.next()).resolves.toEqual({ done: true, value: undefined })
    const second = await secondResult as AsyncIterable<string>
    await vi.waitFor(() => expect(starts).toEqual(["first", "second"]))
    gates.second.resolve()
    for await (const _value of second) {}
  })

  it("holds capacity through nested stream result finalization", async () => {
    const starts: string[] = []
    const gates = { first: deferred(), second: deferred() }
    const agent = defineAgent({
      driver: {
        capacity: { concurrency: 1, queue: { maxPending: 1 } },
        run({ input }) {
          const id = input.prompt as keyof typeof gates
          starts.push(id)
          return {
            stream: (async function* () {
              yield id
              await gates[id].promise
            })(),
          }
        },
      },
      runtime: false,
    })

    const first = await runAgentInline(agent, runtime(), { prompt: "first" }) as { stream: AsyncIterable<string> }
    const secondResult = runAgentInline(agent, runtime(), { prompt: "second" })
    const firstIterator = first.stream[Symbol.asyncIterator]()
    await firstIterator.next()
    expect(starts).toEqual(["first"])

    gates.first.resolve()
    await firstIterator.next()
    const second = await secondResult as { stream: AsyncIterable<string> }
    await vi.waitFor(() => expect(starts).toEqual(["first", "second"]))
    gates.second.resolve()
    for await (const _value of second.stream) {}
  })

  it("holds UI-message result capacity across run and stream APIs", async () => {
    const starts: string[] = []
    const gates = { first: deferred(), second: deferred() }
    const agent = defineAgent({
      driver: {
        capacity: { concurrency: 1, queue: { maxPending: 1 } },
        run({ input }) {
          const id = input.prompt as keyof typeof gates
          starts.push(id)
          return {
            toUIMessageStream: () => uiMessageStream(id, gates[id].promise),
          }
        },
      },
      runtime: false,
    })

    const first = await runAgentInline(agent, runtime(), { prompt: "first" }) as { toUIMessageStream: () => ReadableStream<unknown> }
    const secondResult = streamAgentInline(agent, runtime(), { prompt: "second" }, { output: "ui-message-stream" })
    const firstStream = first.toUIMessageStream()
    expect(starts).toEqual(["first"])

    gates.first.resolve()
    for await (const _chunk of firstStream) {}
    const second = await secondResult as ReadableStream<unknown>
    await vi.waitFor(() => expect(starts).toEqual(["first", "second"]))
    gates.second.resolve()
    for await (const _chunk of second) {}
  })

  it("releases capacity when streamed output is cancelled", async () => {
    const starts: string[] = []
    const agent = defineAgent({
      driver: {
        capacity: { concurrency: 1, queue: { maxPending: 1 } },
        run({ input }) {
          starts.push(input.prompt as string)
          let yielded = false
          const iterator: AsyncIterableIterator<string> = {
            [Symbol.asyncIterator]: () => iterator,
            next: async () => {
              if (yielded) return await new Promise<IteratorResult<string>>(() => {})
              yielded = true
              return { done: false, value: input.prompt as string }
            },
            return: async () => ({ done: true, value: undefined }),
          }
          return iterator
        },
      },
      runtime: false,
    })

    const first = await runAgentInline(agent, runtime(), { prompt: "first" }) as AsyncIterable<string>
    const secondResult = runAgentInline(agent, runtime(), { prompt: "second" })
    const iterator = first[Symbol.asyncIterator]()
    await iterator.next()
    expect(starts).toEqual(["first"])

    await iterator.return?.()
    const second = await secondResult as AsyncIterable<string>
    await vi.waitFor(() => expect(starts).toEqual(["first", "second"]))
    await second[Symbol.asyncIterator]().return?.()
  })

  it("holds capacity until a response body is consumed", async () => {
    const starts: string[] = []
    const gates = { first: deferred(), second: deferred() }
    const agent = defineAgent({
      driver: {
        capacity: { concurrency: 1, queue: { maxPending: 1 } },
        run({ input }) {
          const id = input.prompt as keyof typeof gates
          starts.push(id)
          return new Response(new ReadableStream({
            async start(controller) {
              controller.enqueue(new TextEncoder().encode(id))
              await gates[id].promise
              controller.close()
            },
          }))
        },
      },
      runtime: false,
    })

    const first = await runAgentInline(agent, runtime(), { prompt: "first" }) as Response
    const secondResult = runAgentInline(agent, runtime(), { prompt: "second" })
    expect(starts).toEqual(["first"])

    gates.first.resolve()
    await expect(first.text()).resolves.toBe("first")
    const second = await secondResult as Response
    await vi.waitFor(() => expect(starts).toEqual(["first", "second"]))
    gates.second.resolve()
    await expect(second.text()).resolves.toBe("second")
  })

  it("releases capacity after an active Driver failure", async () => {
    const firstGate = deferred()
    const starts: string[] = []
    const agent = defineAgent({
      driver: {
        capacity: { concurrency: 1, queue: { maxPending: 1 } },
        async run({ input }) {
          starts.push(input.prompt as string)
          if (input.prompt === "first") {
            await firstGate.promise
            throw new Error("driver failed")
          }
          return input.prompt
        },
      },
      runtime: false,
    })

    const first = runAgentInline(agent, runtime(), { prompt: "first" })
    await vi.waitFor(() => expect(starts).toEqual(["first"]))
    const second = runAgentInline(agent, runtime(), { prompt: "second" })
    firstGate.resolve()

    await expect(first).rejects.toThrow("driver failed")
    await expect(second).resolves.toBe("second")
    expect(starts).toEqual(["first", "second"])
  })
})
