import { AgentHttpError } from "../http-error.ts"
import {
  isRuntimeBoolean,
  isRuntimeFunction,
  isRuntimeNumber,
  isRuntimeObject,
  isRuntimeString,
} from "./runtime-value.ts"

import type { UIMessageLike } from "../chat-message-input.ts"
import type { StateAdapter } from "chat"

interface AgentChatPendingApproval {
  id: string
  input?: unknown
  name: string
  toolCallId: string
}

interface AgentChatConsumedApproval extends AgentChatPendingApproval {
  approved: boolean
  reason?: string
}

interface AgentChatApprovalCustodyOptions {
  authenticated: boolean
  invokerId: string
  sessionId: string
  state: StateAdapter
  ttlMs?: number
}

const defaultAgentChatApprovalTtlMs = 24 * 60 * 60 * 1000
const agentChatApprovalLockTtlMs = 10_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return isRuntimeObject(value) && value !== null
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => isRuntimeString(value) && value.length > 0)
}

function isReadableStreamLike(value: unknown): value is ReadableStream<unknown> {
  return (
    isRecord(value) && isRuntimeFunction(value.getReader) && isRuntimeFunction(value.pipeThrough)
  )
}

function isHeadersLike(value: unknown): value is Headers {
  return isRecord(value) && isRuntimeFunction(value.entries) && isRuntimeFunction(value.get)
}

function isResponseLike(value: unknown): value is Response & { body: ReadableStream<unknown> } {
  return (
    isRecord(value) &&
    isReadableStreamLike(value.body) &&
    isHeadersLike(value.headers) &&
    isRuntimeNumber(value.status) &&
    isRuntimeString(value.statusText)
  )
}

function isUiMessageStreamResponse(response: Response): boolean {
  return response.headers.get("x-vercel-ai-ui-message-stream") === "v1"
}

function approvalError(statusCode: number, message: string): AgentHttpError {
  return new AgentHttpError(statusCode, message)
}

function isAgentChatConsumedApproval(value: unknown): value is AgentChatConsumedApproval {
  return (
    isRecord(value) &&
    isRuntimeString(value.id) &&
    isRuntimeString(value.name) &&
    isRuntimeString(value.toolCallId) &&
    isRuntimeBoolean(value.approved)
  )
}

function agentChatApprovalKey(invokerId: string, sessionId: string, approvalId?: string): string {
  const session = `invoker:${encodeURIComponent(invokerId)}:session:${encodeURIComponent(sessionId)}:approval`
  return approvalId ? `${session}:${encodeURIComponent(approvalId)}` : session
}

function agentChatApprovedToolsKey(invokerId: string, sessionId: string): string {
  return `invoker:${encodeURIComponent(invokerId)}:session:${encodeURIComponent(sessionId)}:eve:approved-tools`
}

function agentChatConsumedApprovalKey(
  invokerId: string,
  sessionId: string,
  approvalId: string,
): string {
  return `${agentChatApprovalKey(invokerId, sessionId, approvalId)}:consumed`
}

function uiApprovalPart(
  part: unknown,
): { approval: Record<string, unknown>; record: Record<string, unknown> } | undefined {
  if (!isRecord(part)) return
  const type = part.type
  if (type !== "dynamic-tool" && !(isRuntimeString(type) && type.startsWith("tool-"))) return
  if (part.state !== "approval-requested" && part.state !== "approval-responded") return
  if (!isRecord(part.approval) || !isRuntimeString(part.approval.id)) return
  return { approval: part.approval, record: part }
}

export function resolveAgentChatApprovalTtl(maximumTtlMs?: number): number {
  return maximumTtlMs !== undefined && Number.isFinite(maximumTtlMs) && maximumTtlMs > 0
    ? Math.min(defaultAgentChatApprovalTtlMs, maximumTtlMs)
    : defaultAgentChatApprovalTtlMs
}

export function createAgentChatApprovalCustody(options: AgentChatApprovalCustodyOptions) {
  const { authenticated, invokerId, sessionId, state } = options
  const ttlMs = resolveAgentChatApprovalTtl(options.ttlMs)

  async function approvedTools(): Promise<string[]> {
    if (!authenticated) return []
    return (await state.get<string[]>(agentChatApprovedToolsKey(invokerId, sessionId))) ?? []
  }

  async function withApprovalLock<T>(callback: () => Promise<T>): Promise<T> {
    const lock = await state.acquireLock(
      `${agentChatApprovalKey(invokerId, sessionId)}:lock`,
      agentChatApprovalLockTtlMs,
    )
    if (!lock)
      throw approvalError(409, "Agent chat session is already handling an approval response.")
    try {
      return await callback()
    } finally {
      await state.releaseLock(lock)
    }
  }

  async function authorize(
    messages: UIMessageLike[],
  ): Promise<{ approvedTools: string[]; messages: UIMessageLike[] }> {
    const submitted = messages.flatMap((message, messageIndex) =>
      (message.parts || []).flatMap((part) => {
        const approvalPart = uiApprovalPart(part)
        return approvalPart
          ? [{ ...approvalPart, historical: messageIndex < messages.length - 1 }]
          : []
      }),
    )
    if (!authenticated && submitted.some((part) => part.record.state === "approval-responded")) {
      throw approvalError(400, "Agent chat approval responses require an authenticated invoker.")
    }
    if (!submitted.length) return { approvedTools: await approvedTools(), messages }

    return await withApprovalLock(async () => {
      const pending = new Map(
        await Promise.all(
          submitted
            .map((part) => part.approval.id as string)
            .filter((id, index, ids) => ids.indexOf(id) === index)
            .map(
              async (id) =>
                [
                  id,
                  await state.get<AgentChatPendingApproval>(
                    agentChatApprovalKey(invokerId, sessionId, id),
                  ),
                ] as const,
            ),
        ),
      )
      const historical = new Map(
        await Promise.all(
          submitted
            .filter((part) => part.historical)
            .map((part) => part.approval.id as string)
            .filter((id, index, ids) => ids.indexOf(id) === index)
            .map(async (id) => {
              const value = await state.get<AgentChatConsumedApproval>(
                agentChatConsumedApprovalKey(invokerId, sessionId, id),
              )
              return [id, isAgentChatConsumedApproval(value) ? value : undefined] as const
            }),
        ),
      )
      const consumed = new Set<string>()
      const authorized = messages
        .map((message, messageIndex) => ({
          ...message,
          parts: (message.parts || [])
            .filter((part) => {
              const submittedPart = uiApprovalPart(part)
              if (!submittedPart || messageIndex === messages.length - 1) return true
              const id = submittedPart.approval.id as string
              return Boolean(pending.get(id) || historical.get(id))
            })
            .map((part) => {
              const submittedPart = uiApprovalPart(part)
              if (!submittedPart) return part
              const id = submittedPart.approval.id as string
              const historicalDecision = historical.get(id)
              const request =
                pending.get(id) ??
                (messageIndex < messages.length - 1 ? historicalDecision : undefined)
              if (!request)
                throw approvalError(
                  400,
                  `Agent chat approval ${JSON.stringify(id)} was not issued by this session.`,
                )
              if (submittedPart.record.state === "approval-responded") {
                if (!isRuntimeBoolean(submittedPart.approval.approved)) {
                  throw approvalError(
                    400,
                    `Agent chat approval ${JSON.stringify(id)} requires an approved decision.`,
                  )
                }
                if (consumed.has(id))
                  throw approvalError(
                    400,
                    `Agent chat approval ${JSON.stringify(id)} was submitted more than once.`,
                  )
                consumed.add(id)
              }
              return {
                ...submittedPart.record,
                approval: {
                  id,
                  ...(isRuntimeBoolean(submittedPart.approval.approved)
                    ? { approved: historicalDecision?.approved ?? submittedPart.approval.approved }
                    : {}),
                  ...(isRuntimeString(historicalDecision?.reason ?? submittedPart.approval.reason)
                    ? { reason: historicalDecision?.reason ?? submittedPart.approval.reason }
                    : {}),
                },
                input: request.input,
                toolCallId: request.toolCallId,
                toolName: request.name,
              }
            }),
        }))
        .filter((message) => message.parts.length > 0)

      const newlyApproved = submitted.flatMap((part) => {
        const id = part.approval.id as string
        const request = pending.get(id)
        return part.record.state === "approval-responded" &&
          part.approval.approved === true &&
          request
          ? [request.name]
          : []
      })
      let persistedApprovedTools = await approvedTools()
      if (authenticated && newlyApproved.length) {
        persistedApprovedTools = [...new Set([...persistedApprovedTools, ...newlyApproved])]
        await state.set(
          agentChatApprovedToolsKey(invokerId, sessionId),
          persistedApprovedTools,
          ttlMs,
        )
      }
      await Promise.all(
        [...consumed].map(async (id) => {
          const request = pending.get(id)
          const decision = submitted.find(
            (part) => part.approval.id === id && part.record.state === "approval-responded",
          )?.approval
          if (request && isRuntimeBoolean(decision?.approved)) {
            await state.set(
              agentChatConsumedApprovalKey(invokerId, sessionId, id),
              {
                ...request,
                approved: decision.approved,
                ...(isRuntimeString(decision.reason) ? { reason: decision.reason } : {}),
              } satisfies AgentChatConsumedApproval,
              ttlMs,
            )
          }
        }),
      )
      await Promise.all(
        [...consumed].map((id) => state.delete(agentChatApprovalKey(invokerId, sessionId, id))),
      )
      return { approvedTools: persistedApprovedTools, messages: authorized }
    })
  }

  function observe(result: unknown): unknown {
    const toolInputs = new Map<string, { input?: unknown; name?: string }>()

    async function observeChunk(value: unknown): Promise<void> {
      if (!isRecord(value)) return
      const type = value.type
      const toolCallId = firstString(value.toolCallId, value.id)
      if ((type === "tool-input-available" || type === "tool-call") && toolCallId) {
        toolInputs.set(toolCallId, {
          input: value.input,
          name: firstString(value.toolName, value.name),
        })
      }
      if (type !== "tool-approval-request" || !toolCallId) return
      const id = firstString(value.approvalId, value.id)
      if (!id) return
      const tool = toolInputs.get(toolCallId)
      await state.set(
        agentChatApprovalKey(invokerId, sessionId, id),
        {
          id,
          input: tool?.input ?? value.input,
          name: firstString(value.toolName, tool?.name) || "tool",
          toolCallId,
        } satisfies AgentChatPendingApproval,
        ttlMs,
      )
    }

    function observedStream(
      stream: ReadableStream<unknown>,
      framed = false,
    ): ReadableStream<unknown> {
      const reader = stream.getReader()
      const decoder = framed ? new TextDecoder() : undefined
      let pending = ""
      return new ReadableStream({
        async pull(controller) {
          try {
            const chunk = await reader.read()
            if (chunk.done) {
              if (decoder) pending += decoder.decode()
              controller.close()
              return
            }
            if (decoder) {
              // SAFETY: UI message stream Responses carry encoded SSE bytes.
              pending += decoder.decode(chunk.value as Uint8Array, { stream: true })
              const events = pending.split(/\r?\n\r?\n/)
              pending = events.pop() || ""
              for (const event of events) {
                const data = event
                  .split(/\r?\n/)
                  .filter((line) => line.startsWith("data:"))
                  .map((line) => line.slice(5).trimStart())
                  .join("\n")
                if (data && data !== "[DONE]") {
                  try {
                    await observeChunk(JSON.parse(data))
                  } catch (error) {
                    if (!(error instanceof SyntaxError)) throw error
                  }
                }
              }
            } else await observeChunk(chunk.value)
            controller.enqueue(chunk.value)
          } catch (error) {
            controller.error(error)
          }
        },
        async cancel(reason) {
          await reader.cancel(reason)
        },
      })
    }

    if (result instanceof Response || isResponseLike(result)) {
      if (!result.body || !isUiMessageStreamResponse(result)) return result
      const headers = new Headers([...result.headers.entries()])
      headers.delete("content-encoding")
      headers.delete("content-length")
      return new Response(observedStream(result.body, true) as ReadableStream<Uint8Array>, {
        headers,
        status: result.status,
        statusText: result.statusText,
      })
    }
    if (!isReadableStreamLike(result)) return result
    return observedStream(result)
  }

  return { authorize, observe }
}
