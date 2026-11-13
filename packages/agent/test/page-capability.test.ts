import { agentTools } from "@ui-sdk/core/agent"
import { afterEach, describe, expect, it, vi } from "vitest"

import { page } from "../src/capabilities/index.ts"
import { pageTools } from "../src/capabilities/page-tools.ts"
import { connectPage } from "../src/page.ts"

import type { AgentToolDefinition } from "../src/types.ts"
import type { PageRoom } from "../src/page.ts"

type Answer = [error: { code: string, why: string }, data: undefined] | [error: undefined, data: unknown]

function realtime(answer: Answer = [undefined, { ok: true }]) {
  const request = vi.fn(async (..._args: unknown[]) => answer)
  return { available: () => true, request }
}

function tools(options: { header?: string, context?: Record<string, unknown>, realtime?: unknown } = {}): Record<string, AgentToolDefinition> | undefined {
  const capability = page()
  if (!(capability.tools instanceof Function)) throw new Error("page() must resolve its tools for each run")
  const request = new Request("https://app.example.com/api/_vitehub/agents/settings/chat", { headers: options.header ? { "x-vitehub-page": options.header } : {} })
  // SAFETY: The page tools read only the fields this context sets.
  return capability.tools({
    capabilities: { realtime: options.realtime },
    invocation: { input: { get: () => ({ context: options.context }) } },
    runtimeContext: { request },
  } as never) as Record<string, AgentToolDefinition> | undefined
}

describe("page()", () => {
  it("keeps ui-sdk's tools, with page_ names in their names and descriptions", () => {
    const rewrite = (text: string) => text.replace(/\b(snapshot|query|act)\b/g, "page_$1")
    expect(pageTools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })).sort((a, b) => a.name.localeCompare(b.name)))
      .toEqual(agentTools.map(tool => ({ name: `page_${tool.name}`, description: rewrite(tool.description), inputSchema: tool.inputSchema })).sort((a, b) => a.name.localeCompare(b.name)))
    for (const tool of pageTools) expect(tool.description).not.toMatch(/(?<!page_)\b(snapshot|query|act)\b/)
  })

  it("gives a run without a page no page tools", () => {
    expect(tools({ realtime: realtime() })).toBeUndefined()
    expect(tools({ header: "not a page id", realtime: realtime() })).toBeUndefined()
  })

  it("names the Realtime fix when the app has no Realtime", () => {
    expect(() => tools({ header: "4f1c2a0e-1b2c-4d5e-8f90-a1b2c3d4e5f6" })).toThrow(expect.objectContaining({ code: "AGENT_R1045" }))
    expect(() => tools({ header: "4f1c2a0e-1b2c-4d5e-8f90-a1b2c3d4e5f6", realtime: { available: () => false, request: vi.fn() } })).toThrow(expect.objectContaining({ code: "AGENT_R1045" }))
  })

  it("asks the page of the request header, with a longer wait for page_act", async () => {
    const handle = realtime([undefined, { ok: true, changed: 1 }])
    const set = tools({ header: "4f1c2a0e-1b2c-4d5e-8f90-a1b2c3d4e5f6", realtime: handle })!
    expect(Object.keys(set)).toEqual(["page_snapshot", "page_query", "page_act"])
    expect(set.page_act).toMatchObject({ title: "Changed the page", icon: "i-lucide-mouse-pointer-click" })
    const steps = { steps: [{ ref: "Default region", action: "setValue", args: ["Frankfurt (eu-central-1)"] }] }
    await expect(set.page_act!.execute!(steps)).resolves.toEqual({ ok: true, changed: 1 })
    await set.page_snapshot!.execute!({})
    expect(handle.request.mock.calls).toEqual([
      ["agent-pages", "4f1c2a0e-1b2c-4d5e-8f90-a1b2c3d4e5f6", { method: "act", input: steps }, { timeout: 330_000 }],
      ["agent-pages", "4f1c2a0e-1b2c-4d5e-8f90-a1b2c3d4e5f6", { method: "snapshot", input: {} }, { timeout: 30_000 }],
    ])
  })

  it("takes the page from the run's context before the header", async () => {
    const handle = realtime()
    const set = tools({ header: "header-page-0001", context: { page: { id: "context-page-0001" } }, realtime: handle })!
    await set.page_query!.execute!({ within: "Default region" })
    expect(handle.request.mock.calls[0]?.[1]).toBe("context-page-0001")
  })

  it("answers the model with the code and the reason when the page is gone", async () => {
    const set = tools({ header: "4f1c2a0e-1b2c-4d5e-8f90-a1b2c3d4e5f6", realtime: realtime([{ code: "REALTIME_ROOM_EMPTY", why: "No browser is in the room." }, undefined]) })!
    await expect(set.page_snapshot!.execute!({})).resolves.toEqual({ ok: false, code: "REALTIME_ROOM_EMPTY", error: "No browser is in the room." })
  })
})

describe("connectPage()", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function room() {
    let handler: ((body: unknown) => unknown) | undefined
    const listeners = new Set<() => void>()
    let status: ReturnType<PageRoom["status"]> = "connecting"
    const value: PageRoom = {
      destroy: vi.fn(),
      onRequest: (next) => {
        handler = next
        return () => {}
      },
      onUpdate: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      status: () => status,
    }
    return {
      ask: async (body: unknown) => await handler?.(body),
      connect: () => {
        status = "connected"
        for (const listener of listeners) listener()
      },
      value,
    }
  }

  it("does nothing during server rendering", () => {
    const join = vi.fn()
    expect(connectPage({ act: vi.fn(), query: vi.fn(), snapshot: vi.fn() }, { join })).toMatchObject({ id: "", headers: {} })
    expect(join).not.toHaveBeenCalled()
  })

  it("joins its own room and answers the Agent's calls with the bridge", async () => {
    vi.stubGlobal("window", {})
    const fake = room()
    const join = vi.fn(() => fake.value)
    const bridge = {
      act: vi.fn(async () => ({ ok: true })),
      query: vi.fn(async () => [{ ref: "c5", items: [] }]),
      snapshot: vi.fn(() => [{ ref: "c1" }]),
    }
    const connected = connectPage(bridge, { join })
    expect(connected.id).toMatch(/^[\da-f-]{36}$/)
    expect(connected.headers).toEqual({ "x-vitehub-page": connected.id })
    expect(join).toHaveBeenCalledWith("agent-pages", connected.id, {})
    fake.connect()
    await connected.ready

    await expect(fake.ask({ method: "snapshot" })).resolves.toEqual([{ ref: "c1" }])
    await expect(fake.ask({ method: "query", input: { within: "Default region" } })).resolves.toEqual([{ ref: "c5", items: [] }])
    await expect(fake.ask({ method: "act", input: { steps: [] } })).resolves.toEqual({ ok: true })
    expect(bridge.query).toHaveBeenCalledWith({ within: "Default region" })
    await expect(fake.ask({ method: "subscribe" })).resolves.toEqual({ ok: false, error: "Unknown page call: use page_snapshot, page_query, or page_act." })
    connected.close()
    expect(fake.value.destroy).toHaveBeenCalled()
  })

  it("names the fix when nothing can join Realtime", () => {
    vi.stubGlobal("window", {})
    // SAFETY: A JavaScript caller can leave out `join`, which the types require.
    expect(() => connectPage({ act: vi.fn(), query: vi.fn(), snapshot: vi.fn() }, {} as never)).toThrow(expect.objectContaining({ code: "AGENT_R1046" }))
  })
})
