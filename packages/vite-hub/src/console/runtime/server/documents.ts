import { installConsoleDocumentsScope, resolveConsoleDocuments } from "../../internal.ts"
import { readConsoleAccessUser, withConsoleAccess, type ConsoleAccess, type ConsoleAccessRoute } from "./access.ts"
import { assertConsoleRequest, consoleRequestError, consoleRequestJSON, consoleRequestURL } from "./request.ts"
import { getConsoleSections } from "./sections.ts"

import type { ConsoleDocumentCollection } from "../definitions.ts"
import type { ConsoleRequestEvent } from "./request.ts"

/** The document actions that one Console request may call. It mirrors `ViteHubConsoleDocumentActionName`. */
export const consoleDocumentActionNames = ["get", "list", "overview", "publish", "raw", "references", "remove", "restore", "revisions", "save", "schedule", "search", "session", "sessions", "unschedule"] as const

export type ConsoleDocumentActionName = (typeof consoleDocumentActionNames)[number]

export interface ConsoleDocumentActionContext {
  user: Record<string, unknown> | null
}

type ConsoleDocumentAction = (input: unknown, context: ConsoleDocumentActionContext) => unknown

/**
 * The owner actions of one document editor section. It mirrors `ViteHubConsoleDocumentActions`, which
 * `console/contributions.ts` checks against owner contributions.
 */
export type ConsoleDocumentActions = {
  collections(context: ConsoleDocumentActionContext): readonly ConsoleDocumentCollection[] | Promise<readonly ConsoleDocumentCollection[]>
  /** What the user may do in the media library of the section. */
  mediaAccess(context: ConsoleDocumentActionContext): ConsoleMediaAccess | Promise<ConsoleMediaAccess>
} & Record<ConsoleDocumentActionName, ConsoleDocumentAction>

/** Mirrors `ViteHubConsoleMediaAccess`. */
export interface ConsoleMediaAccess {
  manage: boolean
  read: boolean
  write: boolean
}

/** Loads the owner actions of each document editor section on first use. */
export type ConsoleDocumentEditors = Readonly<Record<string, () => Promise<ConsoleDocumentActions>>>

/** What the generated Console plugin installs for one document editor section. */
export interface ConsoleDocumentEditorInstall {
  /** Owner factory that turns the application module into actions. */
  actions: (module: Record<string, unknown>) => ConsoleDocumentActions
  /** Imports the application module, such as `server/content.ts`. */
  load: () => Promise<Record<string, unknown>>
}

/** Bodies carry a whole Markdown document, so they may exceed the ordinary Console request limit. */
export const maximumConsoleDocumentRequestBytes: number = 1024 * 1024

const actionFailureKey = Symbol.for("vitehub.console.action-failure")

interface ConsoleActionFailure {
  code: string
  details?: Record<string, unknown>
  message: string
  status: number
}

function readActionFailure(error: unknown): ConsoleActionFailure | undefined {
  if (error === null || Object(error) !== error) return
  const failure: unknown = Reflect.get(Object(error), actionFailureKey)
  if (failure === null || Object(failure) !== failure) return
  const code: unknown = Reflect.get(Object(failure), "code")
  const message: unknown = Reflect.get(Object(failure), "message")
  const status: unknown = Reflect.get(Object(failure), "status")
  const details: unknown = Reflect.get(Object(failure), "details")
  if (String(code) !== code || String(message) !== message || !Number.isInteger(status) || Number(status) < 400 || Number(status) > 499) return
  const result: ConsoleActionFailure = { code, message, status: Number(status) }
  if (details !== null && Object(details) === details && !Array.isArray(details)) result.details = JSON.parse(JSON.stringify(details))
  return result
}

/** A Console request error that the RPC response returns with its code and details. */
export function consoleActionError(failure: ConsoleActionFailure): Error {
  const error = Object.assign(consoleRequestError(failure.status, failure.message), { consoleCode: failure.code })
  if (failure.details) Object.assign(error, { consoleDetails: failure.details })
  return error
}

/** Install the document editor sections of one project. Generated Console output calls this. */
export function installConsoleDocuments(projectRoot: string, editors: Readonly<Record<string, ConsoleDocumentEditorInstall>>): ConsoleDocumentEditors {
  const loaders: Record<string, () => Promise<ConsoleDocumentActions>> = {}
  for (const [section, editor] of Object.entries(editors)) {
    let loading: Promise<ConsoleDocumentActions> | undefined
    loaders[section] = () => {
      loading ??= editor.load().then(module => editor.actions(module))
      // Let the next request retry a module that failed to load, for example after a development edit.
      loading.catch(() => {
        loading = undefined
      })
      return loading
    }
  }
  return installConsoleDocumentsScope(projectRoot, Object.freeze(loaders))
}

/** Loads the owner actions of a document editor section that the project enables. */
export async function loadConsoleDocumentActions(section: string): Promise<ConsoleDocumentActions> {
  const load = getConsoleSections().includes(section) ? resolveConsoleDocuments()?.[section] : undefined
  if (!load) throw consoleRequestError(404, "Document editor section not found.")
  try {
    return await load()
  }
  catch (error) {
    globalThis.console.error("[vitehub] The Console could not load the document editor actions.", error)
    throw consoleRequestError(503, "The document editor is unavailable. Check the server log.")
  }
}

/** The owner action context of a checked Console access. */
export async function consoleDocumentActionContext(access: ConsoleAccess): Promise<ConsoleDocumentActionContext> {
  return { user: await readConsoleAccessUser(access) ?? null }
}

/** Runs an owner action and returns its failures with their status, code, and details. */
export async function runConsoleDocumentAction<T>(action: () => T | Promise<T>): Promise<T> {
  try {
    return await action()
  }
  catch (error) {
    const failure = readActionFailure(error)
    if (failure) throw consoleActionError(failure)
    globalThis.console.error("[vitehub] A Console document action failed.", error)
    throw consoleRequestError(500, "The document action failed. Check the server log.")
  }
}

/** Reads the collections that the signed-in user may read, for the definitions route. */
export async function readConsoleDocumentCollections(section: string, access: ConsoleAccess): Promise<ConsoleDocumentCollection[]> {
  const actions = await loadConsoleDocumentActions(section)
  const user = await consoleDocumentActionContext(access)
  return [...await runConsoleDocumentAction(() => actions.collections(user))]
}

function isActionName(value: unknown): value is ConsoleDocumentActionName {
  return consoleDocumentActionNames.some(name => name === value)
}

async function consoleDocumentsHandler(event: ConsoleRequestEvent, access: ConsoleAccess): Promise<{ value: unknown }> {
  assertConsoleRequest(event, ["POST"])
  const query = consoleRequestURL(event).searchParams
  const section = query.get("section") ?? ""
  const action = query.get("action")
  if (!isActionName(action)) throw consoleRequestError(400, "A valid document action is required.")
  const actions = await loadConsoleDocumentActions(section)
  const input = await consoleRequestJSON(event, maximumConsoleDocumentRequestBytes)
  const user = await consoleDocumentActionContext(access)
  // `undefined` does not survive JSON, so a `remove` result is wrapped.
  return { value: await runConsoleDocumentAction(() => actions[action](input, user)) ?? null }
}

/** Runs one owner document action. The section comes from the request and must be in the access scope. */
const guardedHandler: ConsoleAccessRoute<typeof consoleDocumentsHandler> = withConsoleAccess(consoleDocumentsHandler, {
  section: event => consoleRequestURL(event).searchParams.get("section") ?? undefined,
})
export default guardedHandler
