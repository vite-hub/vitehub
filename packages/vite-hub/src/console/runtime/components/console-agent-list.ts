interface ConsoleAgentListStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

const agentListOpenStorageKey = "vitehub-console:agents-open"

/** Number of Agents the panel shows before it offers "Show N more". */
export const consoleAgentListLimit = 5

/** Returns the Agent rows to show. The selected Agent always stays visible. */
export function resolveConsoleAgentRows(
  names: readonly string[],
  selected: string | undefined,
  showAll: boolean,
  limit = consoleAgentListLimit,
): { hidden: number, visible: string[] } {
  if (showAll || names.length <= limit) return { hidden: 0, visible: [...names] }
  const visible = names.slice(0, limit)
  if (selected && names.includes(selected) && !visible.includes(selected)) {
    visible.splice(limit - 1, 1, selected)
  }
  return { hidden: names.length - visible.length, visible }
}

function agentNameList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((name): name is string => typeof name === "string" && Boolean(name.trim())))]
}

/**
 * Reads the Console agents response. `agents` are the registered Agents.
 * `historicalAgents` are names that appear only in invocation history, such as retired jobs.
 */
export function resolveConsoleAgentCatalog(
  value: Readonly<Record<string, unknown>> | undefined,
): { agents: string[], historicalAgents: string[] } {
  const agents = agentNameList(value?.agents)
  const historicalAgents = agentNameList(value?.invocationAgents).filter(name => !agents.includes(name))
  return { agents, historicalAgents }
}

export function readConsoleAgentListOpen(storage?: ConsoleAgentListStorage): boolean {
  try {
    const target = storage ?? globalThis.localStorage
    return target?.getItem(agentListOpenStorageKey) !== "false"
  }
  catch {
    return true
  }
}

export function rememberConsoleAgentListOpen(open: boolean, storage?: ConsoleAgentListStorage): void {
  try {
    const target = storage ?? globalThis.localStorage
    target?.setItem(agentListOpenStorageKey, String(open))
  }
  catch {
    // Browser privacy settings can disable local storage. The panel must still open and close.
  }
}
