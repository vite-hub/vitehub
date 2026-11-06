import { consoleRpcHeader } from "../rpc"
import { consoleErrorFields } from "./request"

import type { ConsoleProjectTarget } from "./projects"

/** The `project.get` protocol that this Console reads. */
export const consoleProjectProtocol = 1

/** The answer of `project.get`: what the project runs, and what this access may use in it. */
export interface ConsoleProjectInfo {
  protocol: typeof consoleProjectProtocol
  name?: string
  /** The `vite-hub` version of the app. */
  vitehub?: string
  sections: string[]
  operations: string[]
}

/**
 * What the Console found when it read `project.get` of a project.
 * - `ready`: the project answered with protocol 1.
 * - `token`: the project uses `auth: "token"`. `rejected` is true when the request sent a token and the project refused it.
 * - `oauth`: the project signs in with OAuth (its challenge names `resource_metadata`).
 * - `sign-in`: the project wants a session of the app, such as with `auth: "app"`.
 * - `protocol`: the project answered with another protocol, or runs a vite-hub without `project.get`.
 * - `unreachable`: the request failed before a response, from CORS, the network, or a project that is offline.
 * - `missing`: no ViteHub Console answers at the URL.
 * - `failed`: the project answered with another error, such as a token that is not configured.
 */
export type ConsoleProjectProbe =
  | { kind: "ready", info: ConsoleProjectInfo }
  | { kind: "token", rejected: boolean }
  | { kind: "oauth" }
  | { kind: "sign-in" }
  | { kind: "protocol", protocol?: number, vitehub?: string }
  | { kind: "unreachable" }
  | { kind: "missing" }
  | { kind: "failed", status: number, message?: string, fix?: string }

/** The `WWW-Authenticate` challenge of a Console data route that needs a token. */
const consoleRealm = /\brealm="vitehub-console"/i
const consoleProjectGetPath = "/_vitehub/rpc/__call"

const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((entry): entry is string => String(entry) === entry) : []

function parseProjectInfo(value: unknown): ConsoleProjectProbe {
  const record = value instanceof Object ? value : undefined
  const protocol: unknown = record ? Reflect.get(record, "protocol") : undefined
  const name: unknown = record ? Reflect.get(record, "name") : undefined
  const vitehub: unknown = record ? Reflect.get(record, "vitehub") : undefined
  const version = String(vitehub) === vitehub && vitehub ? vitehub : undefined
  if (protocol !== consoleProjectProtocol) {
    return { kind: "protocol", ...(Number.isInteger(protocol) ? { protocol: Number(protocol) } : {}), ...(version ? { vitehub: version } : {}) }
  }
  return {
    kind: "ready",
    info: {
      protocol,
      ...(String(name) === name && name.trim() ? { name: name.trim() } : {}),
      ...(version ? { vitehub: version } : {}),
      operations: strings(record ? Reflect.get(record, "operations") : undefined),
      sections: strings(record ? Reflect.get(record, "sections") : undefined),
    },
  }
}

/**
 * Read `project.get` of a project, with its Console token when it has one. The request never sends cookies to another
 * origin. A browser hides why a cross-origin request failed, so every failure before a response is `unreachable`.
 */
export async function probeConsoleProject(
  target: Pick<ConsoleProjectTarget, "base" | "origin">,
  token?: string,
  options: { fetch?: typeof fetch, signal?: AbortSignal } = {},
): Promise<ConsoleProjectProbe> {
  const request = options.fetch ?? globalThis.fetch
  let response: Response
  try {
    response = await request(`${target.origin}${target.base}${consoleProjectGetPath}`, {
      body: JSON.stringify({ operation: "project.get", input: {} }),
      cache: "no-store",
      credentials: "same-origin",
      headers: {
        "content-type": "application/json",
        [consoleRpcHeader]: "1",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      method: "POST",
      signal: options.signal,
    })
  }
  catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error
    return { kind: "unreachable" }
  }
  const body: unknown = await response.json().catch(() => undefined)
  const fields = consoleErrorFields(body)
  if (response.status === 401) {
    // A cross-origin page cannot read `WWW-Authenticate` unless the app exposes it, so the body code also counts.
    const challenge = response.headers.get("www-authenticate") ?? ""
    if (/\bresource_metadata=/i.test(challenge)) return { kind: "oauth" }
    if (fields.code === "CONSOLE_TOKEN_INVALID" || (consoleRealm.test(challenge) && !fields.code)) return { kind: "token", rejected: Boolean(token) }
    return { kind: "sign-in" }
  }
  const record = body instanceof Object ? body : undefined
  if (response.ok && record && Reflect.get(record, "ok") === true) return parseProjectInfo(Reflect.get(record, "value"))
  // A vite-hub release without `project.get` has the RPC endpoint but not the operation.
  if (response.status === 404 && fields.message === "Console operation not found.") return { kind: "protocol" }
  if (response.status === 404 || !record) return { kind: "missing" }
  return { kind: "failed", status: response.status, ...(fields.message ? { message: fields.message } : {}), ...(fields.fix ? { fix: fields.fix } : {}) }
}

/** What the Console says about a probe that did not open the project. */
export interface ConsoleProjectProblem {
  title: string
  message: string
}

/**
 * The words for a probe that did not open the project. `host` is the project host, such as `app.example.com`, and
 * `consoleOrigin` is the origin of the Console page, such as `https://console.example.com`.
 */
export function consoleProjectProblem(probe: Exclude<ConsoleProjectProbe, { kind: "ready" }>, context: { consoleOrigin: string, host: string, url: string }): ConsoleProjectProblem {
  switch (probe.kind) {
    case "token":
      return probe.rejected
        ? { title: "The token is not correct", message: `${context.host} refused this token. Copy the current value of VITEHUB_CONSOLE_TOKEN from the server and try again.` }
        : { title: `Enter the Console token for ${context.host}`, message: "The project uses auth: \"token\". Paste the value of VITEHUB_CONSOLE_TOKEN." }
    case "oauth":
      return { title: "OAuth sign-in is not ready", message: "This project signs in with OAuth. Coming soon; use auth: \"token\" for now." }
    case "sign-in":
      return { title: "App sign-in is not ready", message: "This project signs in through the app. Coming soon; use auth: \"token\" for now." }
    case "protocol":
      return {
        title: "Update vite-hub",
        message: probe.vitehub
          ? `This project runs vite-hub ${probe.vitehub}. This Console needs protocol ${consoleProjectProtocol}. Update vite-hub.`
          : `This project runs an older vite-hub. This Console needs protocol ${consoleProjectProtocol}. Update vite-hub.`,
      }
    case "unreachable":
      return { title: `Cannot reach ${context.host}`, message: `${context.consoleOrigin} is not in console.origins for ${context.host}. Add it and redeploy. The project may also be offline.` }
    case "missing":
      return { title: "No project found", message: `No ViteHub Console answers at ${context.url}. Check the URL, and check that the app sets console in vitehub().` }
    case "failed":
      return {
        title: probe.status === 403 ? "Access denied" : `${context.host} answered with an error`,
        message: [probe.message ?? `The project answered with status ${probe.status}.`, probe.fix].filter(Boolean).join(" "),
      }
  }
}
