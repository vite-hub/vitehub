import type { EnvActor, EnvPermission, EnvSecretMetadata, EnvActivity, EnvGrant } from "@vite-hub/env/bridge"
import * as v from "valibot"
import { ConsoleRequestError } from "./request"

export const envPermissionSchema: v.GenericSchema<unknown, EnvPermission> = v.picklist(["inspect", "preview", "replace", "use"])
export const envActorSchema: v.GenericSchema<unknown, EnvActor> = v.object({ id: v.string(), kind: v.picklist(["user", "agent", "service"]) })
export const envMetadataSchema: v.GenericSchema<unknown, EnvSecretMetadata | null> = v.nullable(v.object({ revision: v.string(), updatedAt: v.string(), preview: v.optional(v.string()) }))
export const envPreviewSchema: v.GenericSchema<unknown, Pick<EnvSecretMetadata, "preview"> | null> = v.nullable(v.object({ preview: v.optional(v.string()) }))
export const envInspectionSchema: v.GenericSchema<unknown, { metadata: EnvSecretMetadata | null; permissions: EnvPermission[]; admin: boolean }> = v.object({ metadata: envMetadataSchema, permissions: v.array(envPermissionSchema), admin: v.boolean() })
export const envActivitySchema: v.GenericSchema<unknown, { events: EnvActivity[] }> = v.object({ events: v.array(v.object({ id: v.string(), operationId: v.string(), key: v.string(), timestamp: v.string(), actor: envActorSchema, action: v.picklist(["inspect", "preview", "replace", "resolve", "use", "grant", "revoke"]), outcome: v.picklist(["started", "succeeded", "failed", "denied"]), revision: v.optional(v.string()), target: v.optional(envActorSchema), permissions: v.optional(v.array(envPermissionSchema)), operation: v.optional(v.string()), traceId: v.optional(v.string()), invocationId: v.optional(v.string()) })) })
export const envGrantsSchema: v.GenericSchema<unknown, { grants: EnvGrant[] }> = v.object({ grants: v.array(v.object({ key: v.string(), actor: envActorSchema, permissions: v.array(envPermissionSchema) })) })

export async function requestEnvManagement<T extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>>(endpoint: string, path: string, action: string, schema: T, input: Record<string, unknown> = {}): Promise<v.InferOutput<T>> {
  const response = await fetch(endpoint, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...input, path, action }) })
  if (!response.ok) throw new ConsoleRequestError(response.status, response.status === 409 ? "This credential changed. Reload its details before replacing it." : response.status === 401 ? "Sign in to manage this credential." : response.status === 403 ? "You do not have access to this operation." : "Could not complete the request. Try again.")
  return v.parse(schema, await response.json())
}
