import { agentTools } from "@ui-sdk/core/agent"
import { afterEach, describe, expect, it, vi } from "vitest"

import { page } from "../src/capabilities/index.ts"
import { pageTools } from "../src/capabilities/page-tools.ts"
import { connectPage } from "../src/page.ts"

import type { AgentToolDefinition } from "../src/types.ts"
import type { PageAllow, PageBridge, PageObservedChange, PageRoom, PageStep } from "../src/page.ts"

type Answer = [error: { code: string, why: string }, data: undefined] | [error: undefined, data: unknown]

function realtime(answer: Answer = [undefined, { ok: true }]) {
  const request = vi.fn(async (..._args: unknown[]) => answer)
  return { available: () => true, request }
}

const noRules = { deny: [], requireApproval: [] }

function tools(options: { header?: string, context?: Record<string, unknown>, realtime?: unknown, user?: string, options?: Parameters<typeof page>[0] } = {}): Record<string, AgentToolDefinition> | undefined {
  const capability = page(options.options)
  if (!(capability.tools instanceof Function)) throw new Error("page() must resolve its tools for each run")
  const request = new Request("https://app.example.com/api/_vitehub/agents/settings/chat", { headers: options.header ? { "x-vitehub-page": options.header } : {} })
  // SAFETY: The page tools read only the fields this context sets.
  return capability.tools({
    capabilities: { realtime: options.realtime },
    invoker: { id: "invoker-1", kind: "user", ...(options.user ? { meta: { authUserId: options.user } } : {}) },
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
    const handle = realtime([undefined, { rules: 1, result: { ok: true, changed: 1 }, changes: [], approvals: [] }])
    const set = tools({ header: "4f1c2a0e-1b2c-4d5e-8f90-a1b2c3d4e5f6", realtime: handle })!
    expect(Object.keys(set)).toEqual(["page_snapshot", "page_query", "page_act"])
    expect(set.page_act).toMatchObject({ title: "Changed the page", icon: "i-lucide-mouse-pointer-click" })
    const steps = { steps: [{ ref: "Default region", action: "setValue", args: ["Frankfurt (eu-central-1)"] }] }
    await expect(set.page_act!.execute!(steps)).resolves.toEqual({ ok: true, changed: 1 })
    await set.page_snapshot!.execute!({})
    expect(handle.request.mock.calls).toEqual([
      ["agent-pages", "4f1c2a0e-1b2c-4d5e-8f90-a1b2c3d4e5f6", { method: "act", input: steps, rules: noRules }, { timeout: 330_000, user: null }],
      ["agent-pages", "4f1c2a0e-1b2c-4d5e-8f90-a1b2c3d4e5f6", { method: "snapshot", input: {}, rules: noRules }, { timeout: 30_000, user: null }],
    ])
  })

  it("takes the page from the run's context before the header", async () => {
    const handle = realtime()
    const set = tools({ header: "header-page-0001", context: { page: { id: "context-page-0001" } }, realtime: handle })!
    await set.page_query!.execute!({ within: "Default region" })
    expect(handle.request.mock.calls[0]?.[1]).toBe("context-page-0001")
  })

  it("sends the rules with each call, and asks only the pages of the run's person", async () => {
    const handle = realtime()
    const rules = { deny: [{ label: "Project name" }], requireApproval: [{ confirm: true }] }
    const set = tools({ header: "4f1c2a0e-1b2c-4d5e-8f90-a1b2c3d4e5f6", realtime: handle, user: "user-ada", options: rules })!
    await set.page_snapshot!.execute!({})
    expect(handle.request.mock.calls[0]?.slice(2)).toEqual([{ method: "snapshot", input: {}, rules }, { timeout: 30_000, user: "user-ada" }])
  })

  it("names a refused step for the model, and lists what changed", async () => {
    const steps = { steps: [{ ref: "Default region", action: "setValue", args: ["fra"] }, { ref: "c2", action: "setValue", args: ["Hacked"] }] }
    const handle = realtime([undefined, {
      rules: 1,
      result: { ok: false, error: { step: 1, message: "The app refused setValue on c2." }, steps: [{ step: 0, ref: "c1" }] },
      changes: [{ id: "chg_1", ref: "c1", label: "Default region", key: "value", before: "iad", after: "fra", step: 0, at: "2026-11-14T00:00:00.000Z" }],
      approvals: [],
      refused: { step: 1, code: "AGENT_R1047" },
    }])
    const set = tools({ header: "4f1c2a0e-1b2c-4d5e-8f90-a1b2c3d4e5f6", realtime: handle, options: { deny: [{ label: "Project name" }] } })!
    const output = await set.page_act!.execute!(steps) as Record<string, unknown>
    expect(output).toMatchObject({
      ok: false,
      code: "AGENT_R1047",
      step: 1,
      changes: [{ label: "Default region", key: "value", before: "iad", after: "fra" }],
    })
    expect(output.error).toContain('step 2 (setValue on "c2")')
  })

  it("does not trust a page that did not apply the rules", async () => {
    const set = tools({ header: "4f1c2a0e-1b2c-4d5e-8f90-a1b2c3d4e5f6", realtime: realtime([undefined, { ok: true }]) })!
    await expect(set.page_act!.execute!({ steps: [] })).resolves.toMatchObject({ ok: false, code: "AGENT_R1050" })
  })

  it("refuses a rule that a step could pass another way", () => {
    expect(() => page({ deny: [{ label: "Delete", action: "press" } as never] })).toThrow(expect.objectContaining({ code: "AGENT_R1052" }))
    expect(() => page({ requireApproval: [{}] })).toThrow(expect.objectContaining({ code: "AGENT_R1052" }))
    expect(() => page({ deny: [{ label: " " }] })).toThrow(expect.objectContaining({ code: "AGENT_R1052" }))
    expect(page({ deny: [{ label: "Project name" }] }).metadata).toMatchObject({ binding: "user", rules: { deny: [{ label: "Project name" }], requireApproval: [] } })
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

  /**
   * A small stand-in for ui-sdk's bridge: it resolves a step by ref or label, asks `allow` with the resolved step, and
   * reports each change with `source: "agent"`, as `createAgent()` does.
   */
  function bridge(components: Array<{ ref: string, component: string, label: string, value: unknown, confirm?: string }>) {
    let allow: PageAllow = () => true
    const listeners = new Set<(change: PageObservedChange) => void>()
    const value: PageBridge = {
      act: vi.fn(async ({ steps }) => {
        const log: Array<{ step: number, ref: string }> = []
        for (const [index, step] of steps.entries()) {
          const found = components.find(item => item.ref === step.ref || item.label === step.ref)
          if (!found) return { ok: false, error: { step: index, message: `No component "${step.ref}".` }, steps: log }
          const resolved: PageStep = { ref: found.ref, component: found.component, label: found.label, action: step.action, args: step.args ?? [], ...(found.confirm ? { confirm: found.confirm } : {}) }
          if (!(await allow(resolved, { signal: new AbortController().signal }))) {
            return { ok: false, error: { step: index, message: found.confirm ? `The person said no to "${found.confirm}".` : `The app refused ${step.action} on ${found.ref}.` }, steps: log }
          }
          const previous = found.value
          found.value = step.args?.[0]
          for (const listener of listeners) listener({ ref: found.ref, component: found.component, label: found.label, key: "value", value: found.value, previous, source: "agent" })
          log.push({ step: index, ref: found.ref })
        }
        return { ok: true, steps: log }
      }),
      query: vi.fn(async () => []),
      snapshot: vi.fn(() => components.map(({ confirm: _confirm, ...component }) => ({ ...component }))),
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    }
    const create = vi.fn((options: { allow: PageAllow }) => {
      allow = options.allow
      return value
    })
    return { components, create, value }
  }

  const settings = () => bridge([
    { ref: "c1", component: "input", label: "Project name", value: "Atlas" },
    { ref: "c2", component: "select", label: "Default region", value: "iad" },
    { ref: "c3", component: "button", label: "Save changes", value: undefined },
    { ref: "c4", component: "button", label: "Delete project", value: undefined, confirm: "Delete the project" },
  ])
  const rules = { deny: [{ label: "Project name" }], requireApproval: [{ label: "Save changes" }] }

  it("does nothing during server rendering", () => {
    const join = vi.fn()
    const page = bridge([])
    expect(connectPage(page.create, { join })).toMatchObject({ id: "", headers: {}, agent: undefined })
    expect(join).not.toHaveBeenCalled()
    expect(page.create).not.toHaveBeenCalled()
  })

  it("joins its own room and answers the Agent's calls with the bridge it made", async () => {
    vi.stubGlobal("window", {})
    const fake = room()
    const join = vi.fn(() => fake.value)
    const page = settings()
    const connected = connectPage(page.create, { join })
    expect(connected.agent).toBe(page.value)
    expect(connected.id).toMatch(/^[\da-f-]{36}$/)
    expect(connected.headers).toEqual({ "x-vitehub-page": connected.id })
    expect(join).toHaveBeenCalledWith("agent-pages", connected.id, {})
    fake.connect()
    await connected.ready

    await expect(fake.ask({ method: "snapshot", rules })).resolves.toEqual(page.value.snapshot())
    await expect(fake.ask({ method: "query", input: { within: "Default region" } })).resolves.toEqual([])
    expect(page.value.query).toHaveBeenCalledWith({ within: "Default region" })
    await expect(fake.ask({ method: "subscribe" })).resolves.toEqual({ ok: false, error: "Unknown page call: use page_snapshot, page_query, or page_act." })
    connected.close()
    expect(fake.value.destroy).toHaveBeenCalled()
  })

  it("refuses a step a deny rule covers, even when the model names its ref", async () => {
    vi.stubGlobal("window", {})
    const fake = room()
    const page = settings()
    connectPage(page.create, { join: () => fake.value })
    const answer = await fake.ask({ method: "act", input: { steps: [{ ref: "Default region", action: "setValue", args: ["fra"] }, { ref: "c1", action: "setValue", args: ["Hacked"] }] }, rules })
    expect(answer).toMatchObject({ rules: 1, refused: { step: 1, code: "AGENT_R1047" }, changes: [{ label: "Default region", before: "iad", after: "fra", step: 0 }] })
    expect(page.components[0]!.value).toBe("Atlas")
  })

  it("asks the person through the page's allow for a step that needs approval, and records the answer", async () => {
    vi.stubGlobal("window", {})
    const fake = room()
    const page = settings()
    const allow = vi.fn(async (step: PageStep) => step.label !== "Delete project")
    connectPage(page.create, { join: () => fake.value, allow })
    await expect(fake.ask({ method: "act", input: { steps: [{ ref: "Save changes", action: "press" }] }, rules })).resolves.toMatchObject({
      approvals: [{ label: "Save changes", approved: true, confirm: "Allow the Agent to Press Save changes?" }],
    })
    // A data-agent-confirm step needs the person too, and their no is a named refusal.
    await expect(fake.ask({ method: "act", input: { steps: [{ ref: "Delete project", action: "press" }] }, rules })).resolves.toMatchObject({
      refused: { step: 0, code: "AGENT_R1049" },
      approvals: [{ label: "Delete project", approved: false, confirm: "Delete the project" }],
    })
  })

  it("revokes pending approval and queued calls when the page closes", async () => {
    vi.stubGlobal("window", {})
    const fake = room()
    const page = settings()
    let approve!: (value: boolean) => void
    const allow = vi.fn((_step: PageStep, { signal }: { signal: AbortSignal }) => {
      expect(signal.aborted).toBe(false)
      return new Promise<boolean>((resolve) => { approve = resolve })
    })
    const connected = connectPage(page.create, { join: () => fake.value, allow })
    const active = fake.ask({ method: "act", input: { steps: [{ ref: "Save changes", action: "press" }, { ref: "Default region", action: "setValue", args: ["fra"] }] }, rules })
    await vi.waitFor(() => expect(allow).toHaveBeenCalledOnce())
    const queued = fake.ask({ method: "act", input: { steps: [{ ref: "Default region", action: "setValue", args: ["fra"] }] }, rules })
    const rejected = expect(queued).rejects.toThrow("This page is closed")
    connected.close()
    // Closing settles the call even if the person's UI never answers.
    await expect(active).resolves.toMatchObject({ result: { ok: false }, changes: [] })
    await rejected
    approve(true)
    await Promise.resolve()
    expect(page.components[1]!.value).toBe("iad")
    expect(page.components[2]!.value).toBeUndefined()
    expect(connected.changes()).toEqual([])
    expect(page.value.act).toHaveBeenCalledOnce()
  })

  it.each(["deny", "requireApproval"] as const)("refuses ambiguous container presses under %s rules", async (list) => {
    vi.stubGlobal("window", {})
    const fake = room()
    const page = bridge([{ ref: "dialog", component: "dialog", label: "Settings", value: "before" }])
    const allow = vi.fn(() => true)
    connectPage(page.create, { join: () => fake.value, allow })
    const policy = { ...noRules, [list]: [{ label: "Save changes" }] }
    await expect(fake.ask({ method: "act", input: { steps: [{ ref: "dialog", action: "press", args: ["Save changes"] }] }, rules: policy }))
      .resolves.toMatchObject({ refused: { code: "AGENT_R1047" }, changes: [] })
    expect(allow).not.toHaveBeenCalled()
    expect(page.components[0]!.value).toBe("before")
  })

  it("refuses a step that needs approval when the page has no way to ask", async () => {
    vi.stubGlobal("window", {})
    const fake = room()
    connectPage(settings().create, { join: () => fake.value })
    await expect(fake.ask({ method: "act", input: { steps: [{ ref: "Save changes", action: "press" }] }, rules })).resolves.toMatchObject({ refused: { step: 0, code: "AGENT_R1048" } })
  })

  it("refuses to act without the server's rules", async () => {
    vi.stubGlobal("window", {})
    const fake = room()
    const page = settings()
    connectPage(page.create, { join: () => fake.value })
    await expect(fake.ask({ method: "act", input: { steps: [{ ref: "c1", action: "setValue", args: ["Hacked"] }] } })).resolves.toMatchObject({ ok: false })
    expect(page.value.act).not.toHaveBeenCalled()
  })

  it("undoes the Agent's changes, and leaves a field a person changed since", async () => {
    vi.stubGlobal("window", {})
    const fake = room()
    const page = bridge([
      { ref: "c2", component: "select", label: "Default region", value: "iad" },
      { ref: "c5", component: "radio-group", label: "Visibility", value: "private" },
    ])
    const connected = connectPage(page.create, { join: () => fake.value })
    const heard = vi.fn()
    connected.onChange(heard)
    await fake.ask({ method: "act", input: { steps: [{ ref: "Default region", action: "setValue", args: ["fra"] }, { ref: "Visibility", action: "setValue", args: ["team"] }] }, rules })
    const [region, visibility] = connected.changes()
    expect(region).toMatchObject({ label: "Default region", key: "value", before: "iad", after: "fra", step: 0 })
    expect(visibility).toMatchObject({ label: "Visibility", before: "private", after: "team", step: 1 })
    page.components[1]!.value = "public"

    await expect(connected.undo()).resolves.toEqual([visibility])
    expect(page.components.map(component => component.value)).toEqual(["iad", "public"])
    expect(connected.changes()[0]).toMatchObject({ undone: true })
    // An undo is not a new change of the Agent.
    expect(connected.changes()).toHaveLength(2)
    expect(heard).toHaveBeenCalledTimes(2)
    // The server asks by id, as an operator's undo does.
    await expect(fake.ask({ method: "undo", input: { change: "chg_unknown" } })).resolves.toMatchObject({ ok: false })
  })

  it("names the fix for a bridge in place of createAgent, and for nothing to join with", () => {
    vi.stubGlobal("window", {})
    const page = settings()
    // SAFETY: A JavaScript caller can pass the bridge itself, which the types refuse.
    expect(() => connectPage(page.value as never, { join: vi.fn() })).toThrow(expect.objectContaining({ code: "AGENT_R1051" }))
    // SAFETY: A JavaScript caller can leave out `join`, which the types require.
    expect(() => connectPage(page.create, {} as never)).toThrow(expect.objectContaining({ code: "AGENT_R1046" }))
  })
})

describe("invocationPageChanges()", () => {
  const at = "2026-11-14T00:00:00.000Z"
  const observation = (sequence: number, name: string, attributes: Record<string, unknown>) => ({ attributes, name, sequence, timestamp: at, type: "run" as const })

  it("lists each page change with the person, the step, and the values, and marks an operator's undo", async () => {
    const { formatInvocationPageChanges, invocationPageChanges } = await import("../src/invocations/page-changes.ts")
    const change = { "page.id": "page-1", "page.user": "user-ada", "page.ref": "c5", "page.label": "Default region", "page.key": "value", "page.step": 0, "tool.id": "call-2" }
    const listed = invocationPageChanges([
      observation(1, "agent.page.change", { ...change, "page.change.id": "chg_1", "page.change.content": { before: "iad", after: "fra" } }),
      observation(2, "agent.page.change", { ...change, "page.change.id": "chg_2", "page.label": "Visibility", "page.step": 1 }),
      observation(3, "agent.approval.request", { "page.id": "page-1", "approval.id": "ap_1", "approval.name": "page_act", "approval.reason": "Press Save changes?" }),
      observation(4, "agent.approval.decision", { "page.id": "page-1", "approval.id": "ap_1", "approval.approved": true }),
      observation(5, "agent.page.undo", { "page.change.id": "chg_1", "page.undo.restored": true, "page.undo.by": "cli" }),
    ])
    expect(listed.pageChanges).toEqual([
      { id: "chg_1", page: "page-1", user: "user-ada", tool: "call-2", step: 0, ref: "c5", label: "Default region", key: "value", before: "iad", after: "fra", at, undone: { at, by: "cli" } },
      { id: "chg_2", page: "page-1", user: "user-ada", tool: "call-2", step: 1, ref: "c5", label: "Visibility", key: "value", valuesOmitted: true, at },
    ])
    expect(listed.approvals).toEqual([{ id: "ap_1", name: "page_act", reason: "Press Save changes?", approved: true, at }])
    expect(formatInvocationPageChanges(listed.pageChanges)).toEqual([
      "Page changes:",
      `  ${at} chg_1 page page-1 user user-ada step 1 Default region value: "iad" -> "fra" (undone)`,
      `  ${at} chg_2 page page-1 user user-ada step 2 Visibility value: values omitted by the journal`,
    ])
  })
})
