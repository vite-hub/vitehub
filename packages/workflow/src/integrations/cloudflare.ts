import { encodeNameHex } from "@vitehub/internal/integrations/hex"

import type { DiscoveredWorkflowDefinition } from "../types.ts"

export function getCloudflareWorkflowBindingName(name: string): string {
  return `WORKFLOW_${encodeNameHex(name).toUpperCase()}`
}

export function getCloudflareWorkflowName(name: string): string {
  return `workflow--${encodeNameHex(name)}`
}

export function getCloudflareWorkflowClassName(name: string): string {
  const suffix = name
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)
    .map(segment => `${segment.charAt(0).toUpperCase()}${segment.slice(1)}`)
    .join("")
    || "Default"

  return `ViteHub${suffix}Workflow`
}

export interface CloudflareWorkflowBindingDescriptor {
  binding: string
  class_name: string
  name: string
}

export function createCloudflareWorkflowBindings(definitions: DiscoveredWorkflowDefinition[]): CloudflareWorkflowBindingDescriptor[] | undefined {
  if (!definitions.length) {
    return undefined
  }
  return definitions.map(definition => ({
    binding: getCloudflareWorkflowBindingName(definition.name),
    class_name: getCloudflareWorkflowClassName(definition.name),
    name: getCloudflareWorkflowName(definition.name),
  }))
}
