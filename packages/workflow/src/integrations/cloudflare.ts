import { encodeNameHex } from "@vitehub/internal/integrations/hex"

import type { DiscoveredWorkflowDefinition } from "../types.ts"

const cloudflareWorkflowNameMaxLength = 64

function shortHash(value: string): string {
  let hash = 0x811c9dc5
  for (const char of value) {
    hash ^= char.codePointAt(0) || 0
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, "0")
}

export function getCloudflareWorkflowBindingName(name: string): string {
  return `WORKFLOW_${encodeNameHex(name).toUpperCase()}`
}

export function getCloudflareWorkflowName(name: string): string {
  const encoded = encodeNameHex(name)
  const fullName = `workflow--${encoded}`
  if (fullName.length <= cloudflareWorkflowNameMaxLength) {
    return fullName
  }

  const hash = shortHash(name)
  const prefixLength = cloudflareWorkflowNameMaxLength - "workflow--".length - "-".length - hash.length
  return `workflow--${encoded.slice(0, prefixLength)}-${hash}`
}

export function getCloudflareWorkflowClassName(name: string): string {
  const suffix = name
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)
    .map(segment => `${segment.charAt(0).toUpperCase()}${segment.slice(1)}`)
    .join("")
    || "Default"

  return `ViteHub${suffix}${shortHash(name)}Workflow`
}

interface CloudflareWorkflowBindingDescriptor {
  binding: string
  class_name: string
  name: string
}

export function createCloudflareWorkflowBindings(
  definitions: DiscoveredWorkflowDefinition[],
  options: { binding?: string, name?: string } | false | undefined,
): CloudflareWorkflowBindingDescriptor[] | undefined {
  if (!definitions.length) {
    return undefined
  }
  return definitions.map(definition => ({
    binding: definitions.length === 1 && options ? options.binding || getCloudflareWorkflowBindingName(definition.name) : getCloudflareWorkflowBindingName(definition.name),
    class_name: getCloudflareWorkflowClassName(definition.name),
    name: definitions.length === 1 && options ? options.name || getCloudflareWorkflowName(definition.name) : getCloudflareWorkflowName(definition.name),
  }))
}
