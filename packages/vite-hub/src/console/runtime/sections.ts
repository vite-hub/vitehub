export const consoleSectionIds = ["agents", "usage", "kv", "workflows", "queues"] as const

export type ConsoleSectionId = (typeof consoleSectionIds)[number]

export const consoleSectionDetails = {
  agents: {
    description: "Inspect Agent sessions and invocation details.",
    icon: "i-ph-robot-light",
    label: "Agents",
    routeName: "vitehub-console-agents",
  },
  usage: {
    description: "Review token use and cost evidence over time.",
    icon: "i-ph-chart-bar-light",
    label: "Usage",
    routeName: "vitehub-console-usage",
  },
  kv: {
    description: "Inspect configured KV stores without changing data.",
    icon: "i-ph-key-light",
    label: "KV",
    routeName: "vitehub-console-kv",
  },
  workflows: {
    description: "Inspect discovered Workflow Definitions and their source metadata.",
    icon: "i-ph-git-branch-light",
    label: "Workflows",
    routeName: "vitehub-console-workflows",
  },
  queues: {
    description: "Inspect discovered Queue Definitions and their source metadata.",
    icon: "i-ph-tray-light",
    label: "Queues",
    routeName: "vitehub-console-queues",
  },
} as const satisfies Record<ConsoleSectionId, {
  description: string
  icon: string
  label: string
  routeName: string
}>

interface ConsoleSectionStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

const lastConsoleSectionStorageKey = "vitehub-console:last-section"

export function isConsoleSectionId(value: unknown): value is ConsoleSectionId {
  return consoleSectionIds.some((section) => section === value)
}

export function resolveConsoleSectionIds(options: { agent?: unknown; kv?: unknown; preset?: unknown; queue?: unknown; workflow?: unknown }): ConsoleSectionId[] {
  const workflowEnabled = options.workflow !== false
    && Boolean(options.workflow || (options.agent && options.preset !== "netlify"))
  return [
    ...(options.agent ? ["agents" as const, "usage" as const] : []),
    ...(options.kv ? ["kv" as const] : []),
    ...(workflowEnabled ? ["workflows" as const] : []),
    ...(options.queue ? ["queues" as const] : []),
  ]
}

export function prioritizeConsoleSectionIds(
  sections: readonly ConsoleSectionId[],
  preferred: ConsoleSectionId | undefined,
): ConsoleSectionId[] {
  return preferred && sections.includes(preferred)
    ? [preferred, ...sections.filter(section => section !== preferred)]
    : [...sections]
}

export function readLastConsoleSection(storage?: ConsoleSectionStorage): ConsoleSectionId | undefined {
  try {
    const target = storage ?? globalThis.localStorage
    const value = target?.getItem(lastConsoleSectionStorageKey)
    return isConsoleSectionId(value) ? value : undefined
  }
  catch {
    return undefined
  }
}

export function rememberConsoleSection(
  section: ConsoleSectionId,
  storage?: ConsoleSectionStorage,
): void {
  try {
    const target = storage ?? globalThis.localStorage
    target?.setItem(lastConsoleSectionStorageKey, section)
  }
  catch {
    // Browser privacy settings can disable local storage. Navigation must still work.
  }
}
