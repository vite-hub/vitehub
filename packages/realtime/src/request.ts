import { getActiveCloudflareBinding } from "@vite-hub/internal/runtime/cloudflare-env"

import { isRealtimeAvailable } from "./availability.ts"
import { realtimeErrorDiagnostics } from "./error-diagnostics.ts"

import type { Result } from "@vite-hub/runtime"
import type { RealtimeRoomRequestErrorCode } from "./types.ts"

export const routePrefix = "/api/_vitehub/realtime/"
/** Marks the request that `requestRealtimeRoom()` sends to a Durable Object. The Worker strips it from client requests. */
export const internalRequestHeader = "x-vitehub-realtime-request"
export const defaultRequestTimeout = 30_000
export const defaultRequestWait = 5_000
/**
 * The one Durable Object instance that holds every room. Nitro's Cloudflare entry hands each WebSocket upgrade
 * to this instance before the application runs, so saves, checkpoints, and refreshes must reach it too: a Durable
 * Object per room would have no peers and never match a room's state.
 */
export const durableRoomsInstance = "server"

/** The `$DurableObject` namespace binding that holds Realtime rooms on Cloudflare. */
export interface RealtimeDurableObjectNamespace {
  get(id: unknown): { fetch(request: Request): Promise<Response> }
  idFromName(name: string): unknown
}

/**
 * Accepts the namespace that holds Realtime rooms, and nothing that only inherits `get` and `idFromName` from an
 * arbitrary prototype. Workerd's binding owns no methods: they belong to its `DurableObjectNamespace` class prototype,
 * and Workers have no global `DurableObjectNamespace` to compare with. Any other namespace, such as a test double,
 * must own both methods.
 */
export function isRealtimeDurableObjectNamespace(value: unknown): value is RealtimeDurableObjectNamespace {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const methods = (target: object) => ["get", "idFromName"].map(name => Object.getOwnPropertyDescriptor(target, name))
  const callable = (method: PropertyDescriptor | undefined) => !!method && !method.get && typeof method.value === "function"
    && Function.prototype.toString.call(method.value) !== "function () { [native code] }"
  try {
    const own = methods(value)
    if (own.every(callable)) return true
    const prototype: unknown = Object.getPrototypeOf(value)
    if (own.some(Boolean) || prototype === null || typeof prototype !== "object" || Object.getPrototypeOf(prototype) !== Object.prototype) return false
    return Object.prototype.toString.call(value) === "[object DurableObjectNamespace]" && methods(prototype).every(callable)
  }
  catch { return false }
}


/** The `$DurableObject` binding of the running Worker. Nitro's Cloudflare entry stores each request's bindings in `globalThis.__env__`. */
export function workerDurableObjects(): RealtimeDurableObjectNamespace | undefined {
  try {
    // The internal runtime resolves the active request's AsyncLocalStorage scope before
    // falling back to Nitro's ambient __env__ binding.
    const binding = getActiveCloudflareBinding<unknown>("$DurableObject")
    return isRealtimeDurableObjectNamespace(binding) ? binding : undefined
  }
  catch {
    return undefined
  }
}


export interface RealtimeRoomRequestOptions {
  /** How long to wait for the browser's answer, in milliseconds. Default 30 seconds. */
  timeout?: number
  /** How long to wait for a browser to join or rejoin the room before the request fails, in milliseconds. Default 5 seconds. */
  wait?: number
  /** Stops the request, such as when the caller's run is cancelled. */
  signal?: AbortSignal
  /** On Cloudflare, the `$DurableObject` binding that holds the rooms. Defaults to the binding of the running Worker. */
  durableObjects?: RealtimeDurableObjectNamespace
}

/** `[error, answer]` of `requestRealtimeRoom()`. */
export type RealtimeRoomRequestResult = Result<unknown, RealtimeRoomRequestErrorCode>

export interface LocalRequestOptions {
  timeout: number
  wait: number
  signal?: AbortSignal
}
type LocalRequest = (definitionName: string, documentId: string, body: unknown, options: LocalRequestOptions) => Promise<RealtimeRoomRequestResult>

const localRequestKey: unique symbol = Symbol.for("vitehub.realtime.local-request")
// SAFETY: This module owns the process slot shared by separately bundled handlers and callers.
const requestScope = globalThis as typeof globalThis & { [localRequestKey]?: Set<WeakRef<LocalRequest>> }

export function localRequesters(): Set<WeakRef<LocalRequest>> {
  requestScope[localRequestKey] ??= new Set()
  return requestScope[localRequestKey]
}

type RoomRequestErrorParams = { count?: number, definition?: string, reason?: string, timeout?: number }

/** The parameters each request error was made with, so a Durable Object can send the same error to the Worker. */
const roomRequestErrorParams = new WeakMap<object, RoomRequestErrorParams>()

export function roomRequestError(code: RealtimeRoomRequestErrorCode, params: RoomRequestErrorParams = {}): RealtimeRoomRequestResult {
  const result = createRoomRequestError(code, params)
  if (result[0]) roomRequestErrorParams.set(result[0], params)
  return result
}

function createRoomRequestError(code: RealtimeRoomRequestErrorCode, params: RoomRequestErrorParams): RealtimeRoomRequestResult {
  switch (code) {
    case "REALTIME_ROOM_ABORTED": return [realtimeErrorDiagnostics.REALTIME_ROOM_ABORTED(), undefined]
    case "REALTIME_ROOM_CROWDED": return [realtimeErrorDiagnostics.REALTIME_ROOM_CROWDED({ count: params.count ?? 2 }), undefined]
    case "REALTIME_ROOM_ELSEWHERE": return [realtimeErrorDiagnostics.REALTIME_ROOM_ELSEWHERE(), undefined]
    case "REALTIME_ROOM_EMPTY": return [realtimeErrorDiagnostics.REALTIME_ROOM_EMPTY(), undefined]
    case "REALTIME_ROOM_REFUSED": return [realtimeErrorDiagnostics.REALTIME_ROOM_REFUSED({ reason: params.reason ?? "no reason given." }), undefined]
    case "REALTIME_ROOM_REQUESTS_OFF": return [realtimeErrorDiagnostics.REALTIME_ROOM_REQUESTS_OFF({ definition: params.definition ?? "" }), undefined]
    case "REALTIME_ROOM_TIMEOUT": return [realtimeErrorDiagnostics.REALTIME_ROOM_TIMEOUT({ timeout: params.timeout ?? defaultRequestTimeout }), undefined]
  }
}

const roomRequestErrorCodes: ReadonlySet<string> = new Set<RealtimeRoomRequestErrorCode>([
  "REALTIME_ROOM_ABORTED",
  "REALTIME_ROOM_CROWDED",
  "REALTIME_ROOM_ELSEWHERE",
  "REALTIME_ROOM_EMPTY",
  "REALTIME_ROOM_REFUSED",
  "REALTIME_ROOM_REQUESTS_OFF",
  "REALTIME_ROOM_TIMEOUT",
])

function isRoomRequestErrorCode(value: unknown): value is RealtimeRoomRequestErrorCode {
  return typeof value === "string" && roomRequestErrorCodes.has(value)
}

/** The JSON a Durable Object returns for one request: the answer, or the error code and its parameters. */
type DurableRequestReply = { ok: true, body: unknown } | { ok: false, code: RealtimeRoomRequestErrorCode, params: RoomRequestErrorParams }

export function toDurableRequestReply(result: RealtimeRoomRequestResult): DurableRequestReply {
  const [error, body] = result
  return error ? { ok: false, code: error.code, params: roomRequestErrorParams.get(error) ?? {} } : { ok: true, body }
}

/** The part of a Durable Object's state that lists its sockets. They outlive hibernation, unlike the rooms in memory. */
export interface DurableSockets {
  getWebSockets(): Array<{ deserializeAttachment(): unknown, send(data: Uint8Array): void }>
}

export function isDurableSockets(value: unknown): value is DurableSockets {
  return typeof value === "object" && value !== null && "getWebSockets" in value && typeof value.getWebSockets === "function"
}

/**
 * Asks the one browser in a room of a presence Definition with `requests: true`, and resolves its answer. The browser
 * answers with `room.onRequest()` from `@vite-hub/realtime/client`. A room with no browser waits `wait` milliseconds for
 * one to join, such as after a reload, before it returns `REALTIME_ROOM_EMPTY`. A room with more than one browser
 * returns `REALTIME_ROOM_CROWDED`. On Cloudflare the request goes to the Durable Object that holds the rooms. On Node it
 * reaches the rooms of this process; with Redis or Postgres, a browser on another instance gives `REALTIME_ROOM_ELSEWHERE`.
 * Returns `[error, answer]` and never throws.
 */
export async function requestRealtimeRoom(definition: string, documentId: string, body: unknown, options: RealtimeRoomRequestOptions = {}): Promise<RealtimeRoomRequestResult> {
  const local: LocalRequestOptions = {
    timeout: options.timeout ?? defaultRequestTimeout,
    wait: options.wait ?? defaultRequestWait,
    ...(options.signal ? { signal: options.signal } : {}),
  }
  if (local.signal?.aborted) return roomRequestError("REALTIME_ROOM_ABORTED")
  const binding = options.durableObjects ?? workerDurableObjects()
  if (binding) return await requestDurableRoom(binding, definition, documentId, body, local)
  // The newest handler first: a reloaded server leaves its old handler behind until it is collected.
  for (const reference of [...localRequesters()].reverse()) {
    const request = reference.deref()
    if (!request) {
      localRequesters().delete(reference)
      continue
    }
    return await request(definition, documentId, body, local)
  }
  // No Realtime handler runs in this process yet: no browser has connected.
  return roomRequestError("REALTIME_ROOM_EMPTY")
}

async function requestDurableRoom(binding: RealtimeDurableObjectNamespace, definition: string, documentId: string, body: unknown, options: LocalRequestOptions): Promise<RealtimeRoomRequestResult> {
  const room = documentId.split("/").map(encodeURIComponent).join("/")
  let response: Response
  try {
    response = await binding.get(binding.idFromName(durableRoomsInstance)).fetch(new Request(
      `https://vitehub.internal${routePrefix}${encodeURIComponent(definition)}/${room}?request=1`,
      {
        method: "POST",
        headers: { [internalRequestHeader]: "1", "content-type": "application/json" },
        body: JSON.stringify({ body, timeout: options.timeout, wait: options.wait }),
        ...(options.signal ? { signal: options.signal } : {}),
      },
    ))
  }
  catch {
    return roomRequestError(options.signal?.aborted ? "REALTIME_ROOM_ABORTED" : "REALTIME_ROOM_EMPTY")
  }
  const reply: unknown = response.ok ? await response.json().catch(() => undefined) : undefined
  if (reply && typeof reply === "object" && "ok" in reply) {
    if (reply.ok === true) return [undefined, "body" in reply ? reply.body : undefined]
    if ("code" in reply && isRoomRequestErrorCode(reply.code)) {
      const params = "params" in reply && reply.params && typeof reply.params === "object" ? reply.params as RoomRequestErrorParams : {}
      return roomRequestError(reply.code, params)
    }
  }
  return roomRequestError("REALTIME_ROOM_REFUSED", { reason: `the Durable Object answered HTTP ${response.status}.` })
}


/**
 * The Realtime handle of an Agent's `page()` Capability. ViteHub passes it to the Agent routes when the app has
 * Realtime, as `capabilities.realtime`.
 */
export interface AgentRealtime {
  available: () => boolean
  request: typeof requestRealtimeRoom
}

export const agentRealtime: AgentRealtime = { available: isRealtimeAvailable, request: requestRealtimeRoom }
