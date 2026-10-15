import type { EnvActor, EnvPermission, EnvSecretMetadata, EnvActivity, EnvGrant } from "@vite-hub/env/bridge"
import * as v from "valibot"
import { ConsoleNetworkError, consoleResponseError } from "./request"

export const envPermissionSchema: v.GenericSchema<unknown, EnvPermission> = v.picklist(["inspect", "preview", "replace", "use"])
export const envActorSchema: v.GenericSchema<unknown, EnvActor> = v.object({ id: v.string(), kind: v.picklist(["user", "agent", "service"]) })
export const envMetadataSchema: v.GenericSchema<unknown, EnvSecretMetadata | null> = v.nullable(v.object({ revision: v.string(), updatedAt: v.string(), preview: v.optional(v.string()) }))
export const envPreviewSchema: v.GenericSchema<unknown, Pick<EnvSecretMetadata, "preview"> | null> = v.nullable(v.object({ preview: v.optional(v.string()) }))
export const envInspectionSchema: v.GenericSchema<unknown, { metadata: EnvSecretMetadata | null; permissions: EnvPermission[]; admin: boolean }> = v.object({ metadata: envMetadataSchema, permissions: v.array(envPermissionSchema), admin: v.boolean() })
export const envActivitySchema: v.GenericSchema<unknown, { events: EnvActivity[] }> = v.object({ events: v.array(v.object({ id: v.string(), operationId: v.string(), key: v.string(), timestamp: v.string(), actor: envActorSchema, action: v.picklist(["inspect", "preview", "replace", "resolve", "use", "grant", "revoke"]), outcome: v.picklist(["started", "succeeded", "failed", "denied"]), revision: v.optional(v.string()), target: v.optional(envActorSchema), permissions: v.optional(v.array(envPermissionSchema)), operation: v.optional(v.string()), traceId: v.optional(v.string()), invocationId: v.optional(v.string()) })) })
export const envGrantsSchema: v.GenericSchema<unknown, { grants: EnvGrant[] }> = v.object({ grants: v.array(v.object({ key: v.string(), actor: envActorSchema, permissions: v.array(envPermissionSchema) })) })

export async function requestEnvManagement<T extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>>(endpoint: string, path: string, action: string, schema: T, input: Record<string, unknown> = {}): Promise<v.InferOutput<T>> {
  const body = JSON.stringify({ ...input, path, action })
  let response: Response
  try {
    response = await fetch(endpoint, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body })
  }
  catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error
    throw new ConsoleNetworkError(error)
  }
  if (!response.ok) throw await consoleResponseError(response, response.status === 409 ? { message: "This credential changed. Reload its details before replacing it." } : {})
  return v.parse(schema, await response.json())
}
