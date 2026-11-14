/**
 * The account of a Console that runs as its own app, such as console.vitehub.dev. People sign in to the Console with
 * GitHub or a passkey. Projects belong to teams, and every account has a personal team. The Console server keeps a
 * private key for each project, and signs the calls of the page that it forwards to `/p/<project>/_vitehub/...`.
 */
import { passkeyClient } from "@better-auth/passkey/client"
import { createAuthClient } from "better-auth/client"
import { organizationClient } from "better-auth/client/plugins"

import { consoleDiagnostic, consoleStatusDiagnosticCode } from "../diagnostics.ts"

/** A project of the active team, as `GET /api/projects` returns it. The page never sees the private key. */
export interface ConsoleAccountProject {
  id: string
  url: string
  label: string | null
  /** The Ed25519 public key of the link, base64url. */
  publicKey: string
  /** The variable of the app that keeps `publicKey`, such as `VITEHUB_CONSOLE_KEY_CONSOLE_3F9A12BC`. */
  keyVariable: string
}

export interface ConsoleAccountTeam {
  id: string
  name: string
  slug: string
}

export interface ConsoleAccount {
  user: { id: string, name: string, email: string, image?: string | null }
  /** `false` for an account that signed up with a passkey and has no email address. */
  hasEmail: boolean
  teams: ConsoleAccountTeam[]
  /** The team that the session opens. Projects belong to it. */
  teamId?: string
  /** The roles of the person in the active team, such as `owner`. */
  roles: string[]
  projects: ConsoleAccountProject[]
}

/** What the sign-in page offers. GitHub needs an OAuth app on the Console server. */
export interface ConsoleSignInMethods {
  github: boolean
}

const passkeyEmailDomain = "@passkey.invalid"

/** The origin of the Console page. Read without DOM types, like `isRemoteProject()`, for the package's server build. */
function pageOrigin(): string {
  const location: unknown = Reflect.get(globalThis, "location")
  const origin: unknown = location instanceof Object ? Reflect.get(location, "origin") : undefined
  return String(origin) === origin ? origin : ""
}

let client: ReturnType<typeof createClient> | undefined

function createClient() {
  return createAuthClient({ baseURL: `${pageOrigin()}/api/auth`, plugins: [organizationClient(), passkeyClient()] })
}

function auth() {
  client ??= createClient()
  return client
}

function failure(error: { message?: string, status?: number } | null | undefined, fallback: string) {
  return consoleDiagnostic(consoleStatusDiagnosticCode(error?.status ?? 500), error?.message || fallback)
}

async function json<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...init, credentials: "same-origin", headers: { accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}) } })
  const body: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    const message: unknown = body instanceof Object ? Reflect.get(body, "message") : undefined
    throw failure({ status: response.status }, String(message) === message && message ? message : `The Console answered ${response.status}.`)
  }
  // SAFETY: The Console server owns these routes and their answers.
  return body as T
}

/**
 * The signed-in account, its teams, and the projects of the active team, or `undefined` before sign-in. With
 * `expectSession`, the page has a session cookie, so the details load together with the session, in one round trip.
 */
export async function loadConsoleAccount(expectSession = false): Promise<ConsoleAccount | undefined> {
  const teams = () => auth().organization.list()
  const member = () => auth().organization.getActiveMember()
  const list = () => json<{ projects: ConsoleAccountProject[] }>("/api/projects").catch(() => ({ projects: [] }))
  const early = expectSession ? { teams: teams(), member: member(), projects: list() } : undefined
  // A stale cookie leaves the early answers unread.
  if (early) for (const answer of Object.values(early)) void answer.catch(() => undefined)
  const { data } = await auth().getSession()
  if (!data?.session) return undefined
  const teamId: unknown = Reflect.get(data.session, "activeOrganizationId")
  const [joined, active, projects] = await Promise.all([
    early?.teams ?? teams(),
    teamId ? early?.member ?? member() : undefined,
    teamId ? early?.projects ?? list() : { projects: [] },
  ])
  return {
    user: { id: data.user.id, name: data.user.name, email: data.user.email, image: data.user.image },
    hasEmail: !data.user.email.endsWith(passkeyEmailDomain),
    teams: (joined.data ?? []).map(team => ({ id: team.id, name: team.name, slug: team.slug })),
    ...(String(teamId) === teamId ? { teamId } : {}),
    roles: String(active?.data?.role ?? "").split(",").map(role => role.trim()).filter(Boolean),
    projects: projects.projects,
  }
}

let signInMethods: Promise<ConsoleSignInMethods> | undefined

/** The sign-in methods of this Console. They do not change while the page is open, so the page asks once. */
export function loadConsoleSignInMethods(): Promise<ConsoleSignInMethods> {
  signInMethods ??= json<ConsoleSignInMethods>("/api/sign-in-methods").catch(() => ({ github: false }))
  return signInMethods
}

/** Leave for GitHub. GitHub sends the browser back to `callbackURL`. */
export async function signInWithGitHub(callbackURL: string): Promise<void> {
  const { error } = await auth().signIn.social({ provider: "github", callbackURL })
  if (error) throw failure(error, "GitHub sign-in did not start.")
}

export async function signInWithPasskey(): Promise<void> {
  const result = await auth().signIn.passkey()
  if (result.error) throw failure(result.error, "The passkey did not sign you in.")
}

/** Make an account with a new passkey. `name` is the name that the Console shows. */
export async function signUpWithPasskey(name: string): Promise<void> {
  const result = await auth().passkey.addPasskey({ context: name, createSession: true, name: "ViteHub Console" })
  if (result.error) throw failure(result.error, "The passkey was not saved.")
}

/** Add a passkey to the signed-in account. */
export async function addConsolePasskey(): Promise<void> {
  const result = await auth().passkey.addPasskey({ name: "ViteHub Console" })
  if (result.error) throw failure(result.error, "The passkey was not saved.")
}

/** Add GitHub sign-in to the signed-in account. */
export async function linkConsoleGitHub(callbackURL: string): Promise<void> {
  const { error } = await auth().linkSocial({ provider: "github", callbackURL })
  if (error) throw failure(error, "GitHub did not start.")
}

export async function signOutConsoleAccount(): Promise<void> {
  const { error } = await auth().signOut()
  if (error) throw failure(error, "Sign out failed.")
}

export async function switchConsoleTeam(teamId: string): Promise<void> {
  const { error } = await auth().organization.setActive({ organizationId: teamId })
  if (error) throw failure(error, "The team did not open.")
}

/** Make a team, with the person as its owner, and open it. */
export async function createConsoleTeam(name: string): Promise<void> {
  const trimmed = name.replace(/\s+/g, " ").trim()
  if (!trimmed) throw consoleDiagnostic("CONSOLE_REQUEST_INVALID", "Enter a team name.")
  const slug = `${trimmed.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "team"}-${crypto.randomUUID().slice(0, 6)}`
  const { data, error } = await auth().organization.create({ name: trimmed, slug })
  if (error || !data) throw failure(error, "The team was not created.")
  await switchConsoleTeam(data.id)
}

/** Invite a person by the email address of their GitHub account. They accept on `/invite/<id>`. */
export async function inviteConsoleMember(email: string, role: "admin" | "member"): Promise<string> {
  const { data, error } = await auth().organization.inviteMember({ email: email.trim(), role })
  if (error || !data) throw failure(error, "The invitation was not created.")
  return invitationLink(data.id)
}

export async function acceptConsoleInvitation(invitationId: string): Promise<void> {
  const { data, error } = await auth().organization.acceptInvitation({ invitationId })
  if (error || !data) throw failure(error, "The invitation was not accepted.")
  await switchConsoleTeam(data.invitation.organizationId)
}

/** A person in the active team. */
export interface ConsoleTeamMember {
  id: string
  role: string
  createdAt: string
  user: { id: string, name: string, email: string, image?: string | null }
}

/** An invitation of the active team that nobody accepted yet. */
export interface ConsoleTeamInvitation {
  id: string
  email: string
  role: string
  expiresAt: string
  link: string
}

export interface ConsoleTeamDetails {
  members: ConsoleTeamMember[]
  invitations: ConsoleTeamInvitation[]
}

function invitationLink(id: string): string {
  return `${pageOrigin()}/invite/${encodeURIComponent(id)}`
}

/** The members and the pending invitations of the active team. */
export async function loadConsoleTeam(): Promise<ConsoleTeamDetails> {
  const { data, error } = await auth().organization.getFullOrganization()
  if (error || !data) throw failure(error, "The team did not load.")
  return {
    members: data.members.map(member => ({
      id: member.id,
      role: String(member.role),
      createdAt: new Date(member.createdAt).toISOString(),
      user: { id: member.user.id, name: member.user.name, email: member.user.email, image: member.user.image },
    })),
    invitations: data.invitations
      .filter(invitation => invitation.status === "pending" && new Date(invitation.expiresAt).getTime() > Date.now())
      .map(invitation => ({ id: invitation.id, email: invitation.email, role: String(invitation.role), expiresAt: new Date(invitation.expiresAt).toISOString(), link: invitationLink(invitation.id) })),
  }
}

export async function removeConsoleMember(memberId: string): Promise<void> {
  const { error } = await auth().organization.removeMember({ memberIdOrEmail: memberId })
  if (error) throw failure(error, "The member was not removed.")
}

export async function cancelConsoleInvitation(invitationId: string): Promise<void> {
  const { error } = await auth().organization.cancelInvitation({ invitationId })
  if (error) throw failure(error, "The invitation was not canceled.")
}

export async function renameConsoleTeam(name: string): Promise<void> {
  const trimmed = name.replace(/\s+/g, " ").trim()
  if (!trimmed) throw consoleDiagnostic("CONSOLE_REQUEST_INVALID", "Enter a team name.")
  const { error } = await auth().organization.update({ data: { name: trimmed } })
  if (error) throw failure(error, "The team was not renamed.")
}

/**
 * Leave a team. The session then opens `next`, another team of the person. The last owner of a team cannot leave it,
 * and the Console server refuses that.
 */
export async function leaveConsoleTeam(teamId: string, next?: string): Promise<void> {
  const { error } = await auth().organization.leave({ organizationId: teamId })
  if (error) throw failure(error, "You did not leave the team.")
  if (next) await switchConsoleTeam(next)
}

/** A passkey of the signed-in account. */
export interface ConsolePasskey {
  id: string
  name?: string | null
  createdAt?: string
}

export async function listConsolePasskeys(): Promise<ConsolePasskey[]> {
  const { data, error } = await auth().passkey.listUserPasskeys()
  if (error) throw failure(error, "The passkeys did not load.")
  return (data ?? []).map(passkey => ({ id: passkey.id, name: passkey.name, ...(passkey.createdAt ? { createdAt: new Date(passkey.createdAt).toISOString() } : {}) }))
}

export async function deleteConsolePasskey(id: string): Promise<void> {
  const { error } = await auth().passkey.deletePasskey({ id })
  if (error) throw failure(error, "The passkey was not removed.")
}

/** The sign-in providers of the signed-in account, such as `github`. Passkeys are not in the list. */
export async function listConsoleSignInProviders(): Promise<string[]> {
  const { data, error } = await auth().listAccounts()
  if (error) throw failure(error, "The sign-in methods did not load.")
  return (data ?? []).map(account => account.providerId)
}

export async function renameConsoleAccount(name: string): Promise<void> {
  const trimmed = name.replace(/\s+/g, " ").trim()
  if (!trimmed) throw consoleDiagnostic("CONSOLE_REQUEST_INVALID", "Enter a name.")
  const { error } = await auth().updateUser({ name: trimmed })
  if (error) throw failure(error, "The name was not saved.")
}

/**
 * What the Console knows about a linked app: it accepts its token, it refuses the token (`setup`: the variable is missing
 * or old), it answers but not as a Console app (`unconfigured`: no `console: true`, or another error), or
 * the Console cannot reach it.
 */
export type ConsoleAccountAppStatus = "checking" | "connected" | "setup" | "unconfigured" | "unreachable"

/** What each status says, in the sidebar and on Home. */
export const accountAppStatusLabels: Record<ConsoleAccountAppStatus, string> = {
  checking: "Checking",
  connected: "Connected",
  setup: "Variable not set",
  unconfigured: "Not connected",
  unreachable: "Not reachable",
}

/** What a check of a linked app found. `setup` means the app refuses the signature, so its variable is missing or old. */
export interface ConsoleAccountCheck {
  status: ConsoleAccountAppStatus
  /** The HTTP status of the app's answer. */
  code: number
}

// The codes of an app that has no public key for the link, or another one.
const variableProblems = new Set(["CONSOLE_KEY_NOT_CONFIGURED", "CONSOLE_KEY_UNKNOWN", "CONSOLE_SIGNATURE_INVALID"])

/** Whether the app keeps the public key of the link: the Console server calls the app with a signed request. */
export async function checkConsoleAccountProject(id: string): Promise<ConsoleAccountCheck> {
  const result = await json<{ linked: boolean, status: number, answer?: unknown }>(`/api/projects/${encodeURIComponent(id)}/check`, { method: "POST" })
  if (result.linked) return { status: "connected", code: result.status }
  const answerCode: unknown = result.answer instanceof Object ? Reflect.get(result.answer, "code") : undefined
  const code = String(answerCode)
  // The Console server answers for the app when it cannot reach it, with a `CONSOLE_FORWARD_` code.
  const status = variableProblems.has(code) ? "setup" : code.startsWith("CONSOLE_FORWARD_") ? "unreachable" : "unconfigured"
  return { status, code: result.status }
}

/** Link an app to the active team. The answer names the variable and the public key to set on the app. */
export async function linkConsoleAccountProject(url: string, label?: string): Promise<ConsoleAccountProject> {
  const { project } = await json<{ project: ConsoleAccountProject }>("/api/projects", { body: JSON.stringify({ url, ...(label ? { label } : {}) }), method: "POST" })
  return project
}

export async function unlinkConsoleAccountProject(id: string): Promise<void> {
  const response = await fetch(`/api/projects/${encodeURIComponent(id)}`, { credentials: "same-origin", method: "DELETE" })
  if (!response.ok && response.status !== 404) throw failure({ status: response.status }, `The Console answered ${response.status}.`)
}

/** The `/invite/<id>` page: the invitation id, or `undefined` on another page. */
export function consoleInvitationOf(pathname: string): string | undefined {
  const match = /^\/invite\/([^/]+)\/?$/.exec(pathname)
  return match ? decodeURIComponent(match[1]!) : undefined
}

/** The sign-in methods that Account settings lists: the passkeys, the linked providers, and what this Console offers. */
export interface ConsoleSignInState {
  passkeys: ConsolePasskey[]
  providers: string[]
  methods: ConsoleSignInMethods
}

export async function loadConsoleSignInState(): Promise<ConsoleSignInState> {
  const [passkeys, providers, methods] = await Promise.all([listConsolePasskeys(), listConsoleSignInProviders(), loadConsoleSignInMethods()])
  return { passkeys, providers, methods }
}

interface EarlyLoad<T> {
  start: () => Promise<unknown>
  take: () => Promise<T>
}

/**
 * A load that starts before its page opens, such as when the pointer reaches the page's link. The page takes it when it
 * opens, so it renders the answer at once. An answer older than 30 seconds is loaded again.
 */
function early<T>(load: () => Promise<T>): EarlyLoad<T> {
  let pending: { at: number, answer: Promise<T> } | undefined
  const fresh = () => pending !== undefined && Date.now() - pending.at < 30_000
  return {
    /** Starts the load, and resolves when it ends, also when it fails. */
    start() {
      if (fresh()) return pending!.answer.catch(() => undefined)
      const answer = load()
      // A failed early load is loaded again by the page.
      answer.catch(() => {
        if (pending?.answer === answer) pending = undefined
      })
      pending = { at: Date.now(), answer }
      return answer.catch(() => undefined)
    },
    take() {
      const answer = fresh() ? pending!.answer : load()
      pending = undefined
      return answer
    },
  }
}

/** The data of the Members page, loaded early. */
export const earlyConsoleTeam: EarlyLoad<ConsoleTeamDetails> = early(loadConsoleTeam)

/** The data of Account settings, loaded early. */
export const earlyConsoleSignInState: EarlyLoad<ConsoleSignInState> = early(loadConsoleSignInState)
