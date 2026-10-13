import { requireAtomicAgentStateLock, type AgentStateCacheMutation } from "./state-lock.ts"
import * as v from "valibot"

import { agentDiagnostics } from "../agent-diagnostics.ts"
import { hasRuntimeType, isRuntimeRecord } from "./runtime-type.ts"

import type { ReplayChannelResult } from "../channel-replay.ts"
import type { AgentChannelHistoryCollection, AgentChannelHistoryQuery, AgentChannelStateBinding } from "../types.ts"
import type { AgentChannelSyncPlan, AgentChannelSyncProvider } from "./channel-sync.ts"

const gmailApiBaseUrl = "https://gmail.googleapis.com/gmail/v1/users/me/"
const googleTokenUrl = "https://oauth2.googleapis.com/token"
const googleCertsUrl = "https://www.googleapis.com/oauth2/v3/certs"
const googleIssuers = new Set(["https://accounts.google.com", "accounts.google.com"])
const requestTimeoutMs = 30_000
const clockSkewMs = 60_000
const labelCacheMs = 5 * 60_000
const syncLockTtlMs = 10 * 60_000
const watchRenewalMarginMs = 24 * 60 * 60_000
const messageFetchConcurrency = 5
export const gmailDefaultBodyLimit = 10_000
export const gmailWatchLabelIds: readonly string[] = ["INBOX"]

// Gmail API: https://developers.google.com/workspace/gmail/api/reference/rest

/** One Gmail REST request. `path` is relative to `https://gmail.googleapis.com/gmail/v1/users/me/`. */
export interface GmailRequest {
  body?: Record<string, unknown>
  method: "GET" | "PATCH" | "POST"
  path: string
  query?: Record<string, number | readonly string[] | string | undefined>
}

/**
 * Sends one Gmail API request and returns the parsed JSON response body.
 * Throw an error with a numeric `status` property when Gmail answers with an HTTP error.
 */
export type GmailClient = (request: GmailRequest) => Promise<unknown>

/** A Gmail API or Google OAuth HTTP error. */
export class GmailApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = "GmailApiError"
    this.status = status
  }
}

/** Gmail and Pub/Sub settings. Each value comes from Server Env `gmail` or its environment variable. */
export interface GmailSettings {
  clientId?: string
  clientSecret?: string
  pubsubAudience?: string
  pubsubServiceAccount?: string
  pubsubSubscription?: string
  pubsubTopic?: string
  refreshToken?: string
}

/** Environment variable for each Gmail setting when Server Env does not declare it. */
export const gmailEnvNames: Readonly<Record<keyof GmailSettings, string>> = {
  clientId: "GMAIL_CLIENT_ID",
  clientSecret: "GMAIL_CLIENT_SECRET",
  pubsubAudience: "GMAIL_PUBSUB_AUDIENCE",
  pubsubServiceAccount: "GMAIL_PUBSUB_SERVICE_ACCOUNT",
  pubsubSubscription: "GMAIL_PUBSUB_SUBSCRIPTION",
  pubsubTopic: "GMAIL_PUBSUB_TOPIC",
  refreshToken: "GMAIL_REFRESH_TOKEN",
}

function settingValue(value: unknown): string | undefined {
  const raw = isRuntimeRecord(value) && hasRuntimeType(value.unseal, "function") ? value.unseal() : value
  return hasRuntimeType(raw, "string") && raw.trim() ? raw.trim() : undefined
}

/** Reads Gmail settings from a Server Env `gmail` namespace, then from the environment variables. */
export function gmailSettings(namespace: Record<string, unknown>, env: (name: string) => unknown): GmailSettings {
  const settings: GmailSettings = {}
  for (const [key, name] of Object.entries(gmailEnvNames)) {
    const value = settingValue(namespace[key]) ?? settingValue(env(name))
    if (value) Object.assign(settings, { [key]: value })
  }
  return settings
}

// Gmail API response shapes. Unknown fields are dropped.

interface GmailApiPart {
  body?: { attachmentId?: string, data?: string, size?: number }
  filename?: string
  headers?: { name: string, value: string }[]
  mimeType?: string
  parts?: GmailApiPart[]
}

const partSchema: v.GenericSchema<GmailApiPart> = v.object({
  body: v.optional(v.object({ attachmentId: v.optional(v.string()), data: v.optional(v.string()), size: v.optional(v.number()) })),
  filename: v.optional(v.string()),
  headers: v.optional(v.array(v.object({ name: v.string(), value: v.string() }))),
  mimeType: v.optional(v.string()),
  parts: v.optional(v.array(v.lazy(() => partSchema))),
})

const apiMessageSchema = v.object({
  id: v.string(),
  internalDate: v.optional(v.string()),
  labelIds: v.optional(v.array(v.string())),
  payload: v.optional(partSchema),
  snippet: v.optional(v.string()),
  threadId: v.string(),
})

const historyListSchema = v.object({
  history: v.optional(v.array(v.object({
    messagesAdded: v.optional(v.array(v.object({ message: v.object({ id: v.string(), labelIds: v.optional(v.array(v.string())) }) }))),
  }))),
  historyId: v.string(),
  nextPageToken: v.optional(v.string()),
})

const messageListSchema = v.object({
  messages: v.optional(v.array(v.object({ id: v.string() }))),
  nextPageToken: v.optional(v.string()),
})

const labelColorSchema = v.object({ backgroundColor: v.string(), textColor: v.string() })

const labelSchema = v.object({
  color: v.optional(labelColorSchema),
  id: v.string(),
  labelListVisibility: v.optional(v.string()),
  messageListVisibility: v.optional(v.string()),
  name: v.string(),
  type: v.optional(v.string()),
})

const labelListSchema = v.object({ labels: v.optional(v.array(labelSchema)) })
const profileSchema = v.object({ emailAddress: v.string(), historyId: v.string() })
const watchSchema = v.object({ expiration: v.string(), historyId: v.string() })
const threadSchema = v.object({ id: v.string(), messages: v.optional(v.array(apiMessageSchema)) })
const tokenSchema = v.object({ access_token: v.string(), expires_in: v.optional(v.number()) })

type GmailApiLabel = v.InferOutput<typeof labelSchema>

/** Gmail label color. Gmail accepts only colors from its label palette. */
export interface GmailLabelColor {
  backgroundColor: string
  textColor: string
}

export interface GmailLabelSettings {
  color?: GmailLabelColor
  /** What the label means. The Channel adds it to the Agent instructions; Gmail does not store it. */
  description?: string
}

/** One Gmail message: the `received` trigger input, the history item, and `event.message.data`. */
export interface GmailMessage {
  attachments: { attachmentId?: string, filename: string, mimeType: string, size: number }[]
  /** Plain-text body, decoded and capped at the Channel's `bodyLimit`. HTML-only mail is converted to text. */
  body: string
  cc: string[]
  /** ISO 8601 time when Gmail received the message. */
  date: string
  from: string
  /** Message headers by lowercase name. The first value wins; transport headers are omitted. */
  headers: Record<string, string>
  id: string
  labelIds: string[]
  snippet: string
  subject: string
  threadId: string
  to: string[]
}

export const gmailMessageSchema: v.GenericSchema<GmailMessage> = v.object({
  attachments: v.array(v.object({
    attachmentId: v.optional(v.string()),
    filename: v.string(),
    mimeType: v.string(),
    size: v.number(),
  })),
  body: v.string(),
  cc: v.array(v.string()),
  date: v.string(),
  from: v.string(),
  headers: v.record(v.string(), v.string()),
  id: v.string(),
  labelIds: v.array(v.string()),
  snippet: v.string(),
  subject: v.string(),
  threadId: v.string(),
  to: v.array(v.string()),
})

export function gmailErrorStatus(error: unknown): number | undefined {
  return isRuntimeRecord(error) && hasRuntimeType(error.status, "number") ? error.status : undefined
}

function withTimeout(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(requestTimeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

async function responseJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return undefined
  try {
    return JSON.parse(text)
  }
  catch {
    return undefined
  }
}

function googleErrorMessage(body: unknown): string | undefined {
  if (!isRuntimeRecord(body)) return
  if (hasRuntimeType(body.error_description, "string")) return body.error_description
  if (hasRuntimeType(body.error, "string")) return body.error
  if (isRuntimeRecord(body.error) && hasRuntimeType(body.error.message, "string")) return body.error.message
}

export interface GmailOAuthCredentials {
  clientId: string
  clientSecret: string
  refreshToken: string
}

// Access tokens stay in process memory. They are not written to the State Adapter.
const accessTokens = new Map<string, { expiresAt: number, token: Promise<string> }>()
const oauthClients = new Map<string, GmailClient>()

async function refreshAccessToken(credentials: GmailOAuthCredentials, fetchImpl: typeof fetch): Promise<string> {
  const response = await fetchImpl(googleTokenUrl, {
    body: new URLSearchParams({
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      grant_type: "refresh_token",
      refresh_token: credentials.refreshToken,
    }),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    method: "POST",
    signal: withTimeout(),
  })
  const body = await responseJson(response)
  const parsed = v.safeParse(tokenSchema, body)
  if (!response.ok || !parsed.success) {
    const reason = googleErrorMessage(body)
    throw new GmailApiError(`Google OAuth token refresh failed with HTTP ${response.status}${reason ? `: ${reason}` : ""}.`, response.status)
  }
  return parsed.output.access_token
}

function accessToken(credentials: GmailOAuthCredentials, fetchImpl: typeof fetch, cacheKey: string, refresh: boolean): Promise<string> {
  const cached = accessTokens.get(cacheKey)
  if (cached && !refresh && cached.expiresAt > Date.now()) return cached.token
  // Google access tokens last one hour. Refresh a minute early.
  const token = refreshAccessToken(credentials, fetchImpl)
  accessTokens.set(cacheKey, { expiresAt: Date.now() + 59 * 60_000, token })
  token.catch(() => {
    if (accessTokens.get(cacheKey)?.token === token) accessTokens.delete(cacheKey)
  })
  return token
}

function requestUrl(request: GmailRequest): string {
  const url = new URL(request.path.replace(/^\/+/, ""), gmailApiBaseUrl)
  for (const [name, value] of Object.entries(request.query || {})) {
    if (value === undefined) continue
    if (hasRuntimeType(value, "string") || hasRuntimeType(value, "number")) url.searchParams.append(name, String(value))
    else for (const item of value) url.searchParams.append(name, item)
  }
  return url.toString()
}

/**
 * Gmail client that authenticates with a Google OAuth refresh token and calls Gmail REST over `fetch`.
 * It runs on Node.js, Cloudflare Workers, and Vercel.
 */
export function createGmailOAuthClient(credentials: GmailOAuthCredentials, fetchImpl: typeof fetch = globalThis.fetch): GmailClient {
  const cacheKey = JSON.stringify([credentials.clientId, credentials.clientSecret, credentials.refreshToken])
  const reuse = fetchImpl === globalThis.fetch ? oauthClients.get(cacheKey) : undefined
  if (reuse) return reuse
  const client: GmailClient = async (request) => {
    const send = async (refresh: boolean) => await fetchImpl(requestUrl(request), {
      ...(request.body ? { body: JSON.stringify(request.body) } : {}),
      headers: {
        authorization: `Bearer ${await accessToken(credentials, fetchImpl, cacheKey, refresh)}`,
        ...(request.body ? { "content-type": "application/json" } : {}),
      },
      method: request.method,
      signal: withTimeout(),
    })
    let response = await send(false)
    // A revoked or expired access token gets one refresh.
    if (response.status === 401) response = await send(true)
    const body = await responseJson(response)
    if (!response.ok) {
      const reason = googleErrorMessage(body)
      throw new GmailApiError(`Gmail ${request.method} ${request.path.split("?")[0]} failed with HTTP ${response.status}${reason ? `: ${reason}` : ""}.`, response.status)
    }
    return body
  }
  if (fetchImpl === globalThis.fetch) oauthClients.set(cacheKey, client)
  return client
}

/** Resolves the Gmail client from Channel options or the OAuth settings. */
export function gmailClientFromSettings(settings: GmailSettings, fetchImpl?: typeof fetch): GmailClient {
  const { clientId, clientSecret, refreshToken } = settings
  if (!clientId || !clientSecret || !refreshToken) {
    const missing = (["clientId", "clientSecret", "refreshToken"] as const).filter(key => !settings[key]).map(key => gmailEnvNames[key])
    throw agentDiagnostics.AGENT_R0937({ message: `[vitehub] The Gmail Channel needs Google OAuth credentials. Set ${missing.join(", ")}, declare them in Server Env gmail, or pass gmail({ client }).` })
  }
  return createGmailOAuthClient({ clientId, clientSecret, refreshToken }, fetchImpl)
}

async function gmailRequest<TSchema extends v.GenericSchema>(client: GmailClient, schema: TSchema, request: GmailRequest): Promise<v.InferOutput<TSchema>> {
  const body = await client(request)
  const parsed = v.safeParse(schema, body)
  if (!parsed.success) {
    throw agentDiagnostics.AGENT_R0938({ message: `[vitehub] Gmail ${request.method} ${request.path} returned an unexpected response: ${v.summarize(parsed.issues)}` })
  }
  return parsed.output
}

// Message mapping

function decodeBase64UrlBytes(data: string): Uint8Array {
  const base64 = data.replaceAll("-", "+").replaceAll("_", "/")
  const binary = atob(base64.padEnd(base64.length + (4 - base64.length % 4) % 4, "="))
  return Uint8Array.from(binary, character => character.charCodeAt(0))
}

function decodeBase64Url(data: string): string {
  return new TextDecoder().decode(decodeBase64UrlBytes(data))
}

function flattenParts(part: GmailApiPart | undefined, excludeAttachments = false, parts: GmailApiPart[] = []): GmailApiPart[] {
  if (!part) return parts
  const disposition = part.headers?.find(header => header.name.toLowerCase() === "content-disposition")?.value
  if (excludeAttachments && (part.filename || /^\s*attachment(?:\s*;|\s*$)/i.test(disposition ?? ""))) return parts
  parts.push(part)
  for (const child of part.parts || []) flattenParts(child, excludeAttachments, parts)
  return parts
}

const htmlEntities: Record<string, string> = { amp: "&", gt: ">", lt: "<", nbsp: " ", quot: "\"", "#39": "'" }

function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(amp|gt|lt|nbsp|quot|#39);/g, (_match, entity: string) => htmlEntities[entity] ?? " ")
}

function messageBodyPart(parts: GmailApiPart[]): GmailApiPart | undefined {
  const candidates = parts.filter(part => !part.filename && (part.body?.data || part.body?.attachmentId))
  return candidates.find(part => part.mimeType === "text/plain") ?? candidates.find(part => part.mimeType === "text/html")
}

const latin1Charsets = new Set(["iso-8859-1", "iso_8859-1", "iso_8859-1:1987", "iso-ir-100", "latin1", "l1", "ibm819", "cp819", "csisolatin1"])
// ISO-2022-KR is a historical MIME label but is not part of the Encoding Standard.
// Some runtimes still accept it in TextDecoder, so reject it explicitly and keep
// the documented UTF-8 fallback consistent across hosts.
const unsupportedMimeCharsets = new Set(["iso-2022-kr"])

function decodeMimeBody(data: string, charset: string | undefined): string {
  const bytes = decodeBase64UrlBytes(data)
  const normalizedCharset = charset?.trim().toLowerCase()
  if (normalizedCharset && unsupportedMimeCharsets.has(normalizedCharset)) return new TextDecoder().decode(bytes)
  // MIME ISO-8859-1 keeps C1 bytes; TextDecoder aliases it to Windows-1252.
  if (normalizedCharset && latin1Charsets.has(normalizedCharset)) {
    let text = ""
    for (let start = 0; start < bytes.length; start += 8192) text += String.fromCharCode(...bytes.subarray(start, start + 8192))
    return text
  }
  let decoder = new TextDecoder()
  try {
    if (charset) decoder = new TextDecoder(charset)
  }
  catch {
    // Untrusted MIME labels outside this host's Encoding Standard support keep UTF-8 replacement decoding.
  }
  return decoder.decode(bytes)
}

function bodyText(parts: GmailApiPart[], limit: number): string {
  const part = messageBodyPart(parts)
  const data = part?.body?.data
  const contentType = part?.headers?.find(header => header.name.toLowerCase() === "content-type")?.value
  const charset = contentType?.match(/;\s*charset\s*=\s*(?:"([^"\r\n]+)"|([^;\s]+))/i)
  const decoded = data ? decodeMimeBody(data, charset?.[1] || charset?.[2]) : ""
  return (part?.mimeType === "text/html" ? htmlToText(decoded) : decoded)
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, limit)
}

// Headers that describe transport, not the message. They are long and repeat.
const omittedHeaders = new Set([
  "arc-authentication-results",
  "arc-message-signature",
  "arc-seal",
  "authentication-results",
  "dkim-signature",
  "received",
  "received-spf",
  "x-gm-message-state",
  "x-google-dkim-signature",
  "x-google-smtp-source",
  "x-received",
])

function headerMap(parts: GmailApiPart[]): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const { name, value } of parts[0]?.headers || []) {
    const key = name.toLowerCase()
    if (omittedHeaders.has(key) || Object.hasOwn(headers, key)) continue
    headers[key] = value
  }
  return headers
}

/** Splits an address list header at commas outside quotes, comments, and angle brackets. */
export function splitAddresses(value: string | undefined): string[] {
  if (!value) return []
  const addresses: string[] = []
  let current = ""
  let quoted = false
  let escaped = false
  let comments = 0
  let angle = 0
  for (const character of value) {
    if ((quoted || comments > 0) && escaped) {
      current += character
      escaped = false
      continue
    }
    if ((quoted || comments > 0) && character === "\\") {
      current += character
      escaped = true
      continue
    }
    if (!quoted && character === "(") {
      comments++
      current += character
      continue
    }
    if (comments > 0) {
      if (character === ")") comments--
      current += character
      continue
    }
    if (character === "\"") quoted = !quoted
    else if (!quoted && character === "<") angle += 1
    else if (!quoted && character === ">") angle = Math.max(0, angle - 1)
    if (character === "," && !quoted && angle === 0) {
      if (current.trim()) addresses.push(current.trim())
      current = ""
      continue
    }
    current += character
  }
  if (current.trim()) addresses.push(current.trim())
  return addresses
}

function messageDate(internalDate: string | undefined, header: string | undefined): string {
  const received = internalDate ? new Date(Number(internalDate)) : undefined
  if (received && !Number.isNaN(received.getTime())) return received.toISOString()
  const sent = header ? new Date(header) : undefined
  return sent && !Number.isNaN(sent.getTime()) ? sent.toISOString() : ""
}

async function toGmailMessage(client: GmailClient, message: v.InferOutput<typeof apiMessageSchema>, bodyLimit: number): Promise<GmailMessage> {
  const parts = flattenParts(message.payload)
  const bodyParts = flattenParts(message.payload, true)
  const part = messageBodyPart(bodyParts)
  if (!part?.body?.data && part?.body?.attachmentId) {
    const attachment = await gmailRequest(client, v.object({ data: v.string() }), { method: "GET", path: `messages/${encodeURIComponent(message.id)}/attachments/${encodeURIComponent(part.body.attachmentId)}` })
    part.body.data = attachment.data
  }
  const rawHeaders = headerMap(parts)
  const headers = Object.fromEntries(Object.entries(rawHeaders).map(([name, value]) => [name, value.slice(0, 1_000)]))
  return {
    attachments: parts.flatMap(part => part.filename
      ? [{ attachmentId: part.body?.attachmentId, filename: part.filename, mimeType: part.mimeType || "application/octet-stream", size: part.body?.size ?? 0 }]
      : []),
    body: bodyText(bodyParts, bodyLimit),
    cc: splitAddresses(rawHeaders.cc),
    date: messageDate(message.internalDate, headers.date),
    from: rawHeaders.from ?? "",
    headers,
    id: message.id,
    labelIds: message.labelIds || [],
    snippet: message.snippet ?? "",
    subject: rawHeaders.subject ?? "",
    threadId: message.threadId,
    to: splitAddresses(rawHeaders.to),
  }
}

/** Reads one message. Returns `undefined` when Gmail no longer has it. */
export async function getGmailMessage(client: GmailClient, id: string, bodyLimit: number): Promise<GmailMessage | undefined> {
  let message: v.InferOutput<typeof apiMessageSchema>
  try {
    message = await gmailRequest(client, apiMessageSchema, { method: "GET", path: `messages/${encodeURIComponent(id)}`, query: { format: "full" } })
  }
  catch (error) {
    if (gmailErrorStatus(error) === 404) return undefined
    throw error
  }
  return await toGmailMessage(client, message, bodyLimit)
}

/** History labels can be stale. Read current labels without downloading a non-Inbox body. */
async function getGmailInboxMessage(client: GmailClient, id: string, bodyLimit: number): Promise<GmailMessage | undefined> {
  let metadata: { labelIds?: string[] }
  try {
    metadata = await gmailRequest(client, v.object({ labelIds: v.optional(v.array(v.string())) }), {
      method: "GET", path: `messages/${encodeURIComponent(id)}`, query: { format: "minimal" },
    })
  }
  catch (error) {
    if (gmailErrorStatus(error) === 404) return undefined
    throw error
  }
  return metadata.labelIds?.includes("INBOX") ? await getGmailMessage(client, id, bodyLimit) : undefined
}

/** Reads messages in order with bounded concurrency. Deleted messages are skipped. */
export async function getGmailMessages(client: GmailClient, ids: readonly string[], bodyLimit: number): Promise<GmailMessage[]> {
  const messages: (GmailMessage | undefined)[] = []
  for (let start = 0; start < ids.length; start += messageFetchConcurrency) {
    messages.push(...await Promise.all(ids.slice(start, start + messageFetchConcurrency).map(id => getGmailMessage(client, id, bodyLimit))))
  }
  return messages.filter(message => message !== undefined)
}

export async function getGmailThread(client: GmailClient, threadId: string, bodyLimit: number): Promise<GmailMessage[]> {
  const thread = await gmailRequest(client, threadSchema, { method: "GET", path: `threads/${encodeURIComponent(threadId)}`, query: { format: "full" } })
  const messages = thread.messages || []
  const result: GmailMessage[] = []
  for (let start = 0; start < messages.length; start += messageFetchConcurrency) {
    result.push(...await Promise.all(messages.slice(start, start + messageFetchConcurrency).map(message => toGmailMessage(client, message, bodyLimit))))
  }
  return result
}

/** Formats a message as the default Invocation prompt. */
export function gmailMessagePrompt(message: GmailMessage): string {
  const lines = [
    `From: ${message.from}`,
    `To: ${message.to.join(", ")}`,
    ...(message.cc.length ? [`Cc: ${message.cc.join(", ")}`] : []),
    `Subject: ${message.subject}`,
    ...(message.date ? [`Date: ${message.date}`] : []),
    ...(message.labelIds.length ? [`Labels: ${message.labelIds.join(", ")}`] : []),
    ...(message.attachments.length
      ? [`Attachments: ${message.attachments.map(attachment => `${attachment.filename} (${attachment.mimeType}, ${attachment.size} bytes)`).join(", ")}`]
      : []),
  ]
  return `${lines.join("\n")}\n\n${message.body || message.snippet}`
}

// Labels

const labelCaches = new WeakMap<GmailClient, { fetchedAt: number, labels: GmailApiLabel[] }>()

async function listLabels(client: GmailClient, refresh = false): Promise<GmailApiLabel[]> {
  const cached = labelCaches.get(client)
  if (cached && !refresh && Date.now() - cached.fetchedAt < labelCacheMs) return cached.labels
  const labels = (await gmailRequest(client, labelListSchema, { method: "GET", path: "labels" })).labels || []
  labelCaches.set(client, { fetchedAt: Date.now(), labels })
  return labels
}

function labelBody(name: string, settings: GmailLabelSettings | undefined) {
  return {
    ...(settings?.color ? { color: settings.color } : {}),
    labelListVisibility: "labelShow",
    messageListVisibility: "show",
    name,
  }
}

async function createLabel(client: GmailClient, name: string, settings: GmailLabelSettings | undefined): Promise<GmailApiLabel> {
  try {
    const label = await gmailRequest(client, labelSchema, { body: labelBody(name, settings), method: "POST", path: "labels" })
    labelCaches.delete(client)
    return label
  }
  catch (error) {
    // Another process created the label first.
    if (gmailErrorStatus(error) !== 409) throw error
    const existing = (await listLabels(client, true)).find(label => label.name === name)
    if (!existing) throw error
    return existing
  }
}

/**
 * Maps label names to IDs. System labels such as `INBOX` and `STARRED` and existing label IDs pass through.
 * A missing label is created only when `labels` declares it.
 */
export async function gmailLabelIds(client: GmailClient, names: readonly string[], declared: Record<string, GmailLabelSettings>): Promise<string[]> {
  const ids: string[] = []
  for (const name of names) {
    const find = (labels: GmailApiLabel[]) => labels.find(label => label.name === name) ?? labels.find(label => label.id === name)
    let label = find(await listLabels(client))
    label ??= find(await listLabels(client, true))
    if (!label && Object.hasOwn(declared, name)) label = await createLabel(client, name, declared[name])
    if (!label) {
      throw agentDiagnostics.AGENT_R0940({ message: `[vitehub] Gmail label "${name}" does not exist. Declare it in gmail({ labels }) or create it in Gmail.` })
    }
    ids.push(label.id)
  }
  return ids
}

export interface GmailModifyInput {
  addLabels?: readonly string[]
  removeLabels?: readonly string[]
}

export async function modifyGmailMessage(client: GmailClient, id: string, input: GmailModifyInput, declared: Record<string, GmailLabelSettings>): Promise<void> {
  const [addLabelIds, removeLabelIds] = await Promise.all([
    gmailLabelIds(client, input.addLabels || [], declared),
    gmailLabelIds(client, input.removeLabels || [], declared),
  ])
  if (!addLabelIds.length && !removeLabelIds.length) return
  await client({ body: { addLabelIds, removeLabelIds }, method: "POST", path: `messages/${encodeURIComponent(id)}/modify` })
}

export async function trashGmailMessage(client: GmailClient, id: string): Promise<void> {
  await client({ method: "POST", path: `messages/${encodeURIComponent(id)}/trash` })
}

// Pub/Sub push authentication

const jwkSchema = v.object({ e: v.string(), kid: v.string(), kty: v.literal("RSA"), n: v.string() })
const jwksSchema = v.object({ keys: v.array(v.looseObject({ kid: v.optional(v.string()), kty: v.optional(v.string()) })) })
const jwtHeaderSchema = v.object({ alg: v.string(), kid: v.optional(v.string()) })
const oidcClaimsSchema = v.object({
  aud: v.union([v.string(), v.array(v.string())]),
  email: v.optional(v.string()),
  email_verified: v.optional(v.boolean()),
  exp: v.number(),
  iat: v.optional(v.number()),
  iss: v.string(),
})

type GoogleJwk = v.InferOutput<typeof jwkSchema>

const googleKeyCaches = new WeakMap<typeof fetch, { expiresAt: number, fetchedAt: number, keys: GoogleJwk[] }>()

async function googleKeys(fetchImpl: typeof fetch, refresh: boolean): Promise<GoogleJwk[]> {
  const cached = googleKeyCaches.get(fetchImpl)
  // Refetch for an unknown key at most once a minute, so forged key IDs cannot flood Google.
  if (cached && (refresh ? Date.now() - cached.fetchedAt < 60_000 : cached.expiresAt > Date.now())) return cached.keys
  const response = await fetchImpl(googleCertsUrl, { signal: withTimeout() })
  const body = await responseJson(response)
  const parsed = v.safeParse(jwksSchema, body)
  if (!response.ok || !parsed.success) throw new GmailApiError(`Google OAuth certificates request failed with HTTP ${response.status}.`, response.status)
  const keys = parsed.output.keys.flatMap((key) => {
    const jwk = v.safeParse(jwkSchema, key)
    return jwk.success ? [jwk.output] : []
  })
  const maxAge = Number(/max-age=(\d+)/.exec(response.headers.get("cache-control") || "")?.[1] || 3600)
  googleKeyCaches.set(fetchImpl, { expiresAt: Date.now() + maxAge * 1000, fetchedAt: Date.now(), keys })
  return keys
}

function jsonSegment(segment: string): unknown {
  try {
    return JSON.parse(decodeBase64Url(segment))
  }
  catch {
    return undefined
  }
}

function base64UrlBytes(segment: string): Uint8Array<ArrayBuffer> {
  const base64 = segment.replaceAll("-", "+").replaceAll("_", "/")
  const binary = atob(base64.padEnd(base64.length + (4 - base64.length % 4) % 4, "="))
  return Uint8Array.from(binary, character => character.charCodeAt(0))
}

export interface GoogleOidcExpectation {
  audience: string
  fetch: typeof fetch
  serviceAccount: string
}

/**
 * Verifies the Google-signed OIDC token that Pub/Sub sends with a push request:
 * RS256 signature, issuer, audience, expiry, and the verified service account email.
 * Returns the reason when the token is not accepted.
 */
export async function verifyGoogleOidcToken(token: string, expected: GoogleOidcExpectation): Promise<string | undefined> {
  const [headerSegment, claimsSegment, signatureSegment, extra] = token.split(".")
  if (!headerSegment || !claimsSegment || !signatureSegment || extra !== undefined) return "malformed token"
  const header = v.safeParse(jwtHeaderSchema, jsonSegment(headerSegment))
  const claims = v.safeParse(oidcClaimsSchema, jsonSegment(claimsSegment))
  if (!header.success || !claims.success) return "malformed token"
  if (header.output.alg !== "RS256" || !header.output.kid) return "unsupported token algorithm"
  const kid = header.output.kid
  let key = (await googleKeys(expected.fetch, false)).find(candidate => candidate.kid === kid)
  key ??= (await googleKeys(expected.fetch, true)).find(candidate => candidate.kid === kid)
  if (!key) return "unknown signing key"
  let signature: Uint8Array<ArrayBuffer>
  try {
    signature = base64UrlBytes(signatureSegment)
  }
  catch {
    return "malformed token"
  }
  const cryptoKey = await crypto.subtle.importKey(
    "jwk",
    { alg: "RS256", e: key.e, ext: true, kty: "RSA", n: key.n },
    { hash: "SHA-256", name: "RSASSA-PKCS1-v1_5" },
    false,
    ["verify"],
  )
  const signed = new TextEncoder().encode(`${headerSegment}.${claimsSegment}`)
  if (!await crypto.subtle.verify("RSASSA-PKCS1-v1_5", cryptoKey, signature, signed)) return "invalid signature"
  const { aud, email, email_verified: emailVerified, exp, iat, iss } = claims.output
  const now = Date.now()
  if (!googleIssuers.has(iss)) return "unexpected issuer"
  if (!(Array.isArray(aud) ? aud.includes(expected.audience) : aud === expected.audience)) return "unexpected audience"
  if (exp * 1000 <= now - clockSkewMs) return "expired token"
  if (iat !== undefined && iat * 1000 > now + clockSkewMs) return "token issued in the future"
  if (email !== expected.serviceAccount || emailVerified !== true) return "unexpected service account"
}

const pushInputSchema = v.object({
  payload: v.optional(v.unknown()),
  request: v.object({ headers: v.record(v.string(), v.string()) }),
})
const pushBodySchema = v.object({
  message: v.object({ data: v.string() }),
  subscription: v.string(),
})
const notificationSchema = v.object({
  emailAddress: v.string(),
  historyId: v.pipe(v.union([v.string(), v.number()]), v.transform(String), v.regex(/^\d+$/)),
})

export type GmailPushResult =
  | { emailAddress: string, historyId: string, ok: true }
  | { ok: false, reason: string, status: 400 | 401 | 503 }

/** Authenticates a Pub/Sub push request and reads the Gmail notification from it. */
export async function readGmailPush(input: unknown, settings: GmailSettings, fetchImpl: typeof fetch): Promise<GmailPushResult> {
  const { pubsubAudience: audience, pubsubServiceAccount: serviceAccount, pubsubSubscription: subscription } = settings
  if (!audience || !serviceAccount || !subscription) {
    return { ok: false, reason: `Gmail push needs ${gmailEnvNames.pubsubAudience}, ${gmailEnvNames.pubsubServiceAccount}, and ${gmailEnvNames.pubsubSubscription}.`, status: 503 }
  }
  const parsed = v.safeParse(pushInputSchema, input)
  if (!parsed.success) return { ok: false, reason: "Invalid Pub/Sub push request.", status: 400 }
  const token = /^Bearer (\S+)$/i.exec(parsed.output.request.headers.authorization || "")?.[1]
  if (!token) return { ok: false, reason: "Missing Pub/Sub OIDC token.", status: 401 }
  const rejected = await verifyGoogleOidcToken(token, { audience, fetch: fetchImpl, serviceAccount })
  if (rejected) return { ok: false, reason: `Invalid Pub/Sub OIDC token: ${rejected}.`, status: 401 }
  const body = v.safeParse(pushBodySchema, parsed.output.payload)
  if (!body.success || body.output.subscription !== subscription) return { ok: false, reason: "Unexpected Pub/Sub subscription.", status: 400 }
  let notification: unknown
  try {
    notification = JSON.parse(decodeBase64Url(body.output.message.data))
  }
  catch {
    return { ok: false, reason: "Invalid Gmail notification.", status: 400 }
  }
  const parsedNotification = v.safeParse(notificationSchema, notification)
  if (!parsedNotification.success) return { ok: false, reason: "Invalid Gmail notification.", status: 400 }
  return { emailAddress: parsedNotification.output.emailAddress, historyId: parsedNotification.output.historyId, ok: true }
}

// Mailbox synchronization

function log(event: string, details: Record<string, unknown>): void {
  console.info(JSON.stringify({ event, scope: "vitehub.channel.gmail", ...details }))
}

export async function listGmailMessageIds(
  client: GmailClient,
  options: { includeSpamTrash?: boolean, labelIds?: readonly string[], limit: number, pageToken?: string, query?: string },
): Promise<{ ids: string[], nextPageToken?: string }> {
  const page = await gmailRequest(client, messageListSchema, {
    method: "GET",
    path: "messages",
    query: { includeSpamTrash: options.includeSpamTrash ? "true" : undefined, labelIds: options.labelIds, maxResults: options.limit, pageToken: options.pageToken, q: options.query },
  })
  return { ids: (page.messages || []).map(message => message.id), ...(page.nextPageToken ? { nextPageToken: page.nextPageToken } : {}) }
}

export interface GmailMailboxSync {
  bodyLimit: number
  client: GmailClient
  /** Starts one Invocation per message with a stable Invocation ID. */
  dispatch: (messages: GmailMessage[]) => Promise<ReplayChannelResult>
  /** History ID from the push notification. The first notification starts the cursor at it. */
  notificationHistoryId: string
  state: AgentChannelStateBinding
  /** Pub/Sub topic of the watch. The sync renews the watch when it expires within a day. */
  topic?: string
}

export async function gmailMailboxAddress(client: GmailClient): Promise<string> {
  return (await gmailRequest(client, profileSchema, { method: "GET", path: "profile" })).emailAddress
}

interface GmailSyncProgress {
  startHistoryId: string
  historyId: string
  mode: "history" | "recovery"
  query?: string
  pageToken?: string
  nextPageToken?: string
  pageLoaded: boolean
  done: boolean
  pendingIds: string[]
  retryIds: string[]
}

async function syncMailboxOnce(sync: GmailMailboxSync, cursorKey: string, renew: () => Promise<void>, mutate: (mutations: readonly AgentStateCacheMutation[]) => Promise<void>): Promise<boolean> {
  const { client, state } = sync
  const progressKey = `${state.keyPrefix}sync-progress`
  // Keep the growing deduplication snapshot separate from per-message checkpoints.
  const seenKey = `${state.keyPrefix}sync-seen-ids`
  const cursor = await state.state.get<string>(cursorKey)
  if (!cursor) {
    await renew()
    await mutate([
      { key: cursorKey, type: "set", value: sync.notificationHistoryId },
      { key: progressKey, type: "delete" },
      { key: seenKey, type: "delete" },
    ])
    log("cursor.initialized", { historyId: sync.notificationHistoryId })
    return false
  }
  const stored = await state.state.get<GmailSyncProgress>(progressKey)
  const resumable = stored?.startHistoryId === cursor
  let progress: GmailSyncProgress = resumable ? stored : {
    startHistoryId: cursor, historyId: cursor, mode: "history", pageLoaded: false, done: false, pendingIds: [], retryIds: [],
  }
  const seen = new Set(resumable ? await state.state.get<string[]>(seenKey) ?? [] : [])
  const save = async (next: GmailSyncProgress, saveSeen = false): Promise<void> => {
    await renew()
    await mutate([
      { key: progressKey, type: "set", value: next },
      ...(saveSeen ? [{ key: seenKey, type: "set" as const, value: [...seen] }] : []),
    ])
    progress = next
  }
  if (!resumable) await save(progress, true)
  let restartedPageToken = false
  const restartExpiredPageToken = async (error: unknown): Promise<boolean> => {
    if (gmailErrorStatus(error) !== 400 || !progress.pageToken || restartedPageToken) return false
    restartedPageToken = true
    await save({ ...progress, pageToken: undefined, nextPageToken: undefined })
    return true
  }

  const dispatchMessageIds = async (ids: readonly string[], retrying = false): Promise<void> => {
    for (let start = 0; start < ids.length; start += messageFetchConcurrency) {
      await renew()
      const batch = ids.slice(start, start + messageFetchConcurrency)
      const fetched = retrying
        ? await getGmailMessages(client, batch, sync.bodyLimit)
        : (await Promise.all(batch.map(id => getGmailInboxMessage(client, id, sync.bodyLimit)))).filter(message => message !== undefined)
      const messages = new Map(fetched.map(message => [message.id, message]))
      for (const id of batch) {
        const message = messages.get(id)
        let failed = false
        if (message && (retrying || message.labelIds.includes("INBOX"))) {
          await renew()
          const result = await sync.dispatch([message])
          log("messages.dispatched", { failed: result.failed, processed: result.processed, skipped: result.skipped })
          failed = result.failed > 0
        }
        await save({
          ...progress,
          pendingIds: progress.pendingIds.filter(pending => pending !== id),
          retryIds: failed ? [...new Set([...progress.retryIds, id])] : progress.retryIds.filter(retry => retry !== id),
        })
      }
    }
  }
  // Only failures from an earlier attempt are retried in this pass.
  await dispatchMessageIds(progress.retryIds, true)
  while (!progress.done) {
    if (!progress.pageLoaded) {
      await renew()
      let ids: string[]
      let nextPageToken: string | undefined
      let historyId = progress.historyId
      if (progress.mode === "history") {
        // Only an expired history request triggers recovery, not a dispatch failure.
        const page = await gmailRequest(client, historyListSchema, {
          method: "GET", path: "history",
          query: { historyTypes: "messageAdded", pageToken: progress.pageToken, startHistoryId: cursor },
        }).catch(async (error: unknown) => {
          if (await restartExpiredPageToken(error)) return null
          if (gmailErrorStatus(error) !== 404) throw error
          return undefined
        })
        if (page === null) continue
        if (!page) {
          const profile = await gmailRequest(client, profileSchema, { method: "GET", path: "profile" })
          // Handler label changes must not remove messages from the paginated search.
          await save({
            ...progress, mode: "recovery", historyId: profile.historyId,
            query: `after:${Math.floor((Date.now() - 2 * 24 * 60 * 60 * 1000) / 1000)}`,
            pageToken: undefined, nextPageToken: undefined,
          })
          continue
        }
        ids = (page.history || []).flatMap(entry => (entry.messagesAdded || []).map(({ message }) => message.id))
        nextPageToken = page.nextPageToken
        historyId = page.historyId
      } else {
        const page = await listGmailMessageIds(client, {
          includeSpamTrash: true, limit: 100, query: progress.query, pageToken: progress.pageToken,
        }).catch(async (error: unknown) => {
          if (await restartExpiredPageToken(error)) return undefined
          throw error
        })
        if (!page) continue
        ids = page.ids
        nextPageToken = page.nextPageToken
      }
      const pendingIds = ids.filter(id => {
        if (seen.has(id)) return false
        seen.add(id)
        return true
      })
      // Save enumeration before body fetches, which can exceed one worker's time window.
      await save({ ...progress, historyId, nextPageToken, pendingIds, pageLoaded: true }, true)
    }
    await dispatchMessageIds(progress.pendingIds)
    await save({ ...progress, pageToken: progress.nextPageToken, nextPageToken: undefined, pageLoaded: false, done: !progress.nextPageToken })
  }
  if (progress.retryIds.length) return false
  if (progress.mode === "recovery") log("history.expired", { historyId: cursor, recovered: seen.size })
  // Completion and checkpoint cleanup commit only while this worker owns the mailbox lease.
  await renew()
  await mutate([
    { key: cursorKey, type: "set", value: progress.historyId },
    { key: progressKey, type: "delete" },
    { key: seenKey, type: "delete" },
  ])
  return resumable
}

/**
 * Reads new Inbox messages since the stored history cursor and dispatches them.
 * One process holds the mailbox lock. A notification that arrives during a sync marks it pending,
 * and the lock holder runs once more, so overlapping notifications never read the same history twice.
 */
export async function syncGmailMailbox(sync: GmailMailboxSync): Promise<void> {
  const keyPrefix = sync.state.keyPrefix
  const atomic = requireAtomicAgentStateLock(sync.state.state)
  const state = requireAtomicAgentStateLock(atomic.forCacheLocks?.() ?? atomic)
  sync = { ...sync, state: { keyPrefix, state } }
  const cursorKey = `${keyPrefix}history-id`
  const lockKey = `${keyPrefix}sync`
  const pendingKey = `${keyPrefix}sync-pending`
  let lock = await state.acquireLock(lockKey, syncLockTtlMs)
  if (!lock) {
    await state.set(pendingKey, true)
    // The holder may have released the lock before it saw the pending mark.
    lock = await state.acquireLock(lockKey, syncLockTtlMs)
    if (!lock) return
  }
  const failures: unknown[] = []
  for (;;) {
    const heldLock = lock
    let ownershipLost = false
    const renew = async () => {
      if (ownershipLost || !await state.extendLock(heldLock, syncLockTtlMs)) {
        ownershipLost = true
        throw new Error("Lost ownership of the Gmail mailbox lease.")
      }
    }
    const mutate = async (mutations: readonly AgentStateCacheMutation[]) => {
      if (ownershipLost || !await state.mutateWithLock(heldLock, mutations)) {
        ownershipLost = true
        throw new Error("Lost ownership of the Gmail mailbox lease.")
      }
    }
    let renewalTask = Promise.resolve()
    const timer = setInterval(() => {
      renewalTask = renewalTask.then(renew).catch(() => { ownershipLost = true })
    }, syncLockTtlMs / 3)
    try {
      let resumedSnapshot = false
      do {
        await renew()
        await mutate([{ key: pendingKey, type: "delete" }])
        resumedSnapshot = await syncMailboxOnce(sync, cursorKey, renew, mutate)
      } while (resumedSnapshot || await state.get(pendingKey) !== null)
    }
    catch (error) {
      failures.push(error)
    }
    finally {
      clearInterval(timer)
      await renewalTask
      await state.releaseLock(heldLock)
    }
    if (await state.get(pendingKey) === null) break
    lock = await state.acquireLock(lockKey, syncLockTtlMs)
    if (!lock) break
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, "Gmail mailbox synchronization failed while draining pending notifications.")
  if (sync.topic) await renewGmailWatchWhenDue(sync.client, sync.state, sync.topic)
}

export async function startGmailWatch(client: GmailClient, topic: string): Promise<{ expiration: string, historyId: string }> {
  const watch = await gmailRequest(client, watchSchema, {
    body: { labelFilterBehavior: "include", labelIds: gmailWatchLabelIds, topicName: topic },
    method: "POST",
    path: "watch",
  })
  return { expiration: new Date(Number(watch.expiration)).toISOString(), historyId: watch.historyId }
}

/** Renews the Gmail watch when the stored expiration is less than a day away. */
export async function renewGmailWatchWhenDue(client: GmailClient, binding: AgentChannelStateBinding, topic: string): Promise<boolean> {
  const key = `${binding.keyPrefix}watch-expires-at`
  const expiresAt = await binding.state.get<string>(key)
  if (expiresAt && Date.parse(expiresAt) - Date.now() > watchRenewalMarginMs) return false
  const watch = await startGmailWatch(client, topic)
  await binding.state.set(key, watch.expiration)
  log("watch.renewed", { expiration: watch.expiration })
  return true
}

// History Collection

const historyQuerySchema = v.object({
  /** Gmail label IDs that every message must have. */
  labelIds: v.optional(v.array(v.string())),
  /** Gmail search query, such as `in:inbox newer_than:7d`. */
  query: v.optional(v.string(), "in:inbox"),
})

type GmailHistoryQuery = v.InferOutput<typeof historyQuerySchema>

class GmailHistoryCursorError extends Error {
  constructor() {
    super("Invalid Gmail page token.")
    // `replayChannel()` reports this name as an invalid history cursor.
    this.name = "CollectionCursorError"
  }
}

/** Past Gmail messages from `messages.list`. The cursor is Gmail's `nextPageToken`. */
export function gmailHistoryCollection(
  resolveClient: () => Promise<GmailClient>,
  bodyLimit: number,
): AgentChannelHistoryCollection<GmailMessage> {
  return {
    async page(options) {
      const query = v.parse(historyQuerySchema, options.query)
      const client = await resolveClient()
      let cursor = options.cursor
      while (true) {
        let page: { ids: string[], nextPageToken?: string }
        try {
          page = await listGmailMessageIds(client, {
            labelIds: query.labelIds,
            limit: Math.min(Math.max(options.limit ?? 50, 1), 100),
            ...(cursor ? { pageToken: cursor } : {}),
            query: query.query,
          })
        }
        catch (error) {
          if (cursor && gmailErrorStatus(error) === 400) throw new GmailHistoryCursorError()
          throw error
        }
        const items = await getGmailMessages(client, page.ids, bodyLimit)
        if (items.length || !page.nextPageToken) return { items, nextCursor: page.nextPageToken ?? null }
        cursor = page.nextPageToken
      }
    },
    async parseQuery(input: AgentChannelHistoryQuery): Promise<GmailHistoryQuery> {
      const labelIds = input.labelIds
      return v.parse(historyQuerySchema, {
        ...input,
        ...(hasRuntimeType(labelIds, "string") ? { labelIds: [labelIds] } : {}),
      })
    },
    querySchema: historyQuerySchema,
  }
}

// Channel sync: managed labels and the watch

function labelNeedsUpdate(label: GmailApiLabel, settings: GmailLabelSettings): boolean {
  const colorChanged = settings.color !== undefined
    && (label.color?.textColor !== settings.color.textColor || label.color?.backgroundColor !== settings.color.backgroundColor)
  return colorChanged || label.labelListVisibility !== "labelShow" || label.messageListVisibility !== "show"
}

async function planLabels(client: GmailClient, declared: Record<string, GmailLabelSettings>) {
  const labels = await listLabels(client, true)
  const create: string[] = []
  const update: { id: string, name: string }[] = []
  const current: Record<string, unknown> = {}
  for (const [name, settings] of Object.entries(declared)) {
    const label = labels.find(candidate => candidate.name === name)
    if (!label) {
      create.push(name)
      continue
    }
    current[name] = { ...(label.color ? { color: label.color } : {}), id: label.id }
    if (labelNeedsUpdate(label, settings)) update.push({ id: label.id, name })
  }
  return { create, current, update }
}

export interface GmailSyncProviderOptions {
  client: (fetchImpl: typeof fetch) => GmailClient
  labels: Record<string, GmailLabelSettings>
  /** Gmail mailbox identity, shared even when separate credentials access the account. */
  resourceKey: string
  topic?: string
}

/**
 * Plans and applies Gmail account resources: managed labels and the push watch.
 * Gmail cannot report the current watch, so every plan with a topic renews it.
 */
export function createGmailChannelSyncProvider(options: GmailSyncProviderOptions): AgentChannelSyncProvider {
  return {
    resourceKey: options.resourceKey,
    async apply(_plan, fetchImpl) {
      const client = options.client(fetchImpl)
      // Plan again: labels may have changed since the reviewed plan.
      const { create, update } = await planLabels(client, options.labels)
      for (const name of create) await createLabel(client, name, options.labels[name])
      for (const { id, name } of update) {
        await client({ body: labelBody(name, options.labels[name]), method: "PATCH", path: `labels/${encodeURIComponent(id)}` })
      }
      labelCaches.delete(client)
      const watch = options.topic ? await startGmailWatch(client, options.topic) : undefined
      return {
        labels: { created: create, updated: update.map(label => label.name) },
        ...(watch ? { watch } : {}),
      }
    },
    mode: "account",
    async plan({ fetch: fetchImpl }): Promise<AgentChannelSyncPlan> {
      const { create, current, update } = await planLabels(options.client(fetchImpl), options.labels)
      const changes = [
        ...create.map(name => `Create label "${name}"`),
        ...update.map(label => `Update label "${label.name}"`),
        ...(options.topic ? [`Start or renew the Gmail watch on ${options.topic}`] : []),
      ]
      return {
        action: changes.length ? "update" : "none",
        changes,
        current: { labels: current },
        desired: {
          labels: options.labels,
          ...(options.topic ? { watch: { labelIds: gmailWatchLabelIds, topicName: options.topic } } : {}),
        },
        ...(options.topic ? { unverifiable: ["watch"] } : {}),
      }
    },
  }
}
