export function resolveConsoleNewChatAgent(
  selectedAgentName: string | undefined,
  invocationOptions: Record<string, unknown>,
): string | undefined {
  if (selectedAgentName && Object.hasOwn(invocationOptions, selectedAgentName)) {
    return selectedAgentName;
  }
  return Object.keys(invocationOptions)[0];
}
