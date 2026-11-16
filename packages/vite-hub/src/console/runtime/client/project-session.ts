import { clearDevice, openDevice, setDeviceAccount } from "@vite-hub/device"
import { ref, shallowRef, watch } from "vue"

import type { Ref, ShallowRef } from "vue"

import { setConsoleProject } from "./project"
import { consoleProjectProblem, probeConsoleProject } from "./project-link"
import { consoleProjectHost, consoleProjectTarget, consoleProjectsStorageKey, createConsoleProjectStore, memoryProjectStorage } from "./projects"
import { consoleResponseError } from "./request"
import { consoleSectionsPath, reloadConsoleNavigation, seedConsoleNavigation } from "./sections"
import { consoleAccountKey, consoleDeviceVersion, consoleProjectKey, readStored } from "./stored"

import type { ConsoleAccount, ConsoleAccountProject } from "./account"
import type { ConsoleProjectInfo, ConsoleProjectProbe, ConsoleProjectProblem } from "./project-link"
import type { ConsoleLinkedProject, ConsoleProjectStorage, ConsoleProjectStore, ConsoleProjectTarget } from "./projects"
import type { ConsoleStoredRead } from "./stored"

/**
 * How the Console page started.
 * - `embedded`: the page and the app share one origin, and the app is the only project. The Console playground runs
 *   this way.
 * - `account`: the Console app serves the page. People sign in, and the projects of their team come from the Console
 *   server, which signs each call to the project.
 */
export type ConsoleProjectsMode = "embedded" | "account"

/** What the switcher shows next to a linked project. */
export type ConsoleProjectStatus = "checking" | "ready" | "sign-in" | "unreachable"

/** The state of the boot gate, before the Console shows the project. */
export type ConsoleProjectGate =
  | { kind: "opening" }
  | { kind: "empty" }
  /** `home` offers a way back to the Console instead of a retry. */
  | { kind: "problem", problem: ConsoleProjectProblem, home?: boolean }
  /**
   * The sign-in page of an `account` Console, or the `/invite/<id>` page of an invitation to a team. `returnTo` is the
   * `/open` link that the person followed, which the sign-in opens again when it completes.
   */
  | { kind: "account", invitation?: string, returnTo?: string }
  /** An `account` Console linked the project, but the project does not have the public key of the link yet. */
  | { kind: "setup", project: ConsoleAccountProject }
  /** A page of an `account` Console that belongs to no project: the onboarding, the team, or the account settings. */
  | { kind: "home", page: ConsoleAccountPage }
  | { kind: "ready" }

/** The pages of an `account` Console outside the projects. Each one has its own path, such as `/team`. */
export const consoleAccountPages = ["home", "team", "team-settings", "settings"] as const
export type ConsoleAccountPage = typeof consoleAccountPages[number]

function accountPageOf(pathname: string): ConsoleAccountPage | undefined {
  const page = /^\/([a-z-]+)\/?$/.exec(pathname)?.[1]
  return consoleAccountPages.find(item => item === page)
}

interface ConsoleProjectsState {
  mode: ConsoleProjectsMode
  /** The origin of the Console page, such as `https://console.example.com`. */
  pageOrigin: string
  store: ConsoleProjectStore
  /** Load a Console page, such as the Overview after a switch. */
  navigate: (url: string) => void
  /** The Console page that opens a project. */
  home: string
  /** The project that this page opens. In embedded mode it is the app of the page. */
  current: ShallowRef<ConsoleLinkedProject | undefined>
  info: ShallowRef<ConsoleProjectInfo | undefined>
  gate: ShallowRef<ConsoleProjectGate>
  projects: ShallowRef<ConsoleLinkedProject[]>
  statuses: ShallowRef<Readonly<Record<string, ConsoleProjectStatus>>>
  /**
   * The name that each project reported, by project id: in `project.get`, or in the check of the team sidebar. The
   * device keeps those answers, so the next visit shows the names at once.
   */
  names: ShallowRef<Readonly<Record<string, string>>>
  /** The Link an app dialog is open. The rail and the search palette open it. */
  linkOpen: Ref<boolean>
  /** The signed-in account of an `account` Console. */
  account: ShallowRef<ConsoleAccount | undefined>
  /**
   * The frame of a project that is still opening in an `account` Console: the rail of an open app, or the team sidebar.
   * It matches the first paint of the page, so a slow app does not change the frame twice.
   */
  openingView: "app" | "shell"
}

let state: ConsoleProjectsState | undefined
let probeVersion = 0
/** The `project.get` of the app of a `?app=<id>` link, sent while the account loads. */
let earlyProbe: { id: string, read: ConsoleStoredRead<ConsoleProjectProbe> } | undefined
/** The `project.get` read of the open app. It lives until another app opens, so it can start over on the naming. */
let projectRead: { id: string, read: ConsoleStoredRead<ConsoleProjectProbe> } | undefined
/** The page loads again: the first reload wins, so a sign-out and a read that starts over do not navigate twice. */
let reloading = false
/** The project reads whose answer an `openConsoleProject()` call waits for. That call applies it, not `followProject()`. */
const awaited = new Set<ConsoleStoredRead<ConsoleProjectProbe>>()
/** The account read of an `account` Console. It lives as long as the page, and each answer names the device account. */
let accountRead: ConsoleStoredRead<ConsoleAccount | undefined> | undefined
/**
 * The page opened from the account that the device kept. Only then does a stored `project.get` answer open the app:
 * the stored answers belong to that account.
 */
let openedFromDevice = false
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

/**
 * Where the requests of a project go. An `account` Console sends them to its own server, at `/p/<project id>`, with the
 * session cookie of the Console. The server signs them for the project.
 */
function targetOf(projects: Pick<ConsoleProjectsState, "mode">, project: Pick<ConsoleLinkedProject, "id" | "url">): ConsoleProjectTarget {
  const target = consoleProjectTarget(project)
  return projects.mode === "account" ? { ...target, origin: "", base: `/p/${encodeURIComponent(project.id)}` } : target
}

function applyTransport(target: Pick<ConsoleProjectTarget, "base" | "origin">): void {
  const projects = useState()
  if (projects.mode === "account") {
    const app = projects.current.value ? consoleProjectTarget(projects.current.value) : undefined
    setConsoleProject({ ...target, ...(app ? { app: { origin: app.origin, base: app.base } } : {}), remote: true })
    return
  }
  setConsoleProject(target)
}

/** Start the project state. Embedded mode opens the app of the page, at `base`. Account mode opens the active project. */
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
    gate: shallowRef(options.mode !== "embedded" && !current ? { kind: "empty" } : { kind: "opening" }),
    account: shallowRef(),
    openingView: "app",
    home: options.home,
    info: shallowRef(),
    linkOpen: ref(false),
    mode: options.mode,
    names: shallowRef({}),
    navigate: options.navigate,
    pageOrigin: options.pageOrigin,
    projects: shallowRef(projects),
    statuses: shallowRef({}),
    store,
  }
  state = started
  // The embedded Console sends app paths to its own origin.
  if (options.mode === "embedded") applyTransport({ origin: "", base: options.base })
  else if (current) applyTransport(targetOf(started, current))
  return started
}

function open(info: ConsoleProjectInfo): void {
  const projects = useState()
  projects.info.value = info
  const current = projects.current.value
  if (current?.id) {
    projects.statuses.value = { ...projects.statuses.value, [current.id]: "ready" }
    rememberConsoleProjectName(current.id, info.name)
    if (projects.mode === "account") rememberAccountProject(projects.account.value?.teamId, current.id)
  }
  // The rail and the Overview read the sections that came with `project.get`, so they need no second call. A newer
  // answer replaces the stored one, so a section that the access lost goes away. An answer without navigation drops the
  // one of a stored answer, and the sections come from `sections.list` again.
  if (info.navigation) seedConsoleNavigation(consoleSectionsPath, info.navigation)
  else reloadConsoleNavigation(consoleSectionsPath)
  projects.gate.value = { kind: "ready" }
  resolveReady?.()
}

/** The `project.get` read of a project of an `account` Console. The device keeps its answer for the next visit. */
function readProject(id: string): ConsoleStoredRead<ConsoleProjectProbe> {
  return readStored(consoleProjectKey(id), ({ signal }) => probeConsoleProject({ origin: "", base: `/p/${encodeURIComponent(id)}` }, { signal }))
}

/** Embedded mode opens the app whatever it answers. Account mode shows the setup step or why the project did not open. */
function gateOf(probe: ConsoleProjectProbe, target: ConsoleProjectTarget): ConsoleProjectGate | undefined {
  if (probe.kind === "ready") return undefined
  const projects = useState()
  if (projects.mode === "embedded") return undefined
  // The project has no public key for this link yet, or another one: the person sets the variable of this link. An app
  // without `console: true` yet has no Console route at all. The setup page asks for both, so the person gets the
  // variable and the next step in one place instead of a retry.
  if (probe.kind === "signed" || probe.kind === "missing" || (probe.kind === "failed" && probe.code === "CONSOLE_KEY_NOT_CONFIGURED")) {
    const linked = projects.account.value?.projects.find(project => project.url === target.url)
    if (linked) return { kind: "setup", project: linked }
  }
  return { kind: "problem", problem: consoleProjectProblem(probe, { host: consoleProjectHost(target), url: target.url }) }
}

/**
 * Read `project.get` of the current project and open it, or set the gate that says what it needs. An `account` Console
 * opens at once from the answer that the device kept, then applies the answer of this visit: another navigation, or
 * the step that the project needs now.
 */
export async function openConsoleProject(): Promise<void> {
  const projects = useState()
  const current = projects.current.value
  if (!current) {
    projects.gate.value = { kind: "empty" }
    return
  }
  const version = ++probeVersion
  projects.gate.value = { kind: "opening" }
  // The boot sent `project.get` while the account loaded. Its answer counts only for the app that opens.
  const early = earlyProbe
  earlyProbe = undefined
  if (early && early.id !== current.id) early.read.stop()
  let probe: ConsoleProjectProbe
  if (projects.mode === "embedded") probe = await probeConsoleProject({ ...consoleProjectTarget(current), origin: "" })
  else {
    let read = projectRead?.id === current.id ? projectRead.read : undefined
    // A retry of the open app asks again, and the answer of this visit decides: the stored one opened the app only once.
    if (read) void read.read.refresh()
    else {
      projectRead?.read.stop()
      read = early?.id === current.id ? early.read : readProject(current.id)
      projectRead = { id: current.id, read }
      followProject(read, current)
      // Only an answer that opened the project counts. A stored refusal waits for the project.
      if (openedFromDevice && read.stored?.kind === "ready") open(read.stored.info)
    }
    awaited.add(read)
    try {
      probe = await read.answer()
    }
    finally {
      awaited.delete(read)
    }
  }
  // A switch or a newer attempt can finish first. Only the current attempt may open the gate or update the project.
  if (projects !== state || version !== probeVersion || projects.current.value !== current) return
  applyProbe(probe, current)
}

/**
 * Apply each later answer of the `project.get` read of the open app: the read starts over when the page names its
 * account, or when another tab clears the device or signs in as another person.
 */
function followProject(read: ConsoleStoredRead<ConsoleProjectProbe>, current: ConsoleLinkedProject): void {
  const projects = useState()
  // `sync`, so the watcher runs while an `openConsoleProject()` call still waits for the same answer and applies it.
  watch(read.read.status, (status) => {
    if (status !== "success" || awaited.has(read) || !read.read.data.value) return
    if (projects !== state || projectRead?.read !== read || projects.current.value !== current) return
    // An account page that the person opened, such as Settings, stays. The next open of the app reads the answer.
    const gate = projects.gate.value.kind
    if (gate === "home" || gate === "account" || gate === "empty") return
    applyProbe(read.read.data.value, current)
  }, { flush: "sync" })
}

/** Open the project with its `project.get` answer, or set the gate that says what it needs. */
function applyProbe(probe: ConsoleProjectProbe, current: ConsoleLinkedProject): void {
  const projects = useState()
  const gate = gateOf(probe, consoleProjectTarget(current))
  if (gate) {
    projects.gate.value = gate
    return
  }
  if (probe.kind === "ready") open(probe.info)
  else {
    // The embedded Console opens and shows the errors of its sections.
    projects.gate.value = { kind: "ready" }
    resolveReady?.()
  }
}

/**
 * Make a project of the team active and load the Console for it. Before the Console shows a project, it opens the
 * project in place.
 */
export function switchConsoleProject(id: string): void {
  const projects = useState()
  projects.store.select(id)
  if (projects.mode === "account") rememberAccountProject(projects.account.value?.teamId, id)
  const project = projects.store.get(id)
  if (projects.gate.value.kind === "ready" || !project) {
    projects.navigate(projects.home)
    return
  }
  projects.current.value = project
  projects.projects.value = projects.store.list()
  applyTransport(targetOf(projects, project))
  void openConsoleProject()
}

/** Unlink a project from the team of an `account` Console. The project itself does not change. */
export async function forgetConsoleProject(id: string): Promise<void> {
  const projects = useState()
  if (projects.mode !== "account" || !projects.store.get(id)) return
  // The Console server removes the project and its key for the whole team.
  const { unlinkConsoleAccountProject } = await import("./account")
  await unlinkConsoleAccountProject(id)
  reloadConsoleAccount()
}

/** Read `project.get` of every project of the team, for the status dots of the switcher. */
export async function checkConsoleProjects(): Promise<void> {
  const projects = useState()
  const list = projects.store.list()
  projects.projects.value = list
  // The open project answered at boot, so only the others need a request.
  const opened = projects.gate.value.kind === "ready" ? projects.current.value?.id : undefined
  const pending = list.filter(project => project.id !== opened)
  projects.statuses.value = { ...projects.statuses.value, ...Object.fromEntries(pending.map(project => [project.id, "checking" as const])) }
  await Promise.all(pending.map(async (project) => {
    const stored = projects.mode === "account" ? readProject(project.id) : undefined
    // The stored answer names the project while it answers again.
    if (stored?.stored?.kind === "ready") rememberConsoleProjectName(project.id, stored.stored.info.name)
    const answer = stored ? stored.answer() : probeConsoleProject(targetOf(projects, project))
    const probe = await answer.catch((): ConsoleProjectProbe => ({ kind: "unreachable" }))
    stored?.stop()
    const status: ConsoleProjectStatus = probe.kind === "ready" ? "ready" : probe.kind === "signed" ? "sign-in" : "unreachable"
    projects.statuses.value = { ...projects.statuses.value, [project.id]: status }
    if (probe.kind === "ready") rememberConsoleProjectName(project.id, probe.info.name)
  }))
}

/** Keep the name that a project of an `account` Console reported, for `consoleProjectDisplayName()`. */
export function rememberConsoleProjectName(id: string, name: string | undefined): void {
  const projects = useState()
  const value = name?.trim()
  if (projects.mode !== "account" || !value || projects.names.value[id] === value) return
  projects.names.value = { ...projects.names.value, [id]: value }
}

/**
 * The name that the Console shows for a project: the name that the app reports in `project.get`, else the label of the
 * link, else the host.
 */
export function consoleProjectDisplayName(project: { id: string, label?: string | null, url: string }): string {
  return useState().names.value[project.id] || project.label || consoleProjectHost(project)
}

/** Only owners and admins of a team link and unlink its apps. */
export function canManageConsoleProjects(account: Pick<ConsoleAccount, "roles">): boolean {
  return account.roles.includes("owner") || account.roles.includes("admin")
}

// The person picks it, so no answer of the server has it, and the device keeps only answers. It holds an id of the team,
// which opens nothing for another account.
const accountProjectKey = (teamId: string) => `vitehub-console:account-project:${teamId}`

/** The project that an `account` Console opens next for a team, kept in this browser. */
export function rememberAccountProject(teamId: string | undefined, projectId: string): void {
  if (!teamId) return
  try {
    globalThis.localStorage?.setItem(accountProjectKey(teamId), projectId)
  }
  catch {}
}

function rememberedAccountProject(teamId: string | undefined): string | undefined {
  if (!teamId) return undefined
  try {
    return globalThis.localStorage?.getItem(accountProjectKey(teamId)) ?? undefined
  }
  catch {
    return undefined
  }
}

/**
 * Start an `account` Console: read the session, then the projects of the active team from the Console server. Without
 * a session, or on an `/invite/<id>` page, the gate shows the sign-in page.
 */
/** A project URL as the Console compares it: the origin and the mount, without a trailing slash. */
function comparableProjectUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    return `${url.origin}${url.pathname.replace(/\/_vitehub(?:\/.*)?$/, "").replace(/\/+$/, "")}`
  }
  catch {
    return undefined
  }
}

/**
 * The app and the page of a link from `hostedConsoleUrl()`, `/open?project=<app URL>&path=<Console path>`, among the
 * projects of the team. `undefined` when the link names no project of the team, or a path that is not a Console page.
 */
export function consoleOpenLink(search: string, projects: readonly { id: string, url: string }[]): { id: string, path: string } | undefined {
  const query = new URLSearchParams(search)
  const project = comparableProjectUrl(query.get("project") ?? "")
  const raw = query.get("path") ?? "/"
  // A Console path starts with one `/`. Another form could leave the Console origin.
  if (!project || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return undefined
  const path = raw.replace(/^\/_vitehub(?=\/|$)/, "") || "/"
  const match = projects.find(candidate => comparableProjectUrl(candidate.url) === project)
  return match ? { id: match.id, path } : undefined
}

/**
 * The address of an `/open` link that the Console opens again after a sign-in, such as
 * `/open?project=https%3A%2F%2Fapp.example.com&path=%2Fkv`. It keeps only the project and the path of the link.
 * `undefined` when the link names no project URL or a path that is not a Console page.
 */
export function consoleOpenReturnPath(home: string, search: string): string | undefined {
  const query = new URLSearchParams(search)
  const project = query.get("project") ?? ""
  const path = query.get("path") ?? "/"
  if (!comparableProjectUrl(project) || !path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return undefined
  return `${home.replace(/\/+$/, "")}/open?project=${encodeURIComponent(project)}&path=${encodeURIComponent(path)}`
}

/** The `/invite/<id>` page: the invitation id, or `undefined` on another page. */
export function consoleInvitationOf(pathname: string): string | undefined {
  const match = /^\/invite\/([^/]+)\/?$/.exec(pathname)
  return match ? decodeURIComponent(match[1]!) : undefined
}

/** The boot read of an `account` Console (`@vite-hub/console`, server/api/account.get.ts). */
export const consoleAccountPath = "/api/account"

/**
 * The signed-in account, its teams, and the projects of its team, with one session check, or `undefined` before
 * sign-in. With a session cookie, the page HTML already started this request.
 */
export async function loadConsoleAccount(): Promise<ConsoleAccount | undefined> {
  // No headers and no cache option, so the request matches the preload of the HTML and the browser reuses its answer.
  const response = await fetch(consoleAccountPath, { credentials: "same-origin" })
  if (response.status === 401 || response.status === 403) return undefined
  if (!response.ok) throw await consoleResponseError(response)
  // SAFETY: The Console server owns this route and its answer.
  return await response.json() as ConsoleAccount
}

interface ConsoleAccountBoot {
  home: string
  navigate: (url: string) => void
  pageOrigin: string
  pathname: string
  search?: string
  showPath: (path: string) => void
  /** The first paint of the page, which the Console server picked from the path and the cookies. */
  boot?: string
}

/**
 * Start an `account` Console. Returns the address that the page shows before its router reads it: the page of an
 * `/open` link, or `undefined` to keep the address.
 *
 * With a session cookie, the page opens at once from the account and the `project.get` answer that the device kept
 * from the last visit of this account, then reads both again. When the new answers open another page, such as for
 * another person, another team, or an app that the team unlinked, the Console deletes the stored answers and loads
 * the page again.
 */
export async function startConsoleAccount(options: ConsoleAccountBoot): Promise<string | undefined> {
  showAccountPath = options.showPath
  await openDevice({ version: consoleDeviceVersion })
  // Only a page with a session cookie uses the stored account. The server picks the sign-in page without one.
  const signedIn = options.boot === "app" || options.boot === "shell"
  // The answer of `/api/account` says who is signed in, so it names the account of the device, and the device stores it
  // under that account. Until then the page names no account: the stored answers only draw the first frame, and the
  // device stores the answers of the other reads only when their calls start after the naming.
  const read = readStored(consoleAccountKey, loadConsoleAccount, { account: account => account?.user.id ?? null })
  accountRead = read
  const stored = signedIn && read.stored && opensFromStored(read.stored, options) ? read.stored : undefined
  // Without a stored account, the `project.get` of a `?app=<id>` link goes out now, so it does not wait for the account.
  const linked = new URLSearchParams(options.search ?? "").get("app")
  if (signedIn && !stored && linked && !accountPageOf(options.pathname)) earlyProbe = { id: linked, read: readProject(linked) }
  if (stored) {
    openedFromDevice = true
    const address = startAccountState(stored, options)
    followConsoleAccount(read, options)
    return address
  }
  const account = await read.answer().catch(() => undefined)
  const address = startAccountState(account, options)
  followConsoleAccount(read, options)
  return address
}

/**
 * Apply each later answer of the account read: the answer of this visit after a stored account, and the answer after
 * another tab signed out, signed in as another person, or cleared the device, when the read starts over.
 */
function followConsoleAccount(read: ConsoleStoredRead<ConsoleAccount | undefined>, options: ConsoleAccountBoot): void {
  watch(read.read.status, (status) => {
    if (status === "success" && accountRead === read) void refreshConsoleAccount(read.read.data.value, options)
  })
}

/** Set the projects of the account and the gate of the page. Returns the address that the page shows. */
function startAccountState(account: ConsoleAccount | undefined, options: ConsoleAccountBoot): string | undefined {
  let storage = memoryProjectStorage()
  let missingApp = false
  let address: string | undefined
  if (account) {
    // A link to one app, `/?app=<id>`, opens that app. `/open?project=<URL>&path=<page>` opens a page of the app with
    // that URL. Other links open the app that this browser used last.
    const home = options.home.replace(/\/+$/, "")
    const openLink = options.pathname.replace(/\/+$/, "") === `${home}/open`
    const opened = openLink ? consoleOpenLink(options.search ?? "", account.projects) : undefined
    if (opened) address = `${home}${opened.path}`
    const requested = opened?.id ?? new URLSearchParams(options.search ?? "").get("app") ?? undefined
    if (requested && account.projects.some(project => project.id === requested)) rememberAccountProject(account.teamId, requested)
    // An app of another team, or one that is gone, opens Home instead of another app.
    else if (requested || openLink) missingApp = true
    const remembered = rememberedAccountProject(account.teamId)
    storage = accountProjectStorage(account, account.projects.find(project => project.id === remembered)?.id ?? account.projects[0]?.id)
  }
  const started = startConsoleProjects({ base: "", home: options.home, mode: "account", navigate: options.navigate, pageOrigin: options.pageOrigin, storage })
  started.account.value = account
  if (options.boot === "shell") started.openingView = "shell"
  const invitation = consoleInvitationOf(options.pathname)
  const page = accountPageOf(options.pathname)
  // Signed out, an `/open` link waits for the sign-in. Each sign-in method comes back to it.
  const returnTo = !account && !invitation && options.pathname.replace(/\/+$/, "") === `${options.home.replace(/\/+$/, "")}/open`
    ? consoleOpenReturnPath(options.home, options.search ?? "")
    : undefined
  if (!account || invitation) started.gate.value = { kind: "account", ...(invitation ? { invitation } : {}), ...(returnTo ? { returnTo } : {}) }
  else if (page) started.gate.value = { kind: "home", page }
  else if (missingApp) started.gate.value = { kind: "home", page: "home" }
  // A guess for another app, or a boot that opens no app, leaves the early answer unread. A later open asks again.
  if (started.gate.value.kind !== "opening" || started.current.value?.id !== earlyProbe?.id) {
    earlyProbe?.read.stop()
    earlyProbe = undefined
  }
  return address ?? (missingApp ? options.home : undefined)
}

/**
 * Apply the account of this visit to a page that opened from the stored account. A new name, role, or app shows in
 * place. A sign-out, another person, another team, or an open app that the team no longer has loads the page again,
 * without the stored answers, so nothing of the stored account stays usable.
 */
async function refreshConsoleAccount(fresh: ConsoleAccount | undefined, options: ConsoleAccountBoot): Promise<void> {
  const projects = useState()
  const shown = projects.account.value
  // A page that shows the sign-in loads again when another tab signed in.
  if (!shown) {
    if (fresh) reloadConsolePage(`${options.pathname}${options.search ?? ""}`)
    return
  }
  const current = projects.current.value
  const store = fresh && createConsoleProjectStore(accountProjectStorage(fresh, current?.id))
  // The open app must still be an app of the team, at the same URL. A team that had no app opens one now.
  const sameApp = current ? store?.get(current.id)?.url === current.url : projects.gate.value.kind !== "empty" || !store?.list().length
  if (!fresh || !store || fresh.user.id !== shown.user.id || fresh.teamId !== shown.teamId || !sameApp) {
    // A newer attempt must not open the stale app while the page loads again.
    ++probeVersion
    reloadConsolePage(`${options.pathname}${options.search ?? ""}`)
    return
  }
  projects.account.value = fresh
  projects.store = store
  projects.projects.value = store.list()
}

/** The projects of the team, with `active` as the project that the page opens. */
function accountProjectStorage(account: ConsoleAccount, active: string | undefined): ConsoleProjectStorage {
  const storage = memoryProjectStorage()
  storage.setItem(consoleProjectsStorageKey, JSON.stringify({
    ...(active ? { active } : {}),
    projects: account.projects.map(project => ({ id: project.id, url: project.url, ...(project.label ? { label: project.label } : {}) })),
  }))
  return storage
}

/**
 * Whether the stored account can open the page. A link to an app that it does not have, such as an app that the team
 * linked after it was stored, waits for the account of this visit.
 */
function opensFromStored(account: ConsoleAccount, options: ConsoleAccountBoot): boolean {
  const home = options.home.replace(/\/+$/, "")
  if (options.pathname.replace(/\/+$/, "") === `${home}/open`) return consoleOpenLink(options.search ?? "", account.projects) !== undefined
  const linked = new URLSearchParams(options.search ?? "").get("app")
  return !linked || account.projects.some(project => project.id === linked)
}

/** Puts a path in the address bar without a load. The page sets it, because only the page has a history. */
let showAccountPath: ((path: string) => void) | undefined

/**
 * Show a page of an `account` Console outside the projects, such as `/team`. Before a project opens, the page changes in
 * place. In an open project, the Console loads again, because the router owns the path there.
 */
export function showConsoleAccountPage(page: ConsoleAccountPage): void {
  const projects = useState()
  // An earlier app-opening response must not replace the page the person selected.
  ++probeVersion
  const path = `${projects.home.replace(/\/+$/, "")}/${page}`
  if (projects.gate.value.kind === "ready") {
    projects.navigate(path)
    return
  }
  showAccountPath?.(path)
  projects.gate.value = { kind: "home", page }
}

/** The address of one app of the team, which opens that app in any tab. */
export function accountProjectPath(id: string): string {
  return `${useState().home}?app=${encodeURIComponent(id)}`
}

/** Open a project of the team from a page outside the projects. The Console loads again at its home path. */
export function openAccountProject(id: string): void {
  const projects = useState()
  rememberAccountProject(projects.account.value?.teamId, id)
  projects.navigate(projects.home)
}

/** Link an app to the active team, then open it. Until the app keeps the hash of its token, it opens on the setup step. */
export async function linkAccountProject(url: string, label?: string): Promise<void> {
  const { linkConsoleAccountProject } = await import("./account")
  const project = await linkConsoleAccountProject(url.trim(), label?.trim() || undefined)
  rememberAccountProject(useState().account.value?.teamId, project.id)
  reloadConsoleAccount()
}

/**
 * Load the Console again from its home page, such as after a sign-in, a team switch, or a new project. The account
 * changed, so the next page must not open from the stored one: the stored answers go first.
 */
export function reloadConsoleAccount(): void {
  reloadConsolePage(useState().home)
}

/** Sign out of the Console, delete the stored answers in every tab, and load the Console again. */
export async function signOutConsole(): Promise<void> {
  const { endConsoleSession } = await import("./account")
  // A failed sign-out throws here, and the page keeps following its account.
  await endConsoleSession()
  // The reads of the page must not start over and load the page on their own when the device forgets the account.
  stopConsoleReads()
  await setDeviceAccount(null)
  reloadConsoleAccount()
}

/**
 * Load the page at `url` without the stored answers. The reads of the boot stop first, and only the first reload of the
 * page navigates.
 */
function reloadConsolePage(url: string): void {
  if (reloading) return
  reloading = true
  const projects = useState()
  stopConsoleReads()
  void clearDevice().then(() => projects.navigate(url))
}

/** Stop the reads of the boot before the page loads again, so a read that starts over does not load it a second time. */
function stopConsoleReads(): void {
  accountRead?.stop()
  accountRead = undefined
  projectRead?.read.stop()
  projectRead = undefined
}

/** The page that a completed sign-in opens: the `/open` link that the person followed, else the Console home. */
export function consoleSignInReturnPath(): string {
  const projects = useState()
  const gate = projects.gate.value
  return gate.kind === "account" && gate.returnTo ? gate.returnTo : projects.home
}

/** Load the Console after a sign-in on this page, such as with a passkey, at the page that the sign-in opens. */
export function finishConsoleSignIn(): void {
  useState().navigate(consoleSignInReturnPath())
}
