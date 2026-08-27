export const consoleSectionIds = ["agents", "kv", "workflows", "queues"] as const

export type ConsoleSectionId = (typeof consoleSectionIds)[number]

export const consoleSectionDetails = {
  agents: {
    description: "Inspect Agent sessions and invocation details.",
    icon: "i-lucide-bot",
    label: "Agents",
    routeName: "vitehub-console-agents",
  },
  kv: {
    description: "Inspect configured KV stores without changing data.",
    icon: "i-lucide-key-round",
    label: "KV",
    routeName: "vitehub-console-kv",
  },
  workflows: {
    description: "Inspect discovered Workflow Definitions and their source metadata.",
    icon: "i-lucide-git-branch",
    label: "Workflows",
    routeName: "vitehub-console-workflows",
  },
  queues: {
    description: "Inspect discovered Queue Definitions and their source metadata.",
    icon: "i-lucide-inbox",
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

export function resolveConsoleSectionIds(options: { agent?: unknown; kv?: unknown; queue?: unknown; workflow?: unknown }): ConsoleSectionId[] {
  return [
    ...(options.agent ? ["agents" as const] : []),
    ...(options.kv ? ["kv" as const] : []),
    ...(options.workflow ? ["workflows" as const] : []),
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
