import type { BetterAuthPlugin } from "better-auth"
import type { AuthSessionRefresh, AuthSessionRefreshFields } from "./types.ts"

type RefreshOutcome =
  | { kind: "clear" }
  | { fields?: AuthSessionRefreshFields, kind: "refresh" }
  | { kind: "skip" }

/**
 * Runs `session.onRefresh` from the Better Auth `session.update.before` database hook.
 * Better Auth calls `updateSession(token, { expiresAt, updatedAt })` when a stored session
 * passes `session.updateAge`. No other built-in session update sets `expiresAt`.
 */
export function createSessionRefreshPlugin(onRefresh: AuthSessionRefresh): BetterAuthPlugin {
  return {
    id: "vitehub-session-refresh",
    init: () => ({
      options: {
        databaseHooks: {
          session: {
            update: {
              async before(data, endpoint) {
                const current = endpoint?.context.session
                if (!current || !Object.hasOwn(data, "expiresAt")) return

                // A holder object, because TypeScript does not track assignments made inside the callbacks.
                const result: { outcome: RefreshOutcome } = { outcome: { kind: "skip" } }
                await onRefresh({
                  session: current.session,
                  user: current.user,
                  refresh: (fields) => {
                    if (result.outcome.kind !== "clear") result.outcome = { fields, kind: "refresh" }
                  },
                  clear: () => {
                    result.outcome = { kind: "clear" }
                  },
                })

                const { outcome } = result
                if (outcome.kind === "refresh") return outcome.fields ? { data: outcome.fields } : undefined
                if (outcome.kind === "skip") return { data: { expiresAt: current.session.expiresAt } }
                // Better Auth deletes the session cookies and answers 401 when this hook returns false.
                await endpoint.context.internalAdapter.deleteSession(current.session.token)
                return false
              },
            },
          },
        },
      },
    }),
  }
}
