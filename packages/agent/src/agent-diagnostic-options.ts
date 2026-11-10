export const agentDocsBase = "https://vitehub.dev/docs/agents/diagnostics"

export const agentDiagnosticOptions = {
  docsBase: agentDocsBase,
}

export const dynamicAgentError = {
  why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
}
