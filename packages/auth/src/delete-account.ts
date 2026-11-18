import { viteHubUserData } from "@vite-hub/internal/runtime/user-data"
import { isRecord as isPlainObject } from "@vite-hub/internal/object"

import { authErrorDiagnostics } from "./error-diagnostics.ts"

import type { AuthContext, BetterAuthOptions, BetterAuthPlugin } from "better-auth"
import type { AuthDeleteAccountOptions } from "./types.ts"

type DeleteUserOptions = NonNullable<NonNullable<BetterAuthOptions["user"]>["deleteUser"]>

/** Also checked when a Definition callback returns the options. */
export function validateDeleteAccount(options: { deleteAccount?: unknown, user?: unknown }): void {
  if (isPlainObject(options.user) && options.user.deleteUser !== undefined) throw authErrorDiagnostics.AUTH_DELETE_USER_UNSUPPORTED()
  const value = options.deleteAccount
  if (value === undefined || value === true) return
  if (!isPlainObject(value) || Object.hasOwn(value, "enabled")
    || (value.beforeDelete !== undefined && typeof value.beforeDelete !== "function")
    || (value.afterDelete !== undefined && typeof value.afterDelete !== "function")) {
    throw authErrorDiagnostics.AUTH_DELETE_ACCOUNT_INVALID()
  }
}

// Better Auth deletes these itself, after `beforeDelete`.
const betterAuthModels = new Set(["user", "session", "account"])

/**
 * The rows of the Better Auth tables that name the user, such as passkeys, organization members, and MCP tokens. A
 * Database deletes them through `on delete cascade`, but an app schema can lack the foreign keys. The `apikey` table of
 * `apiKey()` names its owner in `referenceId`, without a foreign key.
 */
async function deleteAuthRows(context: AuthContext, userId: string): Promise<void> {
  const userModel = context.tables.user?.modelName ?? "user"
  for (const [model, table] of Object.entries(context.tables)) {
    if (betterAuthModels.has(model)) continue
    for (const [field, attribute] of Object.entries(table.fields)) {
      const reference = attribute.references
      if (!reference || (reference.model !== "user" && reference.model !== userModel)) continue
      const where = [{ field, value: userId }]
      if (reference.onDelete === "set null") await context.adapter.updateMany({ model, where, update: { [field]: null } })
      else await context.adapter.deleteMany({ model, where })
    }
  }
  if (context.tables.apikey?.fields.referenceId) await context.adapter.deleteMany({ model: "apikey", where: [{ field: "referenceId", value: userId }] })
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
export function createDeleteAccount(option: true | AuthDeleteAccountOptions): { deleteUser: DeleteUserOptions, plugin: BetterAuthPlugin } {
  const { beforeDelete, ...rest } = option === true ? {} : option
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
        for (const data of viteHubUserData()) await deleting(data.owner, () => data.delete(user.id))
        // Better Auth runs `init` when it builds the instance, before any request.
        const auth = context
        if (auth) await deleting("auth", () => deleteAuthRows(auth, user.id))
      },
    },
  }
}
