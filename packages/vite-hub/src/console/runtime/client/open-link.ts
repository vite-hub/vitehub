/**
 * Links that open one page of a project in the hosted Console:
 * `/open?project=<app origin and mount>&path=<Console path>`, as `hostedConsoleUrl()` of `@vite-hub/runtime` builds
 * them. A project that this browser linked opens at the path. Another project opens the Link project dialog with the
 * URL filled in, and the Console goes to the path after the link. The URL holds no secret.
 */

import { normalizeConsolePath, normalizeConsoleProjectUrl } from "@vite-hub/runtime"
import { shallowRef } from "vue"

import type { ShallowRef } from "vue"

import { useConsoleProjects } from "./project-session"
import { consoleProjectTarget, createConsoleProjectStore } from "./projects"

import type { ConsoleProjectProblem } from "./project-link"
import type { ConsoleLinkedProject, ConsoleProjectStorage, ConsoleProjectTarget } from "./projects"

/** What an `/open` URL asks for: a project and a Console path, or why the URL cannot open a project. */
export type ConsoleOpenRequest =
  | { kind: "open", target: ConsoleProjectTarget, path: string }
  | { kind: "problem", problem: ConsoleProjectProblem }

/**
 * Read the query of an `/open` URL, such as `?project=https://app.example.com&path=/kv`. The project must be `https:`,
 * or `http:` on a loopback host. The path must be a Console path: an absolute or protocol-relative URL is refused, so
 * the link cannot send the browser to another site. A missing path opens the Overview.
 */
export function parseConsoleOpenQuery(search: string): ConsoleOpenRequest {
  const params = new URLSearchParams(search)
  const project = params.get("project")?.trim()
  if (!project) {
    return { kind: "problem", problem: { title: "This link names no project", message: "Add the app URL to the link, such as /open?project=https://app.example.com&path=/kv." } }
  }
  const url = normalizeConsoleProjectUrl(project)
  if (!url) {
    return { kind: "problem", problem: { title: "Check the project URL", message: `${project} is not a project URL. The Console opens https:// apps, or http:// apps on localhost.` } }
  }
  const rawPath = params.get("path")?.trim() || "/"
  const path = normalizeConsolePath(rawPath)
  if (!path) {
    return { kind: "problem", problem: { title: "Check the Console path", message: `${rawPath} is not a Console page. Use a path that starts with one /, such as /agents/<agent>.` } }
  }
  return { kind: "open", target: consoleProjectTarget({ url }), path }
}

/** The Console page of `path` below the Console base, such as `/kv` below `/`. */
export function consoleOpenPage(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path}`
}

/** The parts of `window` that `startConsoleOpen()` reads and changes. */
export interface ConsoleOpenPage {
  location: { pathname: string, search: string }
  history: { state: unknown, replaceState(data: unknown, unused: string, url: string): void }
}

const pendingOpen: ShallowRef<{ target: ConsoleProjectTarget, path: string } | undefined> = shallowRef()

/** The project of an `/open` URL that waits for the Link project dialog, and the path to open after the link. */
export function useConsoleOpenRequest(): Readonly<ShallowRef<{ target: ConsoleProjectTarget, path: string } | undefined>> {
  return pendingOpen
}

/**
 * Handle the `/open` page below `base` before the Console opens a project. It returns `undefined` on another page.
 * - A linked project becomes active, and the address changes to the Console path, so the router opens that page.
 * - Another project, or a URL that cannot open one, changes the address to the Console home. Pass the result to
 *   `continueConsoleOpen()` after `startConsoleProjects()`.
 */
export function startConsoleOpen(page: ConsoleOpenPage, base: string, storage: ConsoleProjectStorage): ConsoleOpenRequest | undefined {
  if (page.location.pathname.replace(/\/+$/, "") !== `${base.replace(/\/+$/, "")}/open`) return undefined
  const request = parseConsoleOpenQuery(page.location.search)
  const store = createConsoleProjectStore(storage)
  const linked = request.kind === "open" ? store.find(request.target.url) : undefined
  if (linked) store.select(linked.id)
  page.history.replaceState(page.history.state, "", linked && request.kind === "open" ? consoleOpenPage(base, request.path) : consoleOpenPage(base, "/"))
  return linked ? undefined : request
}

/** Show what an `/open` URL needs after the project state started: the Link project dialog, or the problem. */
export function continueConsoleOpen(request: ConsoleOpenRequest): void {
  const projects = useConsoleProjects()
  if (request.kind === "problem") {
    projects.gate.value = { kind: "problem", problem: request.problem }
    return
  }
  pendingOpen.value = { target: request.target, path: request.path }
  projects.linkOpen.value = true
}

/** Forget the project of the `/open` URL, such as when the person closes the Link project dialog. */
export function cancelConsoleOpen(): void {
  pendingOpen.value = undefined
}

/**
 * After the Link project dialog linked `project`: when it is the project of the `/open` URL, load the Console at its
 * path and return true. `linkConsoleProject()` already made the project active.
 */
export function finishConsoleOpen(project: ConsoleLinkedProject): boolean {
  const request = pendingOpen.value
  if (!request || request.target.url !== project.url) return false
  pendingOpen.value = undefined
  const projects = useConsoleProjects()
  projects.navigate(consoleOpenPage(projects.home, request.path))
  return true
}
