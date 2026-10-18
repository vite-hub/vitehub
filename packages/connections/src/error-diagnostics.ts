import { defineErrors, type ErrorCatalog } from "@vite-hub/runtime"

const connect = (connection: string) => `Run \`vitehub connections connect ${connection}\`.`

const docs = "https://vitehub.dev/docs/connections/limits-and-errors"

// Keep published codes stable. Each code has a heading on the docs page.
const codes = {
  // Runtime errors. Connection client calls return them as `[error, undefined]`.
  CONNECTIONS_APPROVAL_REQUIRED: {
    why: ({ action, approval, connection }: { action: string, approval: string, connection: string }) => `Approval is required for ${action} on Connection "${connection}". Request: ${approval}.`,
    fix: "Approve the request in the Console or with `vitehub connections approve <id>`. ViteHub then runs the call.",
  },
  CONNECTIONS_DENIED: {
    why: ({ action, actor, connection, immediate }: { action: string, actor: string, connection: string, immediate?: boolean }) => immediate
      ? `Connection "${connection}" requires immediate access for ${action}. Set approve: false on the actor's access rule.`
      : `Actor "${actor}" may not call ${action} on Connection "${connection}".`,
    fix: "Change the access rules of the Connection Definition to allow this action for this actor.",
  },
  CONNECTIONS_INVALID_INPUT: {
    why: ({ method, parameter }: { method?: string, parameter?: string }) => method && parameter
      ? `Method "${method}" requires "${parameter}".`
      : "Connection fetch accepts only a string body.",
    fix: "Pass the required parameters, and send a `fetch()` body as a string, for example `JSON.stringify(body)`.",
  },
  CONNECTIONS_NEEDS_RECONNECT: {
    why: ({ connection, problem }: { connection: string, problem?: "approval" | "mutation" | "refresh-token" | "rejected" }) => {
      if (problem === "approval") return `Connection "${connection}" must be connected again before requesting approval.`
      if (problem === "mutation") return `Connection "${connection}" has an unconfirmed token mutation. Confirm the provider outcome and repair its mutation lease before connecting again.`
      if (problem === "refresh-token") return `Connection "${connection}" has no refresh token. Connect it again.`
      return `Connection "${connection}" must be connected again. ${connect(connection)}`
    },
    fix: "Reconnect the Connection in the Console or with `vitehub connections connect <name>`.",
  },
  CONNECTIONS_NOT_CONNECTED: {
    why: ({ apiKey, connection }: { apiKey?: boolean, connection: string }) => apiKey
      ? `Connection "${connection}" uses an API key. Set it with \`vitehub connections set-key ${connection}\` or in the Console.`
      : `Connection "${connection}" is not connected. ${connect(connection)}`,
    fix: "Connect the Connection in the Console or with the CLI command in `why`.",
  },
  CONNECTIONS_ORIGIN_NOT_ALLOWED: {
    why: ({ connection, origin }: { connection: string, origin: string }) => `Connection "${connection}" does not send its token to ${origin}.`,
    fix: "Add the origin to the provider `origins`, or call a URL of a configured API catalog. ViteHub did not send the credential.",
  },
  CONNECTIONS_PROVIDER_FAILED: {
    why: ({ action, message, problem, provider, status }: { action?: string, message?: string, problem?: "invalid-json" | "no-token" | "token-request" | "verify", provider?: string, status?: number }) => {
      if (problem === "invalid-json") return "Provider returned invalid JSON."
      if (problem === "no-token") return `Provider "${provider}" returned no access token.`
      if (problem === "token-request") return `Provider "${provider}" rejected the token request${message ? ` (${message})` : ""}.`
      if (problem === "verify") return `Provider "${provider}" could not verify the key.`
      return `Provider rejected ${action} with ${status}${message ? `: ${message}` : "."}`
    },
    fix: "Check the provider status and the account permissions, then try again.",
  },
  CONNECTIONS_UNAVAILABLE: {
    why: ({ connection }: { connection: string }) => `Connection "${connection}" has a token mutation in progress. Try again.`,
    fix: "Try the call again after a short wait. Another request refreshes the token now.",
  },

  // Approval errors. `approve()` returns them through the management routes.
  CONNECTIONS_EXECUTION_UNKNOWN: {
    why: ({ approval }: { approval: string }) => `The provider may have completed this write. Check the provider before requesting another approval. Approval: ${approval}.`,
    fix: "Check the provider for the result before you send the call again.",
  },
  CONNECTIONS_INVALID_APPROVAL: {
    why: ({ problem }: { problem: "lease-lost" | "previous-grant" }) => problem === "lease-lost"
      ? "Approval execution lease was lost."
      : "Approval belongs to a previous Connection grant.",
    fix: "Request the action again, so that ViteHub creates a new approval for the current grant.",
  },
  CONNECTIONS_KEY_REJECTED: {
    why: ({ provider }: { provider: string }) => `Provider "${provider}" rejected the key.`,
    fix: "Check the key in the provider dashboard, then set it again.",
  },

  // Config errors. ViteHub throws them, because the code or the deployment must change.
  CONNECTIONS_INVALID_ACTOR: {
    why: ({ problem }: { problem: "access" | "agent" | "id" }) => {
      if (problem === "access") return "Connection `access` must be the Env access context of an Agent, without `actor`."
      if (problem === "agent") return "Agent actors come from the Agent runtime. Use the Connection capabilities of the Agent."
      return "Connection actor IDs must contain 1 to 512 characters and no control characters."
    },
    fix: "Pass `actor` as `user:<id>` or `service:<id>` from server code. Agents get their actor from the Agent runtime.",
  },
  CONNECTIONS_INVALID_CONFIG: {
    why: ({ problem }: { problem: "path" | "segment" | "slash" | "type" }) => {
      if (problem === "type") return "Connections basePath must be a string."
      if (problem === "slash") return "Connections basePath must start with `/`."
      if (problem === "path") return "Connections basePath must be a pathname without a query or fragment."
      return "Connections basePath must include a route segment."
    },
    fix: "Set `basePath` to a pathname such as `/_vitehub/connections`.",
  },
  CONNECTIONS_INVALID_DEFINITION: {
    why: ({ problem, provider }: { problem: "client-id" | "definition" | "revocation" | "verify-result", provider?: string }) => {
      if (problem === "client-id") return `Provider "${provider}" has no client id.`
      if (problem === "revocation") return `Provider "${provider}" does not support token revocation.`
      if (problem === "verify-result") return `The verify check of provider "${provider}" must return a boolean or { account }.`
      return "The Connection Definition is invalid."
    },
    fix: "Default export `defineConnection({ provider, access })` from the file. An OAuth provider needs `clientId`; `verify` returns `true`, `false`, or `{ account }`.",
  },
  CONNECTIONS_INVALID_NAME: {
    why: ({ problem }: { problem: "length" | "use-connection" | "whitespace" }) => {
      if (problem === "whitespace") return "Connection names cannot start or end with whitespace."
      if (problem === "use-connection") return "`useConnection()` requires a Connection name of at most 501 characters."
      return "Connection names must not exceed 501 characters so their Env keys fit the 512-character limit."
    },
    fix: "Use the file name of the Connection Definition, for example `useConnection('github')`.",
  },
  CONNECTIONS_INVALID_PROVIDER: {
    why: ({ origin }: { origin?: string }) => origin
      ? `The API key provider origin ${origin} contains a wildcard. ViteHub sends the key only to exact origins.`
      : "The API key provider needs a token header name, a token scheme, and HTTPS or loopback origins without a path.",
    fix: "List each origin that may receive the key, for example `origins: ['https://api.example.com']`.",
  },
  CONNECTIONS_INVALID_STORED_DATA: {
    why: ({ connection, problem }: { connection?: string, problem: "data" | "pagination" | "pagination-end" | "scopes" | "token" }) => {
      if (problem === "token") return `Stored token for Connection "${connection}" is invalid.`
      if (problem === "pagination-end") return "Connections approval pagination did not terminate."
      if (problem === "scopes") return "Stored Connection scopes are invalid."
      if (problem === "pagination") return "Connections approval pagination did not advance."
      return "Stored Connection data is invalid."
    },
    fix: "Reconnect the Connection. If the error stays, check that one app version writes the Connections tables.",
  },
  CONNECTIONS_NOT_CONFIGURED: {
    why: ({ missing }: { missing: "bridge-revision" | "database" | "key" | "leases" | "revisions" }) => {
      if (missing === "bridge-revision") return "Connection revocation requires the Env Bridge to provide the leased token revision."
      if (missing === "key") return "Connections need VITEHUB_CONNECTIONS_KEY with 32 random bytes as base64 or hex. Create one with `openssl rand -base64 32`."
      if (missing === "database") return "Connections need the ViteHub Database. Enable `database` in vitehub(), or call setConnectionsRuntime() with a store."
      if (missing === "leases") return "The Connection store must provide atomic token mutation leases."
      return "The Connection secret store must return token revisions."
    },
    fix: "Set `VITEHUB_CONNECTIONS_KEY` and enable `database` in `vitehub()`, or pass a complete store to `setConnectionsRuntime()`.",
  },
  CONNECTIONS_NOT_FOUND: {
    why: ({ connection }: { connection: string }) => `No Connection Definition was discovered for "${connection}".`,
    fix: "Add `server/connections/<name>.ts` with a default `defineConnection()` export, or use the name of a discovered Connection.",
  },
  CONNECTIONS_UNKNOWN_ACTION: {
    why: ({ action, connection }: { action: string, connection?: string }) => connection
      ? `Connection "${connection}" does not expose ${action}.`
      : `Unknown method "${action}".`,
    fix: "Call a method of the API catalog of the provider, or select the API in the Connection Definition.",
  },

  // Management route errors. The routes return them as `{ error: { code, message, fix, docs } }`.
  CONNECTIONS_AUTH_REQUIRED: {
    why: ({ problem }: { problem: "actor-policy" | "development" }) => problem === "actor-policy"
      ? "createConnectionsHandler() requires an actor policy."
      : "Connections management requires Auth outside local development. Configure an actor module or Console Auth.",
    fix: "Protect the management routes with Console Auth, or pass an actor function to createConnectionsHandler().",
  },
  CONNECTIONS_AUTHORIZATION_CANCELLED: {
    why: "The provider did not grant access.",
    fix: "Connect again and approve the access that the Connection asks for.",
  },
  CONNECTIONS_CONTENT_TYPE_REJECTED: {
    why: "Connections management accepts only application/json requests.",
    fix: "Send the request with Content-Type: application/json.",
  },
  CONNECTIONS_FORBIDDEN: {
    why: ({ problem }: { problem?: "authorization-actor" }) => problem === "authorization-actor"
      ? "Another user started this authorization request. Start the connection again."
      : "The management route found no signed-in manager for this request.",
    fix: "Sign in again. A custom actor function must return user:<id> for an allowed manager.",
  },
  CONNECTIONS_INVALID_REQUEST: {
    why: ({ approval, connection, problem }: { approval?: string, connection?: string, problem: "api-key-format" | "authorization-expired" | "body" | "name" | "not-pending" | "oauth-key" | "redirect-uri" | "start" }) => {
      if (problem === "api-key-format") return "An API key must contain 1 to 8192 visible ASCII characters."
      if (problem === "authorization-expired") return "The authorization request is unknown or expired. Start the connection again."
      if (problem === "not-pending") return `Approval "${approval}" is not pending.`
      if (problem === "oauth-key") return `Connection "${connection}" uses OAuth. Connect it with \`vitehub connections connect ${connection}\`.`
      if (problem === "redirect-uri") return "The redirect URI must use HTTPS or a loopback address."
      if (problem === "name") return "The Connection name is invalid."
      if (problem === "start") return "Start the connection from this application."
      return "Invalid Connections request."
    },
    fix: "Check the request and the Connection state, then send the request again.",
  },
  CONNECTIONS_METHOD_NOT_ALLOWED: {
    why: ({ method }: { method: string }) => `Use ${method}.`,
    fix: "Send the request with the method in the Allow header.",
  },
  CONNECTIONS_ORIGIN_REJECTED: {
    why: ({ problem }: { problem: "cross-site" | "origin" }) => problem === "cross-site"
      ? "The browser marked this request as cross-site."
      : "The browser origin does not match the origin that the server sees.",
    fix: "Behind a TLS-terminating proxy, make the server see the public https origin: trust X-Forwarded-Proto and X-Forwarded-Host, or configure the public URL. Otherwise, send the request from the app origin.",
  },
  CONNECTIONS_REQUEST_FAILED: {
    why: "The Connections request failed.",
    fix: "Try again. If this continues, read the server logs for this request.",
  },
  CONNECTIONS_STATE_CONFLICT: {
    why: ({ connection, problem, provider }: { connection?: string, problem: "authorization" | "key" | "other-account" | "revocation" | "unknown-account", provider?: string }) => {
      if (problem === "other-account") return `Connection "${connection}" belongs to another account. Confirm the provider outcome and repair the mutation lease before revoking or connecting again.`
      if (problem === "unknown-account") return `Provider "${provider}" did not identify the account. The existing Connection was quarantined.`
      if (problem === "key") return "The Connection key changed while it was set."
      if (problem === "revocation") return "The Connection token changed during revocation."
      return "The Connection token changed during authorization."
    },
    fix: "Read the Connection status in the Console, then connect, set the key, or revoke again.",
  },
  CONNECTIONS_ROUTE_NOT_FOUND: {
    why: "Not found.",
    fix: "Check the route path and the Vite base.",
  },
  CONNECTIONS_STATE_MISMATCH: {
    why: "The callback has no `state` cookie of this browser, or the cookie does not match.",
    fix: "Start the connection again in this browser. Each authorization link works one time, for 10 minutes.",
  },
}

export const connectionsErrorDiagnostics: ErrorCatalog<typeof codes> = /*#__PURE__*/ defineErrors({ docs, codes })

/** Repair guidance of a code, for HTTP bodies that do not carry the error object. */
export function connectionsErrorGuidance(code: string): { docs: string, fix: string } | undefined {
  if (!Object.hasOwn(codes, code)) return undefined
  // SAFETY: `Object.hasOwn` confirms that `code` is a key of the catalog.
  return { docs: `${docs}#${code.toLowerCase()}`, fix: codes[code as keyof typeof codes].fix }
}
