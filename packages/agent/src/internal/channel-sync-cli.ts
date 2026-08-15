import { join } from "node:path"

import { VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"

import { discoverAgentDefinitions } from "../discovery.ts"
import { getAgentChannelHistoryDefinition } from "./channel-history.ts"
import { getAgentChannelSyncDefinition, agentChannelSyncProviderHeader } from "./channel-sync.ts"
import { createViteAgentDiscoveryContext, loadViteAgent } from "../vite/runtime-adapter.ts"

import type { AgentChannelDefinition, DiscoveredAgentDefinition } from "../types.ts"
import type { AgentChannelSyncPlan, AgentChannelSyncProvider } from "./channel-sync.ts"

interface ChannelSyncCliContext {
  cwd: string
  env: NodeJS.ProcessEnv
  rootDir: string
  stderr: { write: (chunk: string | Uint8Array) => unknown }
  stdout: { write: (chunk: string | Uint8Array) => unknown }
}

interface ChannelSyncCliOptions {
  fetch?: typeof fetch
  loadTargets?: (input: ChannelSyncLoadInput) => Promise<LoadedChannelSyncTarget[]>
  rootDir?: string
}

interface ChannelSyncLoadInput {
  agent?: string
  channel?: string
  env: NodeJS.ProcessEnv
  rootDir: string
  stage: string
}

export interface LoadedChannelTarget {
  agent: string
  channel: string
  defaultThreadId?: string
  mode: "disabled" | "webhook"
  provider: string
  registration?: {
    id: string
    path?: string
    secretHeader?: string
    secretToken?: false | string
    signature?: string
    url?: string
  }
}

export interface LoadedChannelSyncTarget extends LoadedChannelTarget {
  sync: AgentChannelSyncProvider
}

interface ParsedChannelSyncArgs {
  agent?: string
  allowDelete: boolean
  apply: boolean
  channel?: string
  confirmOrigin?: string
  dryRun: boolean
  force: boolean
  help: boolean
  json: boolean
  origin?: string
  stage?: string
}

interface ChannelSyncResultRegistration {
  action: AgentChannelSyncPlan["action"]
  agent: string
  applied: boolean
  channel: string
  current: Record<string, unknown>
  destructive: boolean
  desired: Record<string, unknown>
  preflight: "not-required" | "verified"
  provider: string
  result?: Record<string, unknown>
  unverifiable: string[]
}

interface PlannedChannelSyncTarget {
  plan: AgentChannelSyncPlan
  preflight: ChannelSyncResultRegistration["preflight"]
  target: LoadedChannelSyncTarget
}

function sanitizedProviderState(state: Record<string, unknown>): Record<string, unknown> {
  if (typeof state.url !== "string" || !state.url) return state
  try {
    const url = new URL(state.url)
    if (!url.username && !url.password && !url.search && !url.hash && url.pathname === "/") {
      return state
    }
    return { ...state, url: `${url.origin}/[redacted]` }
  }
  catch {
    return { ...state, url: "[redacted]" }
  }
}

function sanitizedUrl(url: string): string {
  return String(sanitizedProviderState({ url }).url)
}

const defaultWebhookRoute = "/api/_vitehub/agents/[agent]/webhooks/[webhook]"

function writeChannelSyncUsage(context: ChannelSyncCliContext): void {
  context.stdout.write(
    [
      "Usage: vitehub channels sync --stage <name> --url <https-origin> [--agent <name>] [--channel <id>] [--json]",
      "       vitehub channels sync --stage <name> --url <https-origin> --apply --confirm-origin <https-origin> [--allow-delete]",
      "",
      "Inspect and synchronize provider-owned Channel webhooks for one deployed stage.",
      "The command is a dry run unless --apply is present.",
      "",
      "Options:",
      "  --stage <name>             Load stage-specific Vite environment files.",
      "  --url <https-origin>       Public origin of the deployed application.",
      "  --agent <name>             Limit synchronization to one Agent.",
      "  --channel <id>             Limit synchronization to one Channel.",
      "  --apply                    Apply the complete validated plan.",
      "  --confirm-origin <origin>  Confirm the exact deployment origin for --apply.",
      "  --allow-delete             Permit a planned provider webhook deletion.",
      "  --force                    Reapply registrations whose URL already matches.",
      "  --dry-run                  Explicitly select the default read-only mode.",
      "  --json                     Print one sanitized JSON result to stdout.",
      "  -h, --help                 Show this help.",
      "",
    ].join("\n"),
  )
}

function takeValue(args: string[], index: number, flag: string): [string, number] {
  const value = args[index + 1]
  if (!value || value.startsWith("--")) throw new TypeError(`${flag} requires a value.`)
  return [value, index + 1]
}

function parseChannelSyncArgs(args: string[]): ParsedChannelSyncArgs {
  const parsed: ParsedChannelSyncArgs = {
    allowDelete: false,
    apply: false,
    dryRun: false,
    force: false,
    help: false,
    json: false,
  }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === "-h" || arg === "--help") parsed.help = true
    else if (arg === "--allow-delete") parsed.allowDelete = true
    else if (arg === "--apply") parsed.apply = true
    else if (arg === "--dry-run") parsed.dryRun = true
    else if (arg === "--force") parsed.force = true
    else if (arg === "--json") parsed.json = true
    else if (["--agent", "--channel", "--confirm-origin", "--stage", "--url"].includes(arg)) {
      const [value, next] = takeValue(args, index, arg)
      index = next
      if (arg === "--agent") parsed.agent = value
      else if (arg === "--channel") parsed.channel = value
      else if (arg === "--confirm-origin") parsed.confirmOrigin = value
      else if (arg === "--stage") parsed.stage = value
      else parsed.origin = value
    } else throw new TypeError(`Unknown channels sync option: ${arg}`)
  }
  return parsed
}

function httpsUrlOrigin(value: string, label: string): { origin: string; url: URL } {
  let url: URL
  try {
    url = new URL(value)
  }
  catch {
    throw new TypeError(`${label} must be a valid HTTPS URL.`)
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new TypeError(`${label} must use HTTPS without credentials.`)
  }
  return { origin: url.origin, url }
}

function normalizeOrigin(value: string, flag: string): string {
  const { origin, url } = httpsUrlOrigin(value, flag)
  if (url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new TypeError(
      `${flag} must be an HTTPS origin without credentials, a path, query, or fragment.`,
    )
  }
  return origin
}

function replaceRouteParams(route: string, agent: string, webhook: string): string {
  return route
    .replaceAll("[agent]", encodeURIComponent(agent))
    .replaceAll(":agent", encodeURIComponent(agent))
    .replaceAll("[webhook]", encodeURIComponent(webhook))
    .replaceAll(":webhook", encodeURIComponent(webhook))
}

function desiredWebhookUrl(
  target: LoadedChannelTarget,
  origin: string,
  webhookRoute: false | string,
): string | undefined {
  if (target.mode === "disabled") return
  if (!target.registration)
    throw new TypeError(`Channel ${target.agent}/${target.channel} has no webhook registration.`)
  const configured = target.registration.url || target.registration.path
  const route = configured || webhookRoute
  if (!route)
    throw new TypeError(`Channel ${target.agent}/${target.channel} has no deployed webhook route.`)
  const url = new URL(replaceRouteParams(route, target.agent, target.registration.id), `${origin}/`)
  if (url.origin !== origin) {
    throw new TypeError(
      `Channel ${target.agent}/${target.channel} resolves outside the confirmed deployment origin.`,
    )
  }
  return url.toString()
}

export function deployedChannelWebhookUrl(target: LoadedChannelTarget, origin: string): string | undefined {
  return desiredWebhookUrl(target, origin, defaultWebhookRoute)
}

async function resolvedChannelValue(value: unknown, context: unknown): Promise<unknown> {
  const resolved = typeof value === "function" ? await value(context) : value
  return resolved && typeof resolved === "object" && "unseal" in resolved && typeof resolved.unseal === "function"
    ? resolved.unseal()
    : resolved
}

async function channelRegistration(
  channelId: string,
  channel: AgentChannelDefinition,
  context: unknown,
): Promise<LoadedChannelSyncTarget["registration"]> {
  const webhooks = channel.webhooks
  if (webhooks === false) return
  if (Array.isArray(webhooks)) {
    if (webhooks.length !== 1) {
      throw new TypeError(
        `Channel ${channelId} must declare exactly one webhook registration.`,
      )
    }
    const registration = webhooks[0]!
    const secretToken = await resolvedChannelValue(registration.secretToken, context)
    return {
      id: registration.id || channelId,
      ...(registration.path ? { path: registration.path } : {}),
      ...(registration.secretHeader ? { secretHeader: registration.secretHeader } : {}),
      ...(secretToken === false || typeof secretToken === "string" ? { secretToken } : {}),
      ...(registration.signature ? { signature: registration.signature } : {}),
      ...(registration.url ? { url: registration.url } : {}),
    }
  }
  if (webhooks && webhooks !== true) {
    const secretToken = await resolvedChannelValue(webhooks.secretToken, context)
    return {
      id: webhooks.id || channelId,
      ...(webhooks.path ? { path: webhooks.path } : {}),
      ...(webhooks.secretHeader ? { secretHeader: webhooks.secretHeader } : {}),
      ...(secretToken === false || typeof secretToken === "string" ? { secretToken } : {}),
      ...(webhooks.signature ? { signature: webhooks.signature } : {}),
      ...(webhooks.url ? { url: webhooks.url } : {}),
    }
  }
  return { id: channelId }
}

function uniqueAgentDefinitions(
  rootDir: string,
  serverDirs?: string[],
): DiscoveredAgentDefinition[] {
  const definitions = [
    ...discoverAgentDefinitions({ mode: "vite-suffix", rootDir }),
    ...discoverAgentDefinitions({
      mode: "server-agents",
      scanDirs: serverDirs || [join(rootDir, "server")],
    }),
  ]
  const unique = new Map<string, DiscoveredAgentDefinition>()
  for (const definition of definitions) {
    const existing = unique.get(definition.name)
    if (existing && existing.handler !== definition.handler) {
      throw new TypeError(`Duplicate Agent name "${definition.name}" cannot be synchronized.`)
    }
    unique.set(definition.name, definition)
  }
  return [...unique.values()]
}

async function loadChannelTargetsExclusive(
  input: ChannelSyncLoadInput,
  syncOnly: boolean,
): Promise<Array<LoadedChannelTarget & { sync?: AgentChannelSyncProvider }>> {
  const { createServer, loadEnv } = await import("vite")
  let server: Awaited<ReturnType<typeof createServer>> | undefined
  const previousEnvironment = new Map(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  const selectedEnvironment = new Map(
    Object.entries(input.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  try {
    for (const key of Object.keys(process.env)) delete process.env[key]
    for (const [key, value] of selectedEnvironment) process.env[key] = value
    server = await createServer({
      appType: "custom",
      logLevel: "silent",
      mode: input.stage,
      root: input.rootDir,
      server: { hmr: false, middlewareMode: true },
    })
    const environment = {
      ...loadEnv(input.stage, server.config.envDir, ""),
      ...Object.fromEntries(selectedEnvironment),
    }
    for (const [key, value] of Object.entries(environment)) {
      if (value === undefined) continue
      process.env[key] = value
    }
    const targets: Array<LoadedChannelTarget & { sync?: AgentChannelSyncProvider }> = []
    const stageRoot = server.config.root
    const stageServerDirs = (server.config as typeof server.config & {
      [VITEHUB_SERVER_DIRS]?: string[]
    })[VITEHUB_SERVER_DIRS]
    for (const definition of uniqueAgentDefinitions(stageRoot, stageServerDirs)) {
      if (input.agent && definition.name !== input.agent) continue
      const loaded = await loadViteAgent(server, definition)
      if (!loaded?.agent.channels) continue
      if (input.agent && loaded.identity.name !== input.agent) continue
      const context = createViteAgentDiscoveryContext(loaded.identity)
      for (const [channelId, channel] of Object.entries(loaded.agent.channels)) {
        if (input.channel && channelId !== input.channel) continue
        const syncDefinition = getAgentChannelSyncDefinition(channel)
        const sync = syncOnly && syncDefinition ? await syncDefinition.resolve(context, channel) : undefined
        if (syncOnly && !sync) continue
        if (!sync && (channel.messages === false || channel.adapter === undefined || channel.webhooks === false)) continue
        const provider = syncDefinition?.provider || channel.kind
        targets.push({
          agent: loaded.identity.name,
          channel: channelId,
          defaultThreadId: await getAgentChannelHistoryDefinition(channel)?.resolveDefaultThreadId?.(context, channel),
          mode: sync?.mode || "webhook",
          provider,
          registration: await channelRegistration(channelId, channel, context),
          ...(sync ? { sync } : {}),
        })
      }
    }
    return targets
  }
  finally {
    try {
      await server?.close()
    }
    finally {
      for (const key of Object.keys(process.env)) delete process.env[key]
      for (const [key, value] of previousEnvironment) {
        process.env[key] = value
      }
    }
  }
}

let channelSyncTargetLoadQueue: Promise<void> = Promise.resolve()

async function loadQueuedChannelTargets(
  input: ChannelSyncLoadInput,
  syncOnly: boolean,
): Promise<Array<LoadedChannelTarget & { sync?: AgentChannelSyncProvider }>> {
  const previous = channelSyncTargetLoadQueue
  let release!: () => void
  channelSyncTargetLoadQueue = new Promise<void>((resolve) => {
    release = resolve
  })
  await previous
  try {
    return await loadChannelTargetsExclusive(input, syncOnly)
  }
  finally {
    release()
  }
}

async function loadChannelSyncTargets(
  input: ChannelSyncLoadInput,
): Promise<LoadedChannelSyncTarget[]> {
  return await loadQueuedChannelTargets(input, true) as LoadedChannelSyncTarget[]
}

export async function loadChannelTargets(input: ChannelSyncLoadInput): Promise<LoadedChannelTarget[]> {
  return await loadQueuedChannelTargets(input, false)
}

async function verifyDeployedWebhook(
  url: string,
  provider: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  let response: Response
  try {
    response = await fetchImpl(url, {
      method: "HEAD",
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    })
  }
  catch {
    throw new Error(`Deployed webhook preflight request failed for ${sanitizedUrl(url)}.`)
  }
  if (!response.ok || response.headers.get(agentChannelSyncProviderHeader) !== provider) {
    throw new Error(
      `Deployed webhook preflight failed for ${sanitizedUrl(url)}; expected ${agentChannelSyncProviderHeader}: ${provider}.`,
    )
  }
}

function writeHumanResult(
  result: {
    mode: "apply" | "dry-run"
    origin: string
    registrations: ChannelSyncResultRegistration[]
    stage: string
  },
  context: ChannelSyncCliContext,
): void {
  context.stdout.write(
    `Channel sync ${result.mode} for stage ${result.stage} at ${result.origin}\n`,
  )
  for (const registration of result.registrations) {
    context.stdout.write(
      `  ${registration.agent}/${registration.channel} (${registration.provider}): ${registration.action}${registration.applied ? " applied" : ""}\n`,
    )
    context.stdout.write(
      `    Current URL: ${typeof registration.current.url === "string" && registration.current.url ? registration.current.url : "<none>"}\n`,
    )
    context.stdout.write(
      `    Desired URL: ${typeof registration.desired.url === "string" && registration.desired.url ? registration.desired.url : "<none>"}\n`,
    )
    context.stdout.write(`    Deployed route: ${registration.preflight}\n`)
    if (registration.unverifiable.length) {
      context.stdout.write(`    Provider cannot verify: ${registration.unverifiable.join(", ")}\n`)
    }
  }
}

export async function runAgentChannelSyncCli(
  args: string[],
  context: ChannelSyncCliContext,
  options: ChannelSyncCliOptions = {},
): Promise<number> {
  let parsed: ParsedChannelSyncArgs
  try {
    parsed = parseChannelSyncArgs(args)
    if (parsed.help) {
      writeChannelSyncUsage(context)
      return 0
    }
    if (!parsed.stage) throw new TypeError("channels sync requires --stage <name>.")
    if (!parsed.origin) throw new TypeError("channels sync requires --url <https-origin>.")
    if (parsed.apply && parsed.dryRun)
      throw new TypeError("--apply and --dry-run cannot be used together.")
    const origin = normalizeOrigin(parsed.origin, "--url")
    if (parsed.apply) {
      if (!parsed.confirmOrigin)
        throw new TypeError("--apply requires --confirm-origin <https-origin>.")
      const confirmedOrigin = normalizeOrigin(parsed.confirmOrigin, "--confirm-origin")
      if (confirmedOrigin !== origin)
        throw new TypeError("--confirm-origin must exactly match --url.")
    }

    const loadTargets = options.loadTargets || loadChannelSyncTargets
    const allTargets = await loadTargets({
      agent: parsed.agent,
      channel: parsed.channel,
      env: context.env,
      rootDir: options.rootDir || context.rootDir,
      stage: parsed.stage,
    })
    const targets = allTargets.filter(
      (target) =>
        (!parsed.agent || target.agent === parsed.agent) &&
        (!parsed.channel || target.channel === parsed.channel),
    )
    if (!targets.length)
      throw new Error("No synchronizable Channels matched the selected Agent and Channel filters.")

    const providerResources = new Map<unknown, LoadedChannelSyncTarget>()
    for (const target of targets) {
      if (target.sync.resourceKey === undefined) continue
      const existing = providerResources.get(target.sync.resourceKey)
      if (existing) {
        throw new Error(
          `Channels ${existing.agent}/${existing.channel} and ${target.agent}/${target.channel} target the same ${target.provider} resource.`,
        )
      }
      providerResources.set(target.sync.resourceKey, target)
    }

    const fetchImpl = options.fetch || globalThis.fetch
    const planned: PlannedChannelSyncTarget[] = []
    for (const target of targets) {
      const desiredUrl = desiredWebhookUrl(target, origin, defaultWebhookRoute)
      if (desiredUrl) await verifyDeployedWebhook(desiredUrl, target.provider, fetchImpl)
      const plan = await target.sync.plan({ desiredUrl, fetch: fetchImpl, force: parsed.force })
      planned.push({ plan, preflight: desiredUrl ? "verified" : "not-required", target })
    }
    const deletions = planned.filter((item) => item.plan.action === "delete")
    if (parsed.apply) for (const item of planned) {
      if (item.plan.action !== "delete" && item.plan.action !== "update") continue
      const currentUrl =
        typeof item.plan.current.url === "string" ? item.plan.current.url : ""
      if (currentUrl) {
        const currentOrigin = httpsUrlOrigin(currentUrl, "current provider webhook URL").origin
        if (currentOrigin !== origin) {
          throw new Error(
            `Channel ${item.target.agent}/${item.target.channel} ${item.plan.action} targets ${currentOrigin}, which does not match the confirmed deployment origin ${origin}.`,
          )
        }
      }
    }
    const deletion = deletions[0]
    if (parsed.apply && deletion && !parsed.allowDelete) {
      throw new Error(
        `Channel ${deletion.target.agent}/${deletion.target.channel} requires deletion; rerun with --allow-delete after reviewing the plan.`,
      )
    }

    const registrations: ChannelSyncResultRegistration[] = []
    for (const item of planned) {
      const result = parsed.apply ? await item.target.sync.apply(item.plan, fetchImpl) : undefined
      if (result) {
        const expectedUrl =
          typeof item.plan.desired.url === "string" ? item.plan.desired.url : undefined
        const resultUrl = typeof result.url === "string" ? result.url : undefined
        if (expectedUrl !== undefined && resultUrl !== expectedUrl) {
          throw new Error(
            `Provider verification failed for ${item.target.agent}/${item.target.channel}; expected webhook URL ${expectedUrl ? sanitizedUrl(expectedUrl) : "<empty>"}.`,
          )
        }
      }
      registrations.push({
        action: item.plan.action,
        agent: item.target.agent,
        applied: parsed.apply && item.plan.action !== "none",
        channel: item.target.channel,
        current: sanitizedProviderState(item.plan.current),
        destructive: item.plan.destructive === true,
        desired: item.target.registration?.url || item.target.registration?.path
          ? sanitizedProviderState(item.plan.desired)
          : item.plan.desired,
        preflight: item.preflight,
        provider: item.target.provider,
        ...(result ? { result: sanitizedProviderState(result) } : {}),
        unverifiable: item.plan.unverifiable || [],
      })
    }
    const output = {
      mode: parsed.apply ? ("apply" as const) : ("dry-run" as const),
      origin,
      registrations,
      schemaVersion: 1,
      stage: parsed.stage,
    }
    if (parsed.json) context.stdout.write(`${JSON.stringify(output)}\n`)
    else writeHumanResult(output, context)
    return 0
  }
  catch (error) {
    context.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}
