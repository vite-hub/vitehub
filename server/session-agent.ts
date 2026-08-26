import type { AgentInspectionMetadata } from 'vite-hub/agent'
import type { SessionAgentConfiguration } from './session-snapshots.ts'

export function sessionAgentConfiguration(inspection: AgentInspectionMetadata): SessionAgentConfiguration {
  const driver = inspection.config?.driver
  const sources = [...new Set((inspection.files ?? []).flatMap(file => file.source ? [file.source] : []))]
  return {
    agent: { name: inspection.name, version: inspection.version },
    capabilities: (inspection.capabilities ?? []).map(capability => ({
      id: capability.id,
      ...(Object.keys(capability.metadata).length ? { metadata: capability.metadata } : {}),
    })),
    driver: {
      kind: driver?.kind,
      model: {
        id: driver?.model?.id ?? driver?.provider?.model,
        provider: driver?.model?.provider ?? driver?.provider?.provider,
      },
      provider: driver?.provider?.provider,
    },
    instructions: inspection.instructions ?? [],
    runtime: { name: 'ViteHub' },
    tools: (inspection.tools ?? []).map(tool => ({ name: tool.name })),
    workspace: {
      mode: 'write',
      name: 'Pull request checkout',
      ...(sources.length ? { sources } : {}),
    },
  }
}
