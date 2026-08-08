export const finalChannelOutputContextKey = "vitehub.channel.final-output"
export const requireAgentWorkflowContextKey = "vitehub.agent.require-workflow"
export const finalChannelOutputSelectedSymbol = Symbol("vitehub.channel.final-output.selected")
export const responseTitleFallbackContextKey = "vitehub.title.response-fallback"

const portableAgentWorkflowCapabilities = new Set(["blob", "db"])

export function hasOnlyPortableAgentWorkflowCapabilities(capabilities: Record<string, unknown> | undefined): boolean {
  return Object.entries(capabilities || {}).every(([name, capability]) => capability === false || portableAgentWorkflowCapabilities.has(name))
}
