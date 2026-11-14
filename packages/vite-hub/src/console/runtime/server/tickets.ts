import { operationRpcPath } from "@vite-hub/internal/operation-rpc"
import { resolvePublicUrl } from "@vite-hub/runtime"
import { getStandardContext } from "@vite-hub/runtime/internal/h3"

import { consoleDiagnosticBody, type ConsoleDiagnosticCode } from "../diagnostics.ts"
import { installedConsoleAccessPolicy } from "./access-policy.ts"
import { consoleImpersonation, readConsoleOperationUser, type ConsoleAccess } from "./access.ts"
import { isConsoleLoopbackRequest } from "./loopback.ts"
import { consoleErrorResult, consoleRequestError, type ConsoleRequestEvent } from "./request.ts"
import { loadConsoleRuntime } from "./runtime.ts"
import { getConsoleSections } from "./sections.ts"
import { consoleSiteKeys, consoleSiteKV } from "./site-session.ts"

import type { AuthConsole } from "@vite-hub/auth/console-runtime"
import type { ConsoleSiteKV } from "./site-session.ts"

/**
 * One-time tickets open a page of the app in the browser for the person who called the Console. Content preview and
 * impersonation need the app origin: a frame of the page, or the app session cookie. A signed operation, such as
 * `auth.impersonate`, checks the call and returns a ticket URL on the app's own Console route,
 * `GET /_vitehub/rpc?ticket=<ticket>`. The browser opens it, and the route redeems the ticket once.
 *
 * A ticket is 32 random bytes. The app keeps only the SHA-256 of it, with what it is for: the purpose, the app origin,
 * the person, the target, and the expiry. Redemption takes the record out of the store, so a second request with the
 * same ticket, an expired ticket, or a changed ticket finds nothing.
 */

/** What a ticket opens. */
export type ConsoleTicketPurpose = "auth.impersonate" | "auth.stop-impersonating" | "content.preview" | "page.member" | "page.guest"

/** The answer of an operation that opens a page with a ticket. */
export interface ConsoleTicket {
  /** The app URL that redeems the ticket, such as `https://app.example.com/_vitehub/rpc?ticket=vt1_...`. */
  url: string
  /** When the ticket stops working, as an ISO timestamp. */
  expiresAt: string
}

export interface ConsoleTicketRecord {
  purpose: ConsoleTicketPurpose
  /** The app origin that the ticket works on. */
  origin: string
  /** The app mount below the origin, such as `/portal`, or an empty string. */
  base: string
  /** The person who asked for the ticket. */
  person: { id: string, email?: string, name?: string, image?: string }
  target: Record<string, string>
  /** Milliseconds since the epoch. */
  expiresAt: number
}

/** Seconds that a ticket works. The browser opens it right after the call that made it. */
export const consoleTicketLifetime = 60
/** The search parameter of a ticket on `GET /_vitehub/rpc`. */
export const consoleTicketParameter = "ticket"
const ticketPattern = /^vt1_[\w-]{43}$/
const identifierPrefix = "vitehub-console-ticket:"
/** Guest invites are tickets that the Console lists until someone opens them, so they have a prefix of their own. */
export const consoleInvitePrefix = "vitehub-page-invite:"

/**
 * Where tickets wait to be redeemed. `consume` returns a value once, also when two instances ask at the same time.
 * Guest invites also list and remove their tickets. A store without those methods keeps tickets only.
 */
export interface ConsoleTicketStore {
  save(identifier: string, value: string, expiresAt: Date): Promise<void>
  consume(identifier: string): Promise<string | null>
  list?(prefix: string): Promise<{ identifier: string, value: string, expiresAt: Date }[]>
  remove?(identifier: string): Promise<void>
}

/** A store that also lists and removes tickets, for guest invites. */
export type ConsoleRecordStore = Required<ConsoleTicketStore>

/**
 * Tickets in a KV store: the app's default KV store without Auth, or the memory of a development server. Each value
 * keeps its expiry, because a store can keep a key a little after its TTL. `consume` is `getAndDelete()`.
 */
function kvTicketStore(kv: ConsoleSiteKV): ConsoleRecordStore {
  const read = (stored: string | null | undefined): { value: string, expiresAt: number } | undefined => {
    if (!stored) return undefined
    try {
      const parsed: unknown = JSON.parse(stored)
      const value: unknown = Reflect.get(Object(parsed), "value")
      const expiresAt: unknown = Reflect.get(Object(parsed), "expiresAt")
      return typeof value === "string" && typeof expiresAt === "number" && expiresAt > Date.now() ? { value, expiresAt } : undefined
    }
    catch {
      return undefined
    }
  }
  const unwrap = <T>([error, value]: readonly [unknown, T]): T => {
    if (error) throw error
    return value
  }
  return {
    async save(identifier, value, expiresAt) {
      const ttl = Math.max(1, Math.ceil((expiresAt.getTime() - Date.now()) / 1000))
      unwrap(await kv.set(identifier, JSON.stringify({ value, expiresAt: expiresAt.getTime() }), { ttl }))
    },
    async consume(identifier) {
      return read(unwrap(await kv.getAndDelete(identifier, { type: "text" })))?.value ?? null
    },
    async list(prefix) {
      const keys = await consoleSiteKeys(kv, prefix)
      const rows = await Promise.all(keys.map(async identifier => ({ identifier, entry: read(unwrap(await kv.get(identifier, { type: "text" }))) })))
      return rows.flatMap(({ identifier, entry }) => entry ? [{ identifier, value: entry.value, expiresAt: new Date(entry.expiresAt) }] : [])
    },
    async remove(identifier) {
      unwrap(await kv.delete(identifier))
    },
  }
}

function authTicketStore(api: AuthConsole): ConsoleRecordStore {
  return {
    async save(identifier, value, expiresAt) {
      const [error] = await api.saveVerification(identifier, value, expiresAt)
      if (error) throw error
    },
    async consume(identifier) {
      const [error, value] = await api.consumeVerification(identifier)
      if (error) throw error
      return value
    },
    async list(prefix) {
      const [error, rows] = await api.listVerifications(prefix)
      if (error) throw error
      return rows
    },
    async remove(identifier) {
      const [error] = await api.deleteVerification(identifier)
      if (error) throw error
    },
  }
}

let installedStore: ConsoleTicketStore | undefined

/** Replace the ticket store, or restore the default with `undefined`. Tests use it. */
export function setConsoleTicketStore(store: ConsoleTicketStore | undefined): void {
  installedStore = store
}

function isRequestEvent(event: unknown): event is ConsoleRequestEvent {
  return event instanceof Object && "~standard" in event
}

/** The Auth Console of a request, when the app has the Auth section. */
export async function authConsole(request: Request, event: ConsoleRequestEvent | undefined, impersonation = false): Promise<AuthConsole | undefined> {
  if (!getConsoleSections().includes("auth")) return undefined
  // A build without the Auth section replaces the flag, so the bundler drops the optional import.
  const auth = import.meta.viteHubConsoleAuth === false ? undefined : await import("@vite-hub/auth/server")
  return auth?.getAuthConsoleForRequest(request, event, { impersonation })
}

/** The Auth failure as a Console error, without loading Auth in a build that has none. */
export async function authFailure(error: Parameters<typeof import("./auth.ts").authConsoleFailure>[0]): Promise<unknown> {
  const auth = import.meta.viteHubConsoleAuth === false ? undefined : await import("./auth.ts")
  return auth ? auth.authConsoleFailure(error) : error
}

/**
 * The shared store of tickets: Better Auth's verification table when the app has Auth with a database. Otherwise the
 * KV store of Site access: the app's default KV store with an atomic `getAndDelete()`, or memory on a development
 * server. Without either, tickets fail closed with `CONSOLE_TICKET_STORE_MISSING`.
 */
async function ticketStore(request: Request, event?: ConsoleRequestEvent): Promise<ConsoleTicketStore> {
  if (installedStore) return installedStore
  const api = await authConsole(request, event)
  const fallback = async (): Promise<ConsoleRecordStore> => kvTicketStore(await consoleSiteKV())
  if (!api) return await fallback()
  const shared = authTicketStore(api)
  // Auth without a database answers AUTH_CONSOLE_UNAVAILABLE. Each call decides the same way, so both use one store.
  const unavailable = (error: unknown) => Reflect.get(Object(error), "code") === "AUTH_CONSOLE_UNAVAILABLE"
  const method = <K extends keyof ConsoleRecordStore>(name: K): ConsoleRecordStore[K] => {
    const call = (...args: unknown[]) => Reflect.apply(shared[name], shared, args).catch(async (error: unknown) => {
      if (unavailable(error)) return Reflect.apply((await fallback())[name] as (...input: unknown[]) => unknown, undefined, args)
      throw error
    })
    // SAFETY: `call` forwards the arguments and the answer of the method with this name.
    return call as ConsoleRecordStore[K]
  }
  return { save: method("save"), consume: method("consume"), list: method("list"), remove: method("remove") }
}

/** The ticket store with `list` and `remove`, for guest invites. */
export async function consoleRecordStore(request: Request, event?: ConsoleRequestEvent): Promise<ConsoleRecordStore> {
  const store = await ticketStore(request, event)
  if (!store.list || !store.remove) throw consoleRequestError(500, "Guest invites need a store that lists and removes tickets, and the installed ticket store does not.", "CONSOLE_TICKET_STORE_MISSING")
  // SAFETY: Checked above.
  return store as ConsoleRecordStore
}

export function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}

async function ticketIdentifier(ticket: string, prefix = identifierPrefix): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ticket))
  return `${prefix}${base64url(new Uint8Array(digest))}`
}

/** The origin of the app for a request: `vitehub({ publicUrl })` when set, else the URL of the request. */
export function appOrigin(request: Request): string {
  const origin = resolvePublicUrl({ request })
  if (!origin) throw consoleRequestError(403, "The request host is not an origin of vitehub({ publicUrl }).", "CONSOLE_ORIGIN_REJECTED")
  return new URL(origin).origin
}

/** The app mount of a Console RPC request: its path before `/_vitehub/rpc`. */
export function appBase(request: Request): string {
  const { pathname } = new URL(request.url)
  return pathname.endsWith(operationRpcPath) ? pathname.slice(0, -operationRpcPath.length) : ""
}

/**
 * Make a ticket for the person of a checked Console call. The operation that calls this has checked the section, the
 * grant, and the target. Tickets that act on the app session, such as impersonation, need the email of the person.
 */
export async function issueConsoleTicket(
  context: { access: ConsoleAccess, request?: Request, event?: unknown },
  purpose: ConsoleTicketPurpose,
  target: Record<string, string>,
  options: { lifetime?: number } = {},
): Promise<ConsoleTicket> {
  const { request } = context
  if (!request) throw consoleRequestError(400, "A one-time link needs the request of the call.")
  const user = await readConsoleOperationUser(context.access)
  if (!user?.id) throw consoleRequestError(403, "A one-time link opens the app as the person who asks for it, and this call names no person. Open it from the ViteHub Console.", "CONSOLE_ACCESS_DENIED")
  const [email, name, image]: unknown[] = ["email", "name", "image"].map(field => Reflect.get(user, field))
  const person = {
    id: user.id,
    ...(typeof email === "string" && email ? { email: email.toLowerCase() } : {}),
    ...(typeof name === "string" && name ? { name } : {}),
    ...(typeof image === "string" && image ? { image } : {}),
  }
  if (purpose.startsWith("auth.") && !person.email) {
    throw consoleRequestError(403, "Impersonation checks that the browser is signed in to the app with the email of your Console account, and your Console account has no email. Sign in to the Console with GitHub.", "CONSOLE_ACCESS_DENIED")
  }
  if (purpose === "page.member" && !person.email) {
    throw consoleRequestError(403, "Opening the site signs the browser in as the app user with the email of your Console account, and your Console account has no email. Sign in to the Console with GitHub.", "CONSOLE_ACCESS_DENIED")
  }
  const store = await ticketStore(request, isRequestEvent(context.event) ? context.event : undefined)
  const ticket = `vt1_${base64url(crypto.getRandomValues(new Uint8Array(32)))}`
  const expiresAt = Date.now() + (options.lifetime ?? consoleTicketLifetime) * 1000
  const origin = appOrigin(request)
  const base = appBase(request)
  const record: ConsoleTicketRecord = { purpose, origin, base, person, target, expiresAt }
  await store.save(await ticketIdentifier(ticket, purpose === "page.guest" ? consoleInvitePrefix : identifierPrefix), JSON.stringify(record), new Date(expiresAt))
  const url = new URL(`${base}${operationRpcPath}`, origin)
  url.searchParams.set(consoleTicketParameter, ticket)
  return { url: url.href, expiresAt: new Date(expiresAt).toISOString() }
}

const pageHeaders = {
  "cache-control": "no-store",
  "content-type": "text/html; charset=utf-8",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "x-robots-tag": "noindex, nofollow",
}

function html(value: string): string {
  return value.replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`)
}

/** The page of a refused ticket: the diagnostic code, the why, and the fix, for the person in the browser. */
function problemPage(problem: { code: string, message: string, fix?: string, status: number }): Response {
  const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${html(problem.message)}</title></head><body><main><h1>${html(problem.message)}</h1>${problem.fix ? `<p>${html(problem.fix)}</p>` : ""}<p><code>${html(problem.code)}</code></p></main></body></html>`
  return new Response(page, { headers: { ...pageHeaders, "content-security-policy": "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" }, status: problem.status })
}

export function ticketProblem(status: number, code: ConsoleDiagnosticCode, message?: string): Response {
  return problemPage({ ...consoleDiagnosticBody(code, message), status })
}

/** A failure after the ticket was taken, as a page. A failure without an HTTP status is a bug: it is logged. */
function failurePage(error: unknown): Response {
  const result = consoleErrorResult(error)
  if (result.status >= 500) globalThis.console.error("[vitehub] A one-time link failed.", error)
  const setup = result.code === "CONSOLE_TICKET_STORE_MISSING" || result.code === "CONSOLE_SITE_SECRET_MISSING" ? result.code : "CONSOLE_REQUEST_FAILED"
  return problemPage(result.status >= 500 ? { ...consoleDiagnosticBody(setup), status: result.status } : result)
}

export function seeOther(location: string, headers: Headers = new Headers()): Response {
  const out = new Headers({ "cache-control": "no-store", "referrer-policy": "no-referrer", location })
  for (const cookie of headers.getSetCookie()) out.append("set-cookie", cookie)
  return new Response(null, { headers: out, status: 303 })
}

function readRecord(value: string): ConsoleTicketRecord | undefined {
  try {
    const record: unknown = JSON.parse(value)
    if (!(record instanceof Object)) return undefined
    // SAFETY: Only issueConsoleTicket() writes values under the ticket prefix.
    return record as ConsoleTicketRecord
  }
  catch {
    return undefined
  }
}

async function sha256Base64(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))
  return btoa(String.fromCharCode(...digest))
}

/**
 * Content preview: run the `preview` action of the document editor section as the person, which checks that they may
 * read the document, and post its frame token to the page from a page of the app. The Content preview plugin of the
 * app renders the draft. Its frame form must come from the same origin, so the form leaves from here.
 */
async function openPreview(record: ConsoleTicketRecord): Promise<Response> {
  const { collection, id, path, section } = record.target
  if (!collection || !id || !path || !section) return ticketProblem(401, "CONSOLE_TICKET_INVALID")
  // A build without a document editor leaves the editor code out, so a preview ticket has nothing to open.
  const documents = await (import.meta.viteHubConsoleDocuments === false
    ? Promise.reject(consoleRequestError(404, "The Console document editor section is disabled."))
    : import("./documents.ts"))
  const actions = await documents.loadConsoleDocumentActions(section)
  const preview: unknown = await documents.runConsoleDocumentAction(() => actions.preview({ collection, id }, { user: { ...record.person } }))
  const parameter: unknown = Reflect.get(Object(preview), "parameter")
  const token: unknown = Reflect.get(Object(preview), "token")
  if (String(parameter) !== parameter || String(token) !== token) throw consoleRequestError(409, "The document editor returned no preview token.")
  const page = new URL(path, record.origin)
  if (page.origin !== record.origin) return ticketProblem(401, "CONSOLE_TICKET_INVALID")
  page.searchParams.set(parameter, "")
  const script = "document.forms[0].submit()"
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Opening the preview</title></head><body><form method="post" action="${html(page.href)}"><input type="hidden" name="${html(parameter)}" value="${html(JSON.stringify({ token }))}"><noscript><button>Open the preview</button></noscript></form><script>${script}</script></body></html>`
  return new Response(body, {
    headers: { ...pageHeaders, "content-security-policy": `default-src 'none'; script-src 'sha256-${await sha256Base64(script)}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'` },
  })
}

/** Impersonation: the browser's app session must belong to the person, and Better Auth must let it impersonate. */
async function impersonate(record: ConsoleTicketRecord, request: Request, event: ConsoleRequestEvent, home: string): Promise<Response> {
  if (!consoleImpersonation()) return failurePage(consoleRequestError(404, "Impersonation is off. Set console.impersonation to true to enable it."))
  const api = await authConsole(request, event, true)
  if (!api) return failurePage(consoleRequestError(404, "The app has no Auth section."))
  const [sessionError, session] = await api.session(request)
  if (sessionError) throw sessionError
  const email = record.person.email ?? ""
  if (!session) return failurePage(consoleRequestError(403, `Sign in to the app as ${email}, an account that may impersonate users, then open the link again from the Console.`, "CONSOLE_TICKET_MISMATCH"))
  const userId = record.target.userId
  if (record.purpose === "auth.stop-impersonating") {
    if (!session.impersonatedBy) return failurePage(consoleRequestError(409, "This browser does not impersonate a user."))
    if (session.impersonatedBy.email.toLowerCase() !== email) return failurePage(consoleRequestError(403, `This browser impersonates for ${session.impersonatedBy.email || "another administrator"}, and the link was made for ${email}.`, "CONSOLE_TICKET_MISMATCH"))
    const [error, response] = await api.stopImpersonating(request)
    if (error) return failurePage(await authFailure(error))
    return seeOther(home, response.headers)
  }
  if (!userId) return ticketProblem(401, "CONSOLE_TICKET_INVALID")
  if (session.user.email.toLowerCase() !== email) return failurePage(consoleRequestError(403, `This browser is signed in to the app as ${session.user.email}, and the link was made for ${email}. Sign in to the app as ${email}, then open the link again from the Console.`, "CONSOLE_TICKET_MISMATCH"))
  const [error, response] = await api.execute({ action: "impersonate", userId }, request)
  if (error) return failurePage(await authFailure(error))
  return seeOther(home, response.headers)
}

/**
 * `GET /_vitehub/rpc?ticket=<ticket>`: redeem a one-time ticket. The browser opens it, so every answer is a page or a
 * redirect. The route takes the ticket out of the store first, so a ticket works once even when it fails later.
 */
export async function redeemConsoleTicket(event: ConsoleRequestEvent): Promise<Response> {
  const { req: request, runtime } = getStandardContext(event)
  const policy = installedConsoleAccessPolicy()
  if (!policy) return ticketProblem(500, "CONSOLE_ACCESS_NOT_CONFIGURED")
  if (!await isConsoleLoopbackRequest(request, { access: policy.mode, remoteAddress: runtime?.clientAddress })) return ticketProblem(403, "CONSOLE_LOOPBACK_ONLY")
  const ticket = new URL(request.url).searchParams.get(consoleTicketParameter) ?? ""
  if (!ticketPattern.test(ticket)) return ticketProblem(401, "CONSOLE_TICKET_INVALID")
  try {
    const store = await ticketStore(request, event)
    // A guest invite waits under its own prefix, so the Console can list it.
    const value = await store.consume(await ticketIdentifier(ticket)) ?? await store.consume(await ticketIdentifier(ticket, consoleInvitePrefix))
    const record = value === null ? undefined : readRecord(value)
    if (!record || !(record.expiresAt > Date.now())) return ticketProblem(401, "CONSOLE_TICKET_INVALID")
    if (record.origin !== appOrigin(request) || record.base !== appBase(request)) return ticketProblem(403, "CONSOLE_TICKET_MISMATCH", "This one-time link was made for another app.")
    await loadConsoleRuntime()
    if (record.purpose === "content.preview") return await openPreview(record)
    if (record.purpose === "page.member" || record.purpose === "page.guest") return await (await import("./site-access.ts")).openSiteSession(record, request, event)
    return await impersonate(record, request, event, `${record.origin}${record.base}/`)
  }
  catch (error) {
    return failurePage(error)
  }
}
