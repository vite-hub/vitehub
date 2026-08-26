import { AgentHttpError } from "../http-error.ts"

export const defaultAgentInboundBodyBytes = 1024 * 1024
export const maximumAgentInboundBodyBytes = 10 * 1024 * 1024

export interface CapturedAgentInboundBody {
  bytes: Uint8Array
  request: Request
  text: string
}

function bodyTooLarge(): AgentHttpError {
  return new AgentHttpError(413, "Agent request body exceeds the configured byte limit.")
}

function resolveBodyLimit(value: number | undefined): number {
  if (value === undefined) return defaultAgentInboundBodyBytes
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximumAgentInboundBodyBytes) {
    throw new TypeError(`[vitehub] Agent maxBodyBytes must be a positive integer no greater than ${maximumAgentInboundBodyBytes}.`)
  }
  return value
}

async function cancelRequestBody(request: Request, reason: unknown): Promise<void> {
  if (!request.body || request.body.locked) return
  await request.body.cancel(reason).catch(() => undefined)
}

function requestWithBody(request: Request, bytes: Uint8Array): Request {
  const init: RequestInit = {
    body: bytes.slice(),
    headers: request.headers,
    method: request.method,
    referrer: request.referrer,
    referrerPolicy: request.referrerPolicy,
    signal: request.signal,
  }

  const replayable = new Request(request, init)
  for (const key of Reflect.ownKeys(request)) {
    if (Reflect.has(replayable, key)) continue
    const descriptor = Reflect.getOwnPropertyDescriptor(request, key)
    if (descriptor) Reflect.defineProperty(replayable, key, descriptor)
  }
  return replayable
}

export async function captureAgentInboundBody(request: Request, configuredLimit?: number): Promise<CapturedAgentInboundBody> {
  const limit = resolveBodyLimit(configuredLimit)
  const declared = request.headers.get("content-length")?.trim()
  if (declared && /^\d+$/.test(declared) && BigInt(declared) > BigInt(limit)) {
    const error = bodyTooLarge()
    await cancelRequestBody(request, error)
    throw error
  }

  if (request.signal.aborted) {
    await cancelRequestBody(request, request.signal.reason)
    throw request.signal.reason
  }
  if (!request.body) {
    const bytes = new Uint8Array()
    return { bytes, request: requestWithBody(request, bytes), text: "" }
  }

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  const onAbort = () => {
    const reason = request.signal.reason ?? new DOMException("The request was aborted.", "AbortError")
    void reader.cancel(reason)
  }
  request.signal.addEventListener("abort", onAbort, { once: true })

  try {
    while (true) {
      const chunk = await reader.read()
      if (request.signal.aborted) throw request.signal.reason
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > limit) {
        const error = bodyTooLarge()
        await reader.cancel(error).catch(() => undefined)
        throw error
      }
      chunks.push(chunk.value)
    }
  }
  finally {
    request.signal.removeEventListener("abort", onAbort)
    reader.releaseLock()
  }

  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return {
    bytes,
    request: requestWithBody(request, bytes),
    text: new TextDecoder().decode(bytes),
  }
}
