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
  const pairingPages = new Map<string, string>()
  return {
    status: async () => (await request<CommentSendStatus>(`/send/status?page=${page()}`)).data,
    startPairing: async () => {
      const path = page()
      const pairing = (await request<CommentSendPairing>(`/send/start?page=${path}`, post())).data
      pairingPages.set(pairing.code, path)
      return pairing
    },
    pollPairing: async value => (await request<CommentSendPairingCheck>(`/send/pair/${code(value)}`)).data,
    allow: async (value, selection) => {
      const path = pairingPages.get(value) ?? page()
      const result = (await request<CommentSendResult>(`/send/allow?page=${path}`, post({ code: value, selection }))).data
      // After `changed`, the member may allow the same code again, from the same page.
      if (result.status !== "changed") pairingPages.delete(value)
      return result
    },
    cancel: async (value) => {
      pairingPages.delete(value)
      await request(`/send/pair/${code(value)}`, { method: "DELETE" })
    },
    send: async () => (await request<CommentSendResult>(`/send?page=${page()}`, post())).data,
  }
}
