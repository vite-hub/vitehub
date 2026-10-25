import { defineOperation } from "@vite-hub/internal/operations"
import * as v from "valibot"

import { bindConsoleAccess } from "./access.ts"
import { consoleAttachmentRequestBytes, consoleDocumentActionNames, maximumConsoleDocumentRequestBytes, maximumConsoleMediaRequestBytes, maximumConsoleRpcRequestBytes } from "./limits.ts"
import { consoleRequestError } from "./request.ts"
import { viteHubErrorDiagnostics } from "../../../error-diagnostics.ts"

import type { AnyOperation, OperationContext, OperationDefinition } from "@vite-hub/internal/operations"
import type { ConsoleAccess } from "./access.ts"
import type { ConsoleRequestEvent } from "./request.ts"

/** Document actions that only read. A read-only section grant keeps them. */
const consoleDocumentReadActions: ReadonlySet<string> = new Set(["get", "list", "overview", "raw", "references", "revisions", "search", "session", "sessions"])
/** Media actions that only read. */
const consoleMediaReadActions: ReadonlySet<string> = new Set(["get", "info", "list", "usage"])

type QueryValue = string | number | boolean | readonly string[] | undefined

/** The pieces of the former route request that a legacy Console handler reads. */
interface LegacyRequest {
  agent?: string
  body?: unknown
  id?: string
  query?: Record<string, QueryValue>
}

function legacyEvent(route: string, method: "GET" | "POST", request: LegacyRequest, context: OperationContext): ConsoleRequestEvent {
  const id = request.id ? `/${encodeURIComponent(request.id)}` : ""
  const url = new URL(`/api/_vitehub/console/${route}${id}`, "http://vitehub.local")
  for (const [key, value] of Object.entries(request.query ?? {})) {
    if (value === undefined) continue
    if (Array.isArray(value)) value.forEach(entry => url.searchParams.append(key, entry))
    else url.searchParams.set(key, String(value))
  }
  const params: Record<string, string> = {}
  if (request.agent) params.agent = request.agent
  if (request.id) params.id = request.id
  const event: ConsoleRequestEvent = {
    env: context.env,
    context: Object.keys(params).length ? { params } : undefined,
    method,
    req: { json: async () => request.body, method, url },
    res: context.response ?? {},
  }
  if (context.waitUntil) event.waitUntil = context.waitUntil
  // SAFETY: The Console RPC issues every context of a Console operation with the access that its check created.
  return bindConsoleAccess(context.access as ConsoleAccess, event)
}

const text = v.string()
const optionalText = v.optional(v.string())
const optionalCount = v.optional(v.pipe(v.number(), v.integer()))
const record = v.record(v.string(), v.unknown())

function selectionError(): Error {
  return consoleRequestError(400, "A valid definition section is required.")
}

function actionResult(result: unknown): unknown {
  if (result instanceof Response) throw consoleRequestError(result.status, "This Console access does not include this section.")
  return result
}

/** Large calls put the operation name first in the envelope, so the RPC can classify them within 64 KiB. */
export const consoleOperationRequestBytes = {
  "agents.invoke": consoleAttachmentRequestBytes + maximumConsoleRpcRequestBytes,
  "documents.action": maximumConsoleDocumentRequestBytes + maximumConsoleRpcRequestBytes,
  "media.action": maximumConsoleMediaRequestBytes + maximumConsoleRpcRequestBytes,
} as const

// The handlers of these operations read the signed-in user themselves, when they need it.
function defineConsoleOperation<Input, Output>(definition: OperationDefinition<Input, Output>): OperationDefinition<Input, Output> {
  return defineOperation({ ...definition, user: false })
}

const agentsList = defineConsoleOperation({
  description: "List the Agents of the app.",
  input: v.strictObject({}),
  kind: "read",
  name: "agents.list",
  run: async (_input, context) => (await import("./agents.get.ts")).default(legacyEvent("agents", "GET", {}, context)),
  section: "agents",
})

const agentsInvoke = defineConsoleOperation({
  cli: { positional: ["agent"] },
  description: "Start an Agent Invocation with a prompt.",
  input: v.strictObject({
    agent: v.pipe(text, v.minLength(1)),
    agentRoute: v.optional(v.literal("encoded")),
    attachments: v.optional(v.array(v.object({ id: text, name: text }))),
    files: v.optional(v.array(v.object({ filename: optionalText, url: text }))),
    invokerProfileId: optionalText,
    messages: v.optional(v.array(record)),
    prompt: text,
  }),
  kind: "write",
  maxRequestBytes: consoleOperationRequestBytes["agents.invoke"],
  name: "agents.invoke",
  run: async ({ agent, agentRoute, ...body }, context) => (await import("./agent-invocations.post.ts")).default(legacyEvent(`agents/${agent}/invocations`, "POST", { agent, body, query: { agentRoute } }, context)),
  section: "agents",
})

const blobList = defineConsoleOperation({
  description: "List the objects of a Blob store.",
  input: v.strictObject({ cursor: optionalText, folded: v.optional(v.boolean()), limit: optionalCount, prefix: optionalText, showVitehub: v.optional(v.boolean()), store: optionalText }),
  kind: "read",
  name: "blob.list",
  run: async (input, context) => (await import("./blob.get.ts")).default(legacyEvent("blob", "GET", { query: input }, context)),
  section: "blob",
})

const databasesBrowse = defineConsoleOperation({
  cli: { namespace: "databases", command: "browse" },
  description: "Read the rows of a database table.",
  input: v.strictObject({
    database: optionalText,
    direction: v.optional(v.picklist(["asc", "desc"])),
    limit: optionalCount,
    offset: optionalCount,
    search: optionalText,
    sort: optionalText,
    table: optionalText,
  }),
  kind: "read",
  name: "databases.browse",
  run: async (input, context) => (await import("./database.get.ts")).default(legacyEvent("database", "GET", { query: input }, context)),
  section: "databases",
})

const definitionsList = defineConsoleOperation({
  cli: { positional: ["section"] },
  description: "Read the definitions of one Console section.",
  input: v.strictObject({ section: text }),
  kind: "read",
  name: "definitions.list",
  run: async ({ section }, context) => {
    if (!section) throw selectionError()
    return (await import("./definitions.get.ts")).default(legacyEvent("definitions", "GET", { query: { section } }, context))
  },
  section: input => input.section,
})

const documentsAction = defineConsoleOperation({
  description: "Run one document editor action of a Console section.",
  input: v.strictObject({ action: v.picklist(consoleDocumentActionNames), body: v.optional(v.unknown()), section: text }),
  kind: "write",
  maxRequestBytes: consoleOperationRequestBytes["documents.action"],
  // A read-only grant still opens, lists, and searches documents.
  readOnlyWhen: ({ action }) => consoleDocumentReadActions.has(action),
  name: "documents.action",
  run: async ({ action, body, section }, context) => {
    const result = actionResult(await (await import("./documents.ts")).default(legacyEvent("documents", "POST", { body, query: { action, section } }, context))) as { value: unknown }
    return result.value
  },
  section: input => input.section,
})

const envGet = defineConsoleOperation({
  description: "Read the Server Env declarations, or the status of their values.",
  input: v.strictObject({ status: v.optional(v.boolean()) }),
  kind: "read",
  name: "env.get",
  run: async ({ status }, context) => (await import("./env.get.ts")).default(legacyEvent("env", "GET", { query: { status: status ? "1" : undefined } }, context)),
  section: "env",
})

const invocationsList = defineConsoleOperation({
  cli: { namespace: "invocations" },
  description: "List Agent Invocations, newest first.",
  input: v.strictObject({ agent: optionalText, capability: optionalText, cursor: optionalText, id: v.optional(v.array(text)), limit: optionalCount, triggeredBy: optionalText }),
  kind: "read",
  name: "invocations.list",
  run: async (input, context) => (await import("./invocations.get.ts")).default(legacyEvent("invocations", "GET", { query: input }, context)),
  section: "agents",
})

const invocationsGet = defineConsoleOperation({
  cli: { namespace: "invocations", positional: ["id"] },
  description: "Read one Agent Invocation with its observations.",
  input: v.strictObject({ id: v.pipe(text, v.minLength(1)), observationCount: optionalCount, observationCursor: optionalText }),
  kind: "read",
  name: "invocations.get",
  run: async ({ id, ...query }, context) => (await import("./invocation.get.ts")).default(legacyEvent("invocations", "GET", { id, query }, context)),
  section: "agents",
})

const invocationsCancel = defineConsoleOperation({
  cli: { namespace: "invocations", positional: ["id"] },
  description: "Ask a running Agent Invocation to stop.",
  input: v.strictObject({ id: v.pipe(text, v.minLength(1)) }),
  kind: "write",
  name: "invocations.cancel",
  run: async ({ id }, context) => (await import("./invocation.get.ts")).default(legacyEvent("invocations", "POST", { body: { action: "cancel" }, id }, context)),
  section: "agents",
})

const invocationsDelete = defineConsoleOperation({
  cli: { namespace: "invocations", positional: ["id"] },
  description: "Delete one finished Agent Invocation.",
  input: v.strictObject({ id: v.pipe(text, v.minLength(1)) }),
  kind: "destructive",
  name: "invocations.delete",
  run: async ({ id }, context) => (await import("./invocation.get.ts")).default(legacyEvent("invocations", "POST", { body: { action: "delete" }, id }, context)),
  section: "agents",
})

const invocationsCapabilities = defineConsoleOperation({
  cli: { namespace: "invocations" },
  description: "List the capabilities of an Agent Invocation setup.",
  input: v.strictObject({ agent: optionalText }),
  kind: "read",
  name: "invocations.capabilities",
  run: async (input, context) => (await import("./invocation-capabilities.get.ts")).default(legacyEvent("invocation-capabilities", "GET", { query: input }, context)),
  section: "agents",
})

const invocationsWorkspace = defineConsoleOperation({
  cli: { namespace: "invocations", positional: ["id"] },
  description: "Read the Workspace files and history of one Agent Invocation.",
  input: v.strictObject({ cursor: optionalText, history: v.optional(v.boolean()), id: v.pipe(text, v.minLength(1)), path: optionalText, ref: optionalText, revision: optionalText }),
  kind: "read",
  name: "invocations.workspace",
  run: async ({ id, history, ...query }, context) => (await import("./invocation-workspace.get.ts")).default(legacyEvent("invocation-workspace", "GET", { id, query: { ...query, history: history ? "1" : undefined } }, context)),
  section: "agents",
})

const kvList = defineConsoleOperation({
  description: "List the keys of a KV store.",
  input: v.strictObject({ cursor: optionalText, limit: optionalCount, prefix: optionalText, store: optionalText }),
  kind: "read",
  name: "kv.list",
  run: async (input, context) => (await import("./kv.get.ts")).default(legacyEvent("kv", "GET", { query: input }, context)),
  section: "kv",
})

const kvGet = defineConsoleOperation({
  cli: { positional: ["key"] },
  description: "Read the value of one KV key.",
  input: v.strictObject({ key: text, store: optionalText }),
  kind: "read",
  name: "kv.get",
  run: async (input, context) => (await import("./kv.get.ts")).default(legacyEvent("kv", "POST", { body: input }, context)),
  section: "kv",
})

const mediaAction = defineConsoleOperation({
  description: "Run one media library action of a Console section.",
  input: v.strictObject({ action: text, body: v.optional(v.unknown()), section: text }),
  kind: "write",
  maxRequestBytes: consoleOperationRequestBytes["media.action"],
  // A read-only grant still browses the library.
  readOnlyWhen: ({ action }) => consoleMediaReadActions.has(action),
  name: "media.action",
  run: async ({ action, body, section }, context) => (await import("./media.ts")).runConsoleMediaAction(section, action, body, context.access as ConsoleAccess),
  section: input => input.section,
})

const schedulesRun = defineConsoleOperation({
  cli: { positional: ["name"] },
  description: "Run a manual Schedule Definition now.",
  input: v.strictObject({ name: v.pipe(text, v.minLength(1)) }),
  kind: "write",
  name: "schedules.run",
  run: async (input, context) => (await import("./schedule-run.ts")).consoleScheduleRunHandler(legacyEvent("schedule-run", "POST", { body: input }, context)),
  section: "schedules",
})

const searchQuery = defineConsoleOperation({
  cli: { namespace: "search", command: "query", positional: ["search"] },
  description: "Search the Agent Invocations of the Console.",
  input: v.strictObject({ cursor: optionalText, limit: optionalCount, search: optionalText }),
  kind: "read",
  name: "search.query",
  run: async (input, context) => {
    const event = legacyEvent("search", "GET", { query: input }, context)
    const response = await (await import("./search.get.ts")).consoleSearchCollectionHandler.fetch(new Request(event.req!.url!, { method: "GET" }))
    if (!response.ok) throw await searchError(response)
    return await response.json()
  },
  section: "agents",
})

const sectionsList = defineConsoleOperation({
  description: "List the Console sections that this access may open.",
  input: v.strictObject({}),
  kind: "read",
  name: "sections.list",
  run: async (_input, context) => (await import("./sections.get.ts")).default(legacyEvent("sections", "GET", {}, context)),
  section: false,
})

const statusGet = defineConsoleOperation({
  cli: { command: "status", namespace: "agents" },
  description: "Read the status of an Agent: its setup and what it can do.",
  input: v.strictObject({ agent: optionalText }),
  kind: "read",
  name: "status.get",
  run: async (input, context) => (await import("./status.get.ts")).default(legacyEvent("status", "GET", { query: input }, context)),
  section: "agents",
})

const usageGet = defineConsoleOperation({
  description: "Read token use and cost evidence of Agent Invocations.",
  input: v.strictObject({ agent: optionalText, cursor: optionalText, search: optionalText, status: optionalText, window: optionalText }),
  kind: "read",
  name: "usage.get",
  run: async (input, context) => (await import("./usage.get.ts")).default(legacyEvent("usage", "GET", { query: input }, context)),
  section: "usage",
})

async function searchError(response: Response): Promise<Error> {
  const body = await response.text()
  let message = body
  try {
    const parsed = v.safeParse(v.object({ message: v.optional(v.unknown()), statusMessage: v.optional(v.unknown()) }), JSON.parse(body))
    if (parsed.success) {
      const statusMessage = v.safeParse(v.string(), parsed.output.statusMessage)
      const responseMessage = v.safeParse(v.string(), parsed.output.message)
      if (statusMessage.success) message = statusMessage.output
      else if (responseMessage.success) message = responseMessage.output
    }
  }
  catch {
    // Keep a non-JSON upstream answer as it is.
  }
  return Object.assign(viteHubErrorDiagnostics.VITE_HUB_R0052({ message }), { statusCode: response.status, statusMessage: message })
}

/** The operations that `vite-hub` owns for the Console sections. Packages contribute their own through plugin metadata. */
export const consoleOperations: readonly AnyOperation[] = [
  agentsInvoke,
  agentsList,
  blobList,
  databasesBrowse,
  definitionsList,
  documentsAction,
  envGet,
  invocationsCancel,
  invocationsCapabilities,
  invocationsDelete,
  invocationsGet,
  invocationsList,
  invocationsWorkspace,
  kvGet,
  kvList,
  mediaAction,
  schedulesRun,
  searchQuery,
  sectionsList,
  statusGet,
  usageGet,
]
