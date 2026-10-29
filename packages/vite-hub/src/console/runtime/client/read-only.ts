import { loadConsoleNavigation } from "./sections"

import type { ConsoleSectionId } from "../sections"

/**
 * Whether the access may only read the section (`"<section>:read"` in `console.authorize`). The write actions of the
 * page are hidden then. The server refuses them either way. Unknown navigation counts as writable, so a failed load
 * does not lock the page.
 */
export async function isConsoleSectionReadOnly(sectionsBase: string, section: ConsoleSectionId): Promise<boolean> {
  return (await loadConsoleNavigation(sectionsBase))?.readOnly.includes(section) ?? false
}
