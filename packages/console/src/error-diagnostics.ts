import { defineDiagnostics } from "nostics"

// Each code identifies one failure site of the Console app. Keep published codes stable.
export const consoleErrorDiagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: "https://vitehub.dev/docs/development/diagnostics",
  codes: {
    CONSOLE_ENV_KEY_MISSING: {
      fix: "Add the key that sealed the value to VITEHUB_CONSOLE_ENV_KEYS after the current key, such as `VITEHUB_CONSOLE_ENV_KEYS=<current key>,<old key>`, in place of VITEHUB_CONSOLE_ENV_KEY, and restart the Console. If the old key is lost, set the value again.",
      why: ({ name, stage }: { name?: unknown, stage?: unknown }) => `A key that this Console does not have sealed ${String(name)} of ${String(stage)}, so it cannot open the value. VITEHUB_CONSOLE_ENV_KEY or VITEHUB_CONSOLE_ENV_KEYS does not hold that key.`,
    },
  },
})
