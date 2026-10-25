export const agentDiagnosticOptions = {
  docsBase: () => "https://vitehub.dev/docs/reference/errors-diagnostics#agent-diagnostics",
}

export const dynamicAgentError = {
  why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
}
