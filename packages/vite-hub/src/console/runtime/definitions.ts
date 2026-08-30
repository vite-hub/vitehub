import type { ConsoleSectionId } from "./sections.ts"

export const consoleDefinitionSectionIds = ["databases", "workflows", "queues", "schedules"] as const satisfies readonly ConsoleSectionId[]

export type ConsoleDefinitionSectionId = (typeof consoleDefinitionSectionIds)[number]

export interface ConsoleDefinitionField {
  label: string
  value: string
}

export interface ConsoleDefinitionSummary {
  fields: readonly ConsoleDefinitionField[]
  file: string
  name: string
  source: string
}

export type ConsoleDefinitionCatalog = Partial<
  Record<ConsoleDefinitionSectionId, readonly ConsoleDefinitionSummary[]>
>

export function isConsoleDefinitionSectionId(value: unknown): value is ConsoleDefinitionSectionId {
  return consoleDefinitionSectionIds.some(section => section === value)
}
