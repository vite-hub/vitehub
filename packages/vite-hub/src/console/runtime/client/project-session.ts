import { ref, shallowRef } from "vue"

import type { Ref, ShallowRef } from "vue"

import {
  browserOAuthLock,
  storageOAuthLock,
  consoleAuthorizationUrl,
  consoleCodeChallenge,
  consoleOAuthGrantLockName,
  consoleOAuthStateLifetime,
  createConsoleCodeVerifier,
  createConsoleOAuthRefresher,
  createConsoleOAuthState,
  createConsoleOAuthStateStore,
  discoverConsoleOAuth,
  exchangeConsoleOAuthCode,
  loadConsoleOAuthClient,
  parseConsoleOAuthCallback,
  revokeConsoleOAuthTokens,
} from "./oauth"
import { ConsolePendingLinkStorageError, consolePendingLinksStorageKey, createConsolePendingLinkStore, parseConsoleLinkFragment } from "./pending-links"
import { setConsoleProject } from "./project"
import { consoleProjectProblem, probeConsoleProject } from "./project-link"
import { useConsoleToast } from "./toast"
import { consoleProjectHost, consoleProjectTarget, createConsoleProjectStore, isMixedContentProject, memoryProjectStorage, normalizeProjectUrl } from "./projects"

import type { ConsoleOAuthFetch, ConsoleOAuthLock, ConsoleOAuthPendingSignIn, ConsoleOAuthRefresher, ConsoleOAuthStateStore, ConsoleOAuthTokens } from "./oauth"
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
  /** `home` offers a way back to the Console instead of a retry, such as after a sign-in that cannot finish. */
  | { kind: "problem", problem: ConsoleProjectProblem, home?: boolean }
  /**
   * The project signs Consoles in with OAuth. `resourceMetadata` is the URL that its challenge named. `problem` says
   * why the last sign-in did not open it, such as a denied consent or a session that ended.
   */
  | { kind: "oauth", target: ConsoleProjectTarget, resourceMetadata?: string, problem?: ConsoleProjectProblem }
  /** The `/oauth/callback` page: the Console exchanges the code for tokens. */
  | { kind: "callback" }
  /** The `/link` page of a hosted Console: confirm the app of a one-time link, or why the link cannot be used. */
  | { kind: "link", request: ConsoleLinkRequest }
  | { kind: "ready" }

/** What linking found: the saved project, the token step, or why it failed. */
export type ConsoleProjectLinkResult =
  | { kind: "linked", project: ConsoleLinkedProject }
  | { kind: "token", rejected: boolean, target: ConsoleProjectTarget }
  | { kind: "oauth", target: ConsoleProjectTarget, resourceMetadata: string }
  | { kind: "problem", problem: ConsoleProjectProblem }

interface ConsoleProjectsState {
  mode: ConsoleProjectsMode
  /** The origin of the Console page, such as `https://console.example.com`. */
  pageOrigin: string
  store: ConsoleProjectStore
  /** The one-time links for new projects, in the same storage as the projects. */
  pendingLinks: ConsolePendingLinkStore
  /** The OAuth sign-ins of this tab that wait for their callback, in `sessionStorage`. */
  oauthStates: ConsoleOAuthStateStore
  /** Whether a sign-in survives the redirect to the app: both storages keep their writes across page loads. */
  oauthStorage: boolean
  /** Refreshes the OAuth access tokens of the projects, one refresh at a time per project. */
  refresher: ConsoleOAuthRefresher
  /** Serializes short grant updates and removals across tabs. */
  lock: ConsoleOAuthLock
  /** The `fetch` of OAuth metadata, token, and revocation requests. */
  fetch: ConsoleOAuthFetch
  now: () => number
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

const sessionEnded = (host: string): ConsoleProjectProblem => ({
  title: `Your sign-in to ${host} ended`,
  message: `The Console could not refresh its access to ${host}. Sign in again.`,
})

/** The project that this page opens, read again from the store, so it has the tokens of the latest refresh. */
function stored(): ConsoleLinkedProject | undefined {
  const projects = useState()
  const current = projects.current.value
  return current?.id ? projects.store.find(current.url) ?? current : current
}

/** After the tokens of the open project are gone, the Console asks the person to sign in again. */
function askToSignInAgain(): void {
  const projects = useState()
  const current = projects.current.value
  if (!current?.id || projects.store.find(current.url)?.oauth) return
  const target = consoleProjectTarget(current)
  projects.gate.value = { kind: "oauth", target, problem: sessionEnded(consoleProjectHost(target)) }
}

function applyTransport(target: Pick<ConsoleProjectTarget, "base" | "origin">): void {
  setConsoleProject({
    ...target,
    authorization: async () => {
      const project = stored()
      if (project?.token) return `Bearer ${project.token}`
      if (!project?.oauth) return undefined
      const token = await useState().refresher.accessToken(project.url)
      if (!token) askToSignInAgain()
      return token ? `Bearer ${token}` : undefined
    },
    // A project refuses an OAuth access token that expired early or was signed with a rotated key. One refresh may fix it.
    renew: async (response, sent) => {
      const project = stored()
      const challenge = response.headers.get("www-authenticate")
      if (!project?.oauth || (challenge && !/\berror="invalid_token"/i.test(challenge))) return undefined
      const token = await useState().refresher.accessToken(project.url, { rejected: sent.replace(/^Bearer\s+/i, "") })
      if (!token) askToSignInAgain()
      return token ? `Bearer ${token}` : undefined
    },
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
  /** Keeps the OAuth sign-ins of the tab until their callback. Defaults to memory. */
  sessionStorage?: ConsoleProjectStorage
  /** Whether `storage` keeps its writes across page loads. Defaults to true. */
  durableStorage?: boolean
  fetch?: ConsoleOAuthFetch
  lock?: ConsoleOAuthLock
  now?: () => number
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
  const request: ConsoleOAuthFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
  // Without Web Locks, tabs take turns through a lease in the project storage.
  const lock = options.lock ?? browserOAuthLock() ?? storageOAuthLock(options.storage)
  const started: ConsoleProjectsState = {
    current: shallowRef(current),
    fetch: request,
    lock,
    now: options.now ?? Date.now,
    oauthStates: createConsoleOAuthStateStore(options.sessionStorage ?? memoryProjectStorage(), options.now ? { now: options.now } : {}),
    oauthStorage: options.durableStorage !== false && options.sessionStorage !== undefined,
    refresher: createConsoleOAuthRefresher({
      fetch: request,
      read: url => store.find(url)?.oauth,
      write: (url, tokens) => {
        if (store.find(url)) store.save({ url, oauth: tokens })
      },
      lock,
      ...(options.now ? { now: options.now } : {}),
    }),
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

/**
 * Read `project.get` of a project with what this browser keeps for it: the Console token, or the OAuth access token,
 * refreshed when it expires soon. A refused access token gets one refresh and one more try.
 */
async function probeProject(target: Pick<ConsoleProjectTarget, "base" | "origin">, project: ConsoleLinkedProject | undefined): Promise<ConsoleProjectProbe> {
  const { refresher, store } = useState()
  const oauth = project?.id && !project.token ? store.find(project.url)?.oauth : undefined
  if (!project || !oauth) return probeConsoleProject(target, project?.token)
  const token = await refresher.accessToken(project.url)
  const probe = await probeConsoleProject(target, token)
  if (probe.kind !== "oauth" || !token) return probe
  const renewed = await refresher.accessToken(project.url, { rejected: token })
  return renewed ? probeConsoleProject(target, renewed) : probe
}

/** Embedded mode opens the app unless it asks for a Console token. The app's own pages show the other sign-in states. */
function gateOf(probe: ConsoleProjectProbe, target: ConsoleProjectTarget, signedIn = false): ConsoleProjectGate | undefined {
  if (probe.kind === "ready") return undefined
  if (probe.kind === "token") return { kind: "token", rejected: probe.rejected }
  if (useState().mode === "embedded") return undefined
  if (probe.kind === "oauth") {
    // A project that had tokens before this probe lost them: the refresh token expired or was revoked.
    return { kind: "oauth", target, resourceMetadata: probe.resourceMetadata, ...(signedIn ? { problem: sessionEnded(consoleProjectHost(target)) } : {}) }
  }
  return { kind: "problem", problem: consoleProjectProblem(probe, problemContext(target)) }
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
  const signedIn = Boolean(current.id && projects.store.find(current.url)?.oauth)
  const probe = await probeProject(target, current)
  // A switch or a newer attempt can finish first. Only the current attempt may open the gate or update the project.
  if (projects !== state || version !== probeVersion || projects.current.value !== current) return
  const gate = gateOf(probe, consoleProjectTarget(current), signedIn)
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
export async function linkConsoleProject(input: string, token?: string, signal?: AbortSignal): Promise<ConsoleProjectLinkResult> {
  const projects = useState()
  const normalized = normalizeProjectUrl(input)
  if ("error" in normalized) return { kind: "problem", problem: { title: "Check the URL", message: normalized.error } }
  const { target } = normalized
  if (isMixedContentProject(target, new URL(projects.pageOrigin).protocol)) {
    return { kind: "problem", problem: { title: "Use HTTPS", message: `This Console runs on HTTPS, so the browser blocks ${target.origin}. Use the https:// URL of the project.` } }
  }
  const existing = projects.store.find(target.url)
  const probe = token === undefined ? await probeProject(target, existing) : await probeConsoleProject(target, token)
  // A person who closed the dialog gave up on this project, so a late answer saves nothing.
  signal?.throwIfAborted()
  if (probe.kind === "token") return { kind: "token", rejected: probe.rejected && token !== undefined, target }
  if (probe.kind === "oauth") return { kind: "oauth", target, resourceMetadata: probe.resourceMetadata }
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

/** Ask the authorization server to revoke the refresh token. Best effort: the tokens are already gone from this browser. */
async function revoke(tokens: ConsoleOAuthTokens | undefined): Promise<void> {
  if (tokens) await revokeConsoleOAuthTokens(tokens, { fetch: useState().fetch })
}

/**
 * Remove a project and its tokens from this browser, and revoke its OAuth refresh token. The project itself does not
 * change. When it was the current project, the Console loads the next one, or the empty state.
 */
export async function forgetConsoleProject(id: string): Promise<void> {
  const projects = useState()
  const project = projects.store.get(id)
  if (!project) return
  const tokens = await projects.lock(consoleOAuthGrantLockName(project.url), async () => {
    const latest = projects.store.get(id)
    projects.store.forget(id)
    return latest?.oauth
  })
  projects.projects.value = projects.store.list()
  if (tokens) void revokeConsoleOAuthTokens(tokens, { fetch: projects.fetch })
  if (projects.current.value?.id === id) projects.navigate(projects.home)
}

/**
 * Sign the Console out of the open project. The embedded app forgets its Console token and shows the sign-in form
 * again. A hosted Console revokes the OAuth refresh token, removes the tokens, and keeps the project in the list.
 */
export async function signOutConsoleProject(): Promise<void> {
  const projects = useState()
  const current = projects.current.value
  if (current?.id) {
    const tokens = await projects.lock(consoleOAuthGrantLockName(current.url), async () => {
      const project = projects.store.get(current.id)
      if (project?.oauth && projects.mode === "hosted") projects.store.save({ url: project.url, oauth: null, token: null })
      else projects.store.forget(current.id)
      return project?.oauth
    })
    projects.projects.value = projects.store.list()
    if (tokens) void revokeConsoleOAuthTokens(tokens, { fetch: projects.fetch })
  }
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
    const probe = await probeProject(consoleProjectTarget(project), project).catch((): ConsoleProjectProbe => ({ kind: "unreachable" }))
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
  const projects = useState()
  const create = () => projects.pendingLinks.create()
  return projects.pendingLinkLocks ? projects.pendingLinkLocks.request(consolePendingLinksStorageKey, create) : create()
}

/** Why a pending link cannot link a project. */
const pendingLinkProblems: Record<"expired" | "unknown", ConsoleProjectProblem> = {
  expired: { title: "This link expired", message: "A link works for 24 hours. Make a new link in this Console, and run the new command." },
  unknown: { title: "This link cannot be used here", message: "This link was made in another browser or already used. If you used it in this browser, the project is already in this Console. Otherwise, open the Console in the browser where you started the project." },
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
  // runs the whole claim: check, bind to the target, send, check again, save, and remove. All links share one stored
  // list, so one lock covers every link: a lock for each id would let two tabs overwrite each other's writes.
  try {
    return await projects.pendingLinkLocks.request(consolePendingLinksStorageKey, () => confirmLockedConsoleLink(projects, pendingId, target))
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
        message: `${consoleProjectHost(target)} refused the key of this link. Its \`VITEHUB_CONSOLE_TOKEN_SHA256\` is not the hash from this link. Run the command again or relink.`,
      },
    }
  }
  if (probe.kind !== "ready") return { kind: "problem", problem: consoleProjectProblem(probe, problemContext(target)), final: false }
  // Expiry or removal while the request ran still prevents saving the project.
  if (projects.pendingLinks.lookup(pendingId).kind !== "pending") return { kind: "problem", problem: pendingLinkProblems.unknown, final: true }
  // Save the project before the link is removed. If the browser stops keeping data during the save, the removal fails
  // and the link stays pending, so the person can try again after reload instead of losing both copies of the secret.
  const project = projects.store.save({ url: target.url, label: probe.info.name, token: lookup.link.secret })
  projects.store.select(project.id)
  projects.projects.value = projects.store.list()
  projects.pendingLinks.remove(pendingId)
  return { kind: "linked", project }
}

/**
 * Start the OAuth sign-in of a project: read its sign-in settings, keep the PKCE verifier and a random `state` for this
 * tab, and load the authorization page of the project, where the person signs in and allows the Console. Returns why
 * it could not start. When it starts, the page leaves, and `/oauth/callback` finishes it with `finishConsoleOAuthSignIn()`.
 */
export async function startConsoleOAuthSignIn(target: ConsoleProjectTarget, resourceMetadata?: string, signal?: AbortSignal): Promise<ConsoleProjectProblem | undefined> {
  const projects = useState()
  const host = consoleProjectHost(target)
  if (projects.mode !== "hosted") return { title: "Sign in on the app", message: `Open the Console of ${host} at its own URL to sign in.` }
  // The verifier and the tokens must survive the redirect to the app, so memory is not enough.
  if (!projects.oauthStorage) {
    return { title: "This browser blocks site data", message: `Allow site data for ${new URL(projects.pageOrigin).host} to sign in, or use \`auth: "token"\` in the project.` }
  }
  let metadata = resourceMetadata
  if (!metadata) {
    const probe = await probeConsoleProject(target)
    if (probe.kind === "ready") return { title: `${host} is open`, message: "The project answered without a sign-in. Reload the Console." }
    if (probe.kind !== "oauth") return consoleProjectProblem(probe, problemContext(target))
    metadata = probe.resourceMetadata
  }
  const loaded = await loadConsoleOAuthClient(projects.pageOrigin, projects.fetch)
  if ("problem" in loaded) return loaded.problem
  const found = await discoverConsoleOAuth(target, metadata, { consoleOrigin: projects.pageOrigin, fetch: projects.fetch })
  if ("problem" in found) return found.problem
  const { discovery } = found
  const verifier = createConsoleCodeVerifier()
  const signIn: ConsoleOAuthPendingSignIn = {
    clientId: loaded.client.clientId,
    createdAt: projects.now(),
    issuer: discovery.issuer,
    issuerInResponse: discovery.issuerInResponse,
    projectUrl: target.url,
    redirectUri: loaded.client.redirectUri,
    resource: discovery.resource,
    state: createConsoleOAuthState(),
    tokenEndpoint: discovery.tokenEndpoint,
    verifier,
    ...(discovery.revocationEndpoint ? { revocationEndpoint: discovery.revocationEndpoint } : {}),
  }
  const challenge = await consoleCodeChallenge(verifier)
  // A person who closed the dialog stays on this page. Nothing awaits between this check and the redirect.
  signal?.throwIfAborted()
  projects.oauthStates.save(signIn)
  projects.navigate(consoleAuthorizationUrl(signIn, discovery.authorizationEndpoint, challenge))
  return undefined
}

/** Why a sign-in callback cannot finish, and whether the person can sign in to its project again from here. */
function callbackProblem(problem: ConsoleProjectProblem, signIn?: ConsoleOAuthPendingSignIn): ConsoleProjectGate {
  const projects = useState()
  if (!signIn) return { kind: "problem", problem, home: true }
  const target = consoleProjectTarget({ url: signIn.projectUrl })
  // The gate shows the project of the sign-in, so its button signs in to it again.
  const existing = projects.store.find(signIn.projectUrl)
  projects.current.value = existing ?? { id: "", url: signIn.projectUrl }
  return { kind: "oauth", target, problem }
}

/**
 * Finish an OAuth sign-in on `/oauth/callback`: check the `state` (one use, at most 10 minutes old), exchange the code
 * with the PKCE verifier, save the tokens with the project, read `project.get`, and open the project. Each failure sets
 * a gate that says how to fix it.
 */
export async function finishConsoleOAuthSignIn(search: string): Promise<void> {
  const projects = useState()
  projects.gate.value = { kind: "callback" }
  const callback = parseConsoleOAuthCallback(search)
  if (callback.kind === "invalid") {
    projects.gate.value = callbackProblem({ title: "This sign-in link is not complete", message: "The app sent this page back without its sign-in answer. Sign in again from the Console." })
    return
  }
  const lookup = callback.state ? projects.oauthStates.take(callback.state) : { kind: "unknown" as const }
  if (lookup.kind === "unknown") {
    projects.gate.value = callbackProblem({
      title: "This sign-in cannot finish here",
      message: "This tab did not start the sign-in, or the sign-in already finished. Open the Console and sign in again in one tab.",
    })
    return
  }
  const { signIn } = lookup
  const target = consoleProjectTarget({ url: signIn.projectUrl })
  const host = consoleProjectHost(target)
  // RFC 9207 mix-up defense: the answer, a code or an error, must name the server of this sign-in. A server that does
  // not send `iss` is trusted only through the state, which binds the issuer and the token endpoint discovered for it.
  const issuerProblem = callback.issuer
    ? callback.issuer !== signIn.issuer ? `The answer names ${callback.issuer}, but ${host} signs in with ${signIn.issuer}. Sign in again.` : undefined
    : signIn.issuerInResponse ? `${host} signs in with ${signIn.issuer}, which names itself in each answer, but this answer names no server. Sign in again.` : undefined
  if (issuerProblem) {
    projects.gate.value = callbackProblem({ title: "The answer came from another server", message: issuerProblem }, signIn)
    return
  }
  if (callback.kind === "error") {
    projects.gate.value = callbackProblem(callback.error === "access_denied"
      ? { title: "The Console was not allowed", message: `${host} did not allow this Console. Sign in again and choose Allow.` }
      : { title: `${host} did not sign the Console in`, message: `${callback.description ?? callback.error}. Sign in again.` }, signIn)
    return
  }
  if (lookup.kind === "expired") {
    projects.gate.value = callbackProblem({ title: "The sign-in took too long", message: `A sign-in must finish within ${consoleOAuthStateLifetime / 60_000} minutes. Sign in again.` }, signIn)
    return
  }
  const result = await exchangeConsoleOAuthCode(signIn, callback.code, { fetch: projects.fetch, now: projects.now })
  if (result.kind === "unreachable") {
    projects.gate.value = callbackProblem({ title: `Cannot reach ${host}`, message: `${host} did not answer the token request. If the app is online, add ${projects.pageOrigin} to its \`console.origins\`, redeploy, and sign in again.` }, signIn)
    return
  }
  if (result.kind === "rejected") {
    projects.gate.value = callbackProblem({ title: `${host} did not issue a token`, message: `${result.description ?? result.error ?? "The token request failed"}. Sign in again.` }, signIn)
    return
  }
  const probe = await probeConsoleProject(target, result.tokens.accessToken)
  if (probe.kind !== "ready") {
    // The tokens did not open the project, so they are not kept.
    await revoke(result.tokens)
    projects.gate.value = callbackProblem(consoleProjectProblem(probe, problemContext(target)), signIn)
    return
  }
  // A project that had a Console token before now signs in with OAuth only, so the transport sends the new tokens.
  const project = projects.store.save({ url: signIn.projectUrl, label: probe.info.name, oauth: result.tokens, token: null })
  projects.store.select(project.id)
  projects.projects.value = projects.store.list()
  projects.current.value = project
  applyTransport(target)
  open(probe.info)
}
