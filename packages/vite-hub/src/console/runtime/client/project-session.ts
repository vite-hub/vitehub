import { ref, shallowRef } from "vue"

import type { Ref, ShallowRef } from "vue"

import { ConsolePendingLinkStorageError, consolePendingLinksStorageKey, createConsolePendingLinkStore, parseConsoleLinkFragment } from "./pending-links"
import { setConsoleProject } from "./project"
import { consoleProjectProblem, probeConsoleProject } from "./project-link"
import { useConsoleToast } from "./toast"
import { consoleProjectHost, consoleProjectTarget, createConsoleProjectStore, isMixedContentProject, memoryProjectStorage, normalizeProjectUrl } from "./projects"

import type { ConsoleLinkRequest, ConsolePendingLinkLocks, ConsolePendingLinkStore, ConsolePendingLinkTicket } from "./pending-links"
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
  /** The `/link` page of a hosted Console: confirm the app of a one-time link, or why the link cannot be used. */
  | { kind: "link", request: ConsoleLinkRequest }
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
  /** The one-time links for new projects, in the same storage as the projects. */
  pendingLinks: ConsolePendingLinkStore
  /** `navigator.locks`, so one tab at a time confirms a link. Without it the Console confirms no link. */
  pendingLinkLocks?: ConsolePendingLinkLocks
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
  /** `false` when the browser does not keep the project list, so it ends with the page. */
  persistent: Ref<boolean>
}

let state: ConsoleProjectsState | undefined
let probeVersion = 0
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
  /** `navigator.locks`, so one tab at a time confirms a link. Without it the Console confirms no link. */
  pendingLinkLocks?: ConsolePendingLinkLocks
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
    persistent: ref(options.storage.persistent !== false),
    pendingLinks: createConsolePendingLinkStore(options.storage),
    pendingLinkLocks: options.pendingLinkLocks,
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
  announceVolatile()
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
  const version = ++probeVersion
  projects.gate.value = { kind: "opening" }
  const target = projects.mode === "embedded" ? { ...consoleProjectTarget(current), origin: "" } : consoleProjectTarget(current)
  const probe = await probeConsoleProject(target, current.token)
  // A switch or a newer attempt can finish first. Only the current attempt may open the gate or update the project.
  if (projects !== state || version !== probeVersion || projects.current.value !== current) return
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
  const version = ++probeVersion
  const target = consoleProjectTarget(current)
  const probe = await probeConsoleProject(projects.mode === "embedded" ? { ...target, origin: "" } : target, token)
  if (projects !== state || version !== probeVersion || projects.current.value !== current) return projects.gate.value
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

/** What the Console says, once, when the browser does not keep the project list. */
export const consoleProjectsVolatileNote = "This browser does not let the Console keep data, so linked projects and tokens last until the page reloads."
let volatileAnnounced = false

/** Say once, in a toast of the open Console, that the list ends with the page. Before that, the gate shows the note. */
function announceVolatile(): void {
  if (volatileAnnounced || state?.persistent.value !== false || state.gate.value.kind !== "ready") return
  // An embedded app without a token stores nothing, so the note would only be noise there.
  if (state.mode === "embedded" && !state.current.value?.token) return
  volatileAnnounced = true
  useConsoleToast().show({ duration: 8_000, title: consoleProjectsVolatileNote })
}

/** The project storage stopped keeping the list, such as after a write to full storage failed. */
export function noteConsoleProjectsVolatile(): void {
  if (!state) return
  state.persistent.value = false
  announceVolatile()
}

/**
 * Make a linked project active and load the Console for it. Before the Console shows a project, such as after the first
 * link, it opens the project in place: nothing has loaded yet, and a list that lives only in memory stays.
 */
export function switchConsoleProject(id: string): void {
  const projects = useState()
  projects.store.select(id)
  const project = projects.store.get(id)
  if (projects.gate.value.kind === "ready" || !project) {
    projects.navigate(projects.home)
    return
  }
  projects.current.value = project
  projects.projects.value = projects.store.list()
  applyTransport(consoleProjectTarget(project))
  void openConsoleProject()
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

/**
 * Make a one-time link for a new project in this browser. The future CLI integration will give the app `pendingId`
 * and `verifier` (the value of `VITEHUB_CONSOLE_TOKEN_SHA256`). Ticket creation stays out of the UI until the CLI and
 * host verifier support are available. The secret stays in this browser until the person confirms the app on `/link`.
 */
export function createConsolePendingLink(): Promise<ConsolePendingLinkTicket> {
  return useState().pendingLinks.create()
}

/** Why a pending link cannot link a project. */
const pendingLinkProblems: Record<"expired" | "unknown", ConsoleProjectProblem> = {
  expired: { title: "This link expired", message: "A link works for 24 hours. Make a new link in this Console, and run the new command." },
  unknown: { title: "This link cannot be used here", message: "This link was made in another browser or already used. Open the Console where you started the project, or relink." },
}

const pendingLinkStorageProblem: ConsoleProjectProblem = {
  title: "Allow browser storage",
  message: "The Console could not save this link safely. Allow local storage or free space, then reopen the original link and try again.",
}

/**
 * Show the `/link` page for the fragment of its URL, such as `#p=<pendingId>&url=<appOrigin>`. It sends no request: the
 * app gets the secret only after the person confirms it with `confirmConsoleLink()`.
 */
export function startConsoleLink(hash: string): ConsoleLinkRequest {
  const projects = useState()
  const parsed = parseConsoleLinkFragment(hash)
  let request = parsed
  try {
    const lookup = parsed.kind === "confirm" ? projects.pendingLinks.lookup(parsed.pendingId).kind : "pending"
    if (lookup !== "pending") request = { kind: "problem", problem: pendingLinkProblems[lookup] }
  }
  catch (error) {
    if (!(error instanceof ConsolePendingLinkStorageError)) throw error
    request = { kind: "problem", problem: pendingLinkStorageProblem }
  }
  projects.gate.value = { kind: "link", request }
  return request
}

/**
 * What confirming a link did. `final` is true when the link cannot be used again, so the page shows only the problem.
 */
export type ConsoleLinkResult =
  | { kind: "linked", project: ConsoleLinkedProject }
  | { kind: "problem", problem: ConsoleProjectProblem, final: boolean }

/**
 * Link the app of a pending link after the person confirmed it: send the secret of the link as the Console token of the
 * app, save the project with that token, and delete the link. The caller then loads the project with
 * `switchConsoleProject()`. A link that failed stays pending, so the person can fix the app and try again.
 */
export async function confirmConsoleLink(pendingId: string, target: ConsoleProjectTarget): Promise<ConsoleLinkResult> {
  const projects = useState()
  if (!projects.pendingLinkLocks) {
    return { kind: "problem", final: false, problem: { title: "Update your browser", message: "This browser cannot let only one tab use a link, so the Console does not send the key. Open the link in a current browser, on an https:// Console." } }
  }
  // Without Web Locks, two tabs could both send the secret, so the Console sends nothing. With them, one tab at a time
  // runs the whole claim: check, bind to the target, send, check again, save, and remove.
  try {
    return await projects.pendingLinkLocks.request(`${consolePendingLinksStorageKey}:${pendingId}`, () => confirmLockedConsoleLink(projects, pendingId, target))
  }
  catch (error) {
    if (!(error instanceof ConsolePendingLinkStorageError)) throw error
    return { kind: "problem", problem: pendingLinkStorageProblem, final: false }
  }
}

async function confirmLockedConsoleLink(projects: ConsoleProjectsState, pendingId: string, target: ConsoleProjectTarget): Promise<ConsoleLinkResult> {
  const lookup = projects.pendingLinks.lookup(pendingId)
  if (lookup.kind !== "pending") return { kind: "problem", problem: pendingLinkProblems[lookup.kind], final: true }
  if (lookup.link.targetUrl && lookup.link.targetUrl !== target.url) {
    return { kind: "problem", final: true, problem: { title: "This link belongs to another project", message: `Retry the link for ${lookup.link.targetUrl}, or make a new link for this project and run the new command.` } }
  }
  projects.pendingLinks.bind(pendingId, target.url)
  const probe = await probeConsoleProject(target, lookup.link.secret)
  if (probe.kind === "token") {
    return {
      kind: "problem",
      final: false,
      problem: {
        title: "The host secret does not match",
        message: `${consoleProjectHost(target)} refused the key of this link. Its VITEHUB_CONSOLE_TOKEN_SHA256 is not the hash from this link. Run the command again or relink.`,
      },
    }
  }
  if (probe.kind !== "ready") return { kind: "problem", problem: consoleProjectProblem(probe, problemContext(target)), final: false }
  // Expiry or removal while the request ran still prevents saving the project.
  if (projects.pendingLinks.lookup(pendingId).kind !== "pending") return { kind: "problem", problem: pendingLinkProblems.unknown, final: true }
  projects.pendingLinks.remove(pendingId)
  const project = projects.store.save({ url: target.url, label: probe.info.name, token: lookup.link.secret })
  projects.store.select(project.id)
  projects.projects.value = projects.store.list()
  return { kind: "linked", project }
}
