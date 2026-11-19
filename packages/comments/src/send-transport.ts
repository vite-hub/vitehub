import { createCommentsRestRequest } from "./rest-transport.ts"

import type { CommentSendPairing, CommentSendPairingCheck, CommentSendResult, CommentSendStatus, CommentSendTransport } from "./client-send.ts"
import type { RestTransportOptions } from "./rest-transport.ts"

export interface CommentSendTransportOptions extends Pick<RestTransportOptions, "base" | "headers" | "credentials" | "fetch"> {
  /**
   * The path of the page that Send is on, such as `/notes/azores`. The server turns it into the subject, as `page` of
   * `defineComments()` decides. A function runs before each request, so it follows client-side navigation. Default:
   * `location.pathname`.
   */
  page?: string | (() => string)
}

/**
 * The transport of `createCommentSend()` over the Send routes of Comments, `<base>/_vitehub/comments/send/**`. The
 * ViteHub pill uses it, and an app renders `CommentSend` of `@vite-hub/ui` with it in its own pill:
 *
 * ```ts
 * import { createCommentSend, createCommentSendTransport } from "@vite-hub/comments/client"
 *
 * const send = createCommentSend(createCommentSendTransport({ page: () => location.pathname }))
 * ```
 */
export function createCommentSendTransport(options: CommentSendTransportOptions = {}): CommentSendTransport {
  const request = createCommentsRestRequest(options)
  const page = () => encodeURIComponent(typeof options.page === "function" ? options.page() : options.page ?? location.pathname)
  const post = (body?: unknown): RequestInit => ({ method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const code = (value: string) => encodeURIComponent(value)
  return {
    status: async () => (await request<CommentSendStatus>(`/send/status?page=${page()}`)).data,
    startPairing: async () => (await request<CommentSendPairing>(`/send/start?page=${page()}`, post())).data,
    pollPairing: async value => (await request<CommentSendPairingCheck>(`/send/pair/${code(value)}`)).data,
    allow: async value => (await request<CommentSendResult>(`/send/allow?page=${page()}`, post({ code: value }))).data,
    cancel: async (value) => {
      await request(`/send/pair/${code(value)}`, { method: "DELETE" })
    },
    send: async () => (await request<CommentSendResult>(`/send?page=${page()}`, post())).data,
  }
}
