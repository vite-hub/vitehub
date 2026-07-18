import { Deferred, Effect, Stream } from "effect"

import { nextWithAbort } from "./abortable-stream.ts"
import { runAgentEffect, tryAgentPromise } from "./effect-runtime.ts"

export type AgentStreamCleanupOutcome =
  | { failed: false }
  | { error: unknown, failed: true }

interface AgentStreamIterator<T> extends AsyncIterator<T> {
  cancel(reason?: unknown): Promise<void>
}

const cleanupFailureMessage = "[vitehub] Agent stream failed and finish lifecycle also failed."

async function openAgentStream<T>(
  source: AsyncIterable<T>,
  cleanup: (outcome: AgentStreamCleanupOutcome) => Promise<void>,
  options: {
    abortSignal?: AbortSignal
    onCancel?: (reason: unknown) => void
    returnFailureMessage: string
  },
) {
  const sourceIterator = source[Symbol.asyncIterator]()
  let completed = false
  let returned = false
  let returnError: unknown
  let suppressReturnFailure = false
  const returnSource = async () => {
    if (completed || returned || !sourceIterator.return) return
    returned = true
    try {
      await sourceIterator.return()
    }
    catch (error) {
      if (!suppressReturnFailure) returnError = error
    }
  }
  const managed: AsyncIterable<T> = { [Symbol.asyncIterator]: () => ({
    async next() {
      const result = await sourceIterator.next()
      if (result.done) completed = true
      return result
    },
    async return() {
      await returnSource()
      return { done: true, value: undefined }
    },
  }) }
  const iterator = Stream.toAsyncIterable(
    Stream.fromAsyncIterable(managed, error => error),
  )[Symbol.asyncIterator]()
  const completion = await runAgentEffect(Effect.gen(function* () {
    const outcome = yield* Deferred.make<AgentStreamCleanupOutcome>()
    const complete = yield* Effect.cached(Deferred.await(outcome).pipe(
      Effect.flatMap(value => tryAgentPromise("Agent.Stream.cleanup", () => cleanup(value))),
    ))
    return { complete, outcome }
  }))
  let finished = false

  const finish = async (outcome: AgentStreamCleanupOutcome, throwOutcome: boolean, message: string) => {
    try {
      await runAgentEffect(Deferred.succeed(completion.outcome, outcome).pipe(Effect.andThen(completion.complete)))
    }
    catch (cleanupError) {
      if (throwOutcome && outcome.failed) throw new AggregateError([outcome.error, cleanupError], message)
      throw cleanupError
    }
    if (throwOutcome && outcome.failed) throw outcome.error
  }
  const close = async () => {
    await iterator.return?.()
    await returnSource()
    if (returnError !== undefined) throw returnError
  }

  return {
    async cancel(reason?: unknown) {
      if (finished) return
      finished = true
      options.onCancel?.(reason)
      try {
        await close()
      }
      catch (error) {
        await finish({ error, failed: true }, true, options.returnFailureMessage)
      }
      await finish(reason === undefined ? { failed: false } : { error: reason, failed: true }, false, cleanupFailureMessage)
    },
    async next(): Promise<IteratorResult<T>> {
      if (finished) return { done: true, value: undefined }
      let result: IteratorResult<T>
      try {
        result = await nextWithAbort(iterator.next(), options.abortSignal, "[vitehub] Agent Invocation stream aborted.")
      }
      catch (error) {
        finished = true
        suppressReturnFailure = true
        await close().catch(() => {})
        await finish({ error, failed: true }, true, cleanupFailureMessage)
        throw error
      }
      if (!result.done) return result
      finished = true
      await close()
      await finish({ failed: false }, false, cleanupFailureMessage)
      return result
    },
  }
}

export function withAgentStreamCleanup<T>(
  source: AsyncIterable<T>,
  cleanup: (outcome: AgentStreamCleanupOutcome) => Promise<void>,
  options: {
    abortSignal?: AbortSignal
    onCancel?: (reason: unknown) => void
    returnFailureMessage?: string
  } = {},
): AsyncIterable<T> {
  let session: ReturnType<typeof openAgentStream<T>> | undefined
  const open = () => session ??= openAgentStream(source, cleanup, {
    returnFailureMessage: options.returnFailureMessage ?? cleanupFailureMessage,
    ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
    ...(options.onCancel ? { onCancel: options.onCancel } : {}),
  })
  const iterator: AgentStreamIterator<T> = {
    cancel: reason => open().then(value => value.cancel(reason)),
    next: () => open().then(value => value.next()),
    async return() {
      await iterator.cancel()
      return { done: true, value: undefined }
    },
  }
  return { [Symbol.asyncIterator]: () => iterator }
}

export function withAgentReadableStreamCleanup<T>(
  stream: ReadableStream<T>,
  cleanup: (outcome: AgentStreamCleanupOutcome) => Promise<void>,
  onChunk?: (chunk: T) => void,
): ReadableStream<T> {
  const reader = stream.getReader()
  let cancelReason: unknown
  const source: AsyncIterable<T> = { [Symbol.asyncIterator]: () => ({
    async next() {
      const result = await reader.read()
      if (!result.done) onChunk?.(result.value)
      return result
    },
    async return() {
      await reader.cancel(cancelReason)
      return { done: true, value: undefined }
    },
  }) }
  const iterator = withAgentStreamCleanup(source, cleanup, {
    onCancel: reason => { cancelReason = reason },
  })[Symbol.asyncIterator]() as AgentStreamIterator<T>
  return new ReadableStream<T>({
    cancel: reason => iterator.cancel(reason),
    async pull(controller) {
      try {
        const result = await iterator.next()
        if (result.done) controller.close()
        else controller.enqueue(result.value)
      }
      catch (error) {
        controller.error(error)
      }
    },
  }, { highWaterMark: 0 })
}
