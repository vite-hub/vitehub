import type { ExecutionBudget } from "@vite-hub/runtime"
import type { LanguageModelMiddleware } from "ai"
import { loadAiSdk } from "./ai-sdk-runtime.ts"

/** Own provider retries so each attempt spends the Invocation's shared allowance. */
export function executionBudgetMiddleware(budget: ExecutionBudget, maxRetries = 2): LanguageModelMiddleware {
  if (!Number.isInteger(maxRetries) || maxRetries < 0) throw new RangeError("maxRetries must be a non-negative integer")
  const encoder = new TextEncoder()
  const bytes = (value: unknown) => encoder.encode(JSON.stringify(value) ?? "").byteLength
  async function attempt<T>(execute: () => PromiseLike<T>, inputBytes: number, signal?: AbortSignal): Promise<T> {
    const { APICallError } = await loadAiSdk()
    const abortSignal = signal ? AbortSignal.any([signal, budget.signal]) : budget.signal
    for (let retry = 0; ; retry++) {
      abortSignal.throwIfAborted()
      budget.recordInputBytes(inputBytes)
      try {
        return await execute()
      }
      catch (error) {
        abortSignal.throwIfAborted()
        if (retry >= maxRetries || !APICallError.isInstance(error) || !error.isRetryable) throw error
        budget.recordRetry()
        await new Promise<void>((resolve, reject) => {
          const abort = () => {
            clearTimeout(timer)
            reject(abortSignal.reason)
          }
          const timer = setTimeout(() => {
            abortSignal.removeEventListener("abort", abort)
            resolve()
          }, Math.min(2000 * 2 ** retry, 2_147_483_647))
          abortSignal.addEventListener("abort", abort, { once: true })
          if (abortSignal.aborted) abort()
        })
      }
    }
  }
  return {
    wrapGenerate: async ({ doGenerate, params }) => {
      const result = await attempt(doGenerate, bytes(params.prompt), params.abortSignal)
      budget.recordOutputBytes(bytes(result.content))
      return result
    },
    wrapStream: async ({ doStream, params }) => {
      const result = await attempt(doStream, bytes(params.prompt), params.abortSignal)
      const streamedToolInputs = new Set<string>()
      return {
        ...result,
        stream: result.stream.pipeThrough(new TransformStream({
          transform(part, controller) {
            try {
              budget.signal.throwIfAborted()
              if (part.type === "text-delta" || part.type === "reasoning-delta" || part.type === "tool-input-delta") {
                if (part.type === "tool-input-delta") streamedToolInputs.add(part.id)
                budget.recordOutputBytes(encoder.encode(part.delta).byteLength)
              }
              else if (part.type === "file" || (part.type === "tool-call" && !streamedToolInputs.has(part.toolCallId))) {
                budget.recordOutputBytes(bytes(part))
              }
              controller.enqueue(part)
            }
            catch (error) {
              controller.enqueue({ type: "error", error })
              controller.terminate()
            }
          },
        })),
      }
    },
  }
}
