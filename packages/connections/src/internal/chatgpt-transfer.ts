import * as v from "valibot"
import type { ConnectionInspection } from "../types.ts"
import type { ConnectionsRuntime } from "../runtime.ts"
import { chatgptRegistration } from "./chatgpt-flow.ts"
import { chatgptIssuer } from "./chatgpt-identity.ts"

const credential = v.pipe(v.string(), v.minLength(1), v.maxLength(65_536))
export const chatgptTransferSchema = v.object({
  version: v.literal(1),
  issuer: v.literal(chatgptIssuer),
  client_id: chatgptRegistration,
  subject: v.pipe(v.string(), v.minLength(1)),
  email: v.optional(v.string()),
  access_token: credential,
  refresh_token: credential,
  id_token: credential,
  token_type: v.literal("Bearer"),
  scopes: v.array(v.string()),
  expires_at: v.pipe(v.number(), v.finite()),
  ext_agent_host_id: v.string(),
})

export type ChatGPTTransfer = v.InferOutput<typeof chatgptTransferSchema>
interface TransferOperations {
  export: (input: { actor: string, name: string }) => Promise<ChatGPTTransfer>
  import: (input: { actor: string, name: string, credential: unknown }) => Promise<ConnectionInspection>
  models: (input: { actor: string, name: string }) => Promise<Array<{ id: string, name: string }>>
}
const operations = new WeakMap<ConnectionsRuntime, TransferOperations>()

export function registerChatGPTTransfers(runtime: ConnectionsRuntime, value: TransferOperations): void {
  operations.set(runtime, value)
}

/** Owner management only. No public Connection client exposes credential transfers. */
export function chatgptTransfers(runtime: ConnectionsRuntime): TransferOperations {
  const value = operations.get(runtime)
  if (!value) throw new Error("This Connections runtime does not support ChatGPT credential transfer.")
  return value
}
