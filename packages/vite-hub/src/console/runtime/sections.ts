export const consoleSectionIds = ["agents", "kv"] as const

export type ConsoleSectionId = (typeof consoleSectionIds)[number]

export function isConsoleSectionId(value: unknown): value is ConsoleSectionId {
  return consoleSectionIds.some((section) => section === value)
}

export function resolveConsoleSectionIds(options: { agent?: unknown; kv?: unknown }): ConsoleSectionId[] {
  return [...(options.agent ? ["agents" as const] : []), ...(options.kv ? ["kv" as const] : [])]
}
