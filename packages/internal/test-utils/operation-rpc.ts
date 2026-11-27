/**
 * Test helpers for the birpc framing of `POST /_vitehub/rpc`. Tests keep reading and writing the result shape of
 * `callOperation()`, `{ ok: true, value }` or `{ ok: false, code, message, status }`, and these helpers convert it.
 */

/** The body of one call, as the clients send it: `{ m, a, t: "q", i }`. */
export function operationRpcBody(operation: string, input?: unknown, id = "test-call"): string {
  return JSON.stringify({ m: operation, a: input === undefined ? [] : [input], t: "q", i: id })
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : undefined
}

/** The result shape of `callOperation()`. */
export type OperationRpcTestResult =
  | { ok: true, value: unknown }
  | { ok: false, code: string, message: string, status: number, fix?: string, docs?: string, details?: Record<string, unknown> }

function readCall(body: unknown): { id: string, input: unknown, operation: string } {
  const message = record(typeof body === "string" ? JSON.parse(body) : body)
  if (!message || message.t !== "q" || typeof message.m !== "string" || typeof message.i !== "string" || !Array.isArray(message.a)) throw new TypeError(`Not a birpc call: ${String(body)}`)
  return { id: message.i, input: message.a[0], operation: message.m }
}

/** The operation and input of a sent call body. */
export function operationRpcRequest(body: unknown): { input: unknown, operation: string } {
  const { input, operation } = readCall(body)
  return { input, operation }
}

/** The reply to a sent call body with a result: `{ ok: true, value }` or a failure with `code`, `message`, and `status`. */
export function operationRpcReply(body: unknown, result: OperationRpcTestResult): Record<string, unknown> {
  const { id } = readCall(body)
  if (result.ok) return { t: "s", i: id, r: result.value }
  const { ok: _ok, ...failure } = result
  return { t: "s", i: id, e: failure }
}

/** A JSON Response with the reply to a sent call body. The status is the failure status, or 200. */
export function operationRpcResponse(body: unknown, result: OperationRpcTestResult, init: ResponseInit = {}): Response {
  return Response.json(operationRpcReply(body, result), { status: result.ok ? 200 : result.status, ...init })
}

/**
 * Read a reply as a result. A body that is not a reply, such as a failure of host middleware, comes back as it is. The
 * type is the type of `Response.json()`, so tests read fields as they did from the former result body.
 */
export function operationRpcResult(body: unknown): ReturnType<typeof JSON.parse> {
  const reply = record(body)
  if (!reply || reply.t !== "s") return body
  const failure = record(reply.e)
  return failure ? { ok: false, ...failure } : { ok: true, value: reply.r }
}

/** Read the JSON reply of a Response as a result. */
export async function operationRpcResponseResult(response: Response): ReturnType<Response["json"]> {
  return operationRpcResult(await response.json())
}

function isResult(value: unknown): value is OperationRpcTestResult {
  const body = record(value)
  if (body?.ok === true) return Object.hasOwn(body, "value")
  return body?.ok === false && typeof body.code === "string" && typeof body.message === "string"
}

/**
 * Wrap a fake fetch that answers calls with result bodies, `{ ok: true, value }` or a failure with a `code`, so each
 * such answer becomes the birpc reply to the call it got, with the same status and headers. Other answers, such as a
 * failure of host middleware without a code, pass through.
 */
export function operationRpcFetch<Input, Init extends RequestInit | undefined>(fetch: (input: Input, init: Init) => Promise<Response>): (input: Input, init: Init) => Promise<Response> {
  return async (input, init) => {
    const response = await fetch(input, init)
    let isCall = true
    try {
      readCall(init?.body)
    }
    catch {
      isCall = false
    }
    if (!isCall) return response
    const body: unknown = await response.clone().json().catch(() => undefined)
    if (!isResult(body)) return response
    return Response.json(operationRpcReply(init?.body, body), { headers: response.headers, status: response.status })
  }
}
