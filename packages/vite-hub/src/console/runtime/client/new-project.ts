/**
 * The "New project" page of a hosted Console. A person picks a host, features, and the options that the host needs,
 * and the page prints the `vite-hub init` command for that stack. Shareable options live in the URL query. Private
 * options stay in page memory. The one-time Console link is per browser, so it never goes in the URL.
 */

import { featureIds, features, featureSupport } from "@vite-hub/internal/features"

import type { ViteHubHost } from "@vite-hub/internal/deployment"
import type { FeatureId, HostSupport } from "@vite-hub/internal/features"
import type { ConsolePendingLinkTicket } from "./pending-links"

/** A host that `vite-hub init --host` accepts. */
export type NewProjectHost = ViteHubHost

/** The hosts that `vite-hub init --host` accepts, in its order. */
export const newProjectHosts: readonly { id: NewProjectHost, label: string }[] = [
  { id: "cloudflare", label: "Cloudflare" },
  { id: "vercel", label: "Vercel" },
  { id: "netlify", label: "Netlify" },
  { id: "deno", label: "Deno" },
  { id: "node", label: "Node.js" },
]

/** The folder name when the URL has none. */
export const newProjectDefaultDir = "my-app"

/** What the person picked. `options` maps an `--option` path, such as `kv.driver`, to its value. */
export interface NewProjectStack {
  dir: string
  host?: NewProjectHost
  /** The features that the person turned on, in catalog order. Implied features are not in this list. */
  features: readonly FeatureId[]
  options: Readonly<Record<string, string>>
}

/** An option for a feature on the chosen host, as `--option <path>=<value>`. */
export interface NewProjectOptionInput {
  feature: FeatureId
  /** The `--option` path, such as `email.driver`. */
  path: string
  /** The values that the option accepts. Without them the person types the value. */
  choices?: readonly [string, ...string[]]
  placeholder?: string
  /** An empty value uses the feature default. */
  optional?: boolean
  /** The value can contain credentials. Keep it in page memory, out of the shareable query. */
  private?: boolean
  /** Why the option is needed, from the feature catalog when the host is `explicit`. */
  detail: string
}

/** How a feature shows on the page for the chosen host. */
export type NewProjectFeatureState =
  /** Always on in this new-project flow, such as Env and Console. */
  | { kind: "default" }
  | { kind: "off" }
  | { kind: "on" }
  /** Another feature, or an option value, turns it on. `by` lists the features that do. */
  | { kind: "implied", by: readonly FeatureId[] }

export interface NewProjectFeature {
  id: FeatureId
  title: string
  summary: string
  /** Undefined until the person picks a host. */
  support?: HostSupport
  state: NewProjectFeatureState
}

/** What is wrong with the stack. Each problem names the field that fixes it. */
export type NewProjectProblem =
  | { field: "dir", message: string }
  | { field: "host", message: string }
  | { field: "features", feature: FeatureId, message: string }
  | { field: "option", path: string, message: string }

export interface NewProjectPlan {
  features: readonly NewProjectFeature[]
  /** The options for the turned-on features on the host, in catalog order. */
  options: readonly NewProjectOptionInput[]
  problems: readonly NewProjectProblem[]
}

/**
 * What `--option` takes for an option path, where the catalog does not say. It mirrors `optionChoices` and the required
 * options of `vitehub add` in `packages/cli/src/setup/add.ts`. An option whose value is an object, such as
 * `database.connection`, asks for one key of it.
 */
const optionInputs: Readonly<Record<string, Omit<NewProjectOptionInput, "detail" | "feature">>> = {
  "blob.driver": { path: "blob.driver", choices: ["s3"] },
  "cache.driver": { path: "cache.driver", choices: ["kv"] },
  "database.connection": { path: "database.connection.url", placeholder: "libsql://my-db.example.com", private: true },
  "email.driver": { path: "email.driver", choices: ["resend"] },
  "kv.driver": { path: "kv.driver", choices: ["upstash"] },
  "realtime.authority": { path: "realtime.authority", choices: ["memory"] },
  "workflow.provider": { path: "workflow.provider", choices: ["openworkflow"] },
  "workspace.store": { path: "workspace.store.provider", choices: ["github"] },
}

/** An option value that turns on another feature, such as `cache.driver=kv`. */
const optionRequires: Readonly<Record<string, { value: string, feature: FeatureId }>> = {
  "cache.driver": { value: "kv", feature: "kv" },
}

/** Feature options beyond the `explicit` option of the catalog. */
function featureInputs(id: FeatureId, host: NewProjectHost, dir: string): NewProjectOptionInput[] {
  if (id === "blob" && host === "deno") return [{ feature: id, path: "blob.bucket", placeholder: "app-assets", detail: "The bucket in your S3-compatible store." }]
  if (id === "observability") return [
    { feature: id, path: "observability.service", optional: true, placeholder: packageNameOf(dir), detail: "Set a service name to enable Agent telemetry." },
    { feature: id, path: "observability.logs.source", optional: true, placeholder: "./server/logs.ts", detail: "A Logs source for the Console. It works without Agent telemetry." },
  ]
  if (id === "schedule" && host === "node") return [{ feature: id, path: "schedule.runtime.driver", choices: ["process"], detail: "A Node server runs Schedules in its own process." }]
  if (id === "workspace" && (host === "deno" || host === "netlify")) return [{ feature: id, path: "workspace.store.repository", placeholder: "owner/repo", detail: "The GitHub repository that stores your Workspaces." }]
  return []
}

/** The options for `id` on `host`. */
function inputsOf(id: FeatureId, host: NewProjectHost, dir: string): NewProjectOptionInput[] {
  const support = featureSupport(id, host)
  const inputs = featureInputs(id, host, dir)
  if (support.level !== "explicit") return inputs
  const known = Object.hasOwn(optionInputs, support.option) ? optionInputs[support.option] : { path: support.option }
  return [{ feature: id, ...known, detail: support.detail }, ...inputs]
}

/** The package name that `vite-hub init` derives from the folder. */
function packageNameOf(dir: string): string {
  return dir.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "vitehub-app"
}

const dirPattern = /^[A-Za-z0-9][\w.-]*$/

/** Why `dir` cannot be the folder of `vite-hub init`, or undefined. */
export function newProjectDirProblem(dir: string): string | undefined {
  if (!dir) return "Enter a folder name, such as my-app."
  if (dir.length > 100) return "Use 100 characters or fewer."
  if (!dirPattern.test(dir)) return "Use letters, digits, dots, dashes, and underscores, and start with a letter or digit, such as my-app."
  return undefined
}

/**
 * The features that `on` turns on, with the features that turn on each. It follows the catalog implications, as
 * `impliedFeatures()` does, and option values that need a feature, such as `cache.driver=kv`. Without a host it ignores
 * the hosts where an implication does not apply.
 */
export function newProjectImplied(on: readonly FeatureId[], host: NewProjectHost | undefined, options: NewProjectStack["options"] = {}): Map<FeatureId, FeatureId[]> {
  const implied = new Map<FeatureId, FeatureId[]>()
  const enabled = new Set(on)
  const pending = [...on]
  const add = (id: FeatureId, by: FeatureId): void => {
    const list = implied.get(id)
    if (list) {
      if (!list.includes(by)) list.push(by)
      return
    }
    if (enabled.has(id)) return
    implied.set(id, [by])
    enabled.add(id)
    pending.push(id)
  }
  while (pending.length) {
    const id = pending.shift()!
    for (const implication of features[id].implies) {
      if (host && implication.except?.includes(host)) continue
      add(implication.feature, id)
    }
    if (!host) continue
    const support = featureSupport(id, host)
    if (support.level !== "explicit") continue
    const requires = optionRequires[support.option]
    const path = Object.hasOwn(optionInputs, support.option) ? optionInputs[support.option].path : support.option
    if (requires && options[path] === requires.value) add(requires.feature, id)
  }
  return implied
}

/** The page state for a stack: every feature with its state on the host, the options to ask for, and the problems. */
export function planNewProject(stack: NewProjectStack): NewProjectPlan {
  const { host } = stack
  const on = stack.features.filter(id => !features[id].enabledByDefault)
  const implied = newProjectImplied(on, host, stack.options)
  const problems: NewProjectProblem[] = []
  const dirProblem = newProjectDirProblem(stack.dir)
  if (dirProblem) problems.push({ field: "dir", message: dirProblem })
  if (!host) problems.push({ field: "host", message: "Pick the host that runs the app." })

  const rows = featureIds.map((id): NewProjectFeature => {
    const definition = features[id]
    const support = host ? featureSupport(id, host) : undefined
    const by = implied.get(id)
    const state: NewProjectFeatureState = definition.enabledByDefault || id === "console"
      ? { kind: "default" }
      : on.includes(id) ? { kind: "on" } : by ? { kind: "implied", by } : { kind: "off" }
    return { id, title: definition.title, summary: definition.summary, state, ...(support ? { support } : {}) }
  })

  const options: NewProjectOptionInput[] = []
  if (host) {
    const label = newProjectHosts.find(entry => entry.id === host)!.label
    for (const row of rows) {
      if (row.state.kind !== "on" && row.state.kind !== "implied") continue
      if (row.support?.level === "unsupported") {
        const message = row.state.kind === "on"
          ? `${row.title} is not available on ${label}. Turn it off, or pick another host.`
          : `${row.title} is not available on ${label}, and ${row.state.by.map(by => features[by].title).join(", ")} turns it on. Turn that off, or pick another host.`
        problems.push({ field: "features", feature: row.id, message })
        continue
      }
      for (const input of inputsOf(row.id, host, stack.dir)) {
        options.push(input)
        const value = stack.options[input.path]?.trim() ?? ""
        if (!value && input.optional) continue
        if (!value) problems.push({ field: "option", path: input.path, message: input.choices ? `Choose a value for ${input.path}.` : `Enter a value for ${input.path}.` })
        else if (input.choices && !input.choices.includes(value)) problems.push({ field: "option", path: input.path, message: `${input.path} must be ${input.choices.join(" or ")}.` })
        else if (/[\r\n]/.test(value)) problems.push({ field: "option", path: input.path, message: `${input.path} must be one line.` })
      }
    }
  }
  return { features: rows, options, problems }
}

/**
 * The stack with the value of each option that has one choice, so a person does not pick the only value. A filled value
 * can turn on another feature with options of its own, such as `cache.driver=kv`, so it fills until nothing changes.
 */
export function withNewProjectDefaults(stack: NewProjectStack): NewProjectStack {
  let next = stack
  for (;;) {
    const defaults: Record<string, string> = {}
    for (const input of planNewProject(next).options) {
      if (input.choices?.length === 1 && !next.options[input.path]) defaults[input.path] = input.choices[0]
    }
    if (!Object.keys(defaults).length) return next
    next = { ...next, options: { ...next.options, ...defaults } }
  }
}

function isFeatureId(value: string): value is FeatureId {
  return featureIds.some(id => id === value)
}

function isHost(value: string | null): value is NewProjectHost {
  return newProjectHosts.some(host => host.id === value)
}

function isPrivateOption(path: string): boolean {
  return Object.values(optionInputs).some(input => input.path === path && input.private)
}

/**
 * Read the stack from the query of the page, such as
 * `?host=vercel&features=kv,email&option=email.driver%3Dresend&dir=shop`. Unknown hosts and features, and private options,
 * are dropped.
 */
export function readNewProjectQuery(search: string): NewProjectStack {
  const params = new URLSearchParams(search)
  const host = params.get("host")
  const picked = new Set((params.get("features") ?? "").split(",").map(item => item.trim()).filter(isFeatureId))
  const options: Record<string, string> = {}
  for (const option of params.getAll("option")) {
    const separator = option.indexOf("=")
    if (separator > 0 && !isPrivateOption(option.slice(0, separator))) options[option.slice(0, separator)] = option.slice(separator + 1)
  }
  return {
    dir: params.get("dir") ?? newProjectDefaultDir,
    ...(isHost(host) ? { host } : {}),
    features: featureIds.filter(id => picked.has(id)),
    options,
  }
}

/**
 * The query for a stack, with `?`, or `""` for an empty stack. It keeps only the non-private options that the plan asks
 * for, so a shared URL carries no credentials or values of another host.
 */
export function newProjectQuery(stack: NewProjectStack, plan: NewProjectPlan = planNewProject(stack)): string {
  const params = new URLSearchParams()
  if (stack.dir !== newProjectDefaultDir) params.set("dir", stack.dir)
  if (stack.host) params.set("host", stack.host)
  if (stack.features.length) params.set("features", stack.features.join(","))
  for (const input of plan.options) {
    const value = stack.options[input.path]
    if (value && !input.private) params.append("option", `${input.path}=${value}`)
  }
  const query = params.toString()
  return query ? `?${query}` : ""
}

/** Quotes `value` for a POSIX shell when it needs quotes, as `vite-hub init` prints its commands. */
export function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`
}

/**
 * The `vite-hub init` command for a stack, as groups of a flag and its value, or undefined while the plan has problems.
 * Console with token auth is always enabled so every stack can complete its one-time link.
 * With a ticket it adds `--console <pendingId>:sha256:<verifier>`. The ticket holds no secret: the key stays in this
 * browser. The groups join with spaces into the command; the page wraps lines only between them.
 */
export function newProjectCommandParts(stack: NewProjectStack, ticket?: ConsolePendingLinkTicket, plan: NewProjectPlan = planNewProject(stack)): string[] | undefined {
  if (plan.problems.length || !stack.host) return undefined
  const consoleValue = ticket ? `${ticket.pendingId}:sha256:${ticket.verifier}` : undefined
  return [
    `pnpm dlx vite-hub init ${shellQuote(stack.dir)}`,
    `--host ${stack.host}`,
    `--features ${["console", ...stack.features.filter(id => id !== "console" && !features[id].enabledByDefault)].join(",")}`,
    "--option console.auth=token",
    ...plan.options.filter(input => stack.options[input.path]?.trim()).map(input => `--option ${shellQuote(`${input.path}=${stack.options[input.path]!.trim()}`)}`),
    // A value that starts with a dash would read as a flag, so it goes after `=`.
    ...(consoleValue ? [consoleValue.startsWith("-") ? `--console=${consoleValue}` : `--console ${consoleValue}`] : []),
    "--yes",
  ]
}

/** The `vite-hub init` command for a stack, or undefined while the plan has problems. See `newProjectCommandParts()`. */
export function newProjectCommand(stack: NewProjectStack, ticket?: ConsolePendingLinkTicket, plan: NewProjectPlan = planNewProject(stack)): string | undefined {
  return newProjectCommandParts(stack, ticket, plan)?.join(" ")
}

/** How many features a host can run, for the host picker. */
export function newProjectHostFeatureCount(host: NewProjectHost): number {
  return featureIds.filter(id => featureSupport(id, host).level !== "unsupported").length
}

/**
 * A prompt that starts the project from a coding agent: run the command and deploy. The person opens the link that the
 * CLI prints, because the one-time link works only in this browser.
 */
export function newProjectPrompt(stack: NewProjectStack, ticket: ConsolePendingLinkTicket, plan: NewProjectPlan = planNewProject(stack)): string | undefined {
  const command = newProjectCommand(stack, ticket, plan)
  if (!command) return undefined
  return [
    `Create a ViteHub app in the folder ${stack.dir}.`,
    "",
    "1. Run this command. It creates the app and prepares its ViteHub Console link:",
    "",
    command,
    "",
    stack.host === "node"
      ? `2. Open the app folder and deploy the Node.js app with VITEHUB_CONSOLE_TOKEN_SHA256 set to ${ticket.verifier}. Give me https://console.vitehub.dev/link#p=${encodeURIComponent(ticket.pendingId)}&url=<app-origin>, replacing <app-origin> with the URL-encoded origin of the deployed app. I open that link in my browser to link the app.`
      : "2. Open the app folder and run pnpm vitehub deploy. This sets up the Console key and prints a link. Give me that link. I open it in my browser to link the app.",
  ].join("\n")
}
