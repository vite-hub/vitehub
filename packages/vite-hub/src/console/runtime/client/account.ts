/**
 * The account of a Console that runs as its own app, such as console.vitehub.dev. People sign in to the Console with
 * GitHub or a passkey. Projects belong to teams, and every account has a personal team. The Console server keeps a
 * private key for each project, and signs the calls of the page that it forwards to `/p/<project>/_vitehub/...`.
 */
import { passkeyClient } from "@better-auth/passkey/client"
import { createAuthClient } from "better-auth/client"
import { organizationClient } from "better-auth/client/plugins"

import { consoleDiagnostic, consoleStatusDiagnosticCode } from "../diagnostics.ts"
import { consoleProjectBuildOf } from "./project-link.ts"

import type { ConsoleProjectBuild } from "./project-link.ts"

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
    // A code of the Console catalog also carries its fix.
    const fix: unknown = body instanceof Object ? Reflect.get(body, "fix") : undefined
    const why = String(message) === message && message ? message : `The Console answered ${response.status}.`
    throw failure({ status: response.status }, String(fix) === fix && fix ? `${why} ${fix}` : why)
  }
  // SAFETY: The Console server owns these routes and their answers.
  return body as T
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

/** An API key of the signed-in person, as `GET /api/api-keys` lists it. It never holds the key. */
export interface ConsoleApiKey {
  id: string
  name: string
  /** The prefix and the first characters of the key, such as `vhk_Ab3x`. */
  start: string
  team: { id: string, name: string }
  /** The projects that the key may open, or `null` for every project of the team. */
  projectIds: string[] | null
  createdAt: number
  expiresAt: number
  lastUsedAt: number | null
}

export async function listConsoleApiKeys(): Promise<ConsoleApiKey[]> {
  return (await json<{ apiKeys: ConsoleApiKey[] }>("/api/api-keys")).apiKeys
}

/** Make an API key in the active team. The answer holds the key once: show it, then forget it. */
export async function createConsoleApiKey(input: { name: string, projectIds?: string[], days: number }): Promise<{ apiKey: ConsoleApiKey, key: string }> {
  return await json<{ apiKey: ConsoleApiKey, key: string }>("/api/api-keys", { body: JSON.stringify(input), method: "POST" })
}

export async function revokeConsoleApiKey(id: string): Promise<void> {
  const response = await fetch(`/api/api-keys/${encodeURIComponent(id)}`, { credentials: "same-origin", method: "DELETE" })
  if (!response.ok && response.status !== 404) throw failure({ status: response.status }, `The Console answered ${response.status}.`)
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
  /** The build that the connected app runs, from its `project.get` answer. */
  build?: ConsoleProjectBuild
}

// The codes of an app that has no public key for the link, or another one.
const variableProblems = new Set(["CONSOLE_KEY_NOT_CONFIGURED", "CONSOLE_KEY_UNKNOWN", "CONSOLE_SIGNATURE_INVALID"])

/** Whether the app keeps the public key of the link: the Console server calls the app with a signed request. */
export async function checkConsoleAccountProject(id: string): Promise<ConsoleAccountCheck> {
  const result = await json<{ linked: boolean, status: number, answer?: unknown }>(`/api/projects/${encodeURIComponent(id)}/check`, { method: "POST" })
  if (result.linked) {
    const build = consoleProjectBuildOf(result.answer instanceof Object ? Reflect.get(result.answer, "build") : undefined)
    return { status: "connected", code: result.status, ...(build ? { build } : {}) }
  }
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

/** A name of a stage, as `GET /api/projects/<id>/env/<stage>` lists it. The Console never lists values. */
export interface ConsoleEnvVariable {
  name: string
  updatedAt: string
}

/**
 * The env values of one stage of a project. `off` is a Console that stores no values, which is the default: `message`
 * says how its operator turns them on.
 */
export type ConsoleEnvStage =
  | { off: true, message: string }
  | { off: false, stage: string, stages: string[], variables: ConsoleEnvVariable[], canReveal: boolean }

function envPath(projectId: string, ...parts: string[]): string {
  return [`/api/projects/${encodeURIComponent(projectId)}/env`, ...parts.map(encodeURIComponent)].join("/")
}

export async function loadConsoleEnvStage(projectId: string, stage: string): Promise<ConsoleEnvStage> {
  const response = await fetch(envPath(projectId, stage), { credentials: "same-origin", headers: { accept: "application/json" } })
  const body: unknown = await response.json().catch(() => undefined)
  const field = (name: string): unknown => body instanceof Object ? Reflect.get(body, name) : undefined
  const message = field("message")
  if (field("code") === "CONSOLE_ENV_VALUES_OFF") return { message: String(message), off: true }
  if (!response.ok) throw failure({ status: response.status }, typeof message === "string" && message ? message : `The Console answered ${response.status}.`)
  // SAFETY: The Console server owns this route and its answer.
  return { ...(body as Omit<ConsoleEnvStage & { off: false }, "off">), off: false }
}

/** Set or replace a value. Only owners and admins. The page never shows the value again. */
export async function setConsoleEnvValue(projectId: string, stage: string, name: string, value: string): Promise<void> {
  await json(envPath(projectId, stage, name), { body: JSON.stringify({ value }), method: "PUT" })
}

export async function deleteConsoleEnvValue(projectId: string, stage: string, name: string): Promise<void> {
  const response = await fetch(envPath(projectId, stage, name), { credentials: "same-origin", method: "DELETE" })
  if (!response.ok && response.status !== 404) throw failure({ status: response.status }, `The Console answered ${response.status}.`)
}

/** Read one value. The Console writes who read it in the env activity first. */
export async function revealConsoleEnvValue(projectId: string, stage: string, name: string): Promise<string | undefined> {
  const { values } = await json<{ values: Record<string, string> }>(envPath(projectId, stage, "reveal"), { body: JSON.stringify({ names: [name] }), method: "POST" })
  return values[name]
}
