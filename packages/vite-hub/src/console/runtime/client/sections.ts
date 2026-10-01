import type { ConsoleContributedSection } from "../definitions"
import type { ConsoleSectionDetails, ConsoleSectionId } from "../sections"

import { parseConsoleContributedSection } from "../definitions"
import { consoleSectionDetails, consoleSectionRouteName, isConsoleBuiltinSectionId, isConsoleSectionId } from "../sections"
import { requestConsole } from "./request"

export interface ConsoleNavigation {
  /** `true` for a Console Auth session, `"cloudflare-access"` when Cloudflare Access verifies each request. */
  auth: boolean | "cloudflare-access"
  /** Descriptors of the installed sections that owner packages contribute, keyed by section id. */
  contributions: Readonly<Record<ConsoleSectionId, ConsoleContributedSection>>
  projectName?: string
  sections: ConsoleSectionId[]
}

const navigationRequests = new Map<string, Promise<ConsoleNavigation | undefined>>()
const navigationSubscribers = new Map<string, Set<(navigation: ConsoleNavigation) => void>>()

function parseConsoleNavigation(value: unknown): ConsoleNavigation {
  // SAFETY: Reading an optional property is safe for every non-null JavaScript value; the property remains unknown until validated below.
  const response = value as { auth?: unknown, contributions?: unknown, projectName?: unknown, sections?: unknown } | null | undefined
  const contributions: Record<ConsoleSectionId, ConsoleContributedSection> = {}
  for (const entry of Array.isArray(response?.contributions) ? response.contributions : []) {
    const section = parseConsoleContributedSection(entry)
    if (section && isConsoleSectionId(section.id) && !isConsoleBuiltinSectionId(section.id)) contributions[section.id] = section
  }
  const sections = Array.isArray(response?.sections)
    ? response.sections.filter((section): section is ConsoleSectionId =>
        isConsoleBuiltinSectionId(section) || (isConsoleSectionId(section) && Object.hasOwn(contributions, section)))
    : []
  return {
    auth: response?.auth === true || response?.auth === "cloudflare-access" ? response.auth : false,
    contributions,
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Console responses are untrusted JSON.
    ...(typeof response?.projectName === "string" && response.projectName.trim()
      ? { projectName: response.projectName.trim() }
      : {}),
    sections,
  }
}

/** Returns the label, icon, description, and route name of a built-in or contributed section. */
export function resolveConsoleSectionDetails(
  navigation: Pick<ConsoleNavigation, "contributions"> | undefined,
  section: ConsoleSectionId,
): ConsoleSectionDetails | undefined {
  if (isConsoleBuiltinSectionId(section)) return consoleSectionDetails[section]
  const contributed = navigation && Object.hasOwn(navigation.contributions, section) ? navigation.contributions[section] : undefined
  return contributed
    ? { description: contributed.description, icon: contributed.icon, label: contributed.label, routeName: consoleSectionRouteName(section) }
    : undefined
}

export async function loadConsoleNavigation(base: string): Promise<ConsoleNavigation | undefined> {
  let request = navigationRequests.get(base)
  if (!request) {
    request = requestConsole(base)
      .then((value) => {
        const navigation = parseConsoleNavigation(value)
        for (const subscriber of navigationSubscribers.get(base) || []) subscriber(navigation)
        return navigation
      })
      .catch(() => {
        navigationRequests.delete(base)
        return undefined
      })
    navigationRequests.set(base, request)
  }
  return await request
}

export function subscribeConsoleNavigation(
  base: string,
  subscriber: (navigation: ConsoleNavigation) => void,
): () => void {
  const subscribers = navigationSubscribers.get(base) || new Set()
  subscribers.add(subscriber)
  navigationSubscribers.set(base, subscribers)
  return () => {
    subscribers.delete(subscriber)
    if (subscribers.size === 0) navigationSubscribers.delete(base)
  }
}

export function createConsoleSectionLoader(base: string): () => Promise<ConsoleSectionId[] | undefined> {
  return async () => (await loadConsoleNavigation(base))?.sections
}
