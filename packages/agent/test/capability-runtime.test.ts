import { describe, expect, it, vi } from "vitest"

import { createMessage } from "@vitehub/messages"

const runtime = () => ({
  memo: vi.fn(),
  runtime: "unknown" as const,
  runtimeConfig: {},
  waitUntil: vi.fn(),
})

describe("agent capability runtime", () => {
  it("runs lifecycle phases in capability order and closes in reverse order", async () => {
    const { defineCapability, resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const order: string[] = []

    const resolved = await resolveAgentCapabilities({
      capabilities: [
        defineCapability({
          id: "first",
          close: () => { order.push("close:first") },
          configure: () => { order.push("configure:first") },
          resolve: () => { order.push("resolve:first") },
        }),
        defineCapability({
          id: "second",
          close: () => { order.push("close:second") },
          configure: () => { order.push("configure:second") },
          resolve: () => { order.push("resolve:second") },
        }),
      ],
    }, runtime(), {})

    await resolved.close()

    expect(order).toEqual([
      "configure:first",
      "resolve:first",
      "configure:second",
      "resolve:second",
      "close:second",
      "close:first",
    ])
  })

  it("cleans up initialized capabilities after setup failures", async () => {
    const { defineCapability, resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const order: string[] = []

    await expect(resolveAgentCapabilities({
      capabilities: [
        defineCapability({
          id: "first",
          close: () => { order.push("close:first") },
          resolve: () => { order.push("resolve:first") },
        }),
        defineCapability({
          id: "second",
          close: () => { order.push("close:second") },
          resolve() {
            order.push("resolve:second")
            throw new Error("setup failed")
          },
        }),
      ],
    }, runtime(), {})).rejects.toThrow("setup failed")

    expect(order).toEqual(["resolve:first", "resolve:second", "close:second", "close:first"])
  })

  it("applies instruction slots, tool transforms, renderers, and input mutation", async () => {
    const {
      applyCapabilityInstructionSlots,
      applyCapabilityToolTransforms,
      applyOutputRenderers,
      defineCapability,
      resolveAgentCapabilities,
    } = await import("../src/capability-runtime.ts")

    const resolved = await resolveAgentCapabilities({
      capabilities: [
        defineCapability({
          id: "skills",
          input(context) {
            context.input.setMessages([createMessage({ role: "user", text: "rewritten" })])
          },
          instructions: "Skill instructions.",
          output(context) {
            context.output.render(result => ({ text: `${(result as { text: string }).text}:rendered` }))
          },
          resolve(context) {
            context.tools.add({ original: { name: "original" } })
            context.tools.transform(tools => ({ ...(tools || {}), added: { name: "added" } }))
          },
        }),
      ],
    }, runtime(), { messages: [createMessage({ role: "user", text: "initial" })] })

    expect(resolved.messages.map(message => message.parts[0])).toEqual([
      expect.objectContaining({ text: "rewritten" }),
    ])
    expect(applyCapabilityInstructionSlots("Base\n{{ skills }}", resolved.capabilityInstructions)).toBe("Base\nSkill instructions.")
    await expect(applyCapabilityToolTransforms(resolved.tools, resolved.toolTransforms)).resolves.toEqual({
      added: { name: "added" },
      original: { name: "original" },
    })
    await expect(applyOutputRenderers({ text: "base" }, resolved.registries.outputRenderers)).resolves.toEqual({ text: "base:rendered" })
  })

  it("closes streamed and Response outputs after consumption", async () => {
    const { defineAgent, runAgent, streamAgent } = await import("../src/index.ts")
    const order: string[] = []
    const capability = {
      close: () => { order.push("close") },
      id: "cleanup",
    }

    const stream = await streamAgent(defineAgent({
      capabilities: [capability],
      run: () => (async function* () {
        yield "hello"
        order.push("stream:done")
      })(),
    }), runtime(), {})

    for await (const _event of stream as AsyncIterable<unknown>) {}
    expect(order).toEqual(["stream:done", "close"])

    order.length = 0
    const response = await runAgent(defineAgent({
      capabilities: [capability],
      run: () => new Response("ok"),
    }), runtime(), {})
    await expect((response as Response).text()).resolves.toBe("ok")
    expect(order).toEqual(["close"])
  })

  it("runs model-backed capability lifecycle once per agent run", async () => {
    vi.doMock("ai", () => ({
      ToolLoopAgent: class {
        async generate() {
          return { text: "ok" }
        }
      },
      stepCountIs: () => () => false,
    }))

    try {
      const { defineAgent, runAgent } = await import("../src/index.ts")
      const order: string[] = []
      const agent = defineAgent({
        capabilities: [{
          close: () => { order.push("close") },
          configure: () => { order.push("configure") },
          id: "tracked",
        }],
        model: {} as never,
        provider: "ai-sdk",
      })

      await expect(runAgent(agent, runtime(), {})).resolves.toMatchObject({ text: "ok" })
      expect(order).toEqual(["configure", "close"])
    }
    finally {
      vi.doUnmock("ai")
    }
  })
})
