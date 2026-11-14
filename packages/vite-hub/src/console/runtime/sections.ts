/** Sections that the Console UI in `vite-hub` renders with its own components. Owner packages contribute the others. */
export const consoleBuiltinSectionIds = ["env", "agents", "skills", "usage", "channels", "mcp-client", "logs", "blob", "databases", "kv", "site", "setup"] as const

/**
 * Sections that are tools, not primitives, so the Overview does not offer them: Setup, which only a development server
 * has, and Site access, which comes with the page tools.
 */
export const consoleToolSectionIds: readonly ConsoleBuiltinSectionId[] = ["setup", "site"]

export type ConsoleBuiltinSectionId = (typeof consoleBuiltinSectionIds)[number]

/** A built-in section id or the id of a section that an owner package contributes. */
export type ConsoleSectionId = string

export interface ConsoleSectionDetails {
  readonly description: string
  readonly icon: string
  readonly label: string
  readonly routeName: string
}

/** Details of built-in sections. Contributed sections get their details from the navigation response. */
export const consoleSectionDetails: Readonly<Record<ConsoleBuiltinSectionId, ConsoleSectionDetails>> = {
  env: { description: "Inspect Server Env declarations and their providers.", icon: "i-vitehub-env", label: "Env", routeName: "vitehub-console-env" },
  agents: {
    description: "Inspect Agent sessions and invocation details.",
    icon: "i-vitehub-agent",
    label: "Agents",
    routeName: "vitehub-console-agents",
  },
  skills: { description: "Inspect bundled Agent Skills and their files.", icon: "i-vitehub-skills", label: "Skills", routeName: "vitehub-console-skills" },
  logs: { description: "Read structured events from the connected log source.", icon: "i-vitehub-logs", label: "Logs", routeName: "vitehub-console-logs" },
  usage: {
    description: "Review token use and cost evidence over time.",
    icon: "i-vitehub-usage",
    label: "Usage",
    routeName: "vitehub-console-usage",
  },
  channels: {
    description: "Read and export the conversations of Agent Channels.",
    icon: "i-vitehub-channels",
    label: "Channels",
    routeName: "vitehub-console-channels",
  },
  "mcp-client": {
    description: "Connect to MCP servers as yourself, then call their tools, resources, and prompts.",
    icon: "i-vitehub-connections",
    label: "MCP client",
    routeName: "vitehub-console-mcp-client",
  },
  blob: {
    description: "Inspect configured Blob stores and object metadata without downloading contents.",
    icon: "i-vitehub-blob",
    label: "Blob",
    routeName: "vitehub-console-blob",
  },
  databases: {
    description: "Inspect discovered Database Definitions and static schema metadata.",
    icon: "i-vitehub-database",
    label: "Databases",
    routeName: "vitehub-console-databases",
  },
  kv: {
    description: "Inspect configured KV stores without changing data.",
    icon: "i-vitehub-kv",
    label: "KV",
    routeName: "vitehub-console-kv",
  },
  site: {
    description: "Sign your browsers and invited guests in to the site, for the page tools.",
    icon: "i-lucide-globe-lock",
    label: "Site access",
    routeName: "vitehub-console-site",
  },
  setup: {
    description: "Turn features on and off for this app. Development only.",
    icon: "i-lucide-blocks",
    label: "Setup",
    routeName: "vitehub-console-setup",
  },
}

/** Navigation groups in rail order. A contributed section with an unknown id goes to `more`. */
export const consoleSectionGroupIds = ["agents", "data", "runtime", "platform", "more"] as const

export type ConsoleSectionGroupId = (typeof consoleSectionGroupIds)[number]

const consoleSectionGroupBySection: Readonly<Record<string, ConsoleSectionGroupId>> = {
  agents: "agents",
  skills: "agents",
  "served-skills": "agents",
  usage: "agents",
  channels: "agents",
  "mcp-client": "agents",
  logs: "runtime",
  databases: "data",
  kv: "data",
  blob: "data",
  content: "data",
  comments: "data",
  forms: "data",
  workspaces: "data",
  workflows: "runtime",
  queues: "runtime",
  schedules: "runtime",
  "sandbox-tasks": "runtime",
  env: "platform",
  auth: "platform",
  email: "platform",
  "rate-limits": "platform",
  site: "platform",
  setup: "platform",
}

/** Labels that the Overview shows above each navigation group. */
export const consoleSectionGroupLabels: Readonly<Record<ConsoleSectionGroupId, string>> = {
  agents: "Agents",
  data: "Data",
  runtime: "Runtime",
  platform: "Platform",
  more: "More",
}

/** Returns the navigation group of a section. A contributed section with an unknown id goes to `more`. */
export function resolveConsoleSectionGroup(section: ConsoleSectionId): ConsoleSectionGroupId {
  return Object.hasOwn(consoleSectionGroupBySection, section) ? consoleSectionGroupBySection[section] : "more"
}

/**
 * Inserts a section before the first section of the same or a later navigation group, so it leads its group. Returns a
 * copy of the sections when they already include it.
 */
export function insertConsoleSection(sections: readonly ConsoleSectionId[], section: ConsoleSectionId): ConsoleSectionId[] {
  if (sections.includes(section)) return [...sections]
  const group = consoleSectionGroupIds.indexOf(resolveConsoleSectionGroup(section))
  const index = sections.findIndex(candidate => consoleSectionGroupIds.indexOf(resolveConsoleSectionGroup(candidate)) >= group)
  return index === -1 ? [...sections, section] : [...sections.slice(0, index), section, ...sections.slice(index)]
}

/** Splits enabled sections into navigation groups. Keeps the given order inside each group and drops empty groups. */
export function groupConsoleSections<T extends { id: ConsoleSectionId }>(sections: readonly T[]): T[][] {
  return consoleSectionGroupIds
    .map(group => sections.filter(section => resolveConsoleSectionGroup(section.id) === group))
    .filter(group => group.length > 0)
}

export const consoleDocsBase = "https://vitehub.dev/docs"

/** A primitive that the Console can show. The Overview lists the primitives that a project has not enabled yet. */
export interface ConsolePrimitive {
  readonly docs: string
  readonly icon: string
  readonly id: ConsoleSectionId
  readonly label: string
  /** What the primitive does, from the first line of its documentation. */
  readonly pitch: string
  readonly setup: string
}

const primitive = (id: ConsoleSectionId, label: string, icon: string, slug: string, pitch: string, setup = `${slug}/get-started`): ConsolePrimitive => ({
  docs: `${consoleDocsBase}/${slug}`,
  icon,
  id,
  label,
  pitch,
  setup: `${consoleDocsBase}/${setup}`,
})

/**
 * Every primitive that has a Console section, in navigation order. Contributed sections repeat the label and icon
 * of their owner descriptor because the Console only receives descriptors for enabled sections.
 */
export const consolePrimitives: readonly ConsolePrimitive[] = [
  primitive("auth", "Auth", "i-vitehub-auth", "auth", "Manage users, sessions, organizations, and approved OAuth clients."),
  primitive("env", "Env", consoleSectionDetails.env.icon, "env", "Declare public, build-time, server runtime, and secret values behind typed accessors."),
  primitive("agents", "Agents", consoleSectionDetails.agents.icon, "agents", "Define a server-side Agent, choose how it runs, and connect it to your application.", "getting-started/first-agent"),
  primitive("skills", "Skills", consoleSectionDetails.skills.icon, "agents/capabilities/skills", "Inspect the bundled Skill files that each Agent receives.", "agents/capabilities/skills"),
  primitive("logs", "Logs", consoleSectionDetails.logs.icon, "logs", "Read structured logs and diagnostic guidance from your existing pipeline."),
  primitive("usage", "Usage", consoleSectionDetails.usage.icon, "development/console", "Review the token use and cost that Agent Invocations record.", "agents"),
  primitive("channels", "Channels", consoleSectionDetails.channels.icon, "agents/channels", "Read and export the conversations that Agents have in Telegram, Slack, and other Channels.", "agents/channels"),
  primitive("mcp-client", "MCP client", consoleSectionDetails["mcp-client"].icon, "development/console", "Connect to MCP servers as one or more accounts, and call their tools, resources, and prompts.", "development/console"),
  primitive("content", "Content", "i-vitehub-content", "content", "Edit Markdown documents with validated fields, drafts, publishing, and revision history."),
  primitive("comments", "Comments", "i-vitehub-comments", "comments", "Pin comments to any page of the site, reply, resolve, and edit Content text in place."),
  primitive("blob", "Blob", consoleSectionDetails.blob.icon, "blob", "Store uploads, generated files, binary objects, and metadata with one object-storage API."),
  primitive("databases", "Databases", consoleSectionDetails.databases.icon, "database", "Define relational data with Drizzle and query it through generated imports."),
  primitive("email", "Email", "i-vitehub-email", "email", "Send transactional email through a provider-neutral driver, with safe test capture."),
  primitive("kv", "KV", consoleSectionDetails.kv.icon, "kv", "Store and read small values by key through one key-value API."),
  primitive("rate-limits", "Rate Limits", "i-vitehub-rate-limit", "rate-limit", "Require request budgets through an H3 guard and atomic drivers."),
  primitive("sandbox-tasks", "Sandbox Tasks", "i-vitehub-sandbox", "sandbox", "Run named package projects as Sandbox Tasks in an isolated Cloudflare or Vercel Sandbox."),
  primitive("workspaces", "Workspaces", "i-vitehub-workspace", "workspace", "Build persistent file-tree state with rules, Source Bindings, snapshots, and diffs."),
  primitive("workflows", "Workflows", "i-vitehub-workflow", "workflows", "Start provider-tracked long-running work with run ids, durable state, and steps."),
  primitive("queues", "Queues", "i-vitehub-queue", "queue", "Define Queue Definitions, enqueue jobs, and choose a Cloudflare or Vercel provider."),
  primitive("schedules", "Schedules", "i-vitehub-schedule", "schedule", "Declare cron schedules and inspect the schedules that code starts."),
]

/**
 * The guide that the Overview links under Learn, before the docs of each enabled section. It is for the people who run
 * the app, so it explains the Console, not how to build with ViteHub.
 */
export const consoleGuide: { readonly description: string, readonly href: string, readonly icon: string, readonly label: string } = {
  description: "What each page of this Console does, and who can open it.",
  href: `${consoleDocsBase}/development/console`,
  icon: "i-vitehub-docs",
  label: "Console guide",
}

/** Returns the documentation link of a section, or undefined for a contributed section that the Console does not know. */
export function resolveConsoleSectionDocs(section: ConsoleSectionId): string | undefined {
  return consolePrimitives.find(entry => entry.id === section)?.docs
}

/** First key of every "Go to" chord, as in Linear and GitHub. */
export const consoleGoToKey = "g"

/** Keys that open the Overview: `g` and then `o`. */
export const consoleOverviewShortcut: readonly [typeof consoleGoToKey, "o"] = [consoleGoToKey, "o"]

/** Second key of the "Go to" chord of each known section. Each key is unique and is not `o`. */
export const consoleSectionShortcutKeys: Readonly<Record<string, string>> = {
  auth: "h",
  agents: "a",
  content: "t",
  skills: "i",
  comments: "n",
  usage: "u",
  channels: "v",
  "mcp-client": "p",
  logs: "l",
  databases: "d",
  kv: "k",
  blob: "b",
  workspaces: "w",
  workflows: "f",
  queues: "q",
  schedules: "s",
  "sandbox-tasks": "x",
  env: "e",
  email: "m",
  "rate-limits": "r",
  site: "c",
  setup: "y",
}

/** Returns the "Go to" chord keys of a section. A contributed section with an unknown id has no chord. */
export function consoleSectionShortcut(section: ConsoleSectionId): readonly [typeof consoleGoToKey, string] | undefined {
  return Object.hasOwn(consoleSectionShortcutKeys, section)
    ? [consoleGoToKey, consoleSectionShortcutKeys[section]!]
    : undefined
}

interface ConsoleSectionStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

const lastConsoleSectionStorageKey = "vitehub-console:last-section"
const consoleSectionIdPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

/** Returns true for a lowercase route segment. Built-in and contributed section ids use this form. */
export function isConsoleSectionId(value: unknown): value is ConsoleSectionId {
  return typeof value === "string" && consoleSectionIdPattern.test(value)
}

export function isConsoleBuiltinSectionId(value: unknown): value is ConsoleBuiltinSectionId {
  return consoleBuiltinSectionIds.some(section => section === value)
}

/** The MCP client section is on when the Console options set `mcpClient: true`. */
export function isConsoleMcpClientEnabled(console: unknown): boolean {
  return typeof console === "object" && console !== null && Reflect.get(console, "mcpClient") === true
}

/** Route name of a contributed section. The Console serves it at `/_vitehub/<id>`. */
export function consoleSectionRouteName(section: ConsoleSectionId): string {
  return `vitehub-console-${section}`
}

/**
 * Route segment between a section and its pages, as in `/_vitehub/content/-/media`. Section and page ids start with a
 * letter, so `-` never collides with a page, and the main view of a section never gets it as its first segment.
 */
export const consoleSectionPageSegment = "-"

/** Route name of a section page: `vitehub-console-<section>--<page>`. */
export function consoleSectionPageRouteName(section: ConsoleSectionId, page: string): string {
  return `${consoleSectionRouteName(section)}--${page}`
}

/** One route of a contributed section, below the Console root. */
export interface ConsoleSectionRoute {
  name: string
  /** Path below `/_vitehub`, such as `/content/-/media`. */
  path: string
  /** The page that the route serves. Absent for the main view. */
  page?: string
  /** Path below `/_vitehub` to redirect to. An index page redirects from `/-/<id>` to the section root. */
  redirect?: string
}

/**
 * Routes of a contributed section. Vite and Nuxt hosts both register these, so deep links match:
 *
 * - `/<section>`: the main view. A document editor section adds `/:collection?/:document(.*)*`, and its root serves
 *   the index page when one exists.
 * - `/<section>/-/<page>`: every other page. The path of the index page redirects to the root.
 */
export function describeConsoleSectionRoutes(section: { id: ConsoleSectionId, pages?: readonly { id: string, index?: boolean }[], view: { kind: string } }): ConsoleSectionRoute[] {
  const name = consoleSectionRouteName(section.id)
  if (section.view.kind !== "document-editor") return [{ name, path: `/${section.id}` }]
  return [
    ...(section.pages ?? []).map((page): ConsoleSectionRoute => {
      const route = { name: consoleSectionPageRouteName(section.id, page.id), path: `/${section.id}/${consoleSectionPageSegment}/${page.id}` }
      return page.index ? { ...route, redirect: `/${section.id}` } : { ...route, page: page.id }
    }),
    { name, path: `/${section.id}/:collection?/:document(.*)*` },
  ]
}

/**
 * Returns the enabled section ids in navigation order. Owner packages contribute `rate-limits`, `sandbox-tasks`,
 * `workspaces`, `workflows`, `queues`, and `schedules`. `console/contributions.ts` maps each id to its owner.
 */
export function resolveConsoleSectionIds(options: {
  auth?: unknown;
  env?: unknown;
  console?: unknown;
  agent?: unknown;
  blob?: unknown;
  comments?: unknown;
  database?: unknown;
  email?: unknown;
  host?: unknown;
  kv?: unknown;
  observability?: unknown;
  queue?: unknown;
  rateLimit?: unknown;
  sandboxTask?: unknown;
  schedule?: unknown;
  workflow?: unknown;
  workspace?: unknown
}): ConsoleSectionId[] {
  const workflowEnabled = options.workflow !== false
    && Boolean(options.workflow || (options.agent && options.host !== "netlify"))
  return [
    ...(options.auth ? ["auth"] : []),
    // `observability: { logs }` connects the log source that the section reads.
    ...(options.observability && typeof options.observability === "object" && "logs" in options.observability && options.observability.logs ? ["logs"] : []),
    ...(options.env ? ["env"] : []),
    ...(options.agent ? ["agents", "skills", "usage", "channels"] : []),
    ...(isConsoleMcpClientEnabled(options.console) ? ["mcp-client"] : []),
    ...(options.blob ? ["blob"] : []),
    // Without the option, `server/comments.ts` turns the section on through discovery.
    ...(options.comments ? ["comments"] : []),
    ...(options.database ? ["databases"] : []),
    ...(options.email ? ["email"] : []),
    ...(options.kv ? ["kv"] : []),
    ...(options.rateLimit ? ["rate-limits"] : []),
    ...(options.sandboxTask ? ["sandbox-tasks"] : []),
    ...(options.workspace ? ["workspaces"] : []),
    ...(workflowEnabled ? ["workflows"] : []),
    ...(options.queue ? ["queues"] : []),
    ...(options.schedule ? ["schedules"] : []),
  ]
}

export function prioritizeConsoleSectionIds(
  sections: readonly ConsoleSectionId[],
  preferred: ConsoleSectionId | undefined,
): ConsoleSectionId[] {
  return preferred && sections.includes(preferred)
    ? [preferred, ...sections.filter(section => section !== preferred)]
    : [...sections]
}

export function readLastConsoleSection(storage?: ConsoleSectionStorage): ConsoleSectionId | undefined {
  try {
    const target = storage ?? globalThis.localStorage
    const value = target?.getItem(lastConsoleSectionStorageKey)
    return isConsoleSectionId(value) ? value : undefined
  }
  catch {
    return undefined
  }
}

export function rememberConsoleSection(
  section: ConsoleSectionId,
  storage?: ConsoleSectionStorage,
): void {
  try {
    const target = storage ?? globalThis.localStorage
    target?.setItem(lastConsoleSectionStorageKey, section)
  }
  catch {
    // Browser privacy settings can disable local storage. Navigation must still work.
  }
}
