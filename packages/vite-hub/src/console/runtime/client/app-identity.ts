import { computed, shallowRef } from "vue"

import type { ComputedRef } from "vue"
import type { ConsoleLinkedProject } from "./projects"
import { consoleProjectDisplayName, useConsoleProjects } from "./project-session"
import { consoleProjectHost, consoleProjectTarget } from "./projects"

/** The name, host, and logo of an app, as the sidebar, the app switcher, and the page header show them. */
export interface ConsoleAppIdentity {
  name: string
  /** The host and mount, such as `app.example.com/portal`. Empty when the app has no URL. */
  host: string
  /** The favicon of the app. The logo shows the first letter of the name when it does not load. */
  icon?: string
  letter: string
}

/** The identity of a linked app. The site serves its favicon at `/favicon.ico` of its origin. */
export function consoleAppIdentity(project: ConsoleLinkedProject, name = consoleProjectDisplayName(project)): ConsoleAppIdentity {
  const { origin } = consoleProjectTarget(project)
  return { name, host: consoleProjectHost(project), icon: `${origin}/favicon.ico`, letter: letterOf(name) }
}

function letterOf(name: string): string {
  return name.trim().charAt(0).toUpperCase() || "A"
}

// The navigation that the sidebar loads also names the app. It is the name when `project.get` reported none.
const navigationName = shallowRef<string>()

/** Keep the app name that the navigation reported, for the header and the sidebar. */
export function setConsoleNavigationName(name: string | undefined): void {
  navigationName.value = name
}

/** The app that the Console shows now. */
export function useConsoleApp(): ComputedRef<ConsoleAppIdentity> {
  const projects = useConsoleProjects()
  return computed(() => {
    const current = projects.current.value
    const name = projects.info.value?.name || navigationName.value || (current ? consoleProjectDisplayName(current) : "App")
    return current ? consoleAppIdentity(current, name) : { name, host: "", letter: letterOf(name) }
  })
}
