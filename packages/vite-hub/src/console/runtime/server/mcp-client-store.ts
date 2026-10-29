import { OAuthClientInformationSchema, OAuthTokensSchema } from "@modelcontextprotocol/sdk/shared/auth.js"
import { importSealKey, seal, unseal } from "@vite-hub/env/seal"
import { getActiveCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"
import * as v from "valibot"

import { consoleRequestError } from "./request.ts"

import type { SealKey } from "@vite-hub/env/seal"
import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js"
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js"
import type { ConsoleMcpAuth, ConsoleMcpIdentity, ConsoleMcpServerInfo, ConsoleMcpStatus } from "../mcp-client.ts"

export interface PendingAuthorization {
  expiresAt: number
  prompt?: "login"
  state: string
  /** The authorization URL that the browser opens. */
  url?: string
  verifier?: string
}

export interface StoredOAuth {
  discovery?: OAuthDiscoveryState
  pending?: PendingAuthorization
  /** When the tokens arrived, so `expires_in` becomes a date. */
  receivedAt?: number
  redirectUrl: string
  tokens?: OAuthTokens
}

export interface StoredConnection {
  auth: ConsoleMcpAuth
  bearer?: string
  createdAt: number
  error?: string
  id: string
  identity?: ConsoleMcpIdentity
  label: string
  /** The person named the connection. Otherwise a sign-in names it after its account. */
  labelled: boolean
  oauth?: StoredOAuth
  owner: string
  protocolVersion?: string
  sameOrigin: boolean
  server?: ConsoleMcpServerInfo
  sessionId?: string
  status: ConsoleMcpStatus
  url: string
  usedAt?: number
}

/**
 * Where the MCP client keeps connections and OAuth client registrations. Without `VITEHUB_CONSOLE_MCP_KEY`, they stay in
 * the memory of this process. With it, they live in the app's default KV store, sealed with that key, so they outlive
 * a restart and every instance of the app reads the same ones.
 */
export interface ConsoleMcpRecords {
  /** Whether connections outlive a restart. */
  readonly durable: boolean
  client: (key: string) => Promise<OAuthClientInformationMixed | undefined>
  connection: (owner: string, id: string) => Promise<StoredConnection | undefined>
  connections: (owner: string) => Promise<StoredConnection[]>
  remove: (connection: StoredConnection) => Promise<void>
  removeClient: (key: string) => Promise<void>
  save: (connection: StoredConnection) => Promise<void>
  saveClient: (key: string, client: OAuthClientInformationMixed) => Promise<void>
}

/** The part of the ViteHub KV store that the records use. Each call returns `[error, value]`. */
export interface ConsoleMcpKV {
  del: (key: string) => Promise<readonly [unknown, unknown]>
  get: (key: string) => Promise<readonly [unknown, unknown]>
  keys: (base?: string) => Promise<readonly [unknown, string[] | undefined]>
  set: (key: string, value: unknown) => Promise<readonly [unknown, unknown]>
}

interface MemoryState {
  clients: Map<string, OAuthClientInformationMixed>
  connections: Map<string, StoredConnection>
}

const stateKey: unique symbol = Symbol.for("vitehub.console.mcp-client")
// SAFETY: This module owns the process slot, so separately bundled Console chunks share one store.
const scope = globalThis as typeof globalThis & { [stateKey]?: MemoryState }

function memoryRecords(): ConsoleMcpRecords {
  const state = scope[stateKey] ??= { clients: new Map(), connections: new Map() }
  return {
    durable: false,
    client: async key => state.clients.get(key),
    connection: async (owner, id) => {
      const connection = state.connections.get(id)
      return connection?.owner === owner ? connection : undefined
    },
    connections: async owner => [...state.connections.values()].filter(connection => connection.owner === owner),
    remove: async (connection) => { state.connections.delete(connection.id) },
    removeClient: async (key) => { state.clients.delete(key) },
    save: async (connection) => { state.connections.set(connection.id, connection) },
    saveClient: async (key, client) => { state.clients.set(key, client) },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const optionalText = v.optional(v.string())
const clientSchema = v.custom<OAuthClientInformationMixed>(value => OAuthClientInformationSchema.safeParse(value).success)
const connectionSchema = v.object({
  auth: v.picklist(["bearer", "console", "none", "oauth"]),
  bearer: optionalText,
  createdAt: v.number(),
  error: optionalText,
  id: v.string(),
  identity: v.optional(v.object({ email: optionalText, name: optionalText, picture: optionalText, subject: optionalText })),
  label: v.string(),
  labelled: v.boolean(),
  oauth: v.optional(v.object({
    discovery: v.optional(v.custom<OAuthDiscoveryState>(value => isRecord(value) && typeof value.authorizationServerUrl === "string")),
    pending: v.optional(v.object({ expiresAt: v.number(), prompt: v.optional(v.literal("login")), state: v.string(), url: optionalText, verifier: optionalText })),
    receivedAt: v.optional(v.number()),
    redirectUrl: v.string(),
    tokens: v.optional(v.custom<OAuthTokens>(value => OAuthTokensSchema.safeParse(value).success)),
  })),
  owner: v.string(),
  protocolVersion: optionalText,
  sameOrigin: v.boolean(),
  server: v.optional(v.custom<ConsoleMcpServerInfo>(value => isRecord(value) && typeof value.name === "string" && isRecord(value.capabilities))),
  sessionId: optionalText,
  status: v.picklist(["authorizing", "connected", "failed", "signed-out"]),
  url: v.string(),
  usedAt: v.optional(v.number()),
}) satisfies v.GenericSchema<unknown, StoredConnection>

const keyVariable = "VITEHUB_CONSOLE_MCP_KEY"
const prefix = "vitehub:console:mcp-client"

function decodeKey(value: string): Uint8Array | undefined {
  if (/^[a-f0-9]{64}$/i.test(value)) return Uint8Array.from(value.match(/../g)!, byte => Number.parseInt(byte, 16))
  if (!/^[\w+/-]+={0,2}$/.test(value)) return undefined
  try {
    return Uint8Array.from(atob(value.replace(/=+$/, "").replaceAll("-", "+").replaceAll("_", "/")), character => character.charCodeAt(0))
  }
  catch {
    return undefined
  }
}

function configuredKey(): string | undefined {
  const value: unknown = globalThis.process?.env?.[keyVariable] ?? getActiveCloudflareEnv()?.[keyVariable]
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

/** A short hash, so KV key names do not show who owns a connection, such as a Cloudflare Access email. */
async function hashed(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))
  return Array.from(digest.slice(0, 16), byte => byte.toString(16).padStart(2, "0")).join("")
}

function unwrap<T>([error, value]: readonly [unknown, T]): T {
  if (error) throw error
  return value
}

/**
 * Records in KV, one sealed value per connection and per client registration. Each value is bound to its key, so a
 * record copied under another owner does not open. Two requests that change the same connection at once keep the
 * last write.
 */
export function kvConsoleMcpRecords(kv: ConsoleMcpKV, key: SealKey): ConsoleMcpRecords {
  const encoder = new TextEncoder()
  async function read<TSchema extends v.GenericSchema>(name: string, schema: TSchema): Promise<v.InferOutput<TSchema> | undefined> {
    const stored = unwrap(await kv.get(name))
    const sealed = isRecord(stored) && typeof stored.sealed === "string" ? stored.sealed : undefined
    if (!sealed) return undefined
    let value: unknown
    try {
      value = JSON.parse(await unseal(key, encoder.encode(name), sealed))
    }
    catch {
      // A record sealed with another key, such as before a key rotation, reads as missing.
      return undefined
    }
    const parsed = v.safeParse(schema, value)
    return parsed.success ? parsed.output : undefined
  }
  async function write(name: string, value: unknown): Promise<void> {
    unwrap(await kv.set(name, { sealed: await seal(key, encoder.encode(name), JSON.stringify(value)) }))
  }
  const connectionKey = async (owner: string, id: string) => `${prefix}:connections:${await hashed(owner)}:${id}`
  const clientKey = async (name: string) => `${prefix}:clients:${await hashed(name)}`
  return {
    durable: true,
    client: async name => read(await clientKey(name), clientSchema),
    connection: async (owner, id) => {
      const connection = await read(await connectionKey(owner, id), connectionSchema)
      return connection?.owner === owner ? connection : undefined
    },
    connections: async (owner) => {
      const base = `${prefix}:connections:${await hashed(owner)}`
      const names = (unwrap(await kv.keys(base)) ?? []).map(name => name.replaceAll("/", ":")).filter(name => name.startsWith(`${base}:`))
      const connections = await Promise.all(names.map(name => read(name, connectionSchema)))
      return connections.filter((connection): connection is StoredConnection => connection?.owner === owner)
    },
    remove: async (connection) => { unwrap(await kv.del(await connectionKey(connection.owner, connection.id))) },
    removeClient: async (name) => { unwrap(await kv.del(await clientKey(name))) },
    save: async connection => write(await connectionKey(connection.owner, connection.id), connection),
    saveClient: async (name, client) => write(await clientKey(name), client),
  }
}

let durable: { records: Promise<ConsoleMcpRecords>, value: string } | undefined

/** The records of this process: in KV with `VITEHUB_CONSOLE_MCP_KEY`, else in memory. */
export async function consoleMcpRecords(): Promise<ConsoleMcpRecords> {
  const value = configuredKey()
  if (!value) return memoryRecords()
  if (durable?.value !== value) {
    const bytes = decodeKey(value)
    if (bytes?.byteLength !== 32) throw consoleRequestError(500, `${keyVariable} must be 32 random bytes as base64 or hex. Create one with \`openssl rand -base64 32\`.`, "CONSOLE_MCP_KEY_INVALID")
    const records = Promise.all([import("@vite-hub/kv"), importSealKey(bytes)]).then(([{ kv }, sealKey]) => kvConsoleMcpRecords(kv, sealKey))
    durable = { records, value }
  }
  return durable.records
}

/** Forget every connection kept in memory. Tests use it. */
export function resetConsoleMcpRecords(): void {
  delete scope[stateKey]
  durable = undefined
}
