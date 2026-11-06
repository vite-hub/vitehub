/**
 * Proof that a development request came from this machine, for dev servers that run the app behind a proxy.
 *
 * Nuxt 4 (Nitro 2) and Nitro 3 run the app in a worker behind a proxy. The worker never sees the client's address:
 * over a Unix socket it sees none, and over TCP it sees the proxy on `127.0.0.1`. The proxy forwards a client
 * `x-forwarded-for` as is. The front process sees the real socket, so its Nitro dev handler removes any client copy
 * of {@link viteHubDevPeerHeader} and, for a loopback socket only, adds an HMAC over the method, the path, a
 * timestamp, and a nonce. The key is random for each process and reaches the worker only through its environment
 * ({@link viteHubDevPeerKeyEnv}), never through a header.
 *
 * The worker calls {@link verifyViteHubDevPeer}. Each piece of evidence is valid once, for one method and path, for a
 * short time. This module uses Web Crypto and no Node import, so the check also runs in Worker runtimes.
 */

/** The request header that carries the evidence from the front process to the worker. */
export const viteHubDevPeerHeader = "x-vitehub-dev-peer"

/** The environment variable that carries the per-process key from the front process to the worker. */
export const viteHubDevPeerKeyEnv = "VITEHUB_DEV_PEER_KEY"

/** How long evidence stays valid. A dev worker that is still starting can hold a request for some seconds. */
export const viteHubDevPeerMaxAgeMs = 60_000
// The front and the worker read one clock. This allows for a timer that runs slightly ahead in the worker.
const futureSkewMs = 5_000

const version = "v1"
const evidencePattern = /^v1\.(\d{13})\.([\w-]{22})\.([\w-]{43})$/
const encoder = new TextEncoder()

type HmacKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>

interface DevPeerState {
  /** The key that this process signs with. Only the front process creates it. */
  key?: string
  keys: Map<string, Promise<HmacKey>>
  /** Nonces that a verified request used, with the time when they expire. */
  nonces: Map<string, number>
  verified: WeakMap<Request, boolean>
}

const stateKey = Symbol.for("vitehub.dev-peer")
// SAFETY: This module owns the symbol slot. Bundled copies of it in one process share the state through the slot.
const scope = globalThis as typeof globalThis & { [stateKey]?: DevPeerState }
const state: DevPeerState = scope[stateKey] ??= { keys: new Map(), nonces: new Map(), verified: new WeakMap() }

function base64url(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}

function fromBase64url(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"))
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function random(length: number): string {
  return base64url(crypto.getRandomValues(new Uint8Array(length)))
}

function importKey(key: string): Promise<HmacKey> {
  let imported = state.keys.get(key)
  if (!imported) {
    imported = crypto.subtle.importKey("raw", encoder.encode(key), { hash: "SHA-256", name: "HMAC" }, false, ["sign", "verify"])
    state.keys.set(key, imported)
  }
  return imported
}

// Concatenate rather than resolve, so a target such as `//host/path` keeps its own path.
function pathnameOf(path: string): string {
  return new URL(`http://localhost${path}`).pathname
}

function payload(method: string, path: string, timestamp: string, nonce: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(`vitehub-dev-peer\n${version}\n${method.toUpperCase()}\n${pathnameOf(path)}\n${timestamp}\n${nonce}`)
}

/** Whether a socket address is a loopback address. A missing address, such as a Unix socket peer, is not. */
export function isViteHubLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false
  const v4 = address.toLowerCase().startsWith("::ffff:") ? address.slice(7) : address
  return v4 === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4)
}

/**
 * The key of this process, created on the first call and written to `process.env` so a dev worker that starts later
 * inherits it. A value that the process inherited, for example from a parent process or a shell, is replaced.
 * Call it only in the front process of a development server.
 */
export function useViteHubDevPeerKey(): string {
  state.key ??= random(32)
  process.env[viteHubDevPeerKeyEnv] = state.key
  return state.key
}

/** The key that a dev worker inherited from its front process, or `undefined` when no front process set one. */
export function readViteHubDevPeerKey(): string | undefined {
  const value = globalThis.process?.env?.[viteHubDevPeerKeyEnv]
  return typeof value === "string" && value.length >= 32 ? value : undefined
}

/** Create the evidence for one request that came from a loopback socket. */
export async function signViteHubDevPeer(key: string, request: { method: string, path: string }, now = Date.now()): Promise<string> {
  const timestamp = String(Math.trunc(now)).padStart(13, "0")
  const nonce = random(16)
  const signature = await crypto.subtle.sign("HMAC", await importKey(key), payload(request.method, request.path, timestamp, nonce))
  return `${version}.${timestamp}.${nonce}.${base64url(new Uint8Array(signature))}`
}

function forgetExpiredNonces(now: number): void {
  for (const [nonce, expires] of state.nonces) if (expires <= now) state.nonces.delete(nonce)
}

/**
 * Whether `request` carries valid evidence from the front process: signed with `key`, for this method and path, not
 * older than {@link viteHubDevPeerMaxAgeMs}, and not used by another request. A second check of the same `Request`
 * object gives the same answer. Missing, malformed, tampered, expired, and replayed evidence gives `false`.
 */
export async function verifyViteHubDevPeer(request: Request, key: string, now = Date.now()): Promise<boolean> {
  const known = state.verified.get(request)
  if (known !== undefined) return known
  const verified = await verify(request, key, now)
  state.verified.set(request, verified)
  return verified
}

async function verify(request: Request, key: string, now: number): Promise<boolean> {
  const match = evidencePattern.exec(request.headers.get(viteHubDevPeerHeader) ?? "")
  if (!match) return false
  const [, timestamp = "", nonce = "", signature = ""] = match
  const issued = Number(timestamp)
  if (issued < now - viteHubDevPeerMaxAgeMs || issued > now + futureSkewMs) return false
  forgetExpiredNonces(now)
  if (state.nonces.has(nonce)) return false
  // The pattern admits only base64url text of a 32-byte signature, which `atob` decodes. Refuse other spellings of
  // the same bytes, so one signature has one header value.
  const bytes = fromBase64url(signature)
  if (base64url(bytes) !== signature) return false
  const path = new URL(request.url).pathname
  if (!await crypto.subtle.verify("HMAC", await importKey(key), bytes, payload(request.method, path, timestamp, nonce))) return false
  // The check above is async, so a concurrent request with the same nonce can reach this line first.
  if (state.nonces.has(nonce)) return false
  state.nonces.set(nonce, issued + viteHubDevPeerMaxAgeMs + futureSkewMs)
  return true
}

/**
 * Whether a development request came from this machine. Headers can be forged, so only the socket decides.
 * - A dev server whose front process signs loopback requests gives its worker a key. The worker then trusts only
 *   that evidence, because its own peer is the proxy of the front process.
 * - Without a key, `remoteAddress`, the peer address that the host adapter reports, decides. An unknown peer is refused.
 */
export async function isViteHubLoopbackPeer(request: Request, remoteAddress: string | undefined): Promise<boolean> {
  if (remoteAddress && !isViteHubLoopbackAddress(remoteAddress)) return false
  const key = readViteHubDevPeerKey()
  return key ? verifyViteHubDevPeer(request, key) : isViteHubLoopbackAddress(remoteAddress)
}

/** The parts of an H3 1 (Nitro 2) or H3 2 (Nitro 3) event that the dev handler reads. */
interface DevPeerEvent {
  node?: { req?: DevPeerNodeRequest }
  req?: { headers: Headers }
  runtime?: { node?: { req?: DevPeerNodeRequest } }
}

interface DevPeerNodeRequest {
  headers: Record<string, string | string[] | undefined>
  method?: string
  socket?: { remoteAddress?: string }
  url?: string
}

/** Remove a client copy of the evidence. Returns the request to sign when it came from a loopback socket. */
function takeSignableRequest(node: DevPeerNodeRequest): { method: string, path: string } | undefined {
  delete node.headers[viteHubDevPeerHeader]
  if (!isViteHubLoopbackAddress(node.socket?.remoteAddress) || !node.method || !node.url?.startsWith("/")) return
  return { method: node.method, path: node.url }
}

/**
 * The Nitro dev handler that runs in the front process before Nitro forwards a request to its worker. It accepts
 * H3 1 events (Nitro 2) and H3 2 events (Nitro 3), and it never answers a request itself.
 */
export async function viteHubDevPeerDevHandler(event: DevPeerEvent): Promise<void> {
  // H3 2 builds `event.req` from the Node request's raw headers, so change both copies.
  const web = event.runtime?.node?.req ? event.req?.headers : undefined
  const node = event.runtime?.node?.req ?? event.node?.req
  web?.delete(viteHubDevPeerHeader)
  if (!node) return
  const request = takeSignableRequest(node)
  if (!request) return
  const evidence = await signViteHubDevPeer(useViteHubDevPeerKey(), request)
  node.headers[viteHubDevPeerHeader] = evidence
  web?.set(viteHubDevPeerHeader, evidence)
}

/**
 * Sign a WebSocket upgrade in the front process. Nitro 2 and Nitro 3 dev servers hand an upgrade to the worker without
 * their dev handlers, and Node calls `upgrade` listeners one after another without waiting, so this signs at once with
 * `node:crypto`. It signs only in a process that {@link addViteHubDevPeerDevHandler} gave a key.
 */
export function viteHubDevPeerUpgradeListener(req: DevPeerNodeRequest): void {
  const request = takeSignableRequest(req)
  const hmac = globalThis.process?.getBuiltinModule?.("node:crypto")?.createHmac
  if (!request || !state.key || !hmac) return
  const timestamp = String(Date.now()).padStart(13, "0")
  const nonce = random(16)
  const signature = hmac("sha256", state.key).update(payload(request.method, request.path, timestamp, nonce)).digest()
  req.headers[viteHubDevPeerHeader] = `${version}.${timestamp}.${nonce}.${base64url(new Uint8Array(signature))}`
}

/** The parts of a Node HTTP server that {@link addViteHubDevPeerUpgradeSigner} uses. */
export interface ViteHubDevPeerUpgradeServer {
  listeners(event: "upgrade"): readonly unknown[]
  prependListener(event: "upgrade", listener: typeof viteHubDevPeerUpgradeListener): unknown
}

/** Run {@link viteHubDevPeerUpgradeListener} before every other `upgrade` listener of a dev server, once. */
export function addViteHubDevPeerUpgradeSigner(server: ViteHubDevPeerUpgradeServer): void {
  if (!server.listeners("upgrade").includes(viteHubDevPeerUpgradeListener)) server.prependListener("upgrade", viteHubDevPeerUpgradeListener)
}

const devHandlerMark = Symbol.for("vitehub.dev-peer.dev-handler")
// H3 1 marks event handlers with `__is_handler__`, and warns about a plain function.
const devHandler = Object.assign(viteHubDevPeerDevHandler, { __is_handler__: true, [devHandlerMark]: true })

/**
 * Put the dev handler first in Nitro's `devHandlers`, once, and create the key of this process. Call it while Nitro
 * is configured for development, before its worker starts.
 */
export function addViteHubDevPeerDevHandler(devHandlers: Array<{ handler?: unknown, route?: string }>): void {
  useViteHubDevPeerKey()
  const index = devHandlers.findIndex(entry => typeof entry.handler === "function" && devHandlerMark in entry.handler)
  if (index !== -1) devHandlers.splice(index, 1)
  devHandlers.unshift({ handler: devHandler })
}
