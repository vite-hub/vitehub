import { defineCapability } from "../capability-runtime.ts"
import { defineInternalTool } from "./internal.ts"
import { isRuntimeRecord } from "../internal/runtime-type.ts"
import { createPapercutIndex, type PapercutIndex, type PapercutOccurrence } from "./papercut-index.ts"

import type {
  AgentCapabilityCliContribution,
  AgentCapabilityDefinition,
  AgentCapabilityRuntimeContext,
  AgentHostIdentity,
  AgentRunMetadata,
  AgentRuntimeConfig,
  AgentToolSchema,
  MaybePromise,
} from "../types.ts"
import type { TraceContext } from "@vite-hub/runtime"
import type { WorkspaceName } from "@vite-hub/workspace"

export type PapercutSource = "cli" | "tool"

export type PapercutSeverity = "low" | "medium" | "high" | "critical"

export interface PapercutBackend<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> {
  report: (event: PapercutReportEvent<TRuntimeConfig, Name>) => MaybePromise<void>
}

export interface PosthogPapercutsOptions {
  apiKey: string
  host?: string
  distinctId?: string
  projectApiKey?: string
  fetch?: typeof globalThis.fetch
}

export interface Papercut {
  agent?: AgentHostIdentity
  createdAt: string
  id: string
  message: string
  title?: string
  description?: string
  severity?: PapercutSeverity
  category?: string
  consoleUrl?: string
  sourceMetadata?: Record<string, unknown>
  reproduction?: string
  run?: AgentRunMetadata
  source: PapercutSource
  trace?: TraceContext
}

export type PapercutReportContext<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> = Omit<AgentCapabilityRuntimeContext<TRuntimeConfig, Name>, "fs" | "workspace"> & {
  fs?: AgentCapabilityRuntimeContext<TRuntimeConfig, Name>["fs"]
  workspace?: AgentCapabilityRuntimeContext<TRuntimeConfig, Name>["workspace"]
}

export interface PapercutReportEvent<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> {
  context: PapercutReportContext<TRuntimeConfig, Name>
  papercut: Papercut
}

export interface PapercutsOptions<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> {
  cli?: boolean
  report?: (event: PapercutReportEvent<TRuntimeConfig, Name>) => MaybePromise<void>
  backend?: PapercutBackend<TRuntimeConfig, Name>
  retry?: { attempts?: number, delayMs?: number }
  /** Count repeats of a recent similar report instead of reporting them again. Defaults to an in-memory index. */
  dedupe?: boolean | PapercutIndex
}

interface PapercutInput {
  message: string
}

type PapercutResult =
  | { id: string, reported: true }
  | { id: string, reported: false, count: number, since: string, message: string }

const maxMessageLength = 1000
const reportDescription = "Report a problem outside your control that cost you work: a tool, command, or service that failed or is missing, a missing permission, or guidance that is missing, wrong, or out of date. Do not report your own mistakes, such as a wrong flag, a bad patch, or a typo, and do not report expected results, such as a failing test you are fixing or a push that needs a rebase. Report each problem once. When the result says the problem is already known, do not report it again and continue the task. In one or two sentences, say what failed and what you did instead. Never include secrets or customer data."
const papercutInputSchema: AgentToolSchema<PapercutInput> = {
  additionalProperties: false,
  properties: {
    message: {
      description: "One or two sentences describing what you were doing and what got in the way.",
      maxLength: maxMessageLength,
      minLength: 1,
      type: "string",
    },
  },
  required: ["message"],
  type: "object",
}

function createPapercutId(): string {
  const random = globalThis.crypto?.randomUUID?.().replace(/-/g, "") || Math.random().toString(36).slice(2)
  return `papercut_${random}`
}

function normalizePapercutMessage(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError("[vitehub] report_papercut requires a non-empty message.")
  }
  const message = value.trim()
  if (message.length > maxMessageLength) {
    throw new TypeError(`[vitehub] report_papercut message must be at most ${maxMessageLength} characters.`)
  }
  return message
}

function createPapercut(
  context: AgentCapabilityRuntimeContext,
  message: string,
  source: PapercutSource,
): Papercut {
  return {
    ...(context.agentIdentity ? { agent: { ...context.agentIdentity } } : {}),
    createdAt: new Date().toISOString(),
    id: createPapercutId(),
    message,
    ...(context.run ? { run: { ...context.run } } : {}),
    source,
    ...(context.trace ? { trace: { ...context.trace } } : {}),
  }
}

interface PapercutSubmission {
  papercut: Papercut
  known?: PapercutOccurrence
}

async function submitPapercut<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(
  options: PapercutsOptions<TRuntimeConfig, Name>,
  index: PapercutIndex | undefined,
  context: AgentCapabilityRuntimeContext<TRuntimeConfig, Name>,
  value: unknown,
  source: PapercutSource,
): Promise<PapercutSubmission> {
  const papercut = createPapercut(context, normalizePapercutMessage(value), source)
  const report = options.report || options.backend?.report
  if (!report) throw new TypeError("[vitehub] papercuts() requires a report callback or backend.")
  const occurrence = await index?.record(papercut)
  if (occurrence && occurrence.count > 1) return { papercut, known: occurrence }
  if (options.report) {
    try { await options.report({ context, papercut }) }
    catch (error) { await index?.forget(papercut.id); throw error }
    return { papercut }
  }
  const attempts = Math.max(1, options.retry?.attempts ?? 3)
  const delayMs = Math.max(0, options.retry?.delayMs ?? 100)
  const deliver = async () => {
    let failure: unknown
    for (let attempt = 0; attempt < attempts; attempt++) {
      try { await report({ context, papercut }); return }
      catch (error) { failure = error; if (attempt + 1 < attempts && delayMs) await new Promise(resolve => setTimeout(resolve, delayMs * 2 ** attempt)) }
    }
    throw failure
  }
  // Backends are best effort: exhaust retries, then keep the invocation successful.
  // Awaiting the attempt makes delivery deterministic for local runtimes; hosts may
  // still attach their own durable waitUntil implementation around the capability.
  const delivered = await deliver().then(() => true, () => false)
  if (!delivered) await index?.forget(papercut.id)
  return { papercut }
}

function knownPapercutMessage(known: PapercutOccurrence): string {
  return `Already known: ${known.count} reports since ${known.firstReportedAt.slice(0, 10)}. Do not report it again. Continue the task.`
}

function papercutResult(submission: PapercutSubmission): PapercutResult {
  const { known } = submission
  if (!known) return { id: submission.papercut.id, reported: true }
  return { id: known.id, reported: false, count: known.count, since: known.firstReportedAt, message: knownPapercutMessage(known) }
}

/** PostHog issue-board backend. Delivery is fire-and-forget and never fails an invocation. */
export function posthogPapercuts(options: PosthogPapercutsOptions): PapercutBackend {
  if (!options?.apiKey) throw new TypeError("[vitehub] posthogPapercuts() requires an apiKey.")
  const send = options.fetch || globalThis.fetch
  return {
    async report({ papercut }) {
      const host = (options.host || "https://us.i.posthog.com").replace(/\/+$/, "")
      const response = await send(`${host}/capture/`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${options.apiKey}` },
        body: JSON.stringify({
          api_key: options.projectApiKey || options.apiKey,
          event: "papercut",
          distinct_id: options.distinctId || papercut.agent?.name || "vitehub-agent",
          properties: { ...papercut, $process_person_profile: false },
        }),
      })
      if (!response.ok) throw new Error(`[vitehub] PostHog papercut delivery failed (${response.status}).`)
    },
  }
}

function papercutCliMessage(input: unknown): unknown {
  if (!isRuntimeRecord(input)) return undefined
  const argv = input.argv
  if (!Array.isArray(argv) || argv.some(value => typeof value !== "string")) return undefined
  return argv.join(" ")
}

function createPapercutsCli<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(
  options: PapercutsOptions<TRuntimeConfig, Name>,
  index: PapercutIndex | undefined,
  context: AgentCapabilityRuntimeContext<TRuntimeConfig, Name>,
): AgentCapabilityCliContribution<TRuntimeConfig, Name> {
  return {
    commands: {
      report: {
        description: "Report one papercut from the current Agent Invocation.",
        effects: ["write"],
        examples: ["papercuts report \"Describe the friction.\""],
        output: { format: "text" },
        rest: true,
        async run({ input }) {
          const { known } = await submitPapercut(options, index, context, papercutCliMessage(input), "cli")
          return known ? knownPapercutMessage(known) : "Papercut reported."
        },
      },
    },
    description: "Report small friction from the current Agent Invocation.",
    name: "papercuts",
  }
}

export function papercuts<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
>(options: PapercutsOptions<TRuntimeConfig, Name>): AgentCapabilityDefinition<TRuntimeConfig, Name> {
  if (!options || (typeof options.report !== "function" && typeof options.backend?.report !== "function")) {
    throw new TypeError("[vitehub] papercuts() requires a report callback or backend.")
  }
  if (options.cli !== undefined && typeof options.cli !== "boolean") {
    throw new TypeError("[vitehub] papercuts({ cli }) must be a boolean.")
  }
  const dedupe = options.dedupe ?? true
  if (typeof dedupe !== "boolean" && (typeof dedupe?.record !== "function" || typeof dedupe.forget !== "function" || typeof dedupe.list !== "function")) {
    throw new TypeError("[vitehub] papercuts({ dedupe }) must be a boolean or a papercut index.")
  }
  const index = dedupe === true ? createPapercutIndex() : dedupe || undefined

  return defineCapability({
    id: "papercuts",
    cli: options.cli ? context => createPapercutsCli(options, index, context) : undefined,
    metadata: {
      ...(options.cli ? { cli: "papercuts" } : {}),
      tool: "report_papercut",
    },
    tools: (capabilityContext) => {
      // SAFETY: Invocation tool execution supplies the full runtime context, including capability and run metadata.
      const context = capabilityContext as AgentCapabilityRuntimeContext<TRuntimeConfig, Name>
      return {
        report_papercut: defineInternalTool<PapercutInput, PapercutResult>({
          description: reportDescription,
          inputSchema: papercutInputSchema,
          name: "report_papercut",
          async execute(input) {
            return papercutResult(await submitPapercut(options, index, context, input?.message, "tool"))
          },
        }),
      }
    },
  })
}
