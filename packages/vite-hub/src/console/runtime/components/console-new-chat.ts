export function resolveConsoleNewChatAgent(
  selectedAgentName: string | undefined,
  invocationOptions: Record<string, unknown>,
): string | undefined {
  if (selectedAgentName && Object.hasOwn(invocationOptions, selectedAgentName)) {
    return selectedAgentName;
  }
  return Object.keys(invocationOptions)[0];
}

/** Resolve the selected Agent's invocation options without reading inherited object properties. */
export function resolveConsoleAgentInvocation<T>(
  selectedAgentName: string | undefined,
  invocationOptions: Record<string, T>,
): T | undefined {
  return selectedAgentName && Object.hasOwn(invocationOptions, selectedAgentName)
    ? invocationOptions[selectedAgentName]
    : undefined;
}

/** Read an Agent's invocation options from the API response without inherited properties. */
export function resolveConsoleAgentInvocationOptions<T>(
  invocation: Record<string, T> | undefined,
  agentName: string,
): T | undefined {
  return invocation && Object.hasOwn(invocation, agentName) ? invocation[agentName] : undefined;
}
