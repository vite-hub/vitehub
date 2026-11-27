import { defineOperation, operationAccessAllows, operationCall, operationSection } from "@vite-hub/internal/operations"
import * as v from "valibot"

import { bindConsoleAccess, consoleOperationAccess } from "./access.ts"
import { consoleAttachmentRequestBytes, consoleMediaUploadRequestBytes, maximumConsoleDocumentRequestBytes, maximumConsoleMediaRequestBytes, maximumConsoleRpcRequestBytes } from "./limits.ts"
import { consoleRequestError } from "./request.ts"
import { loadConsoleRuntime } from "./runtime.ts"

import type { AnyOperation, OperationContext, OperationDefinition } from "@vite-hub/internal/operations"
import type { ConsoleAccess } from "./access.ts"
import type { ConsoleRequestEvent } from "./request.ts"

type QueryValue = string | number | boolean | readonly string[] | undefined

interface LegacyRequest {
  agent?: string
  body?: unknown
  id?: string
  query?: Record<string, QueryValue>
}

/** The operation context with the Console access of the caller. */
export type ConsoleOperationContext = Omit<OperationContext, "access"> & { access: ConsoleAccess }

/** Builds the request event that a Console route handler reads, for a call of an operation. */
export function legacyEvent(route: string, method: "GET" | "POST", request: LegacyRequest, context: ConsoleOperationContext): ConsoleRequestEvent {
  const id = request.id ? `/${encodeURIComponent(request.id)}` : ""
  const url = new URL(`/_vitehub/api/${route}${id}`, "http://vitehub.local")
  for (const [key, value] of Object.entries(request.query ?? {})) {
    if (value === undefined) continue
    if (Array.isArray(value)) value.forEach(entry => url.searchParams.append(key, entry))
    else url.searchParams.set(key, String(value))
  }
  const params: Record<string, string> = {}
  if (request.agent) params.agent = request.agent
  if (request.id) params.id = request.id
  const body = method === "POST" && request.body !== undefined ? JSON.stringify(request.body) : undefined
  const event: ConsoleRequestEvent = {
    context: Object.keys(params).length ? { params } : undefined,
    "~standard": {
      vendor: "vitehub-console",
      req: new Request(url, { body, headers: context.request?.headers, method, signal: context.request?.signal }),
      res: context.response ?? {},
      runtime: context.env ? { cloudflare: { env: context.env } } : {},
      ...(context.waitUntil ? { waitUntil: context.waitUntil } : {}),
    },
  }
  return bindConsoleAccess(context.access, event)
}

/** A string input field. */
export const text = v.string()
/** An optional string input field. */
export const optionalText = v.optional(v.string())
/** An optional integer input field. */
export const optionalCount = v.optional(v.pipe(v.number(), v.integer()))
/** A record input field. */
export const record = v.record(v.string(), v.unknown())

function selectionError(): Error {
  return consoleRequestError(400, "A valid definition section is required.")
}

/** Returns the result of a Console action, or throws when the handler denied the section. */
export function actionResult(result: unknown): unknown {
  if (result instanceof Response) throw consoleRequestError(result.status, "This Console access does not include this section.")
  return result
}

/** Large calls put the operation name first in the envelope, so the RPC can classify them within 64 KiB. */
export const consoleOperationRequestBytes = {
  "agents.invoke": consoleAttachmentRequestBytes + maximumConsoleRpcRequestBytes,
  "documents.action": maximumConsoleDocumentRequestBytes + maximumConsoleRpcRequestBytes,
  "media.action": maximumConsoleMediaRequestBytes + maximumConsoleRpcRequestBytes,
  "media.upload": consoleMediaUploadRequestBytes,
} as const

/** Defines an operation that checks the Console access of the caller and loads the Console runtime before it runs. */
export function defineConsoleOperation<Input, Output>(definition: Omit<OperationDefinition<Input, Output>, "run"> & { run: (input: Input, context: ConsoleOperationContext) => Output | Promise<Output> }): OperationDefinition<Input, Output> {
  return defineOperation({
    ...definition,
    user: false,
    async run(input, context) {
      const access = await consoleOperationAccess(context)
      if (!operationAccessAllows(access, operationSection(definition, input), operationCall(definition, input))) {
        throw consoleRequestError(403, "This Console access does not include this operation.")
      }
      await loadConsoleRuntime()
      return definition.run(input, { ...context, access })
    },
  })
}

const definitionsList = defineConsoleOperation({
  cli: false,
  description: "Read the definitions of one Console section.",
  input: v.strictObject({ section: text }),
  kind: "read",
  name: "definitions.list",
  run: async ({ section }, context) => {
    if (!section) throw selectionError()
    return (await import("./definitions.get.ts")).listConsoleDefinitions({ section }, context.access)
  },
  section: input => input.section,
})

const projectGet = defineConsoleOperation({
  cli: { command: "get", namespace: "project" },
  description: "Read the project: its name, the vite-hub version, the time and Git commit of its production build, its open Comments threads, and the sections and operations that this access may use.",
  input: v.strictObject({}),
  kind: "read",
  name: "project.get",
  run: async (_input, context) => (await import("./project.ts")).readConsoleProject(context, { navigation: context.surface === "console" }),
  section: false,
})

const sectionsList = defineConsoleOperation({
  description: "List the Console sections that this access may open.",
  input: v.strictObject({}),
  kind: "read",
  name: "sections.list",
  run: async (_input, context) => (await import("./sections.get.ts")).listConsoleSections(context.access),
  section: false,
})

/** The operations that `vite-hub` owns for every Console. Each configured primitive adds its own operations through one lazy import. */
export const consoleOperations: readonly AnyOperation[] = [
  definitionsList,
  projectGet,
  sectionsList,
]
