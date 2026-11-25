import type { CommentUser } from "../types.ts"

/** The fragment parameter of the sign-in code that the Console sends to the registered page: `#vhc=<code>`. */
export const embedCodeParam = "vhc"

/** The `type` of the message that gives the embed frame its port. */
export const embedConnectType = "vitehub-comments:connect"

/** The only requests that the embed frame answers. */
export const embedMethods = ["session", "list", "get", "create", "reply", "resolve", "reopen", "redeem"] as const

export type EmbedMethod = typeof embedMethods[number]

export interface EmbedRequest {
  id: number
  method: EmbedMethod
  input: unknown
}

export interface EmbedFailure {
  code: string
  why: string
  fix?: string
  status: number
}

export type EmbedAnswer =
  | { id: number, ok: true, value: unknown, people: CommentUser[] }
  | { id: number, ok: false, error: EmbedFailure }

/** The messages of the sign-in relay between the tabs of the site: a code that a tab got, and a code that a frame redeemed. */
export type EmbedRelay = { type: "code", code: string } | { type: "redeemed", code: string }

/** The `BroadcastChannel` of one project on the site's origin. */
export function embedChannelName(projectId: string): string {
  return `vitehub-comments:${projectId}`
}

/** The Console route of the frame of one project. */
export function embedPath(projectId: string): string {
  return `/comments/${encodeURIComponent(projectId)}/embed`
}

/** Whether `value` is a request of the embed protocol. */
export function isEmbedRequest(value: unknown): value is EmbedRequest {
  if (value === null || typeof value !== "object") return false
  const id: unknown = Reflect.get(value, "id")
  const method: unknown = Reflect.get(value, "method")
  return typeof id === "number" && Number.isSafeInteger(id) && embedMethods.some(name => name === method)
}

/** The site's end of the connection to the embed frame. */
export interface EmbedFrame {
  call: (method: EmbedMethod, input: unknown) => Promise<Extract<EmbedAnswer, { ok: true }>>
}
