import { callOperationRpc, operationRpcPath, type OperationRpcOutcome } from "@vite-hub/internal/operation-rpc"
import { viteHubPageToolsQuery } from "@vite-hub/internal/runtime/page-tools-shared"

import { consoleRpcHeader } from "../rpc"
import { githubAuthorLogin } from "../github-login"
import { consoleErrorFields } from "./request"
import { parseConsoleNavigation } from "./sections"

import type { ConsoleProjectTarget } from "./projects"
import type { ConsoleNavigation } from "./sections"

/** The `project.get` protocol that this Console reads. */
export const consoleProjectProtocol = 1

/**
 * What the production build of a project recorded: when it ran, its host and framework, and its Git commit when the
 * build found one. An older vite-hub sends no host, framework, or login.
 */
export interface ConsoleProjectBuild {
  time: string
  host?: { name: ConsoleProjectHostName, preset: string }
  framework?: { name: ConsoleProjectFrameworkName, version?: string }
  commit?: { sha: string, message?: string, author?: string, login?: string, branch?: string, repository?: string }
}

/** The names that the Console shows for the host and the framework of a build. */
export const consoleHostLabels = { cloudflare: "Cloudflare", deno: "Deno", netlify: "Netlify", node: "Node", vercel: "Vercel" } as const
export const consoleFrameworkLabels = { nitro: "Nitro", nuxt: "Nuxt" } as const
export type ConsoleProjectHostName = keyof typeof consoleHostLabels
export type ConsoleProjectFrameworkName = keyof typeof consoleFrameworkLabels

/** The GitHub avatar of a commit author, `size` pixels wide. */
export function consoleAuthorAvatarUrl(login: string, size = 40): string {
  return `https://github.com/${encodeURIComponent(login)}.png?size=${size}`
}

/** The answer of `project.get`: what the project runs, and what this access may use in it. */
export interface ConsoleProjectInfo {
  protocol: typeof consoleProjectProtocol
  name?: string
  /** The `vite-hub` version of the app. */
  vitehub?: string
  /** The build that serves the project. A development server and an older vite-hub send none. */
  build?: ConsoleProjectBuild
  /** The open Comments threads, when this access may open Comments. An older vite-hub sends none. */
  comments?: ConsoleProjectComments
  sections: string[]
  operations: string[]
  /** The answer of `sections.list`, which apps send to the Console page with `project.get`. Older apps leave it out. */
  navigation?: ConsoleNavigation
}

/**
 * What the Console found when it read `project.get` of a project.
 * - `ready`: the project answered with protocol 1.
 * - `signed`: the project takes only signed requests, and refused this one. `code` says why, such as
 *   `CONSOLE_KEY_UNKNOWN` before the app has the public key of the link.
 * - `protocol`: the project answered with another protocol, or runs a vite-hub without `project.get`.
 * - `unreachable`: the request failed before a response, from the network or a project that is offline.
 * - `missing`: no ViteHub Console answers at the URL: a 404, or a page that is not JSON without a server error.
 * - `failed`: the project answered with another error, such as a key that is not configured.
 */
export type ConsoleProjectProbe =
  | { kind: "ready", info: ConsoleProjectInfo }
  | { kind: "signed", code: string, message?: string, fix?: string }
  | { kind: "protocol", protocol?: number, vitehub?: string }
  | { kind: "unreachable" }
  | { kind: "missing" }
  | { kind: "failed", status: number, code?: string, message?: string, fix?: string }

/** The Comments of a project in `project.get`: how many threads are open. */
export interface ConsoleProjectComments {
  open: number
}

/** The address of `site` that opens with the Comments pill on, as Comment on site does in the app's Console. */
export function consoleCommentsSiteUrl(site: string): string {
  return `${site}?${viteHubPageToolsQuery}=comments`
}

/** Read the `comments` of a `project.get` answer. A count that is not a whole number is no count. */
export function consoleProjectCommentsOf(value: unknown): ConsoleProjectComments | undefined {
  const open: unknown = value instanceof Object ? Reflect.get(value, "open") : undefined
  return Number.isSafeInteger(open) && Number(open) >= 0 ? { open: Number(open) } : undefined
}

const field = (record: object, key: string): string | undefined => {
  const value: unknown = Reflect.get(record, key)
  return String(value) === value && value.trim() ? value.trim() : undefined
}

const isKey = <T extends object>(record: T, key: string | undefined): key is Extract<keyof T, string> => key !== undefined && Object.hasOwn(record, key)

/** Read the `build` of a `project.get` answer. A value without a valid time is no build. */
export function consoleProjectBuildOf(value: unknown): ConsoleProjectBuild | undefined {
  if (!(value instanceof Object)) return undefined
  const time = field(value, "time")
  if (!time || !Number.isFinite(Date.parse(time))) return undefined
  const build: ConsoleProjectBuild = { time }
  const hostValue: unknown = Reflect.get(value, "host")
  const hostName = hostValue instanceof Object ? field(hostValue, "name") : undefined
  const preset = hostValue instanceof Object ? field(hostValue, "preset") : undefined
  if (isKey(consoleHostLabels, hostName) && preset) build.host = { name: hostName, preset }
  const frameworkValue: unknown = Reflect.get(value, "framework")
  const frameworkName = frameworkValue instanceof Object ? field(frameworkValue, "name") : undefined
  if (frameworkValue instanceof Object && isKey(consoleFrameworkLabels, frameworkName)) {
    const version = field(frameworkValue, "version")
    build.framework = { name: frameworkName, ...(version ? { version } : {}) }
  }
  const commitValue: unknown = Reflect.get(value, "commit")
  const sha = commitValue instanceof Object ? field(commitValue, "sha") : undefined
  if (!(commitValue instanceof Object) || !sha) return build
  const commit: NonNullable<ConsoleProjectBuild["commit"]> = { sha }
  for (const key of ["message", "author", "branch"] as const) {
    const entry = field(commitValue, key)
    if (entry) commit[key] = entry
  }
  const login = githubAuthorLogin(field(commitValue, "login"))
  if (login) commit.login = login
  const repository = field(commitValue, "repository")
  if (repository && /^[\w.-]+\/[\w.-]+$/.test(repository)) commit.repository = repository
  return { ...build, commit }
}

/**
 * The GitHub page that compares the deployed commit with the default branch of its repository, which shows the
 * commits that are not live yet. `HEAD` on GitHub names the default branch. A build without a github.com repository or
 * a commit SHA has none.
 */
export function consoleCompareUrl(build: ConsoleProjectBuild | undefined): string | undefined {
  const commit = build?.commit
  if (!commit?.repository || !/^[0-9a-f]{7,64}$/i.test(commit.sha)) return undefined
  return `https://github.com/${commit.repository}/compare/${commit.sha}...HEAD`
}

const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((entry): entry is string => String(entry) === entry) : []

function parseProjectInfo(value: unknown): ConsoleProjectProbe {
  const record = value instanceof Object ? value : undefined
  const protocol: unknown = record ? Reflect.get(record, "protocol") : undefined
  const name: unknown = record ? Reflect.get(record, "name") : undefined
  const vitehub: unknown = record ? Reflect.get(record, "vitehub") : undefined
  const navigation: unknown = record ? Reflect.get(record, "navigation") : undefined
  const version = String(vitehub) === vitehub && vitehub ? vitehub : undefined
  if (protocol !== consoleProjectProtocol) {
    return { kind: "protocol", ...(Number.isInteger(protocol) ? { protocol: Number(protocol) } : {}), ...(version ? { vitehub: version } : {}) }
  }
  const build = consoleProjectBuildOf(record ? Reflect.get(record, "build") : undefined)
  const comments = consoleProjectCommentsOf(record ? Reflect.get(record, "comments") : undefined)
  return {
    kind: "ready",
    info: {
      protocol,
      ...(String(name) === name && name.trim() ? { name: name.trim() } : {}),
      ...(version ? { vitehub: version } : {}),
      ...(build ? { build } : {}),
      ...(comments ? { comments } : {}),
      operations: strings(record ? Reflect.get(record, "operations") : undefined),
      sections: strings(record ? Reflect.get(record, "sections") : undefined),
      ...(navigation instanceof Object ? { navigation: parseConsoleNavigation(navigation) } : {}),
    },
  }
}

/**
 * Read `project.get` of a project. An `account` Console sends it to its own server, which signs it for the project. The
 * request never sends cookies to another origin. Every failure before a response is `unreachable`.
 */
export async function probeConsoleProject(
  target: Pick<ConsoleProjectTarget, "base" | "origin">,
  options: { fetch?: typeof fetch, signal?: AbortSignal } = {},
): Promise<ConsoleProjectProbe> {
  const request = options.fetch ?? globalThis.fetch
  let outcome: OperationRpcOutcome<{ body: unknown, response: Response }>
  try {
    outcome = await callOperationRpc("project.get", {}, async (body) => {
      const response = await request(`${target.origin}${target.base}${operationRpcPath}`, {
        body,
        cache: "no-store",
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
          [consoleRpcHeader]: "1",
        },
        method: "POST",
        signal: options.signal,
      })
      return { body: await response.json().catch(() => undefined), response }
    })
  }
  catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error
    return { kind: "unreachable" }
  }
  const { response } = outcome.answer
  if (outcome.ok) return parseProjectInfo(outcome.value)
  // The signature check answers with the diagnostic body and no birpc reply.
  const fields = consoleErrorFields(outcome.error ?? outcome.answer.body)
  if (response.status === 401) {
    return { kind: "signed", code: fields.code ?? "CONSOLE_SIGNATURE_INVALID", ...(fields.message ? { message: fields.message } : {}), ...(fields.fix ? { fix: fields.fix } : {}) }
  }
  if (fields.code === "CONSOLE_FORWARD_UNREACHABLE") return { kind: "unreachable" }
  // A vite-hub release without `project.get` has the RPC endpoint but not the operation.
  if (response.status === 404 && fields.message === "Console operation not found.") return { kind: "protocol" }
  // A page that is not JSON means the app has no Console route, unless the server failed: a proxy's 502 page is an outage.
  if (response.status === 404 || (!(outcome.answer.body instanceof Object) && response.status < 500)) return { kind: "missing" }
  return { kind: "failed", status: response.status, ...(fields.code ? { code: fields.code } : {}), ...(fields.message ? { message: fields.message } : {}), ...(fields.fix ? { fix: fields.fix } : {}) }
}

/** What the Console says about a probe that did not open the project. */
export interface ConsoleProjectProblem {
  title: string
  message: string
  /** What to do, when the project said so. The Console shows it under the message. */
  fix?: string
}

/** The words for a probe that did not open the project. `host` is the project host, such as `app.example.com`. */
export function consoleProjectProblem(probe: Exclude<ConsoleProjectProbe, { kind: "ready" }>, context: { host: string, url: string }): ConsoleProjectProblem {
  switch (probe.kind) {
    case "signed":
      return {
        title: `${context.host} takes signed requests only`,
        message: probe.message ?? `${context.host} refused the signature of this Console. Set the VITEHUB_CONSOLE_KEY_<NAME> line that the Console shows for this app.`,
        ...(probe.fix ? { fix: probe.fix } : {}),
      }
    case "protocol":
      return {
        title: "Update vite-hub",
        message: probe.vitehub
          ? `This project runs vite-hub ${probe.vitehub}. This Console needs protocol ${consoleProjectProtocol}. Update vite-hub.`
          : `This project runs an older vite-hub. This Console needs protocol ${consoleProjectProtocol}. Update vite-hub.`,
      }
    case "unreachable":
      return { title: `Cannot reach ${context.host}`, message: `${context.host} did not answer this Console. Check that the app is online at ${context.url}.` }
    case "missing":
      return { title: "No project found", message: `No ViteHub Console answers at ${context.url}. Check the URL, and check that the app sets \`console\` in \`vitehub()\`.` }
    case "failed":
      return {
        title: probe.status === 403 ? "Access denied" : `${context.host} answered with an error`,
        message: probe.message ?? `The project answered with status ${probe.status}.`,
        ...(probe.fix ? { fix: probe.fix } : {}),
      }
  }
}
