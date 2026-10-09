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
