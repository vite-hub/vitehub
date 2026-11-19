import { isRecordOrFunction as isRecord } from "@vite-hub/internal/object"
import { callOperationRpc, operationRpcPath, type OperationRpcOutcome } from "@vite-hub/internal/operation-rpc"

import { commentsAnswerError, commentsUnansweredError } from "../client-diagnostics.ts"
import { uploadFiles } from "../client-files.ts"

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
  CommentSubject,
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
      throw commentsUnansweredError(0, cause)
    }
    // SAFETY: The operation of the same name answers with the type of the transport method that called it.
    if (outcome.ok) return outcome.value as T
    if (outcome.error) {
      const { message, ...failure } = outcome.error
      throw commentsAnswerError({ ...failure, why: message })
    }
    // Host middleware, such as the Console sign-in check, answers with the diagnostic body and no birpc reply.
    const { body, response } = outcome.answer
    if (!isRecord(body) || typeof body.code !== "string" || typeof body.message !== "string") throw commentsUnansweredError(response.status)
    throw commentsAnswerError({
      code: body.code,
      status: typeof body.status === "number" ? body.status : response.status,
      why: body.message,
      ...(typeof body.fix === "string" ? { fix: body.fix } : {}),
      ...(isRecord(body.details) ? { details: body.details } : {}),
    })
  }
  const upload = (input: CommentUploadInput) => call<CommentAttachment>("comments.upload", input)
  const withFiles = async <T extends { attachments?: string[] }>({ files, ...input }: T & CommentFiles, subject?: CommentSubject): Promise<Omit<T, "files">> => {
    if (!files?.length) return input
    return { ...input, attachments: [...(input.attachments ?? []), ...await uploadFiles(files, subject, upload)] }
  }
  return {
    create: async (input: CommentCreateInput & CommentFiles) => call<CommentThread>("comments.create", await withFiles(input, input.subject)),
    delete: (input: CommentDeleteInput) => call<CommentThread | null>("comments.delete", input),
    edit: (input: CommentEditInput) => call<CommentThread>("comments.edit", input),
    get: (input: CommentGetInput) => call<CommentThread | null>("comments.get", input),
    list: (query: CommentListQuery) => call<CommentThread[]>("comments.list", query),
    reopen: (input: CommentStatusInput) => call<CommentThread>("comments.reopen", input),
    reply: async ({ subject, ...input }: CommentReplyInput & CommentFiles) => call<CommentThread>("comments.reply", await withFiles(input, subject)),
    resolve: (input: CommentStatusInput) => call<CommentThread>("comments.resolve", input),
    users: (input: CommentUsersInput) => call<CommentUser[]>("comments.users", input),
  }
}
