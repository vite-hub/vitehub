export const agentDiagnosticOptions = {
  docsBase: "https://vitehub.dev/docs/agents/diagnostics",
}

export const dynamicAgentError = {
  why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
}
