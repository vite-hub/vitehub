import type { PrimitiveIconName } from "@vite-hub/ui/primitive-rail"

/** Sections that the Console UI in `vite-hub` renders with its own components. Owner packages contribute the others. */
export const consoleBuiltinSectionIds = ["env", "connections", "agents", "usage", "blob", "databases", "kv"] as const

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
  env: { description: "Inspect Server Env declarations and their providers.", icon: "i-ph-key-light", label: "Env", routeName: "vitehub-console-env" },
  connections: {
    description: "Inspect and manage app-owned OAuth Connections.",
    icon: "i-ph-plugs-connected-light",
    label: "Connections",
    routeName: "vitehub-console-connections",
  },
  agents: {
    description: "Inspect Agent sessions and invocation details.",
    icon: "i-ph-robot-light",
    label: "Agents",
    routeName: "vitehub-console-agents",
  },
  usage: {
    description: "Review token use and cost evidence over time.",
    icon: "i-ph-chart-bar-light",
    label: "Usage",
    routeName: "vitehub-console-usage",
  },
  blob: {
    description: "Inspect configured Blob stores and object metadata without downloading contents.",
    icon: "i-lucide-file-box",
    label: "Blob",
    routeName: "vitehub-console-blob",
  },
  databases: {
    description: "Inspect discovered Database Definitions and static schema metadata.",
    icon: "i-lucide-database",
    label: "Databases",
    routeName: "vitehub-console-databases",
  },
  kv: {
    description: "Inspect configured KV stores without changing data.",
    icon: "i-lucide-book-key",
    label: "KV",
    routeName: "vitehub-console-kv",
  },
}

/** Navigation groups in rail order. A contributed section with an unknown id goes to `more`. */
export const consoleSectionGroupIds = ["agents", "data", "runtime", "platform", "more"] as const

export type ConsoleSectionGroupId = (typeof consoleSectionGroupIds)[number]

const consoleSectionGroupBySection: Readonly<Record<string, ConsoleSectionGroupId>> = {
  agents: "agents",
  usage: "agents",
  databases: "data",
  kv: "data",
  blob: "data",
  workspaces: "data",
  workflows: "runtime",
  queues: "runtime",
  schedules: "runtime",
  sandboxes: "runtime",
  env: "platform",
  connections: "platform",
  email: "platform",
  "rate-limits": "platform",
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

/** Splits enabled sections into navigation groups. Keeps the given order inside each group and drops empty groups. */
export function groupConsoleSections<T extends { id: ConsoleSectionId }>(sections: readonly T[]): T[][] {
  return consoleSectionGroupIds
    .map(group => sections.filter(section => resolveConsoleSectionGroup(section.id) === group))
    .filter(group => group.length > 0)
}

const consoleDocsBase = "https://vitehub.dev/docs"

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
  primitive("env", "Env", consoleSectionDetails.env.icon, "env", "Declare public, build-time, server runtime, and secret values behind typed accessors."),
  primitive("connections", "Connections", consoleSectionDetails.connections.icon, "connections", "Connect provider accounts with OAuth 2 or an API key and call their APIs with access rules."),
  primitive("agents", "Agents", consoleSectionDetails.agents.icon, "agents", "Define a server-side Agent, choose how it runs, and connect it to your application.", "getting-started/first-agent"),
  primitive("usage", "Usage", consoleSectionDetails.usage.icon, "development/console", "Review the token use and cost that Agent Invocations record.", "agents"),
  primitive("blob", "Blob", consoleSectionDetails.blob.icon, "blob", "Store uploads, generated files, binary objects, and metadata with one object-storage API."),
  primitive("databases", "Databases", consoleSectionDetails.databases.icon, "database", "Define relational data with Drizzle and query it through generated imports."),
  primitive("email", "Email", "i-lucide-mail", "email", "Send transactional email through a provider-neutral driver, with safe test capture."),
  primitive("kv", "KV", consoleSectionDetails.kv.icon, "kv", "Store and read small values by key through one key-value API."),
  primitive("rate-limits", "Rate Limits", "i-lucide-gauge", "rate-limit", "Require request budgets through an H3 guard and atomic drivers."),
  primitive("sandboxes", "Sandboxes", "i-lucide-container", "sandbox", "Run named package projects in an isolated Cloudflare or Vercel Sandbox."),
  primitive("workspaces", "Workspaces", "i-lucide-folder-kanban", "workspace", "Build persistent file-tree state with rules, Source Bindings, snapshots, and diffs."),
  primitive("workflows", "Workflows", "i-ph-git-branch-light", "workflows", "Start provider-tracked long-running work with run ids, durable state, and steps."),
  primitive("queues", "Queues", "i-ph-tray-light", "queue", "Define Queue Definitions, enqueue jobs, and choose a Cloudflare or Vercel provider."),
  primitive("schedules", "Schedules", "i-lucide-calendar-clock", "schedule", "Declare static cron schedules and manage recurring Runtime Schedules."),
]

/** Guides that the Overview links next to the primitives. */
export const consoleGuides: readonly { readonly description: string, readonly href: string, readonly icon: string, readonly label: string }[] = [
  { description: "Enable the Console, inspect primitives, and protect its routes.", href: `${consoleDocsBase}/development/console`, icon: "i-lucide-book-open", label: "Console guide" },
  { description: "Add local KV to a small Vite server and return one stored value.", href: `${consoleDocsBase}/getting-started/first-server-primitive`, icon: "i-lucide-rocket", label: "First Server Primitive" },
  { description: "Vue components for chat, Agent Invocations, traces, diffs, and file trees.", href: `${consoleDocsBase}/ui`, icon: "i-lucide-blocks", label: "UI kit" },
  { description: "Run package-owned development workflows through the local Vite config.", href: `${consoleDocsBase}/development/cli`, icon: "i-lucide-terminal", label: "CLI" },
]

/** Returns the documentation link of a section, or undefined for a contributed section that the Console does not know. */
export function resolveConsoleSectionDocs(section: ConsoleSectionId): string | undefined {
  return consolePrimitives.find(entry => entry.id === section)?.docs
}

/** Rail icon of each known section. A contributed section with an unknown id uses the icon from its descriptor. */
export const consoleSectionRailIcons: Readonly<Record<string, PrimitiveIconName>> = {
  agents: "agent",
  usage: "usage",
  databases: "database",
  kv: "kv",
  blob: "blob",
  workspaces: "workspace",
  workflows: "workflow",
  queues: "queue",
  schedules: "schedule",
  sandboxes: "sandbox",
  env: "env",
  connections: "connection",
  email: "email",
  "rate-limits": "rate-limit",
}

/** Returns the rail icon of a known section, or undefined for a contributed section that the Console does not know. */
export function consoleSectionRailIcon(section: ConsoleSectionId): PrimitiveIconName | undefined {
  return Object.hasOwn(consoleSectionRailIcons, section) ? consoleSectionRailIcons[section] : undefined
}

/** First key of every "Go to" chord, as in Linear and GitHub. */
export const consoleGoToKey = "g"

/** Keys that open the Overview: `g` and then `o`. */
export const consoleOverviewShortcut: readonly [typeof consoleGoToKey, "o"] = [consoleGoToKey, "o"]

/** Second key of the "Go to" chord of each known section. Each key is unique and is not `o`. */
export const consoleSectionShortcutKeys: Readonly<Record<string, string>> = {
  agents: "a",
  usage: "u",
  databases: "d",
  kv: "k",
  blob: "b",
  workspaces: "w",
  workflows: "f",
  queues: "q",
  schedules: "s",
  sandboxes: "x",
  env: "e",
  connections: "c",
  email: "m",
  "rate-limits": "r",
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
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Section ids come from untrusted JSON and browser storage.
  return typeof value === "string" && consoleSectionIdPattern.test(value)
}

export function isConsoleBuiltinSectionId(value: unknown): value is ConsoleBuiltinSectionId {
  return consoleBuiltinSectionIds.some(section => section === value)
}

/** Connections management is mounted for development Consoles and explicit production management. */
export function isConsoleConnectionsEnabled(options: { connections?: unknown }, development = false): boolean {
  const connections = options.connections
  if (!connections) return false
  if (development) return true
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Options cross the host boundary as unknown values.
  if (typeof connections !== "object" || connections === null) return false
  return "management" in connections && Boolean(connections.management)
}

/** Route name of a contributed section. The Console serves it at `/_vitehub/<id>`. */
export function consoleSectionRouteName(section: ConsoleSectionId): string {
  return `vitehub-console-${section}`
}

/**
 * Returns the enabled section ids in navigation order. Owner packages contribute `rate-limits`, `sandboxes`,
 * `workspaces`, `workflows`, `queues`, and `schedules`. `console/contributions.ts` maps each id to its owner.
 */
export function resolveConsoleSectionIds(options: { env?: unknown; connections?: unknown; agent?: unknown; blob?: unknown; database?: unknown; email?: unknown; kv?: unknown; preset?: unknown; queue?: unknown; rateLimit?: unknown; sandbox?: unknown; schedule?: unknown; workflow?: unknown; workspace?: unknown }): ConsoleSectionId[] {
  const workflowEnabled = options.workflow !== false
    && Boolean(options.workflow || (options.agent && options.preset !== "netlify"))
  return [
    ...(options.env ? ["env"] : []),
    ...(options.connections ? ["connections"] : []),
    ...(options.agent ? ["agents", "usage"] : []),
    ...(options.blob ? ["blob"] : []),
    ...(options.database ? ["databases"] : []),
    ...(options.email ? ["email"] : []),
    ...(options.kv ? ["kv"] : []),
    ...(options.rateLimit ? ["rate-limits"] : []),
    ...(options.sandbox ? ["sandboxes"] : []),
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
