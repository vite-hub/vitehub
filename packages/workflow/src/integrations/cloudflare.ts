import { encodeNameHex } from "@vite-hub/internal/integrations/hex"

import type { DiscoveredWorkflowDefinition } from "../types.ts"
import { workflowErrorDiagnostics } from "../error-diagnostics.ts"

const cloudflareWorkflowNameMaxLength = 64

function shortHash(value: string): string {
  let hash = 0xcbf29ce484222325n
  for (const char of value) {
    hash ^= BigInt(char.codePointAt(0) || 0)
    hash = BigInt.asUintN(64, hash * 0x100000001b3n)
  }
  return hash.toString(16).padStart(16, "0")
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
  const configurable = definitions.filter(definition => definition.source !== "agent-workflow-recovery")
  if (configurable.length > 1 && options && (options.binding || options.name)) {
    throw workflowErrorDiagnostics.WORKFLOW_R0001({ message: "Cloudflare workflow binding and name overrides are only supported when one workflow is discovered." })
  }
  return definitions.map(definition => ({
    binding: configurable.length === 1 && configurable[0] === definition && options ? options.binding || getCloudflareWorkflowBindingName(definition.name) : getCloudflareWorkflowBindingName(definition.name),
    class_name: getCloudflareWorkflowClassName(definition.name),
    name: configurable.length === 1 && configurable[0] === definition && options ? options.name || getCloudflareWorkflowName(definition.name) : getCloudflareWorkflowName(definition.name),
  }))
}
