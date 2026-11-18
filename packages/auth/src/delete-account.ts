import { viteHubUserData } from "@vite-hub/internal/runtime/user-data"
import { isRecord as isPlainObject } from "@vite-hub/internal/object"

import { authErrorDiagnostics } from "./error-diagnostics.ts"

import type { AuthContext, BetterAuthOptions, BetterAuthPlugin } from "better-auth"
import type { AuthDeleteAccountOptions } from "./types.ts"

type DeleteUserOptions = NonNullable<NonNullable<BetterAuthOptions["user"]>["deleteUser"]>
type DeleteUser = Parameters<NonNullable<DeleteUserOptions["beforeDelete"]>>[0]

/** Also checked when a Definition callback returns the options. */
export function validateDeleteAccount(options: { deleteAccount?: unknown, user?: unknown, preset?: unknown, session?: unknown }): void {
  if (isPlainObject(options.user) && options.user.deleteUser !== undefined) throw authErrorDiagnostics.AUTH_DELETE_USER_UNSUPPORTED()
  const value = options.deleteAccount
  if (value === undefined) return
  if (value !== true && (!isPlainObject(value) || Object.hasOwn(value, "enabled")
    || (value.beforeDelete !== undefined && typeof value.beforeDelete !== "function")
    || (value.afterDelete !== undefined && typeof value.afterDelete !== "function")
    || (value.userApiKeyConfigIds !== undefined && (!Array.isArray(value.userApiKeyConfigIds)
      || value.userApiKeyConfigIds.some(id => typeof id !== "string" || !id))))) {
    throw authErrorDiagnostics.AUTH_DELETE_ACCOUNT_INVALID()
  }
  const session = options.session
  if (options.preset !== undefined || (isPlainObject(session) && isPlainObject(session.cookieCache) && session.cookieCache.enabled === true)) {
    throw authErrorDiagnostics.AUTH_DELETE_ACCOUNT_SESSION()
  }
}

// Better Auth deletes these itself, after `beforeDelete`.
const betterAuthModels = new Set(["user", "session", "account"])

/**
 * The rows of the Better Auth tables that name the user, such as passkeys, organization members, and MCP tokens. A
 * Database deletes them through `on delete cascade`, but an app schema can lack the foreign keys. The `apikey` table of
 * `apiKey()` names its owner in `referenceId`, without a foreign key.
 */
async function deleteAuthRows(context: AuthContext, user: DeleteUser, userApiKeyConfigIds: readonly string[]): Promise<void> {
  const userModel = context.tables.user?.modelName ?? "user"
  let storedUser: Promise<Record<string, unknown> | null> | undefined
  for (const [model, table] of Object.entries(context.tables)) {
    if (betterAuthModels.has(model)) continue
    for (const [field, attribute] of Object.entries(table.fields)) {
      const reference = attribute.references
      if (!reference || (reference.model !== "user" && reference.model !== userModel)) continue
      const userField = Object.hasOwn(context.tables.user?.fields ?? {}, reference.field) ? reference.field
        : Object.entries(context.tables.user?.fields ?? {}).find(([, attribute]) => attribute.fieldName === reference.field)?.[0] ?? reference.field
      if (userField !== "id") storedUser ??= context.adapter.findOne({ model: "user", where: [{ field: "id", value: user.id }] })
      const value: unknown = userField === "id" ? user.id : (await storedUser)?.[userField]
      if (value == null) continue
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean" && !(value instanceof Date)) {
        throw new TypeError(`Cannot match ${model}.${field} to user.${userField}`)
      }
      const where = [{ field, value }]
      if (reference.onDelete === "set null") await context.adapter.updateMany({ model, where, update: { [field]: null } })
      else await context.adapter.deleteMany({ model, where })
    }
  }
  if (userApiKeyConfigIds.length && context.tables.apikey?.fields.referenceId && context.tables.apikey.fields.configId) {
    const owner = { field: "referenceId", value: user.id }
    await context.adapter.deleteMany({ model: "apikey", where: [owner, { field: "configId", operator: "in", value: [...userApiKeyConfigIds] }] })
    if (userApiKeyConfigIds.includes("default")) {
      await context.adapter.deleteMany({ model: "apikey", where: [owner, { field: "configId", value: null }] })
    }
  }
}

async function deleting(owner: string, run: () => Promise<void>): Promise<void> {
  try {
    await run()
  }
  catch (cause) {
    throw authErrorDiagnostics.AUTH_DELETE_ACCOUNT_FAILED({ owner, cause })
  }
}

/**
 * Better Auth `user.deleteUser` for `deleteAccount`, and the plugin that gives it the Auth tables. The app's
 * `beforeDelete` runs first, so it can still keep the account. Then each Server Primitive deletes the rows of the user,
 * then Auth the rows of the other Better Auth tables, and last Better Auth deletes the user, its sessions, and its
 * accounts. When a step fails, the account stays, so the user can try again.
 */
export function createDeleteAccount(option: true | AuthDeleteAccountOptions, app?: object): { deleteUser: DeleteUserOptions, plugin: BetterAuthPlugin } {
  const { beforeDelete, userApiKeyConfigIds = [], ...rest } = option === true ? {} : option
  let context: AuthContext | undefined
  return {
    plugin: {
      id: "vitehub-delete-account",
      init(ctx) {
        context = ctx
      },
    },
    deleteUser: {
      ...rest,
      enabled: true,
      async beforeDelete(user, request) {
        await beforeDelete?.(user, request)
        for (const data of viteHubUserData(app)) await deleting(data.owner, () => data.delete(user.id))
        // Better Auth runs `init` when it builds the instance, before any request.
        const auth = context
        if (auth) await deleting("auth", () => deleteAuthRows(auth, user, userApiKeyConfigIds))
      },
    },
  }
}
