import type { ConsoleContributedSection } from "../definitions"
import type { ConsoleSectionDetails, ConsoleSectionId } from "../sections"
import type { RouteLocationNormalized, RouteLocationRaw, RouteRecordRaw, Router } from "vue-router"

import { parseConsoleContributedSection } from "../definitions"
import { consoleSectionDetails, consoleSectionRouteName, isConsoleBuiltinSectionId, isConsoleSectionId } from "../sections"
import { requestConsole } from "./request"

export interface ConsoleNavigation {
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
  /** The route of the dev Setup endpoints. Only a development server sends it. */
  setup?: string
}

/** The Console path of `sections.list`. Views pass it as `sectionsBase`, and the navigation cache keys on it. */
export const consoleSectionsPath = "/_vitehub/api/sections"

const navigationRequests = new Map<string, Promise<ConsoleNavigation | undefined>>()
const navigationSubscribers = new Map<string, Set<(navigation: ConsoleNavigation) => void>>()
const navigationErrors = new Map<string, unknown>()
// The last navigation of each base, so a subscriber that comes after a load or a seed, such as the router of
// `main.js`, still gets it.
const navigationValues = new Map<string, ConsoleNavigation>()

/** Read an untrusted `sections.list` answer. Unknown sections and fields are left out. */
export function parseConsoleNavigation(value: unknown): ConsoleNavigation {
  // SAFETY: Reading an optional property is safe for every non-null JavaScript value; the property remains unknown until validated below.
  const response = value as { contributions?: unknown, operations?: unknown, projectName?: unknown, readOnly?: unknown, scoped?: unknown, sections?: unknown, setup?: unknown } | null | undefined
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
    contributions,
    operations: Array.isArray(response?.operations) ? response.operations.filter((name): name is string => typeof name === "string") : [],
    ...(typeof response?.projectName === "string" && response.projectName.trim()
      ? { projectName: response.projectName.trim() }
      : {}),
    readOnly: Array.isArray(response?.readOnly) ? response.readOnly.filter((section): section is ConsoleSectionId => isConsoleSectionId(section)) : [],
    scoped: response?.scoped === true,
    sections,
    ...(typeof response?.setup === "string" && response.setup.startsWith("/") && !response.setup.startsWith("//") ? { setup: response.setup } : {}),
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
        navigationErrors.delete(base)
        const navigation = parseConsoleNavigation(value)
        navigationValues.set(base, navigation)
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

/**
 * Keep the navigation that `project.get` sent with the project, so the rail and the Overview show it without a
 * `sections.list` call. A load that already started keeps its own answer.
 */
export function seedConsoleNavigation(base: string, navigation: ConsoleNavigation): void {
  if (navigationRequests.has(base)) return
  navigationErrors.delete(base)
  navigationRequests.set(base, Promise.resolve(navigation))
  navigationValues.set(base, navigation)
  for (const subscriber of navigationSubscribers.get(base) || []) subscriber(navigation)
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
  const known = navigationValues.get(base)
  if (known) subscriber(known)
  return () => {
    subscribers.delete(subscriber)
    if (subscribers.size === 0) navigationSubscribers.delete(base)
  }
}

export function createConsoleSectionLoader(base: string): () => Promise<ConsoleSectionId[] | undefined> {
  return async () => (await loadConsoleNavigation(base))?.sections
}

/**
 * Matches every path until the navigation response adds the routes of the contributed sections, so a deep link such
 * as `/queues` does not log a Vue Router "No match found" warning. It never renders: the guard of
 * `resolveConsoleSectionDeepLink` always sends the navigation on.
 */
export const consolePendingSectionRoute: RouteRecordRaw & { name: string } = {
  component: { render: () => null },
  name: "vitehub-console-pending-section",
  path: "/:pathMatch(.*)*",
}

/**
 * Router guard step for a path that only `consolePendingSectionRoute` matches. It waits for `addSectionRoutes`, then
 * sends the navigation to the real route, or to the Overview when the path is still unknown.
 */
export async function resolveConsoleSectionDeepLink(
  router: Router,
  to: RouteLocationNormalized,
  addSectionRoutes: () => Promise<void>,
): Promise<RouteLocationRaw | undefined> {
  if (to.name !== consolePendingSectionRoute.name) return undefined
  await addSectionRoutes()
  return router.resolve(to.fullPath).name === consolePendingSectionRoute.name ? { name: "vitehub-console" } : to.fullPath
}
