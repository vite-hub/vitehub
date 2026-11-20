import { webhooksErrors } from "./errors.ts"
import { createMemberEndpoint, memberEndpointHosts } from "./members.ts"
import { requireMemberEndpoints } from "./runtime.ts"
import { sealWebhooksText, unsealWebhooksText } from "./sealing.ts"
import { checkWebhookUrl } from "./url-guard.ts"

import type { Result, ResultError } from "@vite-hub/runtime"
import type { MemberEndpoint, MemberPairingState, StoredMemberPairing } from "./database.ts"
import type { CreateMemberEndpointErrorCode, MemberPairingErrorCode } from "./errors.ts"

/** How long a pairing code works: 10 minutes. */
export const memberPairingLifetime = 10 * 60_000

/** The agents that pair as an inbox, by the name that their pair post gives, such as `{ "code": "...", "inbox": "Codex" }`. */
const inboxes: Record<string, string> = { "Claude Code": "claude-code", "Codex": "codex" }

/** A T3 thread link as `t3_thread_read` gives it: `t3-thread://v2/<environmentId>/<threadId>`. */
const t3ThreadLink = /^t3-thread:\/\/v2\/[\w.~-]{1,128}\/[\w.~:-]{1,256}$/

/**
 * The T3 thread link of a pair post, or `null`. Apps put it in an `href`, such as **Open thread**, so anything but a T3
 * thread link is dropped.
 */
export function memberPairingAddress(value: unknown): string | null {
  return typeof value === "string" && t3ThreadLink.test(value) ? value : null
}

/** A pairing code, as its owner polls it. It never holds the URL or the secret. */
export interface MemberPairing {
  state: MemberPairingState
  owner: string
  /** The agent that used the code, such as `"t3"`, `"claude-code"`, or `"codex"`. */
  agent: string | null
  /** The host of the agent's URL, such as `relay.t3.codes`. `null` for an inbox. */
  host: string | null
  /** Where the agent can be reached, such as its T3 thread link, when the pair post gave one. */
  address: string | null
  expiresAt: number
}

/** What `pairMemberEndpoint()` returns: the code paired, or why it did not. */
export type MemberPairResult =
  | { status: "paired", pairing: MemberPairing }
  | { status: "expired" | "used" }
  | { status: "refused", reason: string }

const hex = (bytes: ArrayBuffer | Uint8Array) => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("")
const random = (bytes: number) => hex(crypto.getRandomValues(new Uint8Array(bytes)))

/** Twelve letters and digits without look-alikes, as `K7QM-4XPA-9RTC`: 60 bits, read aloud without mistakes. */
function pairingCode(): string {
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  const letters = [...bytes].map(byte => alphabet[byte % alphabet.length]).join("")
  return `${letters.slice(0, 4)}-${letters.slice(4, 8)}-${letters.slice(8)}`
}

/** The key of a pairing code: its hash, so the Database never holds a code that works. */
async function codeKey(code: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`vitehub:webhooks:pairing:${code.trim().toUpperCase()}`)))
}

const label = (id: string) => `webhooks-pairing:${id}`

function toPairing(row: StoredMemberPairing): MemberPairing {
  return { state: row.state, owner: row.owner, agent: row.agent, host: row.host, address: row.address, expiresAt: row.expiresAt }
}

function storeError(error: unknown): ResultError<"WEBHOOKS_DATABASE_MISSING" | "WEBHOOKS_STORE_FAILED"> {
  if (webhooksErrors.WEBHOOKS_STORE_FAILED.is(error) || webhooksErrors.WEBHOOKS_DATABASE_MISSING.is(error)) return error
  throw error
}

/** The fields of the JSON that pairing sealed itself. */
function sealedFields(text: string): { secret: string, url?: string } {
  const value: unknown = JSON.parse(text)
  const secret = typeof value === "object" && value !== null ? Reflect.get(value, "secret") : undefined
  const url = typeof value === "object" && value !== null ? Reflect.get(value, "url") : undefined
  if (typeof secret !== "string") throw webhooksErrors.WEBHOOKS_STORE_FAILED({ action: "read a pairing code" })
  return { secret, ...(typeof url === "string" ? { url } : {}) }
}

/**
 * Mints a pairing code for `owner` and returns `[error, { code, secret, expiresAt }]`. Give both to the member's agent,
 * such as in a setup prompt: it signs its webhook schedule with `secret`, then posts the code with its URL to a route
 * that calls `pairMemberEndpoint()`. The code works once, for 10 minutes, and only the owner may allow it. Starting a
 * new pairing deletes the owner's finished codes.
 *
 * ```ts
 * import { startMemberPairing } from "@vite-hub/webhooks"
 *
 * const [error, pairing] = await startMemberPairing("user_ana")
 * ```
 */
export async function startMemberPairing(owner: string): Promise<Result<{ code: string, secret: string, expiresAt: number }, MemberPairingErrorCode>> {
  const { endpoints } = requireMemberEndpoints()
  if (typeof owner !== "string" || !owner.trim()) return [webhooksErrors.WEBHOOKS_ENDPOINT_INVALID({ problem: "`owner` must be non-empty text" }), undefined]
  const code = pairingCode()
  const id = await codeKey(code)
  const secret = `whsec_${random(32)}`
  const [keyError, sealed] = await sealWebhooksText(label(id), JSON.stringify({ secret }))
  if (keyError) return [keyError, undefined]
  const now = Date.now()
  const expiresAt = now + memberPairingLifetime
  try {
    await endpoints.insertPairing({ id, owner, state: "waiting", agent: null, host: null, address: null, sealed, expiresAt, createdAt: now })
  }
  catch (error) {
    return [storeError(error), undefined]
  }
  return [undefined, { code, secret, expiresAt }]
}

/**
 * Pairs the agent that posted `input`: `{ code, url, thread? }` for a receiver URL, such as the `webhookUrl` of a T3
 * task, or `{ code, inbox }` for an agent that reads its inbox, `"Claude Code"` or `"Codex"`. The URL must pass
 * `checkWebhookUrl()` with `hosts`, which defaults to the T3 Code relay; a refused URL uses up the code. `thread` is kept
 * as the endpoint's address only when it is a T3 thread link. Returns `[error, result]`, where a code that is unknown,
 * too old, used, or refused is a `status`, not an error. Input that is not one of the two shapes is an error.
 */
export async function pairMemberEndpoint(input: unknown, options: { hosts?: readonly string[] } = {}): Promise<Result<MemberPairResult, MemberPairingErrorCode>> {
  const { endpoints } = requireMemberEndpoints()
  const field = (name: string): unknown => typeof input === "object" && input !== null ? Reflect.get(input, name) : undefined
  const code = field("code")
  const url = field("url")
  const inbox = field("inbox")
  const invalid = (problem: string) => [webhooksErrors.WEBHOOKS_ENDPOINT_INVALID({ problem }), undefined] as const
  if (typeof code !== "string" || !code || code.length > 64) return invalid("`code` must be the code of the setup prompt")
  if ((typeof url === "string") === (typeof inbox === "string")) return invalid("pass `url`, the agent's receiver URL, or `inbox`, \"Claude Code\" or \"Codex\"")
  const agent = typeof inbox === "string" ? inboxes[inbox] : "t3"
  if (!agent) return invalid("`inbox` must be \"Claude Code\" or \"Codex\"")
  const now = Date.now()
  const id = await codeKey(code)
  try {
    const row = await endpoints.pairing(id)
    if (!row || row.expiresAt < now) return [undefined, { status: "expired" }]
    if (row.state !== "waiting") return [undefined, { status: "used" }]
    if (typeof inbox === "string") {
      const moved = await endpoints.movePairing(id, "waiting", "paired", now, { agent })
      return [undefined, moved ? { status: "paired", pairing: toPairing(moved) } : { status: "used" }]
    }
    const [refused, checked] = await checkWebhookUrl(url as string, { hosts: options.hosts ?? memberEndpointHosts })
    if (refused) {
      await endpoints.movePairing(id, "waiting", "refused", now)
      return [undefined, { status: "refused", reason: refused.why }]
    }
    const [openError, opened] = await unsealWebhooksText(label(id), row.sealed)
    if (openError) return [openError, undefined]
    const [sealError, sealed] = await sealWebhooksText(label(id), JSON.stringify({ secret: sealedFields(opened).secret, url: checked.href }))
    if (sealError) return [sealError, undefined]
    const moved = await endpoints.movePairing(id, "waiting", "paired", now, { agent, host: checked.host, address: memberPairingAddress(field("thread")), sealed })
    return [undefined, moved ? { status: "paired", pairing: toPairing(moved) } : { status: "used" }]
  }
  catch (error) {
    return [storeError(error), undefined]
  }
}

/**
 * Uses up a waiting code without pairing, such as when its pair post came over plain http, where anyone on the way could
 * read it. Returns `[error, refused]`.
 */
export async function refuseMemberPairing(code: string): Promise<Result<boolean, MemberPairingErrorCode>> {
  const { endpoints } = requireMemberEndpoints()
  try {
    return [undefined, Boolean(await endpoints.movePairing(await codeKey(code), "waiting", "refused", Date.now()))]
  }
  catch (error) {
    return [storeError(error), undefined]
  }
}

/** The pairing of `code` while it works, when `owner` minted it, as `[error, pairing]`; `null` otherwise. */
export async function getMemberPairing(owner: string, code: string): Promise<Result<MemberPairing | null, MemberPairingErrorCode>> {
  const { endpoints } = requireMemberEndpoints()
  try {
    const row = await endpoints.pairing(await codeKey(code))
    return [undefined, row && row.owner === owner && row.expiresAt >= Date.now() ? toPairing(row) : null]
  }
  catch (error) {
    return [storeError(error), undefined]
  }
}

/** Deletes the code of `owner`, such as when they close the setup prompt. */
export async function cancelMemberPairing(owner: string, code: string): Promise<Result<void, MemberPairingErrorCode>> {
  const { endpoints } = requireMemberEndpoints()
  try {
    await endpoints.removePairing(await codeKey(code), owner)
    return [undefined, undefined]
  }
  catch (error) {
    return [storeError(error), undefined]
  }
}

/** What `allowMemberPairing()` returns. */
export type MemberAllowResult =
  | { status: "allowed", endpoint: MemberEndpoint, pairing: MemberPairing }
  | { status: "expired" | "not-owner" }

/** Options of `allowMemberPairing()`. */
export interface AllowMemberPairingOptions {
  /** A name that people read, such as `"T3 Code thread"`. */
  name: string | ((pairing: MemberPairing) => string)
  /** The name of the member, for the Console. */
  ownerName?: string
  /** The email of the member, only when it is verified. */
  ownerEmail?: string
  /** The hosts that the agent's URL may use now. Default: the T3 Code relay. */
  hosts?: readonly string[]
}

/**
 * Creates the endpoint of the agent that paired with `code`, when `owner` minted it, and uses up the code. Returns
 * `[error, { status: "allowed", endpoint, pairing }]`, `status: "not-owner"` when another member minted the code, or
 * `status: "expired"` when it is unknown, too old, used, or not paired yet.
 * The endpoint's address is the agent's T3 thread link when it gave one, so a send with that address reaches it.
 *
 * ```ts
 * import { allowMemberPairing } from "@vite-hub/webhooks"
 *
 * const [error, allowed] = await allowMemberPairing("user_ana", code, { name: "T3 Code thread" })
 * ```
 */
export async function allowMemberPairing(owner: string, code: string, options: AllowMemberPairingOptions): Promise<Result<MemberAllowResult, MemberPairingErrorCode | CreateMemberEndpointErrorCode>> {
  const { endpoints } = requireMemberEndpoints()
  const id = await codeKey(code)
  let used: StoredMemberPairing | undefined
  try {
    const row = await endpoints.pairing(id)
    // Only the member who minted the code may allow the agent that used it.
    if (row && row.owner !== owner) return [undefined, { status: "not-owner" }]
    if (!row) return [undefined, { status: "expired" }]
    used = await endpoints.movePairing(id, "paired", "used", Date.now())
  }
  catch (error) {
    return [storeError(error), undefined]
  }
  if (!used) return [undefined, { status: "expired" }]
  const pairing = toPairing(used)
  const name = typeof options.name === "function" ? options.name(pairing) : options.name
  const member = { owner, name, ...(options.ownerName ? { ownerName: options.ownerName } : {}), ...(options.ownerEmail ? { ownerEmail: options.ownerEmail } : {}) }
  let created: Awaited<ReturnType<typeof createMemberEndpoint>>
  if (used.host) {
    const [openError, opened] = await unsealWebhooksText(label(id), used.sealed)
    if (openError) return [openError, undefined]
    const target = sealedFields(opened)
    if (!target.url) throw webhooksErrors.WEBHOOKS_STORE_FAILED({ action: "read a pairing code" })
    created = await createMemberEndpoint({ ...member, agent: used.agent ?? "t3", ...(used.address ? { address: used.address } : {}), kind: "url", url: target.url, secret: target.secret, hosts: options.hosts ?? memberEndpointHosts })
  }
  else {
    created = await createMemberEndpoint({ ...member, ...(used.agent ? { agent: used.agent } : {}), kind: "inbox" })
  }
  if (created[0]) return [created[0], undefined]
  return [undefined, { status: "allowed", endpoint: created[1], pairing }]
}
