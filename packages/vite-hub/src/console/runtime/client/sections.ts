import type { ConsoleContributedSection } from "../definitions"
import type { ConsoleSectionDetails, ConsoleSectionId } from "../sections"

import { parseConsoleContributedSection } from "../definitions"
import { consoleSectionDetails, consoleSectionRouteName, isConsoleBuiltinSectionId, isConsoleSectionId } from "../sections"
import { requestConsole } from "./request"

export interface ConsoleNavigation {
  auth: false | true | "cloudflare-access"
  /** The build id of the deployed Console when this tab loaded it. `watchConsoleBuild()` compares it. */
  build?: string
  /** Descriptors of the installed sections that owner packages contribute, keyed by section id. */
  contributions: Readonly<Record<ConsoleSectionId, ConsoleContributedSection>>
  /** Names of the registered operations that run app code and that this access may run, such as `workflow.start`. */
  operations: readonly string[]
  projectName?: string
  /** Installed sections that the access may only read. Their write actions are hidden. */
  readOnly: ConsoleSectionId[]
  /** The access may use only some installed sections. The Console then does not call other sections "not enabled". */
  scoped: boolean
  sections: ConsoleSectionId[]
}

const navigationRequests = new Map<string, Promise<ConsoleNavigation | undefined>>()
const navigationSubscribers = new Map<string, Set<(navigation: ConsoleNavigation) => void>>()
const navigationErrors = new Map<string, unknown>()

function parseConsoleNavigation(value: unknown): ConsoleNavigation {
  // SAFETY: Reading an optional property is safe for every non-null JavaScript value; the property remains unknown until validated below.
  const response = value as { auth?: unknown, build?: unknown, contributions?: unknown, operations?: unknown, projectName?: unknown, readOnly?: unknown, scoped?: unknown, sections?: unknown } | null | undefined
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
    ...(typeof response?.build === "string" && response.build ? { build: response.build } : {}),
    contributions,
    operations: Array.isArray(response?.operations) ? response.operations.filter((name): name is string => typeof name === "string") : [],
    ...(typeof response?.projectName === "string" && response.projectName.trim()
      ? { projectName: response.projectName.trim() }
      : {}),
    readOnly: Array.isArray(response?.readOnly) ? response.readOnly.filter((section): section is ConsoleSectionId => isConsoleSectionId(section)) : [],
    scoped: response?.scoped === true,
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

/**
 * Requests the page tools session once per loaded Console. It sets the `vitehub-tools` hint cookie when this person may
 * use a page tool, such as Comments, so the app's pages load those tools. The Console ignores the answer.
 */
function openPageToolsSession(base: string): void {
  const marker = base.lastIndexOf("/api/_vitehub/console/")
  const prefix = marker === -1 ? "" : base.slice(0, marker)
  void fetch(`${prefix}/_vitehub/page/session`, { credentials: "same-origin", headers: { accept: "application/json" } }).catch(() => undefined)
}

export async function loadConsoleNavigation(base: string): Promise<ConsoleNavigation | undefined> {
  let request = navigationRequests.get(base)
  if (!request) {
    request = requestConsole(base)
      .then((value) => {
        navigationErrors.delete(base)
        const navigation = parseConsoleNavigation(value)
        openPageToolsSession(base)
        for (const subscriber of navigationSubscribers.get(base) || []) subscriber(navigation)
        return navigation
      })
      .catch((error: unknown) => {
        navigationRequests.delete(base)
        navigationErrors.set(base, error)
        return undefined
      })
    navigationRequests.set(base, request)
  }
  return await request
}

/** Why the last navigation request of `base` failed, such as a 401 when no one is signed in. */
export function consoleNavigationError(base: string): unknown {
  return navigationErrors.get(base)
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
