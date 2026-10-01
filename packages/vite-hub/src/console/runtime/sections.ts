/** Sections that the Console UI in `vite-hub` renders with its own components. Owner packages contribute the others. */
export const consoleBuiltinSectionIds = ["env", "connections", "agents", "usage", "blob", "databases", "kv"] as const

export type ConsoleBuiltinSectionId = (typeof consoleBuiltinSectionIds)[number]

/** A built-in section id or the id of a section that an owner package contributes. */
export type ConsoleSectionId = string

export interface ConsoleSectionDetails {
  readonly description: string
  readonly icon: string
  readonly label: string
  readonly routeName: string
}

/** Details of built-in sections. Contributed sections get their details from the navigation response. */
export const consoleSectionDetails: Readonly<Record<ConsoleBuiltinSectionId, ConsoleSectionDetails>> = {
  env: { description: "Inspect Server Env declarations and their providers.", icon: "i-ph-key-light", label: "Env", routeName: "vitehub-console-env" },
  connections: {
    description: "Connect OAuth accounts, review activity, and decide pending approvals.",
    icon: "i-lucide-plug-zap",
    label: "Connections",
    routeName: "vitehub-console-connections",
  },
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
  blob: {
    description: "Inspect configured Blob stores and object metadata without downloading contents.",
    icon: "i-lucide-file-box",
    label: "Blob",
    routeName: "vitehub-console-blob",
  },
  databases: {
    description: "Inspect Database schemas, relationships, and live table rows.",
    icon: "i-lucide-database",
    label: "Databases",
    routeName: "vitehub-console-databases",
  },
  kv: {
    description: "Inspect configured KV stores without changing data.",
    icon: "i-ph-key-light",
    label: "KV",
    routeName: "vitehub-console-kv",
  },
}

interface ConsoleSectionStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

const lastConsoleSectionStorageKey = "vitehub-console:last-section"
const consoleSectionIdPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

/** Returns true for a lowercase route segment. Built-in and contributed section ids use this form. */
export function isConsoleSectionId(value: unknown): value is ConsoleSectionId {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Section ids come from untrusted JSON and browser storage.
  return typeof value === "string" && consoleSectionIdPattern.test(value)
}

export function isConsoleBuiltinSectionId(value: unknown): value is ConsoleBuiltinSectionId {
  return consoleBuiltinSectionIds.some(section => section === value)
}

/** Route name of a contributed section. The Console serves it at `/_vitehub/<id>`. */
export function consoleSectionRouteName(section: ConsoleSectionId): string {
  return `vitehub-console-${section}`
}

/**
 * Returns the enabled section ids in navigation order. Owner packages contribute `rate-limits`, `sandboxes`,
 * `workspaces`, `workflows`, `queues`, and `schedules`. `console/contributions.ts` maps each id to its owner.
 */
export function resolveConsoleSectionIds(options: { env?: unknown; connections?: unknown; agent?: unknown; blob?: unknown; database?: unknown; kv?: unknown; preset?: unknown; queue?: unknown; rateLimit?: unknown; sandbox?: unknown; schedule?: unknown; workflow?: unknown; workspace?: unknown }): ConsoleSectionId[] {
  const workflowEnabled = options.workflow !== false
    && Boolean(options.workflow || (options.agent && options.preset !== "netlify"))
  return [
    ...(options.env ? ["env"] : []),
    ...(options.connections ? ["connections"] : []),
    ...(options.agent ? ["agents", "usage"] : []),
    ...(options.blob ? ["blob"] : []),
    ...(options.database ? ["databases"] : []),
    ...(options.kv ? ["kv"] : []),
    ...(options.rateLimit ? ["rate-limits"] : []),
    ...(options.sandbox ? ["sandboxes"] : []),
    ...(options.workspace ? ["workspaces"] : []),
    ...(workflowEnabled ? ["workflows"] : []),
    ...(options.queue ? ["queues"] : []),
    ...(options.schedule ? ["schedules"] : []),
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
