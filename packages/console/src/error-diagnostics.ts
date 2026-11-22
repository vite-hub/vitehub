import { defineDiagnostics } from "nostics"

export const consoleErrorDiagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: "https://vitehub.dev/docs/development/diagnostics",
  codes: {
    CONSOLE_APP_VITEHUB_OUTDATED: {
      fix: "Upgrade vite-hub in the app to the latest version and deploy it. Until then, the Console page still opens the app.",
      why: ({ version }: { version?: unknown }) => `The app runs vite-hub ${String(version)}, which does not accept this call of the ViteHub MCP. An older app knows fewer fields of the signed caller.`,
    },
    CONSOLE_ENV_KEY_MISSING: {
      fix: "Add the key that sealed the value to VITEHUB_CONSOLE_ENV_KEYS after the current key, such as `VITEHUB_CONSOLE_ENV_KEYS=<current key>,<old key>`, in place of VITEHUB_CONSOLE_ENV_KEY, and restart the Console. If the old key is lost, set the value again.",
      why: ({ name, stage }: { name?: unknown, stage?: unknown }) => `A key that this Console does not have sealed ${String(name)} of ${String(stage)}, so it cannot open the value. VITEHUB_CONSOLE_ENV_KEY or VITEHUB_CONSOLE_ENV_KEYS does not hold that key.`,
    },
    CONSOLE_FORWARD_RATE_LIMITED: {
      fix: "Wait the seconds in the Retry-After header, then send the call again. A script or an Agent that calls the app through the Console must wait between calls.",
      why: ({ limit, retryAfter }: { limit?: unknown, retryAfter?: unknown }) => `You sent ${String(limit)} calls to this app through the Console in one minute, which is the most that the Console sends for one person. The next call can go in ${String(retryAfter)} seconds.`,
    },
  },
})
