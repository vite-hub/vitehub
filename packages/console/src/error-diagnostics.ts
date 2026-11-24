import { defineDiagnostics } from "nostics"

/** The reason and the HTTP status of a failure of the MCP client of the Console. */
export interface ConsoleMcpFailure {
  message: string
  status: number
}

export const consoleErrorDiagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: "https://vitehub.dev/docs/development/diagnostics",
  codes: {
    CONSOLE_APP_VITEHUB_OUTDATED: {
      fix: "Upgrade vite-hub in the app to the latest version and deploy it. Until then, the Console page still opens the app.",
      why: ({ version }: { version?: unknown }) => `The app runs vite-hub ${String(version)}, which does not accept this call of the ViteHub MCP. An older app knows fewer fields of the signed caller.`,
    },
    CONSOLE_CONFLICT: {
      why: ({ message }: ConsoleMcpFailure) => message,
      fix: "Reload the Console, then try again.",
      data: ({ status }: ConsoleMcpFailure) => ({ status }),
    },
    CONSOLE_ENV_KEY_MISSING: {
      fix: "Add the key that sealed the value to VITEHUB_CONSOLE_ENV_KEYS after the current key, such as `VITEHUB_CONSOLE_ENV_KEYS=<current key>,<old key>`, in place of VITEHUB_CONSOLE_ENV_KEY, and restart the Console. If the old key is lost, set the value again.",
      why: ({ name, stage }: { name?: unknown, stage?: unknown }) => `A key that this Console does not have sealed ${String(name)} of ${String(stage)}, so it cannot open the value. VITEHUB_CONSOLE_ENV_KEY or VITEHUB_CONSOLE_ENV_KEYS does not hold that key.`,
    },
    CONSOLE_FORWARD_RATE_LIMITED: {
      fix: "Wait the seconds in the Retry-After header, then send the call again. A script or an Agent that calls the app through the Console must wait between calls.",
      why: ({ limit, retryAfter }: { limit?: unknown, retryAfter?: unknown }) => `You sent ${String(limit)} calls to this app through the Console in one minute, which is the most that the Console sends for one person. The next call can go in ${String(retryAfter)} seconds.`,
    },
    CONSOLE_MCP_AUTHORIZATION_FAILED: {
      why: ({ message }: ConsoleMcpFailure) => message,
      fix: "Start the sign-in again. The server must publish RFC 9728 metadata that names an authorization server with client registration.",
      data: ({ status }: ConsoleMcpFailure) => ({ status }),
    },
    CONSOLE_MCP_LIST_TOO_LONG: {
      why: ({ kind }: { kind: string }) => `The MCP server sent more than 20 pages of ${kind}. The Console shows no part of a list that it cannot read fully.`,
      fix: "Make the MCP server send its tools, resources, resource templates, or prompts in 20 pages or fewer, such as with more items in each page.",
      data: { status: 502 },
    },
    CONSOLE_MCP_SIGNED_OUT: {
      why: ({ message }: ConsoleMcpFailure) => message,
      fix: "Sign in again. For a token, connect again with a new one.",
      data: ({ status }: ConsoleMcpFailure) => ({ status }),
    },
    CONSOLE_MCP_UNREACHABLE: {
      why: ({ message }: ConsoleMcpFailure) => message,
      fix: "Check that the server runs and that the URL is its Streamable HTTP endpoint, such as /mcp.",
      data: ({ status }: ConsoleMcpFailure) => ({ status }),
    },
    CONSOLE_NOT_FOUND: {
      why: ({ message }: ConsoleMcpFailure) => message,
      fix: "Reload the Console to see the current data.",
      data: ({ status }: ConsoleMcpFailure) => ({ status }),
    },
    CONSOLE_REQUEST_INVALID: {
      why: ({ message }: ConsoleMcpFailure) => message,
      fix: "Reload the Console. If this continues, deploy the Console and the server from the same build.",
      data: ({ status }: ConsoleMcpFailure) => ({ status }),
    },
    CONSOLE_VITE_HUB_BUILD_MISSING: {
      why: ({ file }: { file: string }) => `The Console needs ${file}, which the vite-hub build writes.`,
      fix: "Build vite-hub with `vp run -t vite-hub#build`, then build the Console again.",
    },
  },
})
