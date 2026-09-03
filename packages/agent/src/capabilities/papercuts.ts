import { defineCapability } from "../capability-runtime.ts"
import { hasRuntimeType } from "../internal/runtime-type.ts"
import { defineInternalTool } from "./internal.ts"

import type {
  AgentCapabilityDefinition,
  AgentCapabilityRuntimeContext,
  AgentRuntimeConfig,
  AgentToolSchema,
  MaybePromise,
} from "../types.ts"
import type { WorkspaceName } from "@vite-hub/workspace"

export type PapercutSource = "tool"

export interface Papercut {
  agent?: NonNullable<AgentCapabilityRuntimeContext["agentIdentity"]>
  createdAt: string
  id: string
  message: string
  run?: NonNullable<AgentCapabilityRuntimeContext["run"]>
  source: PapercutSource
  trace?: NonNullable<AgentCapabilityRuntimeContext["trace"]>
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
  report: (event: PapercutReportEvent<TRuntimeConfig, Name>) => MaybePromise<void>
}

interface PapercutInput {
  message: string
}

interface PapercutResult {
  id: string
  reported: true
}

const papercutMaxMessageLength = 1_000
const papercutReportDescription = "Proactively report small friction as soon as it happens, even when non-blocking: a missed or retried tool call, confusing or undocumented setup, flaky command, stale cache, misleading error, or non-obvious gotcha. In one or two sentences, say what you were doing and what got in the way; a likely cause or fix is a bonus. Never include secrets or customer data."
const papercutInputSchema: AgentToolSchema<PapercutInput> = {
  additionalProperties: false,
  properties: {
    message: {
      description: "One or two sentences describing what you were doing and what got in the way.",
      maxLength: papercutMaxMessageLength,
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
  if (!hasRuntimeType(value, "string") || !value.trim()) {
    throw new TypeError("[vitehub] report_papercut requires a non-empty message.")
  }
  const message = value.trim()
  if (message.length > papercutMaxMessageLength) {
    throw new TypeError(`[vitehub] report_papercut message must be at most ${papercutMaxMessageLength} characters.`)
  }
  return message
}

export function papercuts<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
>(options: PapercutsOptions<TRuntimeConfig, Name>): AgentCapabilityDefinition<TRuntimeConfig, Name> {
  if (!options || !hasRuntimeType(options.report, "function")) {
    throw new TypeError("[vitehub] papercuts() requires a report callback.")
  }
  return defineCapability({
    id: "papercuts",
    metadata: { tool: "report_papercut" },
    tools: context => ({
      report_papercut: defineInternalTool<PapercutInput, PapercutResult>({
        description: papercutReportDescription,
        inputSchema: papercutInputSchema,
        name: "report_papercut",
        async execute(input) {
          const papercut: Papercut = {
            ...(context.agentIdentity ? { agent: { ...context.agentIdentity } } : {}),
            createdAt: new Date().toISOString(),
            id: createPapercutId(),
            message: normalizePapercutMessage(input?.message),
            ...(context.run ? { run: { ...context.run } } : {}),
            source: "tool",
            ...(context.trace ? { trace: { ...context.trace } } : {}),
          }
          // SAFETY: Invocation tool resolution supplies the full Capability runtime context. Static tool inspection may omit only Workspace fields.
          await options.report({ context: context as PapercutReportContext<TRuntimeConfig, Name>, papercut })
          return { id: papercut.id, reported: true }
        },
      }),
    }),
  })
}
