import { defineErrors } from "@vite-hub/runtime"

import type { ResultError } from "@vite-hub/runtime"
import type { User } from "better-auth"

import type { AuthAuthorization } from "./types.ts"

/** The Auth user of a caller, with the fields of the app's plugins, such as `role` of `admin()`. */
export type AuthCallerUser = User & Record<string, unknown>

/**
 * Who calls a route, as `requireCaller()` returns it: a person in the browser with an Auth Session, or an Agent with
 * an MCP access token that the person approved. Check `kind` before an action that only the person may do.
 */
export type AuthCaller<TRegistry = ViteHub.AuthRegistry> =
  | {
    kind: "browser"
    user: AuthCallerUser
    session: AuthAuthorization<TRegistry>["session"]
  }
  | {
    kind: "agent"
    /** The person who approved the MCP client, read again for each request. */
    user: AuthCallerUser
    /** The OAuth client and the name it registered, such as "Claude Code". */
    client: { id: string, name: string | undefined }
    /** The scopes that the person approved. */
    scopes: string[]
  }

export type AuthCallerErrorCode = "AUTH_MCP_TOKEN_INVALID" | "AUTH_SIGNED_OUT"

// Keep published codes stable. The docs build writes a page for each code.
const callerErrors = /*#__PURE__*/ defineErrors({
  docs: "https://vitehub.dev/docs/auth/diagnostics",
  codes: {
    // Runtime error. `requireCaller()` returns it as `[error, undefined]`.
    AUTH_SIGNED_OUT: {
      why: "The request has no Auth Session and no MCP access token.",
      fix: "Answer `401`. A person signs in and sends the session cookie. An MCP client sends `Authorization: Bearer <access token>` from `mcpOAuth()`.",
    },
  },
})

export const signedOutError = (): ResultError<"AUTH_SIGNED_OUT"> => callerErrors.AUTH_SIGNED_OUT()
