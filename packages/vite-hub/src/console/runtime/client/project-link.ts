import { callOperationRpc, operationRpcPath, type OperationRpcOutcome } from "@vite-hub/internal/operation-rpc"

import { consoleRpcHeader } from "../rpc"
import { consoleErrorFields } from "./request"

import type { ConsoleProjectTarget } from "./projects"

/** The `project.get` protocol that this Console reads. */
export const consoleProjectProtocol = 1

/** What the production build of a project recorded: when it ran, and its Git commit when the build found one. */
export interface ConsoleProjectBuild {
  time: string
  commit?: { sha: string, message?: string, author?: string, branch?: string }
}

/** The answer of `project.get`: what the project runs, and what this access may use in it. */
export interface ConsoleProjectInfo {
  protocol: typeof consoleProjectProtocol
  name?: string
  /** The `vite-hub` version of the app. */
  vitehub?: string
  /** The build that serves the project. A development server and an older vite-hub send none. */
  build?: ConsoleProjectBuild
  sections: string[]
  operations: string[]
}

/**
 * What the Console found when it read `project.get` of a project.
 * - `ready`: the project answered with protocol 1.
 * - `signed`: the project takes only signed requests, and refused this one. `code` says why, such as
 *   `CONSOLE_KEY_UNKNOWN` before the app has the public key of the link.
 * - `protocol`: the project answered with another protocol, or runs a vite-hub without `project.get`.
 * - `unreachable`: the request failed before a response, from the network or a project that is offline.
 * - `missing`: no ViteHub Console answers at the URL.
 * - `failed`: the project answered with another error, such as a key that is not configured.
 */
export type ConsoleProjectProbe =
  | { kind: "ready", info: ConsoleProjectInfo }
  | { kind: "signed", code: string, message?: string, fix?: string }
  | { kind: "protocol", protocol?: number, vitehub?: string }
  | { kind: "unreachable" }
  | { kind: "missing" }
  | { kind: "failed", status: number, code?: string, message?: string, fix?: string }

const field = (record: object, key: string): string | undefined => {
  const value: unknown = Reflect.get(record, key)
  return String(value) === value && value.trim() ? value.trim() : undefined
}

/** Read the `build` of a `project.get` answer. A value without a valid time is no build. */
export function consoleProjectBuildOf(value: unknown): ConsoleProjectBuild | undefined {
  if (!(value instanceof Object)) return undefined
  const time = field(value, "time")
  if (!time || !Number.isFinite(Date.parse(time))) return undefined
  const commitValue: unknown = Reflect.get(value, "commit")
  const sha = commitValue instanceof Object ? field(commitValue, "sha") : undefined
  if (!(commitValue instanceof Object) || !sha) return { time }
  const commit: NonNullable<ConsoleProjectBuild["commit"]> = { sha }
  for (const key of ["message", "author", "branch"] as const) {
    const entry = field(commitValue, key)
    if (entry) commit[key] = entry
  }
  return { time, commit }
}

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
  const build = consoleProjectBuildOf(record ? Reflect.get(record, "build") : undefined)
  return {
    kind: "ready",
    info: {
      protocol,
      ...(String(name) === name && name.trim() ? { name: name.trim() } : {}),
      ...(version ? { vitehub: version } : {}),
      ...(build ? { build } : {}),
      operations: strings(record ? Reflect.get(record, "operations") : undefined),
      sections: strings(record ? Reflect.get(record, "sections") : undefined),
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
  // A vite-hub release without `project.get` has the RPC endpoint but not the operation.
  if (response.status === 404 && fields.message === "Console operation not found.") return { kind: "protocol" }
  if (response.status === 404 || !(outcome.answer.body instanceof Object)) return { kind: "missing" }
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
