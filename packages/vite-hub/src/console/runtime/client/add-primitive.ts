import { ref } from "vue"

import type { ConsolePrimitive, ConsoleSectionGroupId, ConsoleSectionId } from "../sections"
import { consolePrimitives, consoleSectionGroupLabels, groupConsoleSections, resolveConsoleSectionGroup } from "../sections"

/** The "Add a primitive" dialog is open. The sidebar, the Overview, and the search palette open it. */
export const consoleAddPrimitiveOpen = ref(false)

/** The primitive that the dialog shows. Unset, it lists the primitives to choose from. */
export const consoleAddPrimitiveChoice = ref<ConsoleSectionId>()

/** Opens the dialog at the list, or at the steps for one primitive. */
export function openConsoleAddPrimitive(choice?: ConsoleSectionId): void {
  consoleAddPrimitiveChoice.value = choice
  consoleAddPrimitiveOpen.value = true
}

/** Sections that come with Agents, so the dialog offers Agents instead of them. */
const agentSections: readonly ConsoleSectionId[] = ["channels", "skills", "usage"]

/** The primitives that the app can add: every primitive except the enabled sections and the sections that come with Agents. */
export function consoleAddablePrimitives(enabled: readonly ConsoleSectionId[]): ConsolePrimitive[] {
  return consolePrimitives.filter(entry => !agentSections.includes(entry.id) && !enabled.includes(entry.id))
}

export interface ConsolePrimitiveGroup {
  id: ConsoleSectionGroupId
  label: string
  primitives: ConsolePrimitive[]
}

/**
 * Splits primitives into the navigation groups of the sidebar and keeps the ones whose name, description, or
 * `vitehub add` feature contains every word of the query. Empty groups are dropped.
 */
export function groupConsolePrimitives(primitives: readonly ConsolePrimitive[], query = ""): ConsolePrimitiveGroup[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const matches = primitives.filter((entry) => {
    const text = `${entry.label} ${entry.pitch} ${entry.feature ?? ""}`.toLowerCase()
    return words.every(word => text.includes(word))
  })
  return groupConsoleSections(matches).map((primitives) => {
    const id = resolveConsoleSectionGroup(primitives[0]!.id)
    return { id, label: consoleSectionGroupLabels[id], primitives }
  })
}

/** The command that adds the primitive, such as `npx vitehub add rate-limit`. Undefined when the CLI cannot add it. */
export function consoleAddCommand(primitive: Pick<ConsolePrimitive, "feature">): string | undefined {
  return primitive.feature && `npx vitehub add ${primitive.feature.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`
}

/** A prompt for a coding agent that works in the app's repository. It names the command, when there is one, and the docs. */
export function consoleAddPrompt(primitive: Pick<ConsolePrimitive, "docs" | "feature" | "label">): string {
  const command = consoleAddCommand(primitive)
  return [
    `Add the ViteHub ${primitive.label} primitive to this app.`,
    ...(command ? [`Run \`${command} --dry-run\` to see the change, then run it again with \`--yes\` to apply it.`] : []),
    `Follow ${primitive.docs}`,
  ].join(" ")
}
