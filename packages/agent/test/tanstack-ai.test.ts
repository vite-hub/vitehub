import { beforeEach, describe, expect, it, vi } from "vitest"

const chat = vi.hoisted(() => vi.fn(async (options: unknown) => options))
const toolDefinition = vi.hoisted(() => vi.fn((definition: Record<string, unknown>) => ({
  definition,
  server(execute: unknown) {
    return { definition, execute }
  },
})))

vi.mock("@tanstack/ai", () => ({
  chat,
  toolDefinition,
}))

function context() {
  return {
    input: { messages: [] },
    memo: vi.fn(),
    messages: [],
    prompt: "run",
    runtime: "unknown",
    runtimeConfig: {},
    waitUntil: vi.fn(),
  } as never
}

describe("tanstackAiAdapter", () => {
  beforeEach(() => {
    chat.mockClear()
    toolDefinition.mockClear()
  })

  it("keeps static approval-required tools on ViteHub policy handling", async () => {
    const execute = vi.fn(async () => "done")
    const { tanstackAiAdapter } = await import("../src/tanstack-ai.ts")
    const adapter = tanstackAiAdapter({
      adapter: {},
      tools: {
        migrate: {
          execute,
          name: "migrate",
          policy: "require-approval",
        },
      },
    })

    const result = await adapter.generate(context()) as { raw: { tools: Array<{ definition: Record<string, unknown>, execute: (input: unknown) => Promise<unknown> }> } }
    const tool = result.raw.tools[0]

    expect(tool.definition).toMatchObject({
      name: "migrate",
    })
    expect(tool.definition).not.toHaveProperty("needsApproval")
    await expect(tool.execute({ statement: "create table notes (id text)" })).rejects.toMatchObject({
      request: {
        capability: "migrate",
        input: { statement: "create table notes (id text)" },
        state: "awaiting-approval",
      },
    })
    expect(execute).not.toHaveBeenCalled()
  })
})
