import type { ConnectionApproval, ConnectionInspection } from "@vite-hub/connections"
import type { EnvActivity } from "@vite-hub/env/bridge"
import * as v from "valibot"
import { envActorSchema } from "./env-management"
import { ConsoleRequestError } from "./request"

/** An approval as the Console shows it. The Console never reads call inputs. */
export type ConsoleConnectionApproval = Omit<ConnectionApproval, "input">

export const connectionInspectionSchema: v.GenericSchema<unknown, ConnectionInspection> = v.object({
  account: v.optional(v.object({ email: v.optional(v.string()), id: v.string() })),
  actions: v.array(v.object({ highRisk: v.boolean(), id: v.string(), method: v.string(), write: v.boolean() })),
  connectedAt: v.optional(v.string()),
  name: v.string(),
  provider: v.string(),
  refreshedAt: v.optional(v.string()),
  scopes: v.object({ declared: v.array(v.string()), granted: v.array(v.string()), missing: v.array(v.string()) }),
  status: v.picklist(["connected", "disconnected", "reauth_required", "revoked"]),
})
export const connectionApprovalSchema: v.GenericSchema<unknown, ConsoleConnectionApproval> = v.object({
  action: v.string(),
  actor: v.string(),
  createdAt: v.string(),
  decidedAt: v.optional(v.string()),
  decidedBy: v.optional(v.string()),
  error: v.optional(v.string()),
  id: v.string(),
  invocationId: v.optional(v.string()),
  name: v.string(),
  status: v.picklist(["approved", "denied", "executed", "failed", "pending"]),
  traceId: v.optional(v.string()),
})
export const connectionListSchema: v.GenericSchema<unknown, { connections: ConnectionInspection[] }> = v.object({ connections: v.array(connectionInspectionSchema) })
export const connectionResultSchema: v.GenericSchema<unknown, { connection: ConnectionInspection }> = v.object({ connection: connectionInspectionSchema })
export const connectionActivitySchema: v.GenericSchema<unknown, { activity: EnvActivity[] }> = v.object({ activity: v.array(v.object({ id: v.string(), operationId: v.string(), key: v.string(), timestamp: v.string(), actor: envActorSchema, action: v.picklist(["inspect", "preview", "replace", "resolve", "use", "grant", "revoke"]), outcome: v.picklist(["started", "succeeded", "failed", "denied"]), revision: v.optional(v.string()), target: v.optional(envActorSchema), operation: v.optional(v.string()), traceId: v.optional(v.string()), invocationId: v.optional(v.string()) })) })
export const connectionApprovalsSchema: v.GenericSchema<unknown, { approvals: ConsoleConnectionApproval[], nextCursor?: string }> = v.object({ approvals: v.array(connectionApprovalSchema), nextCursor: v.optional(v.string()) })
export const connectionApprovalCountsSchema: v.GenericSchema<unknown, { counts: Record<string, number> }> = v.object({ counts: v.record(v.string(), v.pipe(v.number(), v.integer(), v.minValue(0))) })
export const connectionApprovalResultSchema: v.GenericSchema<unknown, { approval: ConsoleConnectionApproval }> = v.object({ approval: connectionApprovalSchema })

const errorBodySchema = v.object({ error: v.object({ message: v.pipe(v.string(), v.minLength(1), v.maxLength(500)) }) })

/** A short label for a Connection status. */
export function connectionStatusLabel(status: ConnectionInspection["status"]): string {
  return { connected: "Connected", disconnected: "Not connected", reauth_required: "Reconnect required", revoked: "Revoked" }[status]
}

/** A short label for a Connection activity action. Connection tokens are stored as Env credentials. */
export function connectionActivityLabel(action: EnvActivity["action"]): string {
  return { grant: "Grant", inspect: "Inspect", preview: "Preview", replace: "Store token", resolve: "Retrieve token", revoke: "Revoke", use: "Call" }[action]
}

/** The page that starts the provider authorization flow for one Connection. */
export function connectionConnectURL(endpoint: string, name: string): string {
  return `${endpoint.replace(/\/+$/, "")}/connect/${encodeURIComponent(name)}`
}

async function errorMessage(response: Response): Promise<string> {
  if (response.status === 401) return "Sign in to manage Connections."
  if (response.status === 403) return "You do not have access to this operation."
  if (response.status === 404) return "Connections management is not available. Production builds need connections: { management: true }."
  const body = v.safeParse(errorBodySchema, await response.json().catch(() => undefined))
  return body.success ? body.output.error.message : "Could not complete the request. Try again."
}

/** Run one action on the Connections management API and validate the response. */
export async function requestConnectionsManagement<T extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>>(endpoint: string, action: string, schema: T, input: Record<string, unknown> = {}): Promise<v.InferOutput<T>> {
  const response = await fetch(endpoint, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...input, action }) })
  if (!response.ok) throw new ConsoleRequestError(response.status, await errorMessage(response))
  return v.parse(schema, await response.json())
}

/** Load pending decisions separately so recent history cannot hide older pending calls. */
export async function loadConnectionApprovals(endpoint: string, name: string, before?: string): Promise<{ history: ConsoleConnectionApproval[], pending: ConsoleConnectionApproval[], nextCursor?: string }> {
  const [history, waiting] = await Promise.all([
    requestConnectionsManagement(endpoint, "approval-summaries", connectionApprovalsSchema, { name }),
    requestConnectionsManagement(endpoint, "approval-summaries", connectionApprovalsSchema, { name, status: "pending", ...(before ? { before } : {}) }),
  ])
  return { history: history.approvals, pending: waiting.approvals, ...(waiting.nextCursor ? { nextCursor: waiting.nextCursor } : {}) }
}
