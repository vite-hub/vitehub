import { defineCapability } from "../capability-runtime.ts"
import { defineInternalTool } from "./internal.ts"

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

export interface Papercut {
  agent?: AgentHostIdentity
  createdAt: string
  id: string
  message: string
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
  report: (event: PapercutReportEvent<TRuntimeConfig, Name>) => MaybePromise<void>
}

interface PapercutInput {
  message: string
}

interface PapercutResult {
  id: string
  reported: true
}

const maxMessageLength = 1000
const reportDescription = "Proactively report small friction as soon as it happens, even when non-blocking: a missed or retried tool call, confusing or undocumented setup, flaky command, stale cache, misleading error, or non-obvious gotcha. In one or two sentences, say what you were doing and what got in the way; a likely cause or fix is a bonus. Never include secrets or customer data."
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

async function submitPapercut<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(
  options: PapercutsOptions<TRuntimeConfig, Name>,
  context: AgentCapabilityRuntimeContext<TRuntimeConfig, Name>,
  value: unknown,
  source: PapercutSource,
): Promise<Papercut> {
  const papercut = createPapercut(context, normalizePapercutMessage(value), source)
  await options.report({ context, papercut })
  return papercut
}

function papercutCliMessage(input: unknown): unknown {
  if (!input || typeof input !== "object") return undefined
  const argv = (input as { argv?: unknown }).argv
  if (!Array.isArray(argv) || argv.some(value => typeof value !== "string")) return undefined
  return argv.join(" ")
}

function createPapercutsCli<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(
  options: PapercutsOptions<TRuntimeConfig, Name>,
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
          await submitPapercut(options, context, papercutCliMessage(input), "cli")
          return "Papercut reported."
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
  if (!options || typeof options.report !== "function") {
    throw new TypeError("[vitehub] papercuts() requires a report callback.")
  }
  if (options.cli !== undefined && typeof options.cli !== "boolean") {
    throw new TypeError("[vitehub] papercuts({ cli }) must be a boolean.")
  }

  return defineCapability({
    id: "papercuts",
    cli: options.cli ? context => createPapercutsCli(options, context) : undefined,
    metadata: {
      ...(options.cli ? { cli: "papercuts" } : {}),
      tool: "report_papercut",
    },
    tools: (capabilityContext) => {
      const context = capabilityContext as AgentCapabilityRuntimeContext<TRuntimeConfig, Name>
      return {
        report_papercut: defineInternalTool<PapercutInput, PapercutResult>({
          description: reportDescription,
          inputSchema: papercutInputSchema,
          name: "report_papercut",
          async execute(input) {
            const papercut = await submitPapercut(options, context, input?.message, "tool")
            return { id: papercut.id, reported: true }
          },
        }),
      }
    },
  })
}
