/**
 * The server helpers that `vite-hub/nuxt` auto-imports in Nitro code, per ViteHub feature. This table is the only list.
 *
 * Rules for an entry:
 * - Runtime helpers that server code calls in a handler, such as `kv` or `sendQueue`.
 * - `define*` helpers only when Nitro alone loads their Definition files. ViteHub also loads Agent, Auth, Comments,
 *   Database, Schedule, Workflow, and Workspace Definitions outside Nitro (Vite SSR, jiti, `runnerImport`, or
 *   provider bundles). Those files and their dependencies keep explicit imports for every helper they use.
 * - No name that Nuxt, Nitro, or H3 auto-imports, such as `getSession`, `useSession`, `defineTask`, or `useStorage`.
 *
 * The `satisfies` check fails the typecheck when a name is not a value export of its `vite-hub/*` entry.
 */
export const viteHubServerImports = {
  agent: { "vite-hub/agent": ["runAgent", "streamAgent"] },
  auth: { "vite-hub/auth/server": ["auth", "can", "getAuth", "requireAbility", "requireAuth", "requireAuthorization", "useAuth", "withAnonymousAuthorization", "withAuth", "withAuthorization"] },
  blob: { "vite-hub/blob": ["blob"] },
  browser: { "vite-hub/browser": ["defineBrowser", "runBrowser"] },
  // `defineCachedFunction` and `defineCachedHandler` keep Nitro's auto-imports. Import the tagged ones from `vite-hub/cache`.
  cache: { "vite-hub/cache": ["invalidateTag"] },
  channels: { "vite-hub/channels": ["defineChannel", "useChannel"] },
  connections: { "vite-hub/connections": ["defineConnection"], "vite-hub/connections/server": ["useConnection"] },
  database: { "vite-hub/database": ["db", "schema", "useDatabase"] },
  email: { "vite-hub/email": ["email"] },
  // Generated Env declarations type the primitive root for each app.
  env: { "vite-hub/env": ["useServerEnv"] },
  i18n: { "vite-hub/i18n/server": ["getRequestI18n", "useTranslations"] },
  kv: { "vite-hub/kv": ["kv"] },
  queue: { "vite-hub/queue": ["defineQueue", "deferQueue", "useQueue", "sendQueue"] },
  rateLimit: { "vite-hub/rate-limit": ["checkRateLimit", "peekRateLimit", "requireRateLimit", "resetRateLimit"] },
  realtime: { "vite-hub/realtime": ["defineRealtime"], "vite-hub/realtime/server": ["isRealtimeAvailable", "refreshRealtimeDocument"] },
  sandboxTask: { "vite-hub/sandbox/task": ["runSandboxTask"] },
  schedule: { "vite-hub/schedule": ["cancelSchedule", "getSchedule", "listSchedules", "startSchedule"] },
  workflow: { "vite-hub/workflow": ["cancelWorkflow", "deferWorkflow", "getWorkflowRun", "resumeWorkflow", "startWorkflow"] },
  workspace: { "vite-hub/workspace": ["useWorkspace"] },
} as const satisfies Record<string, { [From in keyof ServerImportEntries]?: readonly (keyof ServerImportEntries[From] & string)[] }>

/** The public entries that the table imports from, mapped to their facade source. */
interface ServerImportEntries {
  "vite-hub/agent": typeof import("./agent.ts")
  "vite-hub/auth/server": typeof import("./auth/server.ts")
  "vite-hub/blob": typeof import("./blob.ts")
  "vite-hub/browser": typeof import("./browser.ts")
  "vite-hub/cache": typeof import("./cache.ts")
  "vite-hub/channels": typeof import("./channels.ts")
  "vite-hub/connections": typeof import("./connections.ts")
  "vite-hub/connections/server": typeof import("./connections/server.ts")
  "vite-hub/database": typeof import("./database.ts")
  "vite-hub/email": typeof import("./email.ts")
  "vite-hub/env": typeof import("./env.ts")
  "vite-hub/i18n/server": typeof import("./i18n/server.ts")
  "vite-hub/kv": typeof import("./kv.ts")
  "vite-hub/queue": typeof import("./queue.ts")
  "vite-hub/rate-limit": typeof import("./rate-limit.ts")
  "vite-hub/realtime": typeof import("./realtime.ts")
  "vite-hub/realtime/server": typeof import("./realtime/server.ts")
  "vite-hub/sandbox/task": typeof import("./sandbox/task.ts")
  "vite-hub/schedule": typeof import("./schedule.ts")
  "vite-hub/workflow": typeof import("./workflow.ts")
  "vite-hub/workspace": typeof import("./workspace.ts")
}

export type ViteHubServerImportFeature = keyof typeof viteHubServerImports

/** An unimport entry, as Nitro and Nuxt read `imports.imports`. */
export interface ServerAutoImport {
  as?: string
  from: string
  name: string
  priority?: number
}

/** The import entries for the enabled features, in table order. */
export function resolveViteHubServerImports(enabled: Partial<Record<ViteHubServerImportFeature, unknown>>): ServerAutoImport[] {
  const imports: ServerAutoImport[] = []
  for (const [feature, sources] of Object.entries(viteHubServerImports)) {
    // SAFETY: `Object.entries` widens the keys of the const table above to string.
    if (!enabled[feature as ViteHubServerImportFeature]) continue
    for (const [from, names] of Object.entries(sources)) {
      // A negative priority lets the app's `server/utils` exports and other modules win a name without a warning.
      for (const name of names) imports.push({ from, name, priority: -1 })
    }
  }
  return imports
}
