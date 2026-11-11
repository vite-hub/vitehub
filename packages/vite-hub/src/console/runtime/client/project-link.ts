import { callOperationRpc, operationRpcPath, type OperationRpcOutcome } from "@vite-hub/internal/operation-rpc"

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
 * - `token`: the project asks for a Console token. `rejected` is true when the request sent a token and the project refused it.
 * - `signed`: the project takes only signed requests (`auth: "token"`), and refused this one. `code` says why, such as
 *   `CONSOLE_KEY_UNKNOWN` before the app has the public key of the link.
 * - `oauth`: the project signs in with OAuth. `resourceMetadata` is the URL of its protected resource metadata, from the
 *   `resource_metadata` of its challenge.
 * - `sign-in`: the project wants a session of the app, such as with `auth: "app"`.
 * - `protocol`: the project answered with another protocol, or runs a vite-hub without `project.get`.
 * - `unreachable`: the request failed before a response, from CORS, the network, or a project that is offline.
 * - `missing`: no ViteHub Console answers at the URL.
 * - `failed`: the project answered with another error, such as a token that is not configured.
 */
export type ConsoleProjectProbe =
  | { kind: "ready", info: ConsoleProjectInfo }
  | { kind: "token", rejected: boolean }
  | { kind: "signed", code: string, message?: string, fix?: string }
  | { kind: "oauth", resourceMetadata: string }
  | { kind: "sign-in" }
  | { kind: "protocol", protocol?: number, vitehub?: string }
  | { kind: "unreachable" }
  | { kind: "missing" }
  | { kind: "failed", status: number, code?: string, message?: string, fix?: string }

/** The `WWW-Authenticate` challenge of a Console data route that needs a token. */
const consoleRealm = /\brealm="vitehub-console"/i

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
          ...(token ? { authorization: `Bearer ${token}` } : {}),
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
  // Host middleware, such as the token check, answers with the diagnostic body and no birpc reply.
  const fields = consoleErrorFields(outcome.error ?? outcome.answer.body)
  if (response.status === 401) {
    // A cross-origin page cannot read `WWW-Authenticate` unless the app exposes it, so the body code also counts.
    const challenge = response.headers.get("www-authenticate") ?? ""
    const resourceMetadata = /\bresource_metadata="([^"]+)"/i.exec(challenge)?.[1]
    if (resourceMetadata) return { kind: "oauth", resourceMetadata }
    if (fields.code?.startsWith("CONSOLE_SIGNATURE_") || fields.code === "CONSOLE_KEY_UNKNOWN") {
      return { kind: "signed", code: fields.code, ...(fields.message ? { message: fields.message } : {}), ...(fields.fix ? { fix: fields.fix } : {}) }
    }
    if (consoleRealm.test(challenge) && !fields.code) return { kind: "token", rejected: Boolean(token) }
    return { kind: "sign-in" }
  }
  // A vite-hub release without `project.get` has the RPC endpoint but not the operation.
  if (response.status === 404 && fields.message === "Console operation not found.") return { kind: "protocol" }
  if (response.status === 404 || !(outcome.answer.body instanceof Object)) return { kind: "missing" }
  return { kind: "failed", status: response.status, ...(fields.code ? { code: fields.code } : {}), ...(fields.message ? { message: fields.message } : {}), ...(fields.fix ? { fix: fields.fix } : {}) }
}

/** What the Console says when a project refuses a token. */
export function consoleTokenRefused(host: string): string {
  return `${host} refused this token. Paste the token again, or ask the owner of the app for a new one.`
}

/** What the Console says about a probe that did not open the project. */
export interface ConsoleProjectProblem {
  title: string
  message: string
  /** What to do, when the project said so. The Console shows it under the message. */
  fix?: string
}

/**
 * The words for a probe that did not open the project. `host` is the project host, such as `app.example.com`, and
 * `consoleOrigin` is the origin of the Console page, such as `https://console.example.com`.
 */
export function consoleProjectProblem(probe: Exclude<ConsoleProjectProbe, { kind: "ready" }>, context: { consoleOrigin: string, host: string, url: string }): ConsoleProjectProblem {
  switch (probe.kind) {
    case "token":
      return probe.rejected
        ? { title: "The token is not correct", message: consoleTokenRefused(context.host) }
        : { title: `Enter the Console token for ${context.host}`, message: "The project uses `auth: \"token\"`. Paste the token that you created for it." }
    case "signed":
      return {
        title: `${context.host} takes signed requests only`,
        message: probe.message ?? `${context.host} uses \`auth: "token"\`. Open it from the ViteHub Console that linked it, or call it with the CLI and a signing key.`,
        ...(probe.fix ? { fix: probe.fix } : {}),
      }
    case "oauth":
      return { title: `Sign in to ${context.host}`, message: `${context.host} signs Consoles in with OAuth. Sign in on ${context.host} and allow this Console.` }
    case "sign-in":
      return {
        title: `${context.host} cannot sign this Console in`,
        message: `The project signs in through the app, but its Auth does not issue Console tokens. Add \`consoleMcpOAuth()\` to the app Auth, list ${context.consoleOrigin} in \`console.origins\`, and redeploy.`,
      }
    case "protocol":
      return {
        title: "Update vite-hub",
        message: probe.vitehub
          ? `This project runs vite-hub ${probe.vitehub}. This Console needs protocol ${consoleProjectProtocol}. Update vite-hub.`
          : `This project runs an older vite-hub. This Console needs protocol ${consoleProjectProtocol}. Update vite-hub.`,
      }
    case "unreachable":
      // The browser hides why a cross-origin request failed, so the message names both causes, the likely one last.
      return { title: `Cannot reach ${context.host}`, message: `${context.host} did not answer this Console. If the app is online, add ${context.consoleOrigin} to its \`console.origins\` and redeploy.` }
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
