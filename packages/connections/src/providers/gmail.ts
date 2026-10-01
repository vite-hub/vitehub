import type { ConnectionCallResult, ConnectionClient, ConnectionEffect, ConnectionOperation, ConnectionRequest } from "../types.ts"

const api = "https://gmail.googleapis.com/gmail/v1/users/me"
const readonlyScope = "https://www.googleapis.com/auth/gmail.readonly"
const modifyScope = "https://www.googleapis.com/auth/gmail.modify"
const composeScope = "https://www.googleapis.com/auth/gmail.compose"
const labelsScope = "https://www.googleapis.com/auth/gmail.labels"

export interface GmailProfile {
  emailAddress: string
  historyId: string
  messagesTotal?: number
  threadsTotal?: number
}

export interface GmailLabel {
  id: string
  labelListVisibility?: "labelHide" | "labelShow" | "labelShowIfUnread"
  messageListVisibility?: "hide" | "show"
  messagesTotal?: number
  messagesUnread?: number
  name: string
  type?: "system" | "user"
}

export interface GmailLabelInput {
  labelListVisibility?: GmailLabel["labelListVisibility"]
  messageListVisibility?: GmailLabel["messageListVisibility"]
  name: string
}

export interface GmailMessageHeader {
  name: string
  value: string
}

/** Body of a message part that Gmail stores separately. `data` is base64url. */
export interface GmailAttachment {
  data?: string
  size?: number
}

export interface GmailMessagePart {
  body?: { attachmentId?: string, data?: string, size?: number }
  filename?: string
  headers?: GmailMessageHeader[]
  mimeType?: string
  partId?: string
  parts?: GmailMessagePart[]
}

export interface GmailMessage {
  historyId?: string
  id: string
  internalDate?: string
  labelIds?: string[]
  payload?: GmailMessagePart
  raw?: string
  sizeEstimate?: number
  snippet?: string
  threadId: string
}

export interface GmailMessageList {
  messages?: Array<Pick<GmailMessage, "id" | "threadId">>
  nextPageToken?: string
  resultSizeEstimate?: number
}

export interface GmailHistoryRecord {
  id: string
  labelsAdded?: Array<{ labelIds: string[], message: Pick<GmailMessage, "id" | "labelIds" | "threadId"> }>
  labelsRemoved?: Array<{ labelIds: string[], message: Pick<GmailMessage, "id" | "labelIds" | "threadId"> }>
  messages?: Array<Pick<GmailMessage, "id" | "threadId">>
  messagesAdded?: Array<{ message: Pick<GmailMessage, "id" | "labelIds" | "threadId"> }>
  messagesDeleted?: Array<{ message: Pick<GmailMessage, "id" | "threadId"> }>
}

export interface GmailHistoryList {
  history?: GmailHistoryRecord[]
  historyId: string
  nextPageToken?: string
}

export interface GmailWatchResponse {
  expiration: string
  historyId: string
}

export interface GmailDraft {
  id: string
  message: Pick<GmailMessage, "id" | "labelIds" | "threadId">
}

type Operation<TInput, TOutput, TEffect extends ConnectionEffect> = ConnectionOperation<TInput, TOutput, TEffect>

// doctor-disable-next-line typescript/evidence/no-caller-chosen-result-type -- Operation declarations state the Gmail REST input and output shapes; the provider response is not validated at runtime.
function operation<TInput, TOutput, TEffect extends ConnectionEffect>(
  id: string,
  effect: TEffect,
  scopes: readonly string[],
  request: (input: TInput) => ConnectionRequest,
): Operation<TInput, TOutput, TEffect> {
  return { effect, id, request, scopes }
}

const path = (value: string) => encodeURIComponent(value)
const readScopes = [readonlyScope, modifyScope]

/** Typed Gmail REST v1 Operations. Ids are the access patterns, for example `gmail.messages.*`. */
export const gmailOperations: {
  attachmentsGet: Operation<{ id: string, messageId: string }, GmailAttachment, "read">
  draftsCreate: Operation<{ raw: string, threadId?: string }, GmailDraft, "write">
  historyList: Operation<{ historyTypes?: Array<"labelAdded" | "labelRemoved" | "messageAdded" | "messageDeleted">, labelId?: string, maxResults?: number, pageToken?: string, startHistoryId: string }, GmailHistoryList, "read">
  labelsCreate: Operation<GmailLabelInput, GmailLabel, "write">
  labelsGet: Operation<{ id: string }, GmailLabel, "read">
  labelsList: Operation<void, { labels?: GmailLabel[] }, "read">
  labelsPatch: Operation<Partial<GmailLabelInput> & { id: string }, GmailLabel, "write">
  messagesGet: Operation<{ format?: "full" | "metadata" | "minimal" | "raw", id: string, metadataHeaders?: string[] }, GmailMessage, "read">
  messagesList: Operation<{ includeSpamTrash?: boolean, labelIds?: string[], maxResults?: number, pageToken?: string, q?: string }, GmailMessageList, "read">
  messagesModify: Operation<{ addLabelIds?: string[], id: string, removeLabelIds?: string[] }, GmailMessage, "write">
  messagesTrash: Operation<{ id: string }, GmailMessage, "write">
  profileGet: Operation<void, GmailProfile, "read">
  watch: Operation<{ labelFilterBehavior?: "exclude" | "include", labelIds?: string[], topicName: string }, GmailWatchResponse, "write">
} = {
  attachmentsGet: operation("gmail.messages.attachments.get", "read", readScopes, input => ({
    method: "GET",
    url: `${api}/messages/${path(input.messageId)}/attachments/${path(input.id)}`,
  })),
  draftsCreate: operation("gmail.drafts.create", "write", [composeScope, modifyScope], input => ({
    body: { message: { raw: input.raw, ...(input.threadId ? { threadId: input.threadId } : {}) } },
    method: "POST",
    url: `${api}/drafts`,
  })),
  historyList: operation("gmail.history.list", "read", readScopes, input => ({
    method: "GET",
    query: { historyTypes: input.historyTypes, labelId: input.labelId, maxResults: input.maxResults, pageToken: input.pageToken, startHistoryId: input.startHistoryId },
    url: `${api}/history`,
  })),
  labelsCreate: operation("gmail.labels.create", "write", [labelsScope, modifyScope], input => ({ body: input, method: "POST", url: `${api}/labels` })),
  labelsGet: operation("gmail.labels.get", "read", [...readScopes, labelsScope], input => ({ method: "GET", url: `${api}/labels/${path(input.id)}` })),
  labelsList: operation("gmail.labels.list", "read", [...readScopes, labelsScope], () => ({ method: "GET", url: `${api}/labels` })),
  labelsPatch: operation("gmail.labels.patch", "write", [labelsScope, modifyScope], ({ id, ...body }) => ({ body, method: "PATCH", url: `${api}/labels/${path(id)}` })),
  messagesGet: operation("gmail.messages.get", "read", readScopes, input => ({
    method: "GET",
    query: { format: input.format, metadataHeaders: input.metadataHeaders },
    url: `${api}/messages/${path(input.id)}`,
  })),
  messagesList: operation("gmail.messages.list", "read", readScopes, input => ({
    method: "GET",
    query: { includeSpamTrash: input.includeSpamTrash, labelIds: input.labelIds, maxResults: input.maxResults, pageToken: input.pageToken, q: input.q },
    url: `${api}/messages`,
  })),
  messagesModify: operation("gmail.messages.modify", "write", [modifyScope], ({ id, ...body }) => ({ body, method: "POST", url: `${api}/messages/${path(id)}/modify` })),
  messagesTrash: operation("gmail.messages.trash", "write", [modifyScope], input => ({ method: "POST", url: `${api}/messages/${path(input.id)}/trash` })),
  profileGet: operation("gmail.profile.get", "read", readScopes, () => ({ method: "GET", url: `${api}/profile` })),
  watch: operation("gmail.watch", "write", readScopes, input => ({ body: input, method: "POST", url: `${api}/watch` })),
}

type Ops = typeof gmailOperations
type Call<TOperation, TDryRun extends boolean | undefined>
  = TOperation extends ConnectionOperation<infer TInput, infer TOutput, infer TEffect>
    ? [TInput] extends [void]
        ? () => Promise<ConnectionCallResult<TOutput, TEffect, TDryRun>>
        : (input: TInput) => Promise<ConnectionCallResult<TOutput, TEffect, TDryRun>>
    : never

export interface GmailClient<TDryRun extends boolean | undefined = boolean | undefined> {
  drafts: { create: Call<Ops["draftsCreate"], TDryRun> }
  history: { list: Call<Ops["historyList"], TDryRun> }
  labels: {
    create: Call<Ops["labelsCreate"], TDryRun>
    get: Call<Ops["labelsGet"], TDryRun>
    list: Call<Ops["labelsList"], TDryRun>
    patch: Call<Ops["labelsPatch"], TDryRun>
  }
  messages: {
    attachments: { get: Call<Ops["attachmentsGet"], TDryRun> }
    get: Call<Ops["messagesGet"], TDryRun>
    list: Call<Ops["messagesList"], TDryRun>
    modify: Call<Ops["messagesModify"], TDryRun>
    trash: Call<Ops["messagesTrash"], TDryRun>
  }
  profile: { get: Call<Ops["profileGet"], TDryRun> }
  watch: Call<Ops["watch"], TDryRun>
}

/** Typed Gmail client over a Google Connection. Every call goes through access checks and audit. */
export function gmail<TDryRun extends boolean | undefined>(connection: ConnectionClient<TDryRun>): GmailClient<TDryRun> {
  const run = <TInput, TOutput, TEffect extends ConnectionEffect>(op: Operation<TInput, TOutput, TEffect>) =>
    // SAFETY: connection.call returns ConnectionCallResult for the same Operation and TDryRun, which is the Call result type.
    ((input: TInput) => connection.call(op, input)) as Call<Operation<TInput, TOutput, TEffect>, TDryRun>
  const ops = gmailOperations
  return {
    drafts: { create: run(ops.draftsCreate) },
    history: { list: run(ops.historyList) },
    labels: { create: run(ops.labelsCreate), get: run(ops.labelsGet), list: run(ops.labelsList), patch: run(ops.labelsPatch) },
    messages: { attachments: { get: run(ops.attachmentsGet) }, get: run(ops.messagesGet), list: run(ops.messagesList), modify: run(ops.messagesModify), trash: run(ops.messagesTrash) },
    profile: { get: run(ops.profileGet) },
    watch: run(ops.watch),
  }
}
