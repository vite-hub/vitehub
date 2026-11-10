/**
 * The account of a Console that runs as its own app, such as console.vitehub.dev. People sign in to the Console with
 * GitHub or a passkey. Projects belong to teams, and every account has a personal team. The Console server keeps the
 * project tokens and forwards the calls of the page to `/p/<project>/_vitehub/...`.
 */
import { passkeyClient } from "@better-auth/passkey/client"
import { createAuthClient } from "better-auth/client"
import { organizationClient } from "better-auth/client/plugins"

/** A project of the active team, as `GET /api/projects` returns it. The page never sees the token. */
export interface ConsoleAccountProject {
  id: string
  url: string
  label: string | null
  tokenSha256: string
  /** The variable of the app that keeps `tokenSha256`. */
  tokenVariable: string
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

/** A failure that the page shows: what happened and what to do. */
export class ConsoleAccountError extends Error {}

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

function failure(error: { message?: string, status?: number } | null | undefined, fallback: string): ConsoleAccountError {
  return new ConsoleAccountError(error?.message || fallback)
}

async function json<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...init, credentials: "same-origin", headers: { accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}) } })
  const body: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    const message: unknown = body instanceof Object ? Reflect.get(body, "message") : undefined
    throw new ConsoleAccountError(String(message) === message && message ? message : `The Console answered ${response.status}.`)
  }
  // SAFETY: The Console server owns these routes and their answers.
  return body as T
}

/** The signed-in account, its teams, and the projects of the active team, or `undefined` before sign-in. */
export async function loadConsoleAccount(): Promise<ConsoleAccount | undefined> {
  const { data } = await auth().getSession()
  if (!data?.session) return undefined
  const teamId: unknown = Reflect.get(data.session, "activeOrganizationId")
  const [teams, member, projects] = await Promise.all([
    auth().organization.list(),
    teamId ? auth().organization.getActiveMember() : undefined,
    teamId ? json<{ projects: ConsoleAccountProject[] }>("/api/projects").catch(() => ({ projects: [] })) : { projects: [] },
  ])
  return {
    user: { id: data.user.id, name: data.user.name, email: data.user.email, image: data.user.image },
    hasEmail: !data.user.email.endsWith(passkeyEmailDomain),
    teams: (teams.data ?? []).map(team => ({ id: team.id, name: team.name, slug: team.slug })),
    ...(String(teamId) === teamId ? { teamId } : {}),
    roles: String(member?.data?.role ?? "").split(",").map(role => role.trim()).filter(Boolean),
    projects: projects.projects,
  }
}

export function loadConsoleSignInMethods(): Promise<ConsoleSignInMethods> {
  return json<ConsoleSignInMethods>("/api/sign-in-methods").catch(() => ({ github: false }))
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
  if (!trimmed) throw new ConsoleAccountError("Enter a team name.")
  const slug = `${trimmed.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "team"}-${crypto.randomUUID().slice(0, 6)}`
  const { data, error } = await auth().organization.create({ name: trimmed, slug })
  if (error || !data) throw failure(error, "The team was not created.")
  await switchConsoleTeam(data.id)
}

/** Invite a person by the email address of their GitHub account. They accept on `/invite/<id>`. */
export async function inviteConsoleMember(email: string, role: "admin" | "member"): Promise<string> {
  const { data, error } = await auth().organization.inviteMember({ email: email.trim(), role })
  if (error || !data) throw failure(error, "The invitation was not created.")
  return `${pageOrigin()}/invite/${encodeURIComponent(data.id)}`
}

export async function acceptConsoleInvitation(invitationId: string): Promise<void> {
  const { data, error } = await auth().organization.acceptInvitation({ invitationId })
  if (error || !data) throw failure(error, "The invitation was not accepted.")
  await switchConsoleTeam(data.invitation.organizationId)
}

/** Link an app to the active team. The answer names the variable and the hash to set on the app. */
export async function linkConsoleAccountProject(url: string, label?: string): Promise<ConsoleAccountProject> {
  const { project } = await json<{ project: ConsoleAccountProject }>("/api/projects", { body: JSON.stringify({ url, ...(label ? { label } : {}) }), method: "POST" })
  return project
}

export async function unlinkConsoleAccountProject(id: string): Promise<void> {
  const response = await fetch(`/api/projects/${encodeURIComponent(id)}`, { credentials: "same-origin", method: "DELETE" })
  if (!response.ok && response.status !== 404) throw new ConsoleAccountError(`The Console answered ${response.status}.`)
}

/** Whether the person may link and unlink projects of the active team. */
export function canManageConsoleProjects(account: ConsoleAccount): boolean {
  return account.roles.includes("owner") || account.roles.includes("admin")
}

/** The `/invite/<id>` page: the invitation id, or `undefined` on another page. */
export function consoleInvitationOf(pathname: string): string | undefined {
  const match = /^\/invite\/([^/]+)\/?$/.exec(pathname)
  return match ? decodeURIComponent(match[1]!) : undefined
}
