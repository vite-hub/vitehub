import { defineCapability, normalizeMode } from "../../capability-runtime.ts"
import { blobTools } from "./blob.ts"
import { dbTools } from "./db.ts"
import { kvTools } from "./kv.ts"

import type { AgentCapabilityDefinition } from "../../types.ts"
import type { BlobCapabilityOptions } from "./blob.ts"
import type { DBCapabilityOptions } from "./db.ts"
import type { KVCapabilityOptions } from "./kv.ts"

export function kv(options: KVCapabilityOptions = {}): AgentCapabilityDefinition {
  const mode = normalizeMode(options.mode, "KV")
  return defineCapability({ id: "kv", mode, requires: [{ primitive: "kv" }], tools: kvTools(mode, options) })
}

export function blob(options: BlobCapabilityOptions = {}): AgentCapabilityDefinition {
  const mode = normalizeMode(options.mode, "Blob")
  return defineCapability({ id: "blob", mode, requires: [{ primitive: "blob" }], tools: blobTools(mode, options) })
}

export function db(options: DBCapabilityOptions = {}): AgentCapabilityDefinition {
  const mode = normalizeMode(options.mode, "DB")
  const schemaMode = normalizeMode(options.schemaMode, "DB schema")
  return defineCapability({ id: "db", mode, metadata: { schemaMode }, requires: [{ primitive: "db" }], tools: dbTools(mode, schemaMode, options) })
}

export type { BlobCapabilityOptions } from "./blob.ts"
export type { DBCapabilityOptions } from "./db.ts"
export type { KVCapabilityOptions } from "./kv.ts"
export type { StorageToolPolicy } from "./shared.ts"
