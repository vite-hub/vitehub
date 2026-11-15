import { defineDiagnostics } from "nostics"

const dynamicError = {
  why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
}

// Each code identifies one ViteHub failure site. Keep published codes stable.
// Retired codes. Do not reuse them: VITE_HUB_B0002, VITE_HUB_B0003, VITE_HUB_B0006, VITE_HUB_B0007, VITE_HUB_B0010, VITE_HUB_B0014, VITE_HUB_B0017, VITE_HUB_R0002 to VITE_HUB_R0039, VITE_HUB_R0048, VITE_HUB_R0055 to VITE_HUB_R0057, VITE_HUB_R0064 to VITE_HUB_R0069, VITE_HUB_R0099, VITE_HUB_R0100, VITE_HUB_R0105, VITE_HUB_R0110 to VITE_HUB_R0112, VITE_HUB_R0119, VITE_HUB_R0122, and VITE_HUB_R0134.
export const viteHubErrorDiagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: "https://vitehub.dev/docs/development/diagnostics",
  codes: {
    CACHE_INVALID_INPUT: {
      ...dynamicError,
      fix: "Pass a cache key or a non-empty prefix, and a list limit from 1 to 100. Prefix deletion cannot clear the whole cache.",
    },
    CACHE_STORAGE_FAILED: {
      ...dynamicError,
      fix: "Check that the cache driver supports the requested storage operation. Vercel Runtime Cache cannot list keys.",
    },
    VITE_HUB_R0120: dynamicError,
    VITE_HUB_R0121: dynamicError,
    VITE_HUB_R0124: dynamicError,
    VITE_HUB_R0125: dynamicError,
    VITE_HUB_R0126: dynamicError,
    VITE_HUB_R0127: dynamicError,
    VITE_HUB_R0128: dynamicError,
    VITE_HUB_R0129: dynamicError,
    VITE_HUB_R0131: dynamicError,
    VITE_HUB_R0132: dynamicError,
    VITE_HUB_R0135: dynamicError,
    VITE_HUB_R0136: dynamicError,
    VITE_HUB_R0137: dynamicError,
    VITE_HUB_R0141: dynamicError,
    VITE_HUB_R0142: {
      ...dynamicError,
      fix: "Set vitehub({ systemd }) to one-line values: a unit name of letters, digits, and _.:-, an absolute workingDirectory, and environment names such as PORT. Or set systemd: false and write the unit yourself.",
    },
    VITE_HUB_R0143: {
      why: "This server has no durability report. ViteHub records it when a Node server starts.",
      fix: "Run the app with the Node host, then run vitehub durability list against that server.",
    },
    VITE_HUB_R0144: {
      ...dynamicError,
      fix: "Remove `rateLimit.provider` to use the preset's supported provider, or use the `node` preset to count in KV.",
    },
    VITE_HUB_R0116: {
      ...dynamicError,
      fix: "Send only `user` and `assistant` Messages in the `messages` history of `agents.invoke`.",
    },
    VITE_HUB_R0117: {
      ...dynamicError,
      fix: "Keep only text, file, image, and audio parts in the `messages` history of `agents.invoke`, and remove tool and approval parts.",
    },
    VITE_HUB_R0118: {
      ...dynamicError,
      fix: "Give each Message in the `messages` history of `agents.invoke` a different `id`.",
    },
    VITE_HUB_R0115: {
      ...dynamicError,
      fix: "Pass the `cursor` of the last `vitehub agent usage` page with the same `--agent`, `--window`, `--status`, and `--search`, or omit `cursor` to read the first page.",
    },
    VITE_HUB_R0113: {
      ...dynamicError,
      fix: "Pass an Agent name of at most 512 characters, as `vitehub agents list` shows it, to `--agent` of `vitehub agents status`.",
    },
    VITE_HUB_R0114: {
      ...dynamicError,
      fix: "Pass to `vitehub agents status --agent` the name of an Agent that `vitehub agents list` shows.",
    },
    VITE_HUB_R0095: {
      ...dynamicError,
      fix: "Update `vite-hub` in the app to the version of the Console and deploy the app again, so its Console route answers in the shape that the Console reads.",
    },
    VITE_HUB_R0096: {
      ...dynamicError,
      fix: "Update `vite-hub` in the app to the version of the Console and deploy the app again, so its Console route answers in the shape that the Console reads.",
    },
    VITE_HUB_R0097: {
      ...dynamicError,
      fix: "Update `vite-hub` in the app to the version of the Console and deploy the app again, so its Console route answers in the shape that the Console reads.",
    },
    VITE_HUB_R0098: {
      ...dynamicError,
      fix: "Update `vite-hub` in the app to the version of the Console and deploy the app again, so its Console route answers in the shape that the Console reads.",
    },
    VITE_HUB_R0101: {
      ...dynamicError,
      fix: "Check that the app runs and answers on its `/_vitehub/rpc` route, then reload the Console page.",
    },
    VITE_HUB_R0102: {
      ...dynamicError,
      fix: "Update `vite-hub` in the app to the version of the Console and deploy the app again, so its Console route answers in the shape that the Console reads.",
    },
    VITE_HUB_R0103: {
      ...dynamicError,
      fix: "Update `vite-hub` in the app to the version of the Console and deploy the app again, so its Console route answers in the shape that the Console reads.",
    },
    VITE_HUB_R0104: {
      ...dynamicError,
      fix: "Update `vite-hub` in the app to the version of the Console and deploy the app again, so its Console route answers in the shape that the Console reads.",
    },
    VITE_HUB_R0106: {
      ...dynamicError,
      fix: "Check that the app runs and answers on its `/_vitehub/rpc` route, then reload the Console page.",
    },
    VITE_HUB_R0107: {
      ...dynamicError,
      fix: "Reload the Workspace view, so that the Console reads the file at the current revision of the Workspace.",
    },
    VITE_HUB_R0108: {
      ...dynamicError,
      fix: "Update `vite-hub` in the app to the version of the Console and deploy the app again, so its Console route answers in the shape that the Console reads.",
    },
    VITE_HUB_R0109: {
      ...dynamicError,
      fix: "Update `vite-hub` in the app to the version of the Console and deploy the app again, so its Console route answers in the shape that the Console reads.",
    },
    VITE_HUB_R0001: dynamicError,
    VITE_HUB_R0040: {
      ...dynamicError,
      fix: "Move the app route or Nitro handler on `/_vitehub/rpc` to another path, or set `vitehub({ console: false })` to turn the Console route off.",
    },
    VITE_HUB_R0041: {
      ...dynamicError,
      fix: "Look up the error code that the app returned and fix that cause in the app. Without a code, read the app logs for the store call that failed.",
    },
    VITE_HUB_R0042: {
      ...dynamicError,
      fix: "Update `vite-hub` in the app to the version of the Console and deploy the app again, so its Console route answers in the shape that the Console reads.",
    },
    VITE_HUB_R0043: {
      ...dynamicError,
      fix: "Update `vite-hub` in the app to the version of the Console and deploy the app again, so its Console route answers in the shape that the Console reads.",
    },
    VITE_HUB_R0044: {
      ...dynamicError,
      fix: "Update `vite-hub` in the app to the version of the Console and deploy the app again, so its Console route answers in the shape that the Console reads.",
    },
    VITE_HUB_R0045: {
      ...dynamicError,
      fix: "Give the Agent a name of 1 to 512 characters without spaces at the start or the end, in its file or folder name under `server/agents/`.",
    },
    VITE_HUB_R0046: {
      ...dynamicError,
      fix: "Change the `agents.invoke`, `invocations.cancel`, `invocations.delete`, or `invocations.undo` call as the message says, with an Agent from `vitehub agents list` and an Invocation id from `vitehub invocations list`. A 409 names what the app lacks for the action, such as Realtime for undo or an invocation store that can delete.",
    },
    VITE_HUB_R0047: {
      ...dynamicError,
      fix: "Give every Agent Definition the same `invocations` journal, or remove `invocations` from the Agent Definitions, so they share the app-wide `agent.invocations` journal.",
    },
    VITE_HUB_R0049: {
      ...dynamicError,
      fix: "Enable Blob with `vitehub({ blob })` and keep the Console on, so that ViteHub installs Blob inspection before `getConsoleBlob()` runs.",
    },
    VITE_HUB_R0050: {
      ...dynamicError,
      fix: "Pass `vitehub database rows` a database and a table that `vitehub database tables` lists, a `--sort` column of that table, and a `--limit`, `--offset`, and `--search` inside the limits that the message names.",
    },
    VITE_HUB_R0051: {
      ...dynamicError,
      fix: "Enable a Database with `vitehub({ database })` and keep the Console on, so that ViteHub installs Database inspection before `getConsoleDatabase()` runs.",
    },
    VITE_HUB_C0001: {
      ...dynamicError,
      fix: "Pass a section that `vitehub project info` lists, or a Workspace, revision, and text file under 512 KiB that `vitehub workspaces files` lists. For a 502 or 503, read the app logs for the Workspace store, Env provider, or section reader that failed, then try again.",
    },
    VITE_HUB_C0002: {
      ...dynamicError,
      fix: "Enable a feature that adds a Console section, such as `vitehub({ database })`, and keep the Console on, so that ViteHub installs Definition inspection before `getConsoleDefinitions()` runs.",
    },
    VITE_HUB_C0003: dynamicError,
    VITE_HUB_C0004: dynamicError,
    VITE_HUB_R0052: {
      ...dynamicError,
      fix: "Pass the `cursor` of the last `vitehub search query` result with the same search, or omit `cursor` to read the first page. A 409 means that the results changed after that cursor, so start again without it.",
    },
    VITE_HUB_R0053: {
      ...dynamicError,
      fix: "Pass an Agent name of at most 512 characters, as `vitehub agents list` shows it, to `--agent` of `vitehub invocations capabilities`.",
    },
    VITE_HUB_R0054: {
      ...dynamicError,
      fix: "Pass an Invocation id that `vitehub invocations list` shows. The journal removes old Invocations after its retention limit.",
    },
    VITE_HUB_R0058: {
      ...dynamicError,
      fix: "Pass the `cursor` of the last `vitehub invocations list` result without changes, or omit `cursor` to read the first page.",
    },
    VITE_HUB_R0059: {
      ...dynamicError,
      fix: "Pass at most 100 Invocation ids in the `id` list of `invocations.list`, and split a longer list into several calls.",
    },
    VITE_HUB_R0060: {
      ...dynamicError,
      fix: "Pass an Agent name of at most 512 characters, as `vitehub agents list` shows it, to `--agent` of `vitehub invocations list`.",
    },
    VITE_HUB_R0061: {
      ...dynamicError,
      fix: "Pass `capability` and `triggeredBy` values of at most 512 characters to `invocations.list` (`vitehub invocations list`).",
    },
    VITE_HUB_R0062: {
      ...dynamicError,
      fix: "Pass a whole number of 1 or more as `limit` to `invocations.list` (`vitehub invocations list --limit`).",
    },
    VITE_HUB_R0063: {
      ...dynamicError,
      fix: "Turn the Console on with `console: true` in `vitehub()`, or in the `vitehub` key of `nuxt.config.ts`, and add an Agent Definition, such as `server/agents/support/agent.ts`. Without the Console, read the journal file with `vitehub agent invocations list --database .vitehub/data/agent-invocations.sqlite`.",
    },
    VITE_HUB_R0070: {
      ...dynamicError,
      fix: "Pass an Agent name of at most 512 characters, as `vitehub agents list` shows it, to `--agent` of `vitehub agent usage`.",
    },
    VITE_HUB_R0071: {
      ...dynamicError,
      fix: "Pass `--window` as 24h, 7d, 14d, 30d, or 90d to `vitehub agent usage`, or omit it to read 30 days.",
    },
    VITE_HUB_R0072: {
      ...dynamicError,
      fix: "Pass `vitehub agent usage` a `--status` of completed, failed, or cancelled, a `--window` of 24h, 7d, 14d, 30d, or 90d, and a `--search` of at most 512 characters.",
    },
    VITE_HUB_R0073: {
      ...dynamicError,
      fix: "Set `vitehub({ publicUrl })` to the public origin of the app, or call `invocationUrl()` while a request runs. With several origins, send the request to one of them.",
    },
    VITE_HUB_R0074: {
      ...dynamicError,
      fix: "Pass `invocationUrl()` an Invocation with a string `agentName` and `id`, such as the current Invocation of the handler.",
    },
    VITE_HUB_B0001: {
      ...dynamicError,
      fix: "Reinstall the project dependencies, so that the `vite-hub` package has its Console runtime files, then build again.",
    },
    VITE_HUB_B0004: dynamicError,
    VITE_HUB_B0005: dynamicError,
    VITE_HUB_R0075: dynamicError,
    VITE_HUB_R0076: dynamicError,
    VITE_HUB_R0077: dynamicError,
    VITE_HUB_R0078: dynamicError,
    VITE_HUB_R0079: dynamicError,
    VITE_HUB_R0080: dynamicError,
    VITE_HUB_R0081: dynamicError,
    VITE_HUB_R0082: dynamicError,
    VITE_HUB_R0083: dynamicError,
    VITE_HUB_R0084: dynamicError,
    VITE_HUB_R0085: dynamicError,
    VITE_HUB_R0086: dynamicError,
    VITE_HUB_R0087: dynamicError,
    VITE_HUB_R0088: dynamicError,
    VITE_HUB_R0089: dynamicError,
    VITE_HUB_B0008: dynamicError,
    VITE_HUB_B0009: dynamicError,
    VITE_HUB_B0011: dynamicError,
    VITE_HUB_B0012: dynamicError,
    VITE_HUB_B0013: dynamicError,
    VITE_HUB_B0015: dynamicError,
    VITE_HUB_B0016: dynamicError,
    VITE_HUB_B0018: dynamicError,
    VITE_HUB_B0019: dynamicError,
    VITE_HUB_B0020: dynamicError,
    VITE_HUB_B0021: dynamicError,
    VITE_HUB_B0022: dynamicError,
    VITE_HUB_B0023: {
      ...dynamicError,
      fix: "Upgrade to Nuxt 5, which supplies Nitro 3 and H3 2. Until Nuxt 5 is stable, run pnpm add nuxt@npm:nuxt-nightly@5x.",
    },
    VITE_HUB_B0024: {
      ...dynamicError,
      fix: "Remove the obsolete option from `vitehub()` or the `vitehub` options in nuxt.config.ts, and apply the migration shown in the error message.",
    },
  },
})
