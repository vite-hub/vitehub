import { ref, shallowRef } from "vue"

import type { Ref, ShallowRef } from "vue"

import { setConsoleProject } from "./project"
import { consoleProjectProblem, probeConsoleProject } from "./project-link"
import { consoleProjectHost, consoleProjectTarget, createConsoleProjectStore, isMixedContentProject, memoryProjectStorage, normalizeProjectUrl } from "./projects"

import type { ConsoleProjectInfo, ConsoleProjectProbe, ConsoleProjectProblem } from "./project-link"
import type { ConsoleLinkedProject, ConsoleProjectStorage, ConsoleProjectStore, ConsoleProjectTarget } from "./projects"

/**
 * How the Console page started.
 * - `embedded`: the app serves the page, and the app is the only project.
 * - `hosted`: a static site serves the page, and the Console opens the projects that this browser linked.
 */
export type ConsoleProjectsMode = "embedded" | "hosted"

/** What the switcher shows next to a linked project. */
export type ConsoleProjectStatus = "checking" | "ready" | "sign-in" | "unreachable"

/** The state of the boot gate, before the Console shows the project. */
export type ConsoleProjectGate =
  | { kind: "opening" }
  | { kind: "empty" }
  | { kind: "token", rejected: boolean }
  | { kind: "problem", problem: ConsoleProjectProblem }
  | { kind: "ready" }

/** What linking found: the saved project, the token step, or why it failed. */
export type ConsoleProjectLinkResult =
  | { kind: "linked", project: ConsoleLinkedProject }
  | { kind: "token", rejected: boolean, target: ConsoleProjectTarget }
  | { kind: "problem", problem: ConsoleProjectProblem }

interface ConsoleProjectsState {
  mode: ConsoleProjectsMode
  /** The origin of the Console page, such as `https://console.example.com`. */
  pageOrigin: string
  store: ConsoleProjectStore
  /** Load a Console page, such as the Overview after a switch. */
  navigate: (url: string) => void
  /** The Console page that opens a project. */
  home: string
  /** The project that this page opens. In embedded mode it is the app, saved only once it has a token. */
  current: ShallowRef<ConsoleLinkedProject | undefined>
  info: ShallowRef<ConsoleProjectInfo | undefined>
  gate: ShallowRef<ConsoleProjectGate>
  projects: ShallowRef<ConsoleLinkedProject[]>
  statuses: ShallowRef<Readonly<Record<string, ConsoleProjectStatus>>>
  /** The Link project dialog is open. The rail and the search palette open it. */
  linkOpen: Ref<boolean>
}

let state: ConsoleProjectsState | undefined
let resolveReady: (() => void) | undefined
const ready = new Promise<void>((resolve) => {
  resolveReady = resolve
})

function useState(): ConsoleProjectsState {
  // Components that render without the Console boot, such as in tests, see the open app of the page.
  if (state) return state
  const opened = startConsoleProjects({ base: "", home: "/_vitehub/", mode: "embedded", navigate: () => {}, pageOrigin: "http://localhost", storage: memoryProjectStorage() })
  opened.gate.value = { kind: "ready" }
  resolveReady?.()
  return opened
}

/** The project state of the page. `startConsoleProjects()` sets it before the app mounts. */
export function useConsoleProjects(): Readonly<ConsoleProjectsState> {
  return useState()
}

/** Resolves when the Console may send requests to the project, after the boot gate opened it. */
export function consoleProjectReady(): Promise<void> {
  return ready
}

function applyTransport(target: Pick<ConsoleProjectTarget, "base" | "origin">): void {
  const current = state?.current
  setConsoleProject({
    ...target,
    authorization: () => current?.value?.token ? `Bearer ${current.value.token}` : undefined,
  })
}

/**
 * Start the project state. Embedded mode opens the app of the page, at `base`. Hosted mode opens the active linked
 * project, or the first one, and has no project before the first link.
 */
export function startConsoleProjects(options: {
  base: string
  home: string
  mode: ConsoleProjectsMode
  navigate: (url: string) => void
  pageOrigin: string
  storage: ConsoleProjectStorage
}): ConsoleProjectsState {
  const store = createConsoleProjectStore(options.storage)
  const projects = store.list()
  let current: ConsoleLinkedProject | undefined
  if (options.mode === "embedded") {
    const url = `${options.pageOrigin}${options.base}`
    current = store.find(url) ?? { id: "", url }
  }
  else {
    current = store.active() ?? projects[0]
    if (current && !store.active()) store.select(current.id)
  }
  const started: ConsoleProjectsState = {
    current: shallowRef(current),
    gate: shallowRef(options.mode === "hosted" && !current ? { kind: "empty" } : { kind: "opening" }),
    home: options.home,
    info: shallowRef(),
    linkOpen: ref(false),
    mode: options.mode,
    navigate: options.navigate,
    pageOrigin: options.pageOrigin,
    projects: shallowRef(projects),
    statuses: shallowRef({}),
    store,
  }
  state = started
  // The embedded Console sends app paths to its own origin, so cookies of the app still work.
  if (options.mode === "embedded") applyTransport({ origin: "", base: options.base })
  else if (current) applyTransport(consoleProjectTarget(current))
  return started
}

function problemContext(target: ConsoleProjectTarget): { consoleOrigin: string, host: string, url: string } {
  return { consoleOrigin: useState().pageOrigin, host: consoleProjectHost(target), url: target.url }
}

function open(info: ConsoleProjectInfo): void {
  const projects = useState()
  projects.info.value = info
  const current = projects.current.value
  // A hosted Console keeps the latest project name, so the switcher shows it before the project answers.
  if (current?.id && info.name && info.name !== current.label) {
    projects.current.value = projects.store.save({ url: current.url, label: info.name })
    projects.projects.value = projects.store.list()
  }
  if (current?.id) projects.statuses.value = { ...projects.statuses.value, [current.id]: "ready" }
  projects.gate.value = { kind: "ready" }
  resolveReady?.()
}

/** Embedded mode opens the app unless it asks for a Console token. The app's own pages show the other sign-in states. */
function gateOf(probe: ConsoleProjectProbe, target: ConsoleProjectTarget): ConsoleProjectGate | undefined {
  if (probe.kind === "ready") return undefined
  if (probe.kind === "token") return { kind: "token", rejected: probe.rejected }
  return useState().mode === "embedded" ? undefined : { kind: "problem", problem: consoleProjectProblem(probe, problemContext(target)) }
}

/** Read `project.get` of the current project and open it, or set the gate that says what it needs. */
export async function openConsoleProject(): Promise<void> {
  const projects = useState()
  const current = projects.current.value
  if (!current) {
    projects.gate.value = { kind: "empty" }
    return
  }
  projects.gate.value = { kind: "opening" }
  const target = projects.mode === "embedded" ? { ...consoleProjectTarget(current), origin: "" } : consoleProjectTarget(current)
  const probe = await probeConsoleProject(target, current.token)
  const gate = gateOf(probe, consoleProjectTarget(current))
  if (gate) {
    projects.gate.value = gate
    return
  }
  if (probe.kind === "ready") open(probe.info)
  else {
    // The embedded Console opens and shows its own sign-in state.
    projects.gate.value = { kind: "ready" }
    resolveReady?.()
  }
}

/**
 * Try a Console token for the current project. A token that the project accepts is saved with the project, and the
 * Console opens. Returns the gate when the token did not open it.
 */
export async function signInConsoleProject(token: string): Promise<ConsoleProjectGate> {
  const projects = useState()
  const current = projects.current.value
  if (!current) return projects.gate.value
  const target = consoleProjectTarget(current)
  const probe = await probeConsoleProject(projects.mode === "embedded" ? { ...target, origin: "" } : target, token)
  if (probe.kind !== "ready") return gateOf(probe, target) ?? { kind: "problem", problem: consoleProjectProblem(probe, problemContext(target)) }
  projects.current.value = projects.store.save({ url: current.url, label: probe.info.name, token })
  projects.projects.value = projects.store.list()
  open(probe.info)
  return projects.gate.value
}

/**
 * Link a project from a URL that a person typed, with a token for the second step. A project that opens is saved and
 * becomes active. The caller then loads the Console for it with `switchConsoleProject()`.
 */
export async function linkConsoleProject(input: string, token?: string): Promise<ConsoleProjectLinkResult> {
  const projects = useState()
  const normalized = normalizeProjectUrl(input)
  if ("error" in normalized) return { kind: "problem", problem: { title: "Check the URL", message: normalized.error } }
  const { target } = normalized
  if (isMixedContentProject(target, new URL(projects.pageOrigin).protocol)) {
    return { kind: "problem", problem: { title: "Use HTTPS", message: `This Console runs on HTTPS, so the browser blocks ${target.origin}. Use the https:// URL of the project.` } }
  }
  const existing = projects.store.find(target.url)
  const probe = await probeConsoleProject(target, token ?? existing?.token)
  if (probe.kind === "token") return { kind: "token", rejected: probe.rejected && token !== undefined, target }
  if (probe.kind !== "ready") return { kind: "problem", problem: consoleProjectProblem(probe, problemContext(target)) }
  const project = projects.store.save({ url: target.url, label: probe.info.name, token: token ?? existing?.token })
  projects.store.select(project.id)
  projects.projects.value = projects.store.list()
  return { kind: "linked", project }
}

/** Make a linked project active and load the Console for it. */
export function switchConsoleProject(id: string): void {
  const projects = useState()
  projects.store.select(id)
  projects.navigate(projects.home)
}

/**
 * Remove a project and its token from this browser. The project itself does not change. When it was the current
 * project, the Console loads the next one, or the empty state.
 */
export function forgetConsoleProject(id: string): void {
  const projects = useState()
  projects.store.forget(id)
  projects.projects.value = projects.store.list()
  if (projects.current.value?.id === id) projects.navigate(projects.home)
}

/** Remove the Console token of the embedded app from this browser, and load the sign-in form again. */
export function signOutConsoleProject(): void {
  const projects = useState()
  const current = projects.current.value
  if (current?.id) projects.store.forget(current.id)
  projects.navigate(projects.home)
}

/** Read `project.get` of every linked project with its token, for the status dots of the switcher. */
export async function checkConsoleProjects(): Promise<void> {
  const projects = useState()
  const list = projects.store.list()
  projects.projects.value = list
  // The open project answered at boot, so only the others need a request.
  const opened = projects.gate.value.kind === "ready" ? projects.current.value?.id : undefined
  const pending = list.filter(project => project.id !== opened)
  projects.statuses.value = { ...projects.statuses.value, ...Object.fromEntries(pending.map(project => [project.id, "checking" as const])) }
  await Promise.all(pending.map(async (project) => {
    const probe = await probeConsoleProject(consoleProjectTarget(project), project.token).catch((): ConsoleProjectProbe => ({ kind: "unreachable" }))
    const status: ConsoleProjectStatus = probe.kind === "ready" ? "ready" : probe.kind === "token" || probe.kind === "oauth" || probe.kind === "sign-in" ? "sign-in" : "unreachable"
    projects.statuses.value = { ...projects.statuses.value, [project.id]: status }
  }))
}
