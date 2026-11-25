import * as v from "valibot"

import { authConsoleActionOperations, authConsoleImpersonationOperations, authConsoleReadOperations } from "../../console/runtime/auth-operations.ts"
import { defineConsoleOperation, text } from "../../console/runtime/server/operations.ts"

import type { AuthConsole, AuthConsoleErrorCode, AuthConsoleMutation } from "@vite-hub/auth/console-runtime"
import type { AnyOperation, OperationDefinition, OperationKind } from "@vite-hub/internal/operations"
import type { Result } from "@vite-hub/runtime"
import type { StandardSchemaV1 } from "@standard-schema/spec"

const authId = v.pipe(text, v.minLength(1), v.maxLength(512))
const authQuery = {
  filter: v.optional(v.picklist(["all", "admins", "banned", "agents"])),
  limit: v.optional(v.number()),
  offset: v.optional(v.number()),
  search: v.optional(v.pipe(text, v.maxLength(200))),
  userId: v.optional(authId),
}
const authValue = v.union([text, v.number(), v.boolean(), v.null(), v.array(text), v.array(v.number())])

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
    run: async (value, context) => (await import("./auth.ts")).runAuthConsoleRead(context, (api, request) => read(api, request, value)),
    section: "auth",
  })
}

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
    run: async (value, context) => (await import("./auth.ts")).runAuthConsoleAction(context, mutation(value)),
    section: "auth",
  })
}

/** The Console operations of the Auth section. The Console registers them only when the app has Auth. */
export const authConsoleOperations: readonly AnyOperation[] = [
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
    description: "Check that the caller may open the app in the browser as a user, and return the app path to open. The Console then signs an impersonate Site access token. The browser must be signed in to the app with the email of the person who asks.",
    input: v.strictObject({ userId: authId }),
    kind: "write",
    mcp: false,
    name: authConsoleImpersonationOperations.start,
    run: async ({ userId }, context) => (await import("./auth.ts")).checkImpersonation(context, userId),
    section: "auth",
  }),
  defineConsoleOperation({
    description: "Check that impersonation is on, and return the app path to open. The Console then signs a Site access token that ends the impersonation of the browser that opens it and restores the administrator's session.",
    input: v.strictObject({}),
    kind: "write",
    mcp: false,
    name: authConsoleImpersonationOperations.stop,
    run: async (_input, context) => (await import("./auth.ts")).checkImpersonation(context),
    section: "auth",
  }),
]
