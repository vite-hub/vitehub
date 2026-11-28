const inViteHub = "in `vitehub()`, or in the `vitehub` key of `nuxt.config.ts`"

const setFeature = (key: string) => `Set \`${key}\` ${inViteHub}.`
const agentFix = `Add an Agent Definition, such as \`server/agents/support.ts\`, and set \`agent\` ${inViteHub}.`
const envFix = `Remove \`env: false\` ${inViteHub}.`

export const consoleFeatureOperations = {
  agentChannelOperations: {
    fix: agentFix,
    operations: { channels: ["conversation", "deliveries", "list", "status", "threads"], conversations: ["export"] },
  },
  agentConsoleOperations: {
    fix: agentFix,
    operations: {
      agents: ["invoke", "list"],
      channels: ["replay"],
      invocations: ["cancel", "capabilities", "delete", "get", "list", "undo", "usage", "workspace"],
      search: ["query"],
      skills: ["inspect"],
      status: ["get"],
    },
  },
  authConsoleOperations: {
    fix: `Add an Auth Definition, such as \`server/auth.ts\`, and set \`auth\` ${inViteHub}.`,
    operations: { auth: ["activity", "agents", "ban", "describe", "edit-field", "impersonate", "organization", "organizations", "overview", "remove", "revoke-consent", "revoke-session", "revoke-sessions", "sessions", "set-role", "stop-impersonating", "unban", "user", "users"] },
  },
  blobOperations: {
    fix: setFeature("blob"),
    operations: { blob: ["delete", "get", "head", "list", "media", "put", "variants"] },
  },
  bundleOperations: {
    fix: setFeature("bundle"),
    operations: { bundle: ["report", "why"] },
  },
  cacheOperations: {
    fix: setFeature("cache"),
    operations: { cache: ["delete", "get", "list"] },
  },
  commentsOperations: {
    fix: "Turn Comments on in the ViteHub configuration, or add `server/comments.ts`.",
    operations: { comments: ["attachment", "create", "delete", "edit", "get", "list", "reopen", "reply", "resolve", "session", "threads", "upload", "users"] },
  },
  contentOperations: {
    fix: "Add a Content Definition in `server/content.ts`.",
    operations: { content: ["advance", "check", "collections", "diff", "head", "list", "pin", "previews", "publish", "remove", "resolve", "restore", "revisions", "save", "schedule", "schedules", "show", "sitemap", "status", "unpin", "unschedule"] },
  },
  databaseConsoleOperations: {
    fix: setFeature("database"),
    operations: { databases: ["browse", "tables"] },
  },
  documentConsoleOperations: {
    fix: "Add a document editor owner, such as Content: define document collections in `server/content.ts`.",
    operations: { documents: ["action", "preview"] },
  },
  emailOperations: {
    fix: setFeature("email"),
    operations: { email: ["outbox-clear", "outbox-list", "outbox-show", "preview"] },
  },
  envConsoleOperations: {
    fix: envFix,
    operations: { env: ["get"] },
  },
  envOperations: {
    fix: envFix,
    operations: { env: ["inspect"] },
  },
  formsOperations: {
    fix: "Add a Form Definition in `server/forms/`.",
    operations: { forms: ["get", "list", "mark"] },
  },
  kvOperations: {
    fix: setFeature("kv"),
    operations: { kv: ["delete", "get", "has", "list", "set"] },
  },
  logsConsoleOperations: {
    fix: setFeature("logs"),
    operations: { logs: ["list"] },
  },
  mediaConsoleOperations: {
    fix: `Set \`blob\` ${inViteHub}, and add a document editor owner, such as Content with document collections in \`server/content.ts\`.`,
    operations: { media: ["action", "upload"] },
  },
  queueOperations: {
    fix: setFeature("queue"),
    operations: { queue: ["jobs-clear", "jobs-list", "jobs-retry", "jobs-show", "list", "send"] },
  },
  rateLimitOperations: {
    fix: setFeature("rateLimit"),
    operations: { "rate-limit": ["peek", "reset"] },
  },
  scheduleOperations: {
    fix: setFeature("schedule"),
    operations: { schedule: ["attempts", "cancel", "list", "run", "runs", "start"] },
  },
  servedSkillsOperations: {
    fix: "Define served skills in `server/skills.ts`.",
    operations: { "served-skills": ["list", "set"] },
  },
  siteAccessOperations: {
    fix: `Set \`console\` and turn Comments on ${inViteHub}, or add \`server/comments.ts\`. Site access is off with \`comments: false\` or \`comments: { overlay: false }\`.`,
    operations: { site: ["access"] },
  },
  syncOperations: {
    fix: "Add a Sync Definition in `server/sync/`.",
    operations: { sync: ["changes", "list"] },
  },
  taskOperations: {
    fix: "Add a Task Definition in `server/tasks/` on a Vite app with Nitro.",
    operations: { task: ["list", "run"] },
  },
  webhooksOperations: {
    fix: "Add a Webhook Definition in `server/webhooks/` and enable Queue and Database.",
    operations: { webhooks: ["cancel", "deliveries", "disable-endpoint", "enable-endpoint", "endpoints", "flush", "get", "list", "pending", "redeliver", "test"] },
  },
  workflowOperations: {
    fix: setFeature("workflow"),
    operations: { workflow: ["cancel", "get", "resume", "runs-clear", "runs-list", "start"] },
  },
  workspaceConsoleOperations: {
    fix: setFeature("workspace"),
    operations: { workspaces: ["files"] },
  },
  workspaceOperations: {
    fix: setFeature("workspace"),
    operations: { workspace: ["changes", "commit", "history", "refs", "show", "stale"] },
  },
} as const satisfies Record<string, { fix: string, operations: Record<string, readonly string[]> }>

const featureFixes = new Map<string, string>(Object.values(consoleFeatureOperations).flatMap(({ fix, operations }) =>
  Object.entries<readonly string[]>(operations).flatMap(([namespace, names]) => names.map(name => [`${namespace}.${name}`, fix] as const)),
))

export function consoleFeatureFix(name: string): string | undefined {
  return featureFixes.get(name)
}
