export const finalChannelOutputContextKey = "vitehub.channel.final-output"
export const requireAgentWorkflowContextKey = "vitehub.agent.require-workflow"
export const finalChannelOutputSelectedSymbol = Symbol("vitehub.channel.final-output.selected")
export const responseTitleFallbackContextKey = "vitehub.title.response-fallback"

const portableAgentWorkflowCapabilities = new Set(["blob", "db"])

export function isPortableAgentWorkflowCapability(name: string): boolean {
  return portableAgentWorkflowCapabilities.has(name)
}

export async function hasOnlyPortableAgentWorkflowCapabilities(capabilities: Record<string, unknown> | undefined): Promise<boolean> {
  for (const [name, capability] of Object.entries(capabilities || {})) {
    if (capability === false) continue
    if (!isPortableAgentWorkflowCapability(name)) return false
    try {
      const { loadAgentWorkflowBlobPrimitive, loadAgentWorkflowDatabasePrimitive } = await import("./workflow-runtime-loaders.ts")
      const primitive = name === "blob"
        ? await loadAgentWorkflowBlobPrimitive()
        : await loadAgentWorkflowDatabasePrimitive()
      if (capability !== primitive) return false
    }
    catch {
      return false
    }
  }
  return true
}
