import { isRecordOrFunction as isRecord } from "@vite-hub/internal/object"
import { callOperationRpc, operationRpcPath, type OperationRpcOutcome } from "@vite-hub/internal/operation-rpc"

import type {
  CommentCreateInput,
  CommentDeleteInput,
  CommentEditInput,
  CommentGetInput,
  CommentListQuery,
  CommentReplyInput,
  CommentsTransport,
  CommentStatusInput,
  CommentThread,
  CommentUser,
  CommentUsersInput,
} from "./types.ts"

export interface RpcTransportOptions {
  /** The app origin and mount, such as `https://app.example.com` or `/portal`. Defaults to the page origin. */
  base?: string
  /** Replaces `fetch`, for tests. */
  fetch?: typeof fetch
}

/** A failed operation, with the fields that every ViteHub surface reports. */
export class CommentsRpcError extends Error {
  readonly code: string
  readonly fix?: string
  readonly status: number
  readonly details?: Record<string, unknown>

  constructor(failure: { code: string, details?: Record<string, unknown>, fix?: string, message: string, status: number }) {
    super(failure.message)
    this.name = "CommentsRpcError"
    this.code = failure.code
    this.status = failure.status
    if (failure.fix) this.fix = failure.fix
    if (failure.details) this.details = failure.details
  }
}

/**
 * A transport over the operations RPC at `POST /_vitehub/rpc`, one birpc call for each request, for development only.
 * A browser cannot sign Console calls, so it works on a development server with `console: { auth: false }` or without
 * the `console` option. Pages of a production app use `createRestTransport()` from `@vite-hub/comments/client`. It has
 * no `subscribe`: the client refreshes when the window gets focus.
 */
export function createRpcTransport(options: RpcTransportOptions = {}): CommentsTransport {
  const base = (options.base ?? "").replace(/\/+$/, "")
  async function call<T>(operation: string, input: unknown): Promise<T> {
    const send = options.fetch ?? globalThis.fetch
    let outcome: OperationRpcOutcome<{ body: unknown, response: Response }>
    try {
      outcome = await callOperationRpc(operation, input, async (body) => {
        const response = await send(`${base}${operationRpcPath}`, {
          body,
          cache: "no-store",
          credentials: "same-origin",
          headers: { "content-type": "application/json", "x-vitehub-console": "1" },
          method: "POST",
        })
        return { body: await response.json().catch(() => undefined), response }
      })
    }
    catch (cause) {
      throw new CommentsRpcError({ code: "COMMENTS_R0013", fix: "Check the connection and try again.", message: `The request failed: ${cause instanceof Error ? cause.message : String(cause)}`, status: 0 })
    }
    // SAFETY: The operation of the same name answers with the type of the transport method that called it.
    if (outcome.ok) return outcome.value as T
    if (outcome.error) throw new CommentsRpcError(outcome.error)
    // Host middleware, such as the Console sign-in check, answers with the diagnostic body and no birpc reply.
    const { body, response } = outcome.answer
    throw new CommentsRpcError({
      code: isRecord(body) && typeof body.code === "string" ? body.code : "COMMENTS_R0013",
      message: isRecord(body) && typeof body.message === "string" ? body.message : `The server answered with HTTP ${response.status}.`,
      status: isRecord(body) && typeof body.status === "number" ? body.status : response.status,
      ...(isRecord(body) && typeof body.fix === "string" ? { fix: body.fix } : {}),
      ...(isRecord(body) && isRecord(body.details) ? { details: body.details } : {}),
    })
  }
  return {
    create: (input: CommentCreateInput) => call<CommentThread>("comments.create", input),
    delete: (input: CommentDeleteInput) => call<CommentThread | null>("comments.delete", input),
    edit: (input: CommentEditInput) => call<CommentThread>("comments.edit", input),
    get: (input: CommentGetInput) => call<CommentThread | null>("comments.get", input),
    list: (query: CommentListQuery) => call<CommentThread[]>("comments.list", query),
    reopen: (input: CommentStatusInput) => call<CommentThread>("comments.reopen", input),
    reply: (input: CommentReplyInput) => call<CommentThread>("comments.reply", input),
    resolve: (input: CommentStatusInput) => call<CommentThread>("comments.resolve", input),
    users: (input: CommentUsersInput) => call<CommentUser[]>("comments.users", input),
  }
}
