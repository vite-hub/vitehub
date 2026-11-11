import type { TraceEventContentPolicy } from "../index.ts"
import { isRuntimeObject } from "./runtime-type.ts"

const contentAttributeKeys = new Set([
  "args", "body", "content", "data", "input", "message", "messages", "output",
  "payload", "progress", "prompt", "raw", "request", "response", "result", "text", "title",
])

const canonicalAttributeKeys = new Set([
  "vitehub.activity.owner", "vitehub.activity.phase", "vitehub.payload.summary",
  "vitehub.payload.value", "vitehub.payload.visibility",
])

export function isTraceContentAttributeKey(key: string): boolean {
  if (key === "error.message") return false
  if (contentAttributeKeys.has(key)) return true
  return key.split(".").some((part, index) => index > 0 && contentAttributeKeys.has(part))
}

function ownProperties(value: unknown): Array<[string, PropertyDescriptor]> {
  if (!isRuntimeObject(value)) return []
  return Reflect.ownKeys(value).flatMap<[string, PropertyDescriptor]>((key) => {
    if (typeof key !== "string") return []
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor?.enumerable ? [[key, descriptor]] : []
  })
}

function mapArray(value: unknown[], map: (value: unknown) => unknown): unknown[] {
  const length: number = Object.getOwnPropertyDescriptor(value, "length")!.value
  const next: unknown[] = []
  next.length = length
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index)
    if (descriptor && "value" in descriptor) next[index] = map(descriptor.value)
  }
  return next
}

function metadataValue(value: unknown, seen: WeakSet<object>): unknown {
  if (!value || typeof value !== "object") return value
  if (seen.has(value)) return "[Circular]"
  seen.add(value)
  try {
    if (Array.isArray(value)) return mapArray(value, child => metadataValue(child, seen))
    return projectProperties(ownProperties(value), "metadata", seen)
  }
  catch {
    return undefined
  }
  finally {
    seen.delete(value)
  }
}

function projectProperties(
  properties: Array<[string, PropertyDescriptor]>,
  content: TraceEventContentPolicy,
  seen: WeakSet<object>,
): Record<string, unknown> {
  const omitted: string[] = []
  const next = Object.fromEntries(properties.flatMap(([key, descriptor]) => {
    if (content === "metadata" && isTraceContentAttributeKey(key)) {
      omitted.push(key)
      return []
    }
    if (!("value" in descriptor)) return []
    return [[key, content === "metadata" ? metadataValue(descriptor.value, seen) : descriptor.value]]
  }))
  if (omitted.length) next["content.omitted"] = omitted
  return next
}

/** Project ordinary attributes; canonical activity and payload fields belong to the event. */
export function normalizeTraceAttributes(
  attributes: Record<string, unknown> | undefined,
  content: TraceEventContentPolicy,
): Record<string, unknown> | undefined {
  let properties: Array<[string, PropertyDescriptor]>
  try {
    properties = ownProperties(attributes || {}).filter(([key]) => !canonicalAttributeKeys.has(key))
  }
  catch {
    return undefined
  }
  const source = projectProperties(properties, "content", new WeakSet())
  try {
    if (Array.isArray(source["content.omitted"])) {
      const omitted = mapArray(source["content.omitted"], value => value)
        .filter(key => typeof key === "string" && !canonicalAttributeKeys.has(key))
      if (omitted.length) source["content.omitted"] = omitted
      else delete source["content.omitted"]
    }
  }
  catch {
    delete source["content.omitted"]
  }
  if (content === "metadata") {
    // Keep accessor-backed content in the omission record without reading it.
    const accessors = properties.filter(([key, descriptor]) => !("value" in descriptor) && isTraceContentAttributeKey(key))
    if (accessors.length) {
      const omitted = new Set(Array.isArray(source["content.omitted"]) ? source["content.omitted"] : [])
      for (const [key] of accessors) omitted.add(key)
      source["content.omitted"] = [...omitted]
    }
    const next = projectProperties(ownProperties(source), content, new WeakSet())
    return Object.keys(next).length ? next : undefined
  }
  return Object.keys(source).length ? source : undefined
}
