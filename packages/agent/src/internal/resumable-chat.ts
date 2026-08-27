interface ResumableChatProcessConfig<TContext> {
  owner: (context: TContext) => string | Promise<string>
  scope: "process"
  ttlMs?: number
}

interface ResumableChatProcessIdentity {
  agentName: string
  channelId: string
  chatId: string
}

interface ResumableChatProcessCompletion {
  messageId?: string
  runId?: string
  waitUntil: (promise: Promise<unknown>) => void
}

interface ResumableChatProcessRun {
  chunks: Uint8Array[]
  cleanup?: ReturnType<typeof setTimeout>
  done: boolean
  failed: boolean
  hasBody: boolean
  headers: Headers
  invocationKey: string
  latestKey: string
  reader?: ReadableStreamDefaultReader<Uint8Array>
  ready: Promise<void>
  removed: boolean
  resolveReady: () => void
  setupError?: unknown
  setupFailed: boolean
  setupSettled: boolean
  status: number
  statusText: string
  subscribers: Set<ReadableStreamDefaultController<Uint8Array>>
  terminalError?: unknown
}

export interface ResumableChatProcessClaim {
  kind: "claimed"
  complete(response: Response, completion: ResumableChatProcessCompletion): Response
  fail(error: unknown): void
}

export interface ResumableChatProcessExistingClaim {
  kind: "existing"
  response: Promise<Response>
}

export type ResumableChatProcessClaimResult =
  | ResumableChatProcessClaim
  | ResumableChatProcessExistingClaim

export interface ResumableChatProcessSession {
  claim(invocationId: string): ResumableChatProcessClaimResult
  latest(): Promise<Response | undefined>
  stop(invocationId: string): Promise<void>
}

export interface ResumableChatProcessCustody<TContext> {
  /** Resolves one process-local session. Claims and bytes never cross this factory instance. */
  session(
    context: TContext,
    identity: ResumableChatProcessIdentity,
  ): Promise<ResumableChatProcessSession>
}

const resumableChatDefaultTtlMs = 10 * 60 * 1000
const resumableChatDiscoveryAttempts = 30
const resumableChatDiscoveryIntervalMs = 100
const resumableChatCancellationReason = "Cancelled by the web chat client."

function resumableChatKey(...parts: string[]): string {
  return JSON.stringify(parts)
}

function resumableChatResponse(run: ResumableChatProcessRun): Response {
  if (!run.hasBody) {
    return new Response(null, {
      headers: run.headers,
      status: run.status,
      statusText: run.statusText,
    })
  }
  let subscriber: ReadableStreamDefaultController<Uint8Array> | undefined
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of run.chunks) controller.enqueue(chunk)
        if (run.failed) controller.error(run.terminalError)
        else if (run.done) controller.close()
        else {
          subscriber = controller
          run.subscribers.add(controller)
        }
      },
      cancel() {
        if (subscriber) run.subscribers.delete(subscriber)
      },
    }),
    {
      headers: run.headers,
      status: run.status,
      statusText: run.statusText,
    },
  )
}

function closeResumableChatRun(run: ResumableChatProcessRun, failed = false, error?: unknown): void {
  if (run.done) return
  run.done = true
  run.failed = failed
  run.terminalError = error
  for (const subscriber of run.subscribers) {
    if (failed) subscriber.error(error)
    else subscriber.close()
  }
  run.subscribers.clear()
}

function createResumableChatRun(latestKey: string, invocationKey: string): ResumableChatProcessRun {
  let resolveReady!: () => void
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve
  })
  return {
    chunks: [],
    done: false,
    failed: false,
    hasBody: false,
    headers: new Headers(),
    invocationKey,
    latestKey,
    ready,
    removed: false,
    resolveReady,
    setupFailed: false,
    setupSettled: false,
    status: 200,
    statusText: "",
    subscribers: new Set(),
  }
}

async function waitForResumableChatRun(
  runs: Map<string, ResumableChatProcessRun>,
  key: string,
): Promise<ResumableChatProcessRun | undefined> {
  for (let attempt = 0; attempt < resumableChatDiscoveryAttempts; attempt++) {
    const run = runs.get(key)
    if (run) return run
    await new Promise<void>(resolve => setTimeout(resolve, resumableChatDiscoveryIntervalMs))
  }
}

async function readyResumableChatResponse(run: ResumableChatProcessRun): Promise<Response> {
  await run.ready
  if (run.setupFailed) throw run.setupError
  return resumableChatResponse(run)
}

/**
 * Owns resumable Chat streams in one generated route process. The returned custody does not
 * provide durability across process replacement or routing to another handler instance.
 */
export function createResumableChatProcessCustody<TContext>(
  config: ResumableChatProcessConfig<TContext>,
): ResumableChatProcessCustody<TContext> {
  const invocationRuns = new Map<string, ResumableChatProcessRun>()
  const latestRuns = new Map<string, ResumableChatProcessRun>()

  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Route options can arrive from untyped JavaScript, so validate the public runtime boundary before invocation.
  const ttlMs = typeof config?.ttlMs === "number" && config.ttlMs > 0
    ? config.ttlMs
    : resumableChatDefaultTtlMs

  function removeRun(run: ResumableChatProcessRun): void {
    if (run.removed) return
    run.removed = true
    if (run.cleanup) clearTimeout(run.cleanup)
    if (invocationRuns.get(run.invocationKey) === run) invocationRuns.delete(run.invocationKey)
    if (latestRuns.get(run.latestKey) === run) latestRuns.delete(run.latestKey)
  }

  function scheduleCleanup(run: ResumableChatProcessRun): void {
    if (run.removed || run.cleanup) return
    run.cleanup = setTimeout(() => removeRun(run), ttlMs)
    run.cleanup.unref?.()
  }

  async function consumeRun(run: ResumableChatProcessRun): Promise<void> {
    try {
      while (!run.done) {
        const chunk = await run.reader!.read()
        if (chunk.done) break
        const value = chunk.value.slice()
        run.chunks.push(value)
        for (const subscriber of run.subscribers) subscriber.enqueue(value)
      }
      closeResumableChatRun(run)
    } catch (error) {
      closeResumableChatRun(run, true, error)
    } finally {
      scheduleCleanup(run)
    }
  }

  function claimedRun(run: ResumableChatProcessRun): ResumableChatProcessClaim {
    return {
      kind: "claimed",
      complete(response, completion) {
        if (run.setupSettled) throw new Error("[vitehub] Resumable Chat claim was already settled.")
        const headers = new Headers(response.headers)
        headers.set("x-vitehub-message-id", completion.messageId || "")
        headers.set("x-vitehub-run-id", completion.runId || "")
        headers.delete("content-length")
        run.headers = headers
        run.status = response.status
        run.statusText = response.statusText
        run.hasBody = Boolean(response.body)
        run.reader = response.body?.getReader()
        if (!run.reader) {
          run.setupSettled = true
          run.resolveReady()
          closeResumableChatRun(run)
          scheduleCleanup(run)
        } else {
          const consume = consumeRun(run)
          try {
            completion.waitUntil(consume)
            run.setupSettled = true
            run.resolveReady()
          } catch (error) {
            run.setupSettled = true
            run.setupFailed = true
            run.setupError = error
            run.resolveReady()
            removeRun(run)
            void run.reader.cancel(error).catch(() => {})
            throw error
          }
        }
        return resumableChatResponse(run)
      },
      fail(error) {
        if (run.setupSettled) return
        run.setupSettled = true
        run.setupFailed = true
        run.setupError = error
        run.resolveReady()
        removeRun(run)
      },
    }
  }

  return {
    async session(context, identity) {
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Route options can arrive from untyped JavaScript, so validate the public runtime boundary before invocation.
      if (!config || typeof config !== "object" || typeof config.owner !== "function") {
        throw new TypeError("[vitehub] Resumable web chat requires route.resumable.owner().")
      }
      if (config.scope !== "process") {
        throw new TypeError(
          '[vitehub] Resumable web chat requires route.resumable.scope to be "process"; streams do not survive process replacement or cross-instance routing.',
        )
      }
      const owner = await config.owner(context)
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- JavaScript owner callbacks can violate the declared return type at this public runtime boundary.
      if (typeof owner !== "string" || !owner.trim()) {
        throw new TypeError("[vitehub] Resumable web chat owner must be a non-empty string.")
      }
      const latestKey = resumableChatKey(
        identity.agentName,
        identity.channelId,
        owner.trim(),
        identity.chatId,
      )

      return {
        claim(invocationId) {
          const invocationKey = resumableChatKey(latestKey, invocationId)
          const existing = invocationRuns.get(invocationKey)
          if (existing) {
            return { kind: "existing", response: readyResumableChatResponse(existing) }
          }
          const run = createResumableChatRun(latestKey, invocationKey)
          invocationRuns.set(invocationKey, run)
          latestRuns.set(latestKey, run)
          return claimedRun(run)
        },
        async latest() {
          const run = latestRuns.get(latestKey) || await waitForResumableChatRun(latestRuns, latestKey)
          return run ? await readyResumableChatResponse(run) : undefined
        },
        async stop(invocationId) {
          const run = invocationRuns.get(resumableChatKey(latestKey, invocationId))
          if (!run) return
          await run.ready
          if (run.setupFailed) throw run.setupError
          removeRun(run)
          closeResumableChatRun(run)
          await run.reader?.cancel(resumableChatCancellationReason).catch(() => undefined)
        },
      }
    },
  }
}
