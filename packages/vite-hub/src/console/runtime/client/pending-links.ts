/**
 * One-time links for a new project. The Console makes a secret and keeps it in `localStorage`, and gives out only an id
 * and the SHA-256 verifier of the secret. The new app stores the verifier as `VITEHUB_CONSOLE_TOKEN_SHA256`. When the
 * person opens `/link#p=<pendingId>&url=<appOrigin>` and confirms the app, the Console sends the secret as the Console
 * token of the app, saves the project, and deletes the entry. The secret never leaves this browser before that.
 */

import { isMixedContentProject, normalizeProjectUrl } from "./projects"

import type { ConsoleProjectProblem } from "./project-link"
import type { ConsoleProjectStorage, ConsoleProjectTarget } from "./projects"

/** The `localStorage` key of the pending links. */
export const consolePendingLinksStorageKey = "vitehub-console:pending-links"

/** A pending link that is older than this, in milliseconds, cannot link a project. */
export const consolePendingLinkLifetime: number = 24 * 60 * 60 * 1000

/** One pending link. `secret` becomes the Console token of the project. */
export interface ConsolePendingLink {
  /** A random id for the link URL and the command. It is not derived from the secret. */
  pendingId: string
  /** 32 random bytes, base64url. */
  secret: string
  /** When the Console made the link, in milliseconds since the epoch. */
  createdAt: number
  /** The first confirmed app, retained on failure so the secret cannot be sent to a second project. */
  targetUrl?: string
}

/** What the Console gives out for a new pending link: the id and the value of `VITEHUB_CONSOLE_TOKEN_SHA256`. */
export interface ConsolePendingLinkTicket {
  pendingId: string
  /** The lowercase hex SHA-256 of the UTF-8 secret, which is what the server compares. */
  verifier: string
}

export type ConsolePendingLinkLookup =
  | { kind: "pending", link: ConsolePendingLink }
  | { kind: "expired" }
  | { kind: "unknown" }

export interface ConsolePendingLinkStore {
  /** Make a pending link and keep it. */
  create(): Promise<ConsolePendingLinkTicket>
  /** Find a pending link. Every read also removes the links that expired. */
  lookup(pendingId: string): ConsolePendingLinkLookup
  /** Remember the confirmed app before sending its secret. The caller holds the link's Web Lock. */
  bind(pendingId: string, targetUrl: string): void
  /** Remove a link, after it linked a project. */
  remove(pendingId: string): void
}

/** The browser's origin-wide Web Locks manager, passed in by the hosted Console. */
export interface ConsolePendingLinkLocks {
  request<T>(name: string, run: () => Promise<T>): Promise<T>
}

const pendingIdPattern = /^[\w-]{8,64}$/

function base64url(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}

function randomText(length: number): string {
  return base64url(globalThis.crypto.getRandomValues(new Uint8Array(length)))
}

/** The verifier of a secret: the lowercase hex SHA-256 of its UTF-8 bytes, the same as `printf %s "$secret" | sha256sum`. */
export async function consoleLinkVerifier(secret: string): Promise<string> {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret)))
  return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("")
}

function parseStoredLinks(raw: string | null): ConsolePendingLink[] {
  let value: unknown
  try {
    value = raw ? JSON.parse(raw) : undefined
  }
  catch {
    return []
  }
  const links: ConsolePendingLink[] = []
  for (const entry of Array.isArray(value) ? value : []) {
    if (!(entry instanceof Object)) continue
    const pendingId: unknown = Reflect.get(entry, "pendingId")
    const secret: unknown = Reflect.get(entry, "secret")
    const createdAt: unknown = Reflect.get(entry, "createdAt")
    const targetUrl: unknown = Reflect.get(entry, "targetUrl")
    if (String(pendingId) !== pendingId || !pendingIdPattern.test(pendingId) || String(secret) !== secret || !secret) continue
    if (!Number.isFinite(createdAt) || links.some(link => link.pendingId === pendingId)) continue
    if (targetUrl !== undefined && (String(targetUrl) !== targetUrl || !targetUrl)) continue
    links.push({ pendingId, secret, createdAt: Number(createdAt), ...(targetUrl !== undefined ? { targetUrl } : {}) })
  }
  return links
}

/** The pending links of one Console origin. `now` is for tests. */
export function createConsolePendingLinkStore(storage: ConsoleProjectStorage, options: { now?: () => number } = {}): ConsolePendingLinkStore {
  const now = options.now ?? Date.now
  const isExpired = (link: ConsolePendingLink, time: number): boolean => time - link.createdAt > consolePendingLinkLifetime || link.createdAt > time + 60_000
  const read = (): ConsolePendingLink[] => {
    try {
      return parseStoredLinks(storage.getItem(consolePendingLinksStorageKey))
    }
    catch {
      return []
    }
  }
  const write = (links: ConsolePendingLink[]): void => {
    storage.setItem(consolePendingLinksStorageKey, JSON.stringify(links))
  }
  return {
    async create() {
      const time = now()
      const link: ConsolePendingLink = { pendingId: randomText(12), secret: randomText(32), createdAt: time }
      write([...read().filter(entry => !isExpired(entry, time)), link])
      return { pendingId: link.pendingId, verifier: await consoleLinkVerifier(link.secret) }
    },
    lookup(pendingId) {
      const time = now()
      const links = read()
      const live = links.filter(link => !isExpired(link, time))
      if (live.length !== links.length) write(live)
      const link = links.find(entry => entry.pendingId === pendingId)
      if (!link) return { kind: "unknown" }
      return live.includes(link) ? { kind: "pending", link } : { kind: "expired" }
    },
    bind(pendingId, targetUrl) {
      write(read().map(link => link.pendingId === pendingId ? { ...link, targetUrl } : link))
    },
    remove(pendingId) {
      write(read().filter(link => link.pendingId !== pendingId))
    },
  }
}

/** What a `/link` URL asks for: the pending link and the app, or why the URL cannot link a project. */
export type ConsoleLinkRequest =
  | { kind: "confirm", pendingId: string, target: ConsoleProjectTarget }
  | { kind: "problem", problem: ConsoleProjectProblem }

/**
 * Read the fragment of a `/link` URL, such as `#p=<pendingId>&url=https://app.example.com`. The app URL must be
 * `https:`, or `http:` on a loopback host.
 */
export function parseConsoleLinkFragment(hash: string): ConsoleLinkRequest {
  const params = new URLSearchParams(hash.replace(/^#/, ""))
  const pendingId = params.get("p")?.trim()
  const url = params.get("url")?.trim()
  if (!pendingId || !url) {
    return {
      kind: "problem",
      problem: {
        title: "This link is not complete",
        message: "Open the link that the command printed. The Console removes the link from the address bar when it opens, so a reload cannot use it again.",
      },
    }
  }
  if (!pendingIdPattern.test(pendingId)) {
    return { kind: "problem", problem: { title: "This link is not valid", message: "Open the link that the command printed, without changes." } }
  }
  const normalized = normalizeProjectUrl(url)
  if ("error" in normalized) return { kind: "problem", problem: { title: "Check the app URL", message: normalized.error } }
  if (isMixedContentProject(normalized.target, "https:")) {
    return { kind: "problem", problem: { title: "Use HTTPS", message: `The link points to ${normalized.target.origin}. The Console links only https:// apps, or http:// apps on localhost.` } }
  }
  return { kind: "confirm", pendingId, target: normalized.target }
}

/** The parts of `window` that `takeConsoleLinkHash()` reads and changes. */
export interface ConsoleLinkPage {
  location: { hash: string, pathname: string, search: string }
  history: { state: unknown, replaceState(data: unknown, unused: string, url: string): void }
}

/**
 * The fragment of the `/link` page below `base`, or `undefined` on another page. It removes the fragment from the
 * address bar and from the history entry at once, so a shared screen or a copied URL does not keep it.
 */
export function takeConsoleLinkHash(page: ConsoleLinkPage, base: string): string | undefined {
  const { hash, pathname, search } = page.location
  if (pathname.replace(/\/+$/, "") !== `${base.replace(/\/+$/, "")}/link`) return undefined
  if (hash) page.history.replaceState(page.history.state, "", `${pathname}${search}`)
  return hash
}
