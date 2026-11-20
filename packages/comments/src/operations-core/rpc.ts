import { isRecordOrFunction as isRecord } from "@vite-hub/internal/object"
import { callOperationRpc, operationRpcPath, type OperationRpcOutcome } from "@vite-hub/internal/operation-rpc"

import { commentsAnswerError, commentsUnansweredError } from "../client-diagnostics.ts"
import { outboxAccountHeader, retryAfterOf, withCommentFiles } from "../client-files.ts"

import type {
  CommentCreateInput,
  CommentDeleteInput,
  CommentAttachment,
  CommentEditInput,
  CommentFiles,
  CommentGetInput,
  CommentListQuery,
  CommentReplyInput,
  CommentsTransport,
  CommentStatusInput,
  CommentThread,
  CommentUploadInput,
  CommentUser,
  CommentUsersInput,
} from "./types.ts"

export interface RpcTransportOptions {
  /** The app origin and mount, such as `https://app.example.com` or `/portal`. Defaults to the page origin. */
  base?: string
  /** Replaces `fetch`, for tests. */
  fetch?: typeof fetch
}

interface CommentRpcResults {
  "comments.create": CommentThread
  "comments.delete": CommentThread | null
  "comments.edit": CommentThread
  "comments.get": CommentThread | null
  "comments.list": CommentThread[]
  "comments.reopen": CommentThread
  "comments.reply": CommentThread
  "comments.resolve": CommentThread
  "comments.upload": CommentAttachment
  "comments.users": CommentUser[]
}

/**
 * A transport over the operations RPC at `POST /_vitehub/rpc`, one birpc call for each request, for development only.
 * A browser cannot sign Console calls, so it works on a development server with `console: { auth: false }` or without
 * the `console` option. Pages of a production app use `createRestTransport()` from `@vite-hub/comments/client`. It has
 * no `subscribe`: the client refreshes when the window gets focus.
 */
export function createRpcTransport(options: RpcTransportOptions = {}): CommentsTransport {
  const base = (options.base ?? "").replace(/\/+$/, "")
  async function call<Name extends keyof CommentRpcResults>(operation: Name, input: unknown, account?: string): Promise<CommentRpcResults[Name]> {
    const send = options.fetch ?? globalThis.fetch
    let outcome: OperationRpcOutcome<{ body: unknown, response: Response }>
    try {
      outcome = await callOperationRpc(operation, input, async (body) => {
        const response = await send(`${base}${operationRpcPath}`, {
          body,
          cache: "no-store",
          credentials: "same-origin",
          headers: { "content-type": "application/json", "x-vitehub-console": "1", ...(account === undefined ? {} : { [outboxAccountHeader]: encodeURIComponent(account) }) },
          method: "POST",
        })
        return { body: await response.json().catch(() => undefined), response }
      })
    }
    catch (cause) {
      throw commentsUnansweredError(0, cause)
    }
    // SAFETY: The operation of the same name answers with the type of the transport method that called it.
    if (outcome.ok) return outcome.value as CommentRpcResults[Name]
    if (outcome.error) {
      const { message, ...failure } = outcome.error
      throw commentsAnswerError({ ...failure, why: message, retryAfter: retryAfterOf(outcome.answer.response) })
    }
    // Host middleware, such as the Console sign-in check, answers with the diagnostic body and no birpc reply.
    const { body, response } = outcome.answer
    const retryAfter = retryAfterOf(response)
    if (!isRecord(body) || typeof body.code !== "string" || typeof body.message !== "string") throw commentsUnansweredError(response.status, undefined, retryAfter)
    throw commentsAnswerError({
      code: body.code,
      status: typeof body.status === "number" ? body.status : response.status,
      why: body.message,
      ...(retryAfter === undefined ? {} : { retryAfter }),
      ...(typeof body.fix === "string" ? { fix: body.fix } : {}),
      ...(isRecord(body.details) ? { details: body.details } : {}),
    })
  }
  const upload = (input: CommentUploadInput, account?: string) => call("comments.upload", input, account)
  return {
    async create({ files, outbox, ...input }: CommentCreateInput & CommentFiles) {
      const body = await withCommentFiles(input, { files, outbox }, input.subject, data => upload(data, outbox?.account))
      return call("comments.create", body, outbox?.account)
    },
    delete: (input: CommentDeleteInput) => call("comments.delete", input),
    edit: (input: CommentEditInput) => call("comments.edit", input),
    get: (input: CommentGetInput) => call("comments.get", input),
    list: (query: CommentListQuery) => call("comments.list", query),
    reopen: (input: CommentStatusInput) => call("comments.reopen", input),
    async reply({ subject, files, outbox, ...input }: CommentReplyInput & CommentFiles) {
      const body = await withCommentFiles(input, { files, outbox }, subject, data => upload(data, outbox?.account))
      return call("comments.reply", body, outbox?.account)
    },
    resolve: (input: CommentStatusInput) => call("comments.resolve", input),
    users: (input: CommentUsersInput) => call("comments.users", input),
  }
}
