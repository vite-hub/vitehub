/**
 * The server helpers that `vite-hub/nuxt` auto-imports in Nitro code, per ViteHub feature, when the app turns on
 * Nuxt's server auto-imports. This table is the only list: the Nuxt module adds these auto-imports, and the
 * `nuxt-server-imports` codemod adds an explicit import for each one. `vite-hub` checks that each name is a value
 * export of its `vite-hub/*` entry.
 *
 * Rules for an entry:
 * - Runtime helpers that server code calls in a handler, such as `kv` or `sendQueue`.
 * - `define*` helpers only when Nitro alone loads their Definition files. ViteHub also loads Agent, Auth, Comments,
 *   Database, Schedule, Workflow, and Workspace Definitions outside Nitro (Vite SSR, jiti, `runnerImport`, or
 *   provider bundles). Those files and their dependencies keep explicit imports for every helper they use.
 * - No name that Nuxt, Nitro, or H3 auto-imports, such as `getSession`, `useSession`, `defineTask`, or `useStorage`.
 */
export const viteHubServerImports = {
  agent: { "vite-hub/agent": ["runAgent", "streamAgent"] },
  auth: { "vite-hub/auth/server": ["can", "requireAbility", "requireAuth", "requireAuthorization", "requireCaller", "useAuth", "withAnonymousAuthorization", "withAuth", "withAuthorization"] },
  blob: { "vite-hub/blob": ["blob"] },
  browser: { "vite-hub/browser": ["defineBrowser", "runBrowser"] },
  cache: { "vite-hub/cache": ["invalidateTag"] },
  channels: { "vite-hub/channels": ["defineChannel", "useChannel"] },
  connections: { "vite-hub/connections": ["defineConnection"], "vite-hub/connections/server": ["useConnection"] },
  database: { "vite-hub/database": ["db", "schema", "useDatabase"] },
  email: { "vite-hub/email": ["email"] },
  env: { "vite-hub/env": ["checkServiceToken", "requireServiceToken", "useServerEnv", "verifyWebhook"] },
  i18n: { "vite-hub/i18n/server": ["getRequestI18n", "useTranslations"] },
  kv: { "vite-hub/kv": ["kv"] },
  queue: { "vite-hub/queue": ["defineQueue", "deferQueue", "useQueue", "sendQueue"] },
  rateLimit: { "vite-hub/rate-limit": ["checkRateLimit", "peekRateLimit", "refundRateLimit", "requireRateLimit", "resetRateLimit"] },
  realtime: { "vite-hub/realtime": ["defineRealtime"], "vite-hub/realtime/server": ["isRealtimeAvailable", "refreshRealtimeDocument"] },
  sandboxTask: { "vite-hub/sandbox/task": ["runSandboxTask"] },
  schedule: { "vite-hub/schedule": ["cancelSchedule", "getSchedule", "listSchedules", "startSchedule"] },
  seo: { "vite-hub/seo": ["defineSitemap"] },
  source: { "vite-hub/source": ["useSource"] },
  workflow: { "vite-hub/workflow": ["cancelWorkflow", "deferWorkflow", "getWorkflowRun", "resumeWorkflow", "startWorkflow"] },
  workspace: { "vite-hub/workspace": ["useWorkspace"] },
} as const

/** Each helper name of {@link viteHubServerImports}, mapped to the `vite-hub/*` entry that exports it. */
export const viteHubServerImportSources: ReadonlyMap<string, string> = new Map(
  serverImportTables().flatMap(sources => Object.entries(sources).flatMap(([from, names]) => names.map(name => [name, from] as const))),
)

function serverImportTables(): ReadonlyArray<Readonly<Record<string, readonly string[]>>> {
  return Object.values(viteHubServerImports)
}
