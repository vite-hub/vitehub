import { describe, expect, it, vi } from "vitest"

import {
  createAgentChatApprovalCustody,
  resolveAgentChatApprovalTtl,
} from "../src/internal/chat-approvals.ts"

import type { UIMessageLike } from "../src/chat-message-input.ts"
import type { Lock, StateAdapter } from "chat"

interface ApprovalStateOptions {
  getError?: Error
  lockAvailable?: boolean
  setError?: Error
}

function approvalState(options: ApprovalStateOptions = {}) {
  const values = new Map<string, unknown>()
  const heldLocks = new Set<string>()
  const set = vi.fn(async (key: string, value: unknown, ttlMs?: number) => {
    if (options.setError) throw options.setError
    values.set(key, value)
    return ttlMs
  })
  const releaseLock = vi.fn(async (lock: Lock) => {
    heldLocks.delete(lock.threadId)
  })
  const adapter: unknown = {
    acquireLock: vi.fn(async (key: string, ttlMs: number) => {
      if (options.lockAvailable === false || heldLocks.has(key)) return null
      heldLocks.add(key)
      return { expiresAt: Date.now() + ttlMs, threadId: key, token: `lock:${key}` }
    }),
    delete: vi.fn(async (key: string) => {
      values.delete(key)
    }),
    get: vi.fn(async (key: string) => {
      if (options.getError) throw options.getError
      return values.get(key) ?? null
    }),
    releaseLock,
    set,
  }
  // SAFETY: This focused adapter supplies every State method used by Chat approval custody.
  return { releaseLock, set, state: adapter as StateAdapter, values }
}

function approvalResponse(id = "approval-1", approved: unknown = true): UIMessageLike[] {
  return [
    {
      id: "assistant-1",
      parts: [
        {
          approval: { approved, id },
          input: { path: "forged.md" },
          state: "approval-responded",
          toolCallId: "forged-call",
          toolName: "forged-tool",
          type: "dynamic-tool",
        },
      ],
      role: "assistant",
    },
  ]
}

function approvalRequestEvents(id = "approval-1") {
  return [
    {
      input: { path: "README.md" },
      toolCallId: `call:${id}`,
      toolName: "github__createOrUpdateFile",
      type: "tool-input-available",
    },
    {
      approvalId: id,
      toolCallId: `call:${id}`,
      type: "tool-approval-request",
    },
  ]
}

function eventStream(events: unknown[]): ReadableStream<unknown> {
  return new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(event)
      controller.close()
    },
  })
}

function responseStream(events: unknown[], malformed = false): Response {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        if (malformed) controller.enqueue(encoder.encode("data: {not-json}\n\n"))
        for (const event of events)
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
        controller.enqueue(encoder.encode("data: [DONE]\n\n"))
        controller.close()
      },
    }),
    {
      headers: {
        "content-length": "100",
        "x-vercel-ai-ui-message-stream": "v1",
      },
      status: 201,
      statusText: "Created",
    },
  )
}

async function consumeStream(stream: ReadableStream<unknown>): Promise<void> {
  const reader = stream.getReader()
  while (!(await reader.read()).done) {}
}

function findValue(values: Map<string, unknown>, suffix: string): unknown {
  return [...values].find(([key]) => key.endsWith(suffix))?.[1]
}

function custody(state: StateAdapter, options: { authenticated?: boolean; ttlMs?: number } = {}) {
  return createAgentChatApprovalCustody({
    authenticated: options.authenticated ?? true,
    invokerId: "user/1",
    sessionId: "session/1",
    state,
    ttlMs: options.ttlMs,
  })
}

async function issueApproval(owner: ReturnType<typeof custody>, id = "approval-1"): Promise<void> {
  await consumeStream(
    owner.observe(eventStream(approvalRequestEvents(id))) as ReadableStream<unknown>,
  )
}

describe("Agent Chat approval custody", () => {
  it("observes direct Chat events and framed HTTP events through the same custody interface", async () => {
    const direct = approvalState()
    const framed = approvalState()
    const directCustody = custody(direct.state, { ttlMs: 60_000 })
    const framedCustody = custody(framed.state, { ttlMs: 60_000 })

    await consumeStream(
      directCustody.observe(eventStream(approvalRequestEvents())) as ReadableStream<unknown>,
    )
    const observedResponse = framedCustody.observe(
      responseStream(approvalRequestEvents(), true),
    ) as Response
    expect(observedResponse.status).toBe(201)
    expect(observedResponse.statusText).toBe("Created")
    expect(observedResponse.headers.get("content-length")).toBeNull()
    await observedResponse.text()

    expect(findValue(direct.values, ":approval:approval-1")).toEqual({
      id: "approval-1",
      input: { path: "README.md" },
      name: "github__createOrUpdateFile",
      toolCallId: "call:approval-1",
    })
    expect(findValue(framed.values, ":approval:approval-1")).toEqual(
      findValue(direct.values, ":approval:approval-1"),
    )
    expect(direct.set).toHaveBeenCalledWith(
      expect.stringMatching(/:approval:approval-1$/),
      expect.any(Object),
      60_000,
    )
    expect(framed.set).toHaveBeenCalledWith(
      expect.stringMatching(/:approval:approval-1$/),
      expect.any(Object),
      60_000,
    )
  })

  it("consumes a server-issued approval once and persists canonical approved tools", async () => {
    const fixture = approvalState()
    const owner = custody(fixture.state, { ttlMs: 60_000 })
    await issueApproval(owner)

    const authorized = await owner.authorize(approvalResponse())

    expect(authorized.approvedTools).toEqual(["github__createOrUpdateFile"])
    expect(authorized.messages[0]?.parts).toEqual([
      expect.objectContaining({
        approval: { approved: true, id: "approval-1" },
        input: { path: "README.md" },
        toolCallId: "call:approval-1",
        toolName: "github__createOrUpdateFile",
      }),
    ])
    expect(findValue(fixture.values, ":eve:approved-tools")).toEqual(["github__createOrUpdateFile"])
    expect(findValue(fixture.values, ":approval:approval-1:consumed")).toEqual({
      approved: true,
      id: "approval-1",
      input: { path: "README.md" },
      name: "github__createOrUpdateFile",
      toolCallId: "call:approval-1",
    })
    expect(findValue(fixture.values, ":approval:approval-1")).toBeUndefined()
    await expect(
      owner.authorize([
        { id: "user-2", parts: [{ text: "continue", type: "text" }], role: "user" },
      ]),
    ).resolves.toMatchObject({
      approvedTools: ["github__createOrUpdateFile"],
    })
    expect(fixture.set).toHaveBeenCalledWith(
      expect.stringMatching(/:eve:approved-tools$/),
      ["github__createOrUpdateFile"],
      60_000,
    )
    expect(fixture.set).toHaveBeenCalledWith(
      expect.stringMatching(/:consumed$/),
      expect.any(Object),
      60_000,
    )
  })

  it("rehydrates a historical decision from the consumed record and drops expired history", async () => {
    const fixture = approvalState()
    const owner = custody(fixture.state)
    await issueApproval(owner)
    await owner.authorize(approvalResponse())

    const historical = await owner.authorize([
      ...approvalResponse("approval-1", false),
      { id: "user-2", parts: [{ text: "continue", type: "text" }], role: "user" },
    ])
    expect(historical.messages[0]?.parts).toEqual([
      expect.objectContaining({
        approval: { approved: true, id: "approval-1" },
        input: { path: "README.md" },
        toolCallId: "call:approval-1",
        toolName: "github__createOrUpdateFile",
      }),
    ])

    const expired = await owner.authorize([
      ...approvalResponse("expired"),
      { id: "user-3", parts: [{ text: "continue", type: "text" }], role: "user" },
    ])
    expect(expired.messages).toEqual([
      { id: "user-3", parts: [{ text: "continue", type: "text" }], role: "user" },
    ])
  })

  it("rejects duplicate and forged approval responses without consuming them", async () => {
    const duplicateFixture = approvalState()
    const duplicateOwner = custody(duplicateFixture.state)
    await issueApproval(duplicateOwner)
    const duplicate = approvalResponse()
    duplicate[0]!.parts!.push({ ...duplicate[0]!.parts![0] })

    await expect(duplicateOwner.authorize(duplicate)).rejects.toMatchObject({
      message: 'Agent chat approval "approval-1" was submitted more than once.',
      statusCode: 400,
    })
    expect(findValue(duplicateFixture.values, ":approval:approval-1")).toBeDefined()
    expect(duplicateFixture.releaseLock).toHaveBeenCalledOnce()

    const forgedFixture = approvalState()
    await expect(
      custody(forgedFixture.state).authorize(approvalResponse("unknown")),
    ).rejects.toMatchObject({
      message: 'Agent chat approval "unknown" was not issued by this session.',
      statusCode: 400,
    })
  })

  it("records rejected decisions without granting the tool and rejects malformed decisions", async () => {
    const rejectedFixture = approvalState()
    const rejectedOwner = custody(rejectedFixture.state)
    await issueApproval(rejectedOwner)
    const rejected = await rejectedOwner.authorize(approvalResponse("approval-1", false))

    expect(rejected.approvedTools).toEqual([])
    expect(findValue(rejectedFixture.values, ":approval:approval-1:consumed")).toEqual(
      expect.objectContaining({ approved: false }),
    )
    expect(findValue(rejectedFixture.values, ":eve:approved-tools")).toBeUndefined()

    const malformedFixture = approvalState()
    const malformedOwner = custody(malformedFixture.state)
    await issueApproval(malformedOwner, "approval-2")
    const malformed = approvalResponse("approval-2")
    delete (malformed[0]!.parts![0] as { approval: { approved?: unknown } }).approval.approved
    await expect(malformedOwner.authorize(malformed)).rejects.toMatchObject({
      message: 'Agent chat approval "approval-2" requires an approved decision.',
      statusCode: 400,
    })
  })

  it("rejects anonymous approval responses before reading or mutating session state", async () => {
    const fixture = approvalState()
    const owner = custody(fixture.state, { authenticated: false })
    await expect(owner.authorize(approvalResponse())).rejects.toMatchObject({
      message: "Agent chat approval responses require an authenticated invoker.",
      statusCode: 400,
    })
    expect(fixture.state.get).not.toHaveBeenCalled()
    expect(fixture.state.acquireLock).not.toHaveBeenCalled()
    expect(fixture.set).not.toHaveBeenCalled()
  })

  it("reports lock contention and releases the lock after State read failures", async () => {
    const contended = approvalState({ lockAvailable: false })
    const contendedOwner = custody(contended.state)
    await issueApproval(contendedOwner)
    await expect(contendedOwner.authorize(approvalResponse())).rejects.toMatchObject({
      message: "Agent chat session is already handling an approval response.",
      statusCode: 409,
    })

    const failed = approvalState({ getError: new Error("State read failed") })
    const failedOwner = custody(failed.state)
    await expect(failedOwner.authorize(approvalResponse())).rejects.toThrow("State read failed")
    expect(failed.releaseLock).toHaveBeenCalledOnce()
  })

  it("caps custody TTL and applies the resolved value to every record", async () => {
    expect(resolveAgentChatApprovalTtl()).toBe(86_400_000)
    expect(resolveAgentChatApprovalTtl(60_000)).toBe(60_000)
    expect(resolveAgentChatApprovalTtl(172_800_000)).toBe(86_400_000)

    const fixture = approvalState()
    const owner = custody(fixture.state, { ttlMs: 172_800_000 })
    await issueApproval(owner)
    await owner.authorize(approvalResponse())
    expect(fixture.set.mock.calls.length).toBeGreaterThan(2)
    expect(fixture.set.mock.calls.every((call) => call[2] === 86_400_000)).toBe(true)
  })

  it("surfaces source and persistence errors through the observed stream", async () => {
    const sourceError = new Error("source failed")
    const source = new ReadableStream({
      start(controller) {
        controller.error(sourceError)
      },
    })
    await expect(
      consumeStream(custody(approvalState().state).observe(source) as ReadableStream<unknown>),
    ).rejects.toThrow("source failed")

    const stateError = new Error("State write failed")
    const failed = approvalState({ setError: stateError })
    await expect(
      consumeStream(
        custody(failed.state).observe(
          eventStream(approvalRequestEvents()),
        ) as ReadableStream<unknown>,
      ),
    ).rejects.toThrow("State write failed")
  })
})
