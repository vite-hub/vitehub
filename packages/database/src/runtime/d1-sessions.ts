import { AsyncLocalStorage } from "node:async_hooks"

import { getStandardContext } from "@vite-hub/runtime/internal/h3"

import type { ViteHubContext, ViteHubStandardProps } from "@vite-hub/runtime"

/** A D1 session from the Sessions API. Drizzle queries it like a D1 database. */
export interface D1SessionLike {
  getBookmark: () => string | null
}

interface DatabaseRequest {
  standard: ViteHubStandardProps
  /** D1 sessions of this request, by binding name. */
  sessions: Map<string, D1SessionLike>
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"])
const storageKey = Symbol.for("vitehub.database.request")
const runtimeGlobal = globalThis as typeof globalThis & Record<symbol, unknown>
// One store for every copy of this module: the request middleware and the database runtime can load different copies.
const requestStorage = (runtimeGlobal[storageKey] ||= new AsyncLocalStorage<DatabaseRequest>()) as AsyncLocalStorage<DatabaseRequest>

/** The cookie that holds the latest D1 bookmark that a client saw for one binding. */
export function d1BookmarkCookieName(binding: string) {
  return `vitehub-d1-bookmark-${binding.toLowerCase()}`
}

function readCookie(headers: Headers, name: string) {
  for (const part of headers.get("cookie")?.split(";") ?? []) {
    const separator = part.indexOf("=")
    if (separator !== -1 && part.slice(0, separator).trim() === name) {
      try {
        return decodeURIComponent(part.slice(separator + 1).trim()) || undefined
      }
      catch {
        return undefined
      }
    }
  }
}

const writes = (standard: ViteHubStandardProps) => !SAFE_METHODS.has(standard.req.method.toUpperCase())

/**
 * Runs one request with its own D1 sessions. After the request, a request that can write (a method other than GET,
 * HEAD, or OPTIONS) gets a bookmark cookie for each D1 session that it used.
 */
export async function runWithDatabaseRequest<T>(event: ViteHubContext, next: () => T): Promise<Awaited<T>> {
  const standard = getStandardContext(event)
  const request: DatabaseRequest = { standard, sessions: new Map() }
  const result = await requestStorage.run(request, next)
  if (request.sessions.size && writes(standard)) {
    const secure = standard.req.url.startsWith("https:")
    for (const [binding, session] of request.sessions) {
      const bookmark = session.getBookmark()
      if (!bookmark) continue
      standard.res.headers?.append("set-cookie", `${d1BookmarkCookieName(binding)}=${encodeURIComponent(bookmark)}; Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`)
    }
  }
  return result
}

/**
 * The D1 session of the active request for `binding`, opened on first use. A request that can write starts on the
 * primary database, so it reads the latest data before it writes. Other requests start after the client's bookmark,
 * or on any replica without one. Undefined outside a request, or when the binding has no Sessions API.
 */
export function useD1Session<TSession extends D1SessionLike>(
  bindingName: string,
  // Local and older bindings may not have `withSession()`.
  binding: { withSession?: (constraint: string) => TSession },
): TSession | undefined {
  const request = requestStorage.getStore()
  if (!request || typeof binding.withSession !== "function") return
  // SAFETY: A binding name always names the same binding in one request, so its session has this binding's type.
  let session = request.sessions.get(bindingName) as TSession | undefined
  if (!session) {
    const constraint = writes(request.standard)
      ? "first-primary"
      : readCookie(request.standard.req.headers, d1BookmarkCookieName(bindingName)) ?? "first-unconstrained"
    session = binding.withSession(constraint)
    request.sessions.set(bindingName, session)
  }
  return session
}
