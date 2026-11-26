import { Diagnostic } from "nostics"

import { commentsUnansweredError } from "../client-diagnostics.ts"
import { hostedCommentNoticeRoom, hostedCommentsNoticeDefinition } from "../page.ts"
import { createCommentsRestRequest, createRestTransport } from "../rest-transport.ts"
import { embedChangedEvent, embedConnectType, isEmbedRequest } from "./protocol.ts"

import type { CommentsSession } from "../overlay/api.ts"
import type { RestTransport } from "../rest-transport.ts"
import type { CommentCreateInput, CommentGetInput, CommentListQuery, CommentReplyInput, CommentStatusInput, CommentUser } from "../types.ts"
import type { EmbedAnswer, EmbedFailure, EmbedRequest } from "./protocol.ts"

const memory = new Map<string, string>()

function read(key: string): string | undefined {
  try {
    return sessionStorage.getItem(key) ?? undefined
  }
  catch {
    return memory.get(key)
  }
}

function write(key: string, value: string | undefined): void {
  if (value === undefined) memory.delete(key)
  else memory.set(key, value)
  try {
    if (value === undefined) sessionStorage.removeItem(key)
    else sessionStorage.setItem(key, value)
  }
  catch {}
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw commentsUnansweredError(400)
  return { ...value }
}

function withoutFiles(value: unknown): Record<string, unknown> {
  const input = record(value)
  for (const key of ["files", "outbox", "attachments"]) delete input[key]
  return input
}

function text(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw commentsUnansweredError(400)
  return value
}

function failure(error: unknown): EmbedFailure {
  const known = error instanceof Diagnostic ? error : commentsUnansweredError(0, error)
  const status: unknown = Reflect.get(known, "status")
  return { code: known.code, why: known.message, ...(known.fix ? { fix: known.fix } : {}), status: typeof status === "number" ? status : 0 }
}

async function hosted(value: CommentsSession, signIn: () => Promise<string>): Promise<CommentsSession> {
  const session: CommentsSession = {
    user: value.user,
    can: { read: value.can.read, comment: value.can.comment, resolve: value.can.resolve, delete: false, change: false },
    realtime: false,
    attachments: false,
    presence: false,
    content: false,
    ...(value.subject ? { subject: value.subject } : {}),
    ...(value.revision === undefined ? {} : { revision: value.revision }),
  }
  return value.user ? session : { ...session, signIn: { provider: "console", url: await signIn() } }
}

function serve(origin: string, projectId: string): void {
  const base = `/comments/${encodeURIComponent(projectId)}`
  const tokenKey = `vitehub-comments:${projectId}:token`
  const verifierKey = `vitehub-comments:${projectId}:verifier`
  const headers = (): HeadersInit => {
    const token = read(tokenKey)
    return token ? { authorization: `Bearer ${token}` } : {}
  }
  let port: MessagePort | undefined
  let notices: { room: string, leave: () => void } | undefined

  async function listen(value: CommentsSession | undefined): Promise<void> {
    const token = read(tokenKey)
    const room = value?.realtime && value.user && value.subject && token ? hostedCommentNoticeRoom(projectId, value.subject) : undefined
    if (notices?.room === room) return
    notices?.leave()
    notices = undefined
    if (!room || !token) return
    const current = { room, leave: () => {} }
    notices = current
    const realtime = await import("@vite-hub/realtime/client").catch(() => undefined)
    if (!realtime || notices !== current) return
    const joined = realtime.connectRealtimeRoom(hostedCommentsNoticeDefinition, room, { baseURL: "/", params: { token } })
    joined.onNotice(() => port?.postMessage({ event: embedChangedEvent }))
    current.leave = () => joined.destroy()
  }

  async function authorizeUrl(): Promise<string> {
    let verifier = read(verifierKey)
    if (!verifier) {
      verifier = base64url(crypto.getRandomValues(new Uint8Array(32)))
      write(verifierKey, verifier)
    }
    const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))))
    return `${location.origin}${base}/authorize?challenge=${challenge}`
  }

  const signedOut = (): Promise<CommentsSession> => hosted({ user: null, can: { read: false, comment: false, resolve: false }, realtime: false, content: false }, authorizeUrl)

  async function session(page: string): Promise<CommentsSession> {
    if (!read(tokenKey)) {
      void listen(undefined)
      return await signedOut()
    }
    const request = createCommentsRestRequest({ route: `${base}/api`, headers, credentials: "omit" })
    try {
      const value = (await request<CommentsSession>(`/session?page=${encodeURIComponent(page)}`)).data
      void listen(value)
      return await hosted(value, authorizeUrl)
    }
    catch (error) {
      if (Reflect.get(Object(error), "status") !== 401) throw error
      write(tokenKey, undefined)
      void listen(undefined)
      return await signedOut()
    }
  }

  async function redeem(code: string): Promise<boolean> {
    const verifier = read(verifierKey)
    if (!verifier) return false
    const response = await fetch(`${base}/redeem`, {
      method: "POST",
      credentials: "omit",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, verifier }),
    }).catch((cause: unknown) => {
      throw commentsUnansweredError(0, cause)
    })
    const value: unknown = await response.json().catch(() => undefined)
    const token: unknown = value !== null && typeof value === "object" ? Reflect.get(value, "token") : undefined
    if (!response.ok || typeof token !== "string" || !token) throw commentsUnansweredError(response.status)
    write(tokenKey, token)
    write(verifierKey, undefined)
    return true
  }

  function run(request: EmbedRequest, rest: RestTransport): Promise<unknown> {
    const { input } = request
    switch (request.method) {
      case "session": return session(text(input))
      case "redeem": return redeem(text(input))
      // SAFETY: the Console API checks the query and the inputs below as it checks those of the app's Comments API.
      case "list": return rest.list(record(input) as CommentListQuery)
      // SAFETY: as above.
      case "get": return rest.get(record(input) as CommentGetInput)
      // SAFETY: as above. Hosted threads have no attachments, so the frame drops them.
      case "create": return rest.create(withoutFiles(input) as unknown as CommentCreateInput)
      // SAFETY: as above.
      case "reply": return rest.reply(withoutFiles(input) as unknown as CommentReplyInput)
      case "resolve": return rest.resolve({ threadId: text(record(input).threadId) } satisfies CommentStatusInput)
      case "reopen": return rest.reopen({ threadId: text(record(input).threadId) } satisfies CommentStatusInput)
    }
  }

  async function answer(request: EmbedRequest): Promise<EmbedAnswer> {
    const people: CommentUser[] = []
    const rest = createRestTransport({ route: `${base}/api`, headers, credentials: "omit", onAnswer: value => people.push(...value.people) })
    try {
      return { id: request.id, ok: true, value: await run(request, rest), people }
    }
    catch (error) {
      return { id: request.id, ok: false, error: failure(error) }
    }
  }

  addEventListener("message", (event) => {
    if (port || event.origin !== origin || event.source !== parent) return
    if (event.data === null || typeof event.data !== "object" || Reflect.get(event.data, "type") !== embedConnectType) return
    const [next] = event.ports
    if (!next) return
    port = next
    next.addEventListener("message", (message) => {
      if (isEmbedRequest(message.data)) void answer(message.data).then(value => next.postMessage(value))
    })
    next.start()
    next.postMessage({ event: "ready" })
  })
}

const { origin, project } = document.documentElement.dataset
if (origin && project && parent !== window) serve(origin, project)
