import { defineOperation, operationAccessAllows, operationCall, operationSection, table } from "@vite-hub/internal/operations"
import * as v from "valibot"

import { bindConsoleAccess, consoleOperationAccess } from "./access.ts"
import { loadConsoleMedia } from "./blob.ts"
import { consoleAttachmentRequestBytes, consoleDocumentActionNames, consoleMediaUploadRequestBytes, maximumConsoleDocumentRequestBytes, maximumConsoleMediaRequestBytes, maximumConsoleRpcRequestBytes } from "./limits.ts"
import { consoleRequestError } from "./request.ts"
import { loadConsoleRuntime } from "./runtime.ts"
import { viteHubErrorDiagnostics } from "../../../error-diagnostics.ts"
import { authConsoleActionOperations, authConsoleImpersonationOperations, authConsoleReadOperations } from "../auth-operations.ts"

import type { AuthConsole, AuthConsoleErrorCode, AuthConsoleMutation } from "@vite-hub/auth/console-runtime"
import type { AnyOperation, OperationContext, OperationDefinition, OperationKind } from "@vite-hub/internal/operations"
import type { Result } from "@vite-hub/runtime"
import type { StandardSchemaV1 } from "@standard-schema/spec"
import type { ConsoleAccess } from "./access.ts"
import type { ConsoleRequestEvent } from "./request.ts"
import type { ConsoleTicket } from "./tickets.ts"
import type { SiteGrant, SiteInvite, SiteSession } from "../site-access.ts"

// Standalone runtime imports retain every operation; host builds replace these flags before bundling.
declare global {
  interface ImportMeta {
    viteHubConsoleAgents?: boolean
    viteHubConsoleAuth?: boolean
    viteHubConsoleDatabase?: boolean
    viteHubConsoleWorkspaces?: boolean
    viteHubConsoleDocuments?: boolean
  }
}

function disabledConsoleFeature(feature: string): Promise<never> {
  return Promise.reject(consoleRequestError(404, `The Console ${feature} section is disabled.`))
}

/** Document actions that only read. A read-only section grant keeps them. */
const consoleDocumentReadActions: ReadonlySet<string> = new Set(["get", "list", "overview", "raw", "references", "resolve", "revisions", "search", "sessions"])
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

type ConsoleOperationContext = Omit<OperationContext, "access"> & { access: ConsoleAccess }

function legacyEvent(route: string, method: "GET" | "POST", request: LegacyRequest, context: ConsoleOperationContext): ConsoleRequestEvent {
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
    // The handlers of an operation read this request event as they read the one of an HTTP route.
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
  "media.upload": consoleMediaUploadRequestBytes,
} as const

// The handlers of these operations read the signed-in user themselves, when they need it.
export function defineConsoleOperation<Input, Output>(definition: Omit<OperationDefinition<Input, Output>, "run"> & { run: (input: Input, context: ConsoleOperationContext) => Output | Promise<Output> }): OperationDefinition<Input, Output> {
  return defineOperation({
    ...definition,
    user: false,
    async run(input, context) {
      const access = await consoleOperationAccess(context)
      if (!operationAccessAllows(access, operationSection(definition, input), operationCall(definition, input))) {
        throw consoleRequestError(403, "This Console access does not include this operation.")
      }
      // As in a guarded Console route, only an accepted call loads the Console runtime.
      await loadConsoleRuntime()
      return definition.run(input, { ...context, access })
    },
  })
}

const agentsList = defineConsoleOperation({
  description: "List the Agents of the app.",
  input: v.strictObject({}),
  kind: "read",
  name: "agents.list",
  run: async () => (await (import.meta.viteHubConsoleAgents === false ? disabledConsoleFeature("Agents") : import("./agents.get.ts"))).listConsoleAgents(),
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
  run: async ({ agent, agentRoute, ...body }, context) => (await (import.meta.viteHubConsoleAgents === false ? disabledConsoleFeature("Agents") : import("./agent-invocations.post.ts"))).default(legacyEvent(`agents/${agent}/invocations`, "POST", { agent, body, query: { agentRoute } }, context)),
  section: "agents",
})

const channelsReplay = defineConsoleOperation({
  // The hand-written `vitehub channels replay` command pages through the history and calls this operation with --url.
  cli: { command: "replay", namespace: "channels" },
  description: "Replay one page of a Channel's history through its trigger, or describe its history query with describe: true.",
  input: v.strictObject({
    agent: v.pipe(text, v.minLength(1)),
    channel: v.pipe(text, v.minLength(1)),
    cursor: optionalText,
    describe: v.optional(v.boolean()),
    dryRun: v.optional(v.boolean()),
    force: v.optional(v.boolean()),
    label: v.optional(v.pipe(text, v.check(label => label.trim() !== "", "Use a label with text."), v.maxLength(512))),
    limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
    query: v.optional(v.record(v.string(), v.union([text, v.array(text)]))),
  }),
  kind: "write",
  mcp: false,
  name: "channels.replay",
  readOnlyWhen: input => input.describe === true,
  run: async (input, context) => (await (import.meta.viteHubConsoleAgents === false ? disabledConsoleFeature("Agents") : import("./channel-replay.ts"))).replayConsoleChannel(input, context),
  section: "agents",
})

const authId = v.pipe(text, v.minLength(1), v.maxLength(512))
const authQuery = {
  filter: v.optional(v.picklist(["all", "admins", "banned", "agents"])),
  limit: v.optional(v.number()),
  offset: v.optional(v.number()),
  search: v.optional(v.pipe(text, v.maxLength(200))),
  userId: v.optional(authId),
}
const authValue = v.union([text, v.number(), v.boolean(), v.null(), v.array(text), v.array(v.number())])

/** One read of the Auth section. The Auth Console of `@vite-hub/auth` loads on the first call. */
function authRead<Input>(
  name: keyof typeof authConsoleReadOperations,
  description: string,
  input: StandardSchemaV1<unknown, Input>,
  read: (api: AuthConsole, request: Request, input: Input) => Promise<Result<unknown, AuthConsoleErrorCode>>,
): OperationDefinition<Input, unknown> {
  return defineConsoleOperation({
    description,
    input,
    kind: "read",
    mcp: false,
    name: authConsoleReadOperations[name],
    run: async (value, context) => (await (import.meta.viteHubConsoleAuth === false ? disabledConsoleFeature("Auth") : import("./auth.ts"))).runAuthConsoleRead(context, (api, request) => read(api, request, value)),
    section: "auth",
  })
}

/** One action of the Auth section. Impersonation has its own operations, which return a one-time link. */
function authAction<Input>(
  action: keyof typeof authConsoleActionOperations,
  description: string,
  kind: Exclude<OperationKind, "read">,
  input: StandardSchemaV1<unknown, Input>,
  mutation: (input: Input) => AuthConsoleMutation,
  positional: string,
): OperationDefinition<Input, unknown> {
  return defineConsoleOperation({
    cli: { positional: [positional] },
    description,
    input,
    kind,
    mcp: false,
    name: authConsoleActionOperations[action],
    run: async (value, context) => (await (import.meta.viteHubConsoleAuth === false ? disabledConsoleFeature("Auth") : import("./auth.ts"))).runAuthConsoleAction(context, mutation(value)),
    section: "auth",
  })
}

const authOperations = [
  authRead("describe", "Describe the Auth of the app: its pages, user fields, and the actions that this access may run.", v.strictObject({}), (api, request) => api.describe(request)),
  authRead("overview", "Count the users, new users, active sessions, and approved Agents of the app, with its recent Auth events.", v.strictObject({}), api => api.overview()),
  authRead("activity", "List recent Auth events, newest first, one page at a time.", v.strictObject({
    cursor: v.optional(v.pipe(text, v.maxLength(2048))),
    group: v.optional(v.picklist(["sign-in", "admin", "agents", "organizations"])),
    limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(200))),
    userId: v.optional(authId),
  }), (api, _request, input) => api.activity(input)),
  authRead("users", "List the users of the app, one page at a time.", v.strictObject(authQuery), (api, _request, input) => api.users(input)),
  authRead("user", "Read one user with its sessions, accounts, Agent clients, and organizations.", v.strictObject({ id: authId }), (api, request, input) => api.user(input.id, request)),
  authRead("sessions", "List the active sessions of the app, one page at a time.", v.strictObject(authQuery), (api, _request, input) => api.sessions(input)),
  authRead("organizations", "List the organizations of the app, one page at a time.", v.strictObject(authQuery), (api, _request, input) => api.organizations(input)),
  authRead("organization", "Read one organization with its members and invitations, one page at a time.", v.strictObject({ ...authQuery, id: authId }), (api, _request, { id, ...query }) => api.organization(id, query)),
  authRead("agents", "List the Agent clients that users granted access, one page at a time.", v.strictObject(authQuery), (api, _request, input) => api.agents(input)),
  authAction("ban", "Ban a user, with an optional reason and expiry in seconds.", "write", v.strictObject({ expiresIn: v.optional(v.number()), reason: v.optional(v.pipe(text, v.maxLength(1000))), userId: authId }), input => ({ action: "ban", ...input }), "userId"),
  authAction("unban", "Lift the ban of a user.", "write", v.strictObject({ userId: authId }), input => ({ action: "unban", ...input }), "userId"),
  authAction("remove", "Delete a user and its sessions and accounts.", "destructive", v.strictObject({ userId: authId }), input => ({ action: "remove", ...input }), "userId"),
  authAction("revokeSessions", "Sign a user out of every session.", "destructive", v.strictObject({ userId: authId }), input => ({ action: "revokeSessions", ...input }), "userId"),
  authAction("setRole", "Set the role of a user.", "write", v.strictObject({ role: authId, userId: authId }), input => ({ action: "setRole", ...input }), "userId"),
  authAction("editField", "Change one field of a user.", "write", v.strictObject({ field: authId, userId: authId, value: authValue }), input => ({ action: "editField", ...input }), "userId"),
  authAction("revokeSession", "End one session.", "destructive", v.strictObject({ id: authId }), input => ({ action: "revokeSession", ...input }), "id"),
  authAction("revokeConsent", "Revoke the access that a user granted an Agent client.", "destructive", v.strictObject({ id: authId }), input => ({ action: "revokeConsent", ...input }), "id"),
  defineConsoleOperation({
    description: "Return a one-time link that opens the app in the browser as a user. The browser must be signed in to the app with the email of the person who asks.",
    input: v.strictObject({ userId: authId }),
    kind: "write",
    mcp: false,
    name: authConsoleImpersonationOperations.start,
    run: async ({ userId }, context) => (await (import.meta.viteHubConsoleAuth === false ? disabledConsoleFeature("Auth") : import("./auth.ts"))).issueImpersonationTicket(context, userId),
    section: "auth",
  }),
  defineConsoleOperation({
    description: "Return a one-time link that ends the impersonation of the browser that opens it and restores the administrator's session.",
    input: v.strictObject({}),
    kind: "write",
    mcp: false,
    name: authConsoleImpersonationOperations.stop,
    run: async (_input, context) => (await (import.meta.viteHubConsoleAuth === false ? disabledConsoleFeature("Auth") : import("./auth.ts"))).issueImpersonationTicket(context),
    section: "auth",
  }),
]

const databasesBrowse = defineConsoleOperation({
  cli: { namespace: "database", command: "rows", positional: ["table"] },
  description: "Read the rows of a database table, one page at a time. Without a table it reads the tables only.",
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
  run: async (input, context) => {
    const result = await (await (import.meta.viteHubConsoleDatabase === false ? disabledConsoleFeature("Database") : import("./database.get.ts"))).browseConsoleDatabase(input)
    // The Console page reads the tables first and shows an empty page for a name that vanished. A command or a tool that
    // names a table that does not exist should hear about it, not read an empty list.
    if (input.table && context.surface !== "console" && result.table !== input.table) {
      throw consoleRequestError(404, `The database has no table "${input.table}".`)
    }
    return result
  },
  section: "databases",
})

const databasesTables = defineConsoleOperation({
  cli: { namespace: "database", command: "tables" },
  description: "List the tables of a database with their columns and relationships.",
  input: v.strictObject({ database: optionalText }),
  kind: "read",
  name: "databases.tables",
  run: async input => {
    const { database, databases, relationships, tables } = await (await (import.meta.viteHubConsoleDatabase === false ? disabledConsoleFeature("Database") : import("./database.get.ts"))).browseConsoleDatabase(input)
    return { database, databases, relationships, tables }
  },
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
    return (await import("./definitions.get.ts")).listConsoleDefinitions({ section }, context.access)
  },
  section: input => input.section,
})

const documentsAction = defineConsoleOperation({
  mcp: false,
  description: "Run one document editor action of a Console section.",
  input: v.strictObject({ action: v.picklist(consoleDocumentActionNames), body: v.optional(v.unknown()), section: text }),
  kind: "write",
  maxRequestBytes: consoleOperationRequestBytes["documents.action"],
  // A read-only grant still opens, lists, and searches documents.
  readOnlyWhen: ({ action, body }) => action === "session"
    ? typeof body === "object" && body !== null && "action" in body && (body.action === "report" || body.action === "release")
    : consoleDocumentReadActions.has(action),
  name: "documents.action",
  run: async ({ action, body, section }, context) => {
    const documents = await (import.meta.viteHubConsoleDocuments === false ? disabledConsoleFeature("document editor") : import("./documents.ts"))
    // JSON cannot preserve an omitted body. Use the checked operation's access for that call.
    if (body === undefined) {
      const actions = await documents.loadConsoleDocumentActions(section)
      const user = await documents.consoleDocumentActionContext(context.access)
      return await documents.runConsoleDocumentAction(() => actions[action](body, user)) ?? null
    }
    const result = actionResult(await documents.default(legacyEvent("documents", "POST", { body, query: { action, section } }, context))) as { value: unknown }
    return result.value
  },
  section: input => input.section,
})

const documentsPreview = defineConsoleOperation({
  mcp: false,
  description: "Return a one-time link that opens the page of a document with its draft, on the app origin.",
  input: v.strictObject({ collection: v.pipe(text, v.minLength(1)), id: v.pipe(text, v.minLength(1)), section: text }),
  kind: "read",
  name: "documents.preview",
  run: async ({ collection, id, section }, context) => (await (import.meta.viteHubConsoleDocuments === false ? disabledConsoleFeature("document editor") : import("./documents.ts"))).issueConsoleDocumentPreview(context, { collection, id, section }),
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
  run: async input => (await (import.meta.viteHubConsoleAgents === false ? disabledConsoleFeature("Agents") : import("./invocations.get.ts"))).listConsoleInvocations(input),
  section: "agents",
})

const invocationsGet = defineConsoleOperation({
  cli: { namespace: "invocations", positional: ["id"] },
  description: "Read one Agent Invocation with its observations.",
  input: v.strictObject({ id: v.pipe(text, v.minLength(1)), observationCount: optionalCount, observationCursor: optionalText }),
  kind: "read",
  name: "invocations.get",
  run: async ({ id, ...query }, context) => (await (import.meta.viteHubConsoleAgents === false ? disabledConsoleFeature("Agents") : import("./invocation.get.ts"))).default(legacyEvent("invocations", "GET", { id, query }, context)),
  section: "agents",
})

const invocationsCancel = defineConsoleOperation({
  cli: { namespace: "invocations", positional: ["id"] },
  description: "Ask a running Agent Invocation to stop.",
  input: v.strictObject({ id: v.pipe(text, v.minLength(1)) }),
  kind: "write",
  name: "invocations.cancel",
  run: async ({ id }, context) => (await (import.meta.viteHubConsoleAgents === false ? disabledConsoleFeature("Agents") : import("./invocation.get.ts"))).default(legacyEvent("invocations", "POST", { body: { action: "cancel" }, id }, context)),
  section: "agents",
})

const invocationsUndo = defineConsoleOperation({
  cli: { namespace: "invocations", positional: ["id"] },
  description: "Ask the person's open page to put back one change an Agent made there. The page restores it only while the field still shows the Agent's value.",
  input: v.strictObject({ change: v.pipe(text, v.minLength(1)), id: v.pipe(text, v.minLength(1)) }),
  kind: "write",
  name: "invocations.undo",
  run: async (input, context) => (await (import.meta.viteHubConsoleAgents === false ? disabledConsoleFeature("Agents") : import("./invocation-page-undo.ts"))).undoConsolePageChange(input, context),
  section: "agents",
})

const invocationsDelete = defineConsoleOperation({
  cli: { namespace: "invocations", positional: ["id"] },
  description: "Delete one finished Agent Invocation.",
  input: v.strictObject({ id: v.pipe(text, v.minLength(1)) }),
  kind: "destructive",
  name: "invocations.delete",
  run: async ({ id }, context) => (await (import.meta.viteHubConsoleAgents === false ? disabledConsoleFeature("Agents") : import("./invocation.get.ts"))).default(legacyEvent("invocations", "POST", { body: { action: "delete" }, id }, context)),
  section: "agents",
})

const invocationsCapabilities = defineConsoleOperation({
  cli: { namespace: "invocations" },
  description: "List the capabilities of an Agent Invocation setup.",
  input: v.strictObject({ agent: optionalText }),
  kind: "read",
  name: "invocations.capabilities",
  run: async input => (await (import.meta.viteHubConsoleAgents === false ? disabledConsoleFeature("Agents") : import("./invocation-capabilities.get.ts"))).listConsoleInvocationCapabilities(input),
  section: "agents",
})

const invocationsWorkspace = defineConsoleOperation({
  cli: { namespace: "invocations", positional: ["id"] },
  description: "Read the Workspace files and history of one Agent Invocation.",
  input: v.strictObject({ cursor: optionalText, history: v.optional(v.boolean()), id: v.pipe(text, v.minLength(1)), path: optionalText, ref: optionalText, revision: optionalText }),
  kind: "read",
  name: "invocations.workspace",
  run: async ({ id, history, ...query }, context) => (await (import.meta.viteHubConsoleAgents === false ? disabledConsoleFeature("Agents") : import("./invocation-workspace.get.ts"))).default(legacyEvent("invocation-workspace", "GET", { id, query: { ...query, history: history ? "1" : undefined } }, context)),
  section: "agents",
})

const workspacesFiles = defineConsoleOperation({
  cli: { namespace: "workspaces", positional: ["name"] },
  description: "Read the files, refs, and revisions of one Workspace, and its changes since main.",
  input: v.strictObject({ cursor: optionalText, name: v.pipe(text, v.minLength(1)), path: optionalText, ref: optionalText, revision: optionalText }),
  kind: "read",
  name: "workspaces.files",
  run: async (input, context) => (await (import.meta.viteHubConsoleWorkspaces === false ? disabledConsoleFeature("Workspaces") : import("./workspace-files.get.ts"))).default(legacyEvent("workspace-files", "GET", { query: input }, context)),
  section: "workspaces",
})

const logsList = defineConsoleOperation({
  description: "Read structured events from the connected log source.",
  input: v.strictObject({ text: optionalText, level: v.optional(v.picklist(["debug", "info", "warn", "error"])), service: optionalText, cursor: optionalText, limit: optionalCount }),
  kind: "read",
  name: "logs.list",
  run: async (input, context) => (await import("./logs.get.ts")).readConsoleLogs(legacyEvent("logs", "GET", { query: input }, context)),
  section: "logs",
})

const mediaAction = defineConsoleOperation({
  mcp: false,
  description: "Run one media library action of a Console section.",
  input: v.strictObject({ action: text, body: v.optional(v.unknown()), section: text }),
  kind: "write",
  maxRequestBytes: consoleOperationRequestBytes["media.action"],
  // A read-only grant still browses the library.
  readOnlyWhen: ({ action }) => consoleMediaReadActions.has(action),
  name: "media.action",
  run: async ({ action, body, section }, context) => (await (import.meta.viteHubConsoleDocuments === false ? disabledConsoleFeature("document editor") : loadConsoleMedia())).runConsoleMediaAction(section, action, body, context.access),
  section: input => input.section,
})

const mediaUpload = defineConsoleOperation({
  mcp: false,
  description: "Upload one file, given as base64, to the media library of a Console section.",
  input: v.strictObject({
    contentType: optionalText,
    // Each crop of an image may have its own replacement file, such as a portrait version for phones.
    crop: optionalText,
    data: text,
    filename: v.pipe(text, v.minLength(1), v.maxLength(255)),
    folder: optionalText,
    pathname: optionalText,
    section: text,
  }),
  kind: "write",
  maxRequestBytes: consoleOperationRequestBytes["media.upload"],
  name: "media.upload",
  run: async (input, context) => (await (import.meta.viteHubConsoleDocuments === false ? disabledConsoleFeature("document editor") : loadConsoleMedia())).uploadConsoleMedia(input, context.access),
  section: input => input.section,
})

const projectGet = defineConsoleOperation({
  cli: { command: "info", namespace: "project" },
  description: "Read the project: its name, the vite-hub version, and the sections and operations that this access may use.",
  input: v.strictObject({}),
  kind: "read",
  name: "project.get",
  run: async (_input, context) => (await import("./project.ts")).readConsoleProject(context.access),
  section: false,
})

const searchQuery = defineConsoleOperation({
  cli: { namespace: "search", command: "query", positional: ["search"] },
  description: "Search the Agent Invocations of the Console.",
  input: v.strictObject({ cursor: optionalText, limit: optionalCount, search: optionalText }),
  kind: "read",
  name: "search.query",
  run: async input => {
    // The Collection handler reads its query from the URL.
    const url = new URL("http://vitehub.local/_vitehub/api/search")
    for (const [key, value] of Object.entries(input)) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }
    const response = await (await (import.meta.viteHubConsoleAgents === false ? disabledConsoleFeature("Agents") : import("./search.get.ts"))).consoleSearchCollectionHandler.fetch(new Request(url))
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
  run: async (_input, context) => (await import("./sections.get.ts")).listConsoleSections(context.access),
  section: false,
})

const skillsInspect = defineConsoleOperation({
  description: "Inspect the bundled Skill files of an Agent, or read one exact bundled text file.",
  input: v.strictObject({ agent: optionalText, path: optionalText }),
  kind: "read",
  name: "skills.inspect",
  run: async input => (await (import.meta.viteHubConsoleAgents === false ? disabledConsoleFeature("Agents") : import("./skills.get.ts"))).inspectConsoleSkills(input),
  section: "skills",
})

const statusGet = defineConsoleOperation({
  cli: { command: "status", namespace: "agents" },
  description: "Read the status of an Agent: its setup and what it can do.",
  input: v.strictObject({ agent: optionalText }),
  kind: "read",
  name: "status.get",
  run: async (input, context) => (await (import.meta.viteHubConsoleAgents === false ? disabledConsoleFeature("Agents") : import("./status.get.ts"))).readConsoleStatus(legacyEvent("status", "GET", { query: input }, context)),
  section: "agents",
})

const sitePagePath = v.optional(v.pipe(text, v.maxLength(2048)))
const siteId = v.pipe(text, v.minLength(1), v.maxLength(64))
const siteAccess = () => import("./site-access.ts")

function formatSiteSessions({ sessions }: { sessions: SiteSession[] }): string {
  if (!sessions.length) return "No browser is signed in through Site access.\n"
  return `${table([
    ["ID", "KIND", "PERSON", "DEVICE", "LAST SEEN", "EXPIRES"],
    ...sessions.map(session => [session.id, session.kind, session.person.email ? `${session.person.name} <${session.person.email}>` : session.person.name, session.device, session.lastSeenAt, session.expiresAt]),
  ])}\n`
}

function formatSiteInvites({ invites }: { invites: SiteInvite[] }): string {
  if (!invites.length) return "No open invites.\n"
  return `${table([
    ["ID", "NAME", "ROLES", "PATH", "EXPIRES", "BY"],
    ...invites.map(invite => [invite.id, invite.name, invite.grants.join(","), invite.path, invite.expiresAt, invite.createdBy.name]),
  ])}\n`
}

function formatSiteGrants({ grants }: { grants: SiteGrant[] }): string {
  return `${table([["ROLE", "LABEL", "GUESTS"], ...grants.map(grant => [grant.id, grant.label, grant.membersOnly ? "no, members only" : "yes"])])}\n`
}

/** Site access: the Console signs browsers in to the app for the page tools. See `site-access.ts`. */
const siteOperations = [
  defineConsoleOperation({
    // A `vitehub` command signs as a key, not as a person, so the server refuses it with CONSOLE_TICKET_NO_PERSON and the fix.
    cli: { command: "open", format: (ticket: ConsoleTicket) => `${ticket.url}\nThe link works once, until ${ticket.expiresAt}.\n`, positional: ["path"] },
    description: "Return a one-time link that signs the browser that opens it in to the app as you, with the console role, then opens the page. With qr: true, it works for 10 minutes, for a phone.",
    input: v.strictObject({ path: sitePagePath, qr: v.optional(v.boolean()) }),
    kind: "write",
    mcp: false,
    name: "site.link",
    run: async (input, context) => (await siteAccess()).linkSite(context, input),
    section: "site",
  }),
  defineConsoleOperation({
    cli: { format: formatSiteSessions },
    description: "List the app sessions of Console members and invited guests: one per browser.",
    input: v.strictObject({}),
    kind: "read",
    name: "site.sessions",
    run: async (_input, context) => (await siteAccess()).listSessions(context),
    section: "site",
  }),
  defineConsoleOperation({
    cli: { command: "revoke", format: ({ removedUser }: { removedUser: boolean }) => removedUser ? "Signed the browser out and deleted the guest.\n" : "Signed the browser out.\n", positional: ["id"] },
    description: "Sign one browser out. Revoking a guest's browser deletes the guest.",
    input: v.strictObject({ id: siteId }),
    kind: "destructive",
    name: "site.revoke-session",
    run: async ({ id }, context) => (await siteAccess()).revokeSession(context, id),
    section: "site",
  }),
  defineConsoleOperation({
    cli: { format: ({ url, invite }: ConsoleTicket & { invite: SiteInvite }) => `${url}\nThe link works once, in one browser, until ${invite.expiresAt}. Revoke it with \`vitehub site revoke-invite ${invite.id}\`.\n`, positional: ["name"] },
    description: "Invite a guest: a one-time link that signs one browser in as a new app user with a name and roles, such as comments-write. Guests never get the Console.",
    input: v.strictObject({
      expiresInDays: v.optional(v.picklist([1, 7, 30])),
      grants: v.pipe(v.array(v.pipe(text, v.maxLength(128))), v.maxLength(32)),
      name: v.pipe(text, v.maxLength(64)),
      path: sitePagePath,
    }),
    kind: "write",
    mcp: false,
    name: "site.invite",
    run: async (input, context) => (await siteAccess()).inviteGuest(context, input),
    section: "site",
  }),
  defineConsoleOperation({
    cli: { format: formatSiteInvites },
    description: "List the guest invites that nobody opened yet.",
    input: v.strictObject({}),
    kind: "read",
    name: "site.invites",
    run: async (_input, context) => (await siteAccess()).listInvites(context),
    section: "site",
  }),
  defineConsoleOperation({
    cli: { format: () => "Revoked the invite.\n", positional: ["id"] },
    description: "Revoke a guest invite that nobody opened yet.",
    input: v.strictObject({ id: siteId }),
    kind: "destructive",
    name: "site.revoke-invite",
    run: async ({ id }, context) => (await siteAccess()).revokeInvite(context, id),
    section: "site",
  }),
  defineConsoleOperation({
    cli: { format: formatSiteGrants },
    description: "List the roles that Site access gives. Console is for members only.",
    input: v.strictObject({}),
    kind: "read",
    name: "site.grants",
    run: async () => (await siteAccess()).listGrants(),
    section: "site",
  }),
]

const usageGet = defineConsoleOperation({
  cli: { command: "usage", namespace: "agent" },
  description: "Read token use and cost evidence of Agent Invocations.",
  input: v.strictObject({ agent: optionalText, cursor: optionalText, search: optionalText, status: optionalText, window: optionalText }),
  kind: "read",
  name: "usage.get",
  run: async (input, context) => (await (import.meta.viteHubConsoleAgents === false ? disabledConsoleFeature("Agents") : import("./usage.get.ts"))).readConsoleUsage(legacyEvent("usage", "GET", { query: input }, context)),
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
  ...authOperations,
  channelsReplay,
  databasesBrowse,
  databasesTables,
  definitionsList,
  documentsAction,
  documentsPreview,
  envGet,
  invocationsCancel,
  invocationsUndo,
  invocationsCapabilities,
  invocationsDelete,
  invocationsGet,
  invocationsList,
  invocationsWorkspace,
  workspacesFiles,
  logsList,
  mediaAction,
  mediaUpload,
  projectGet,
  searchQuery,
  sectionsList,
  ...siteOperations,
  skillsInspect,
  statusGet,
  usageGet,
]
