import { defineCapability } from "../capability-runtime.ts"
import { agentDiagnostics } from "../agent-diagnostics.ts"
import { pageContextKey, pageHeader, pageRealtimeDefinition, pageRulesVersion } from "../internal/page.ts"
import { traceAgentEvent } from "../trace.ts"
import { defineInternalTool, primitiveHandle } from "./internal.ts"
import { pageTools } from "./page-tools.ts"

import type { PageRefusalCode, PageStepRule, PageStepRules } from "../internal/page.ts"
import type { AgentCapabilityContext, AgentCapabilityDefinition, AgentInvoker, AgentToolSet } from "../types.ts"
import type { TraceEvent } from "@vite-hub/runtime"
import type { PageToolDefinition } from "./page-tools.ts"

export type { PageStepRule } from "../internal/page.ts"

export interface PageCapabilityOptions {
  /** How long `page_snapshot` and `page_query` wait for the page to answer, in milliseconds. Default 30 seconds. */
  timeout?: number
  /**
   * How long `page_act` waits for the page, in milliseconds. Default 330 seconds: a step that needs the person waits up
   * to 5 minutes on the page's `allow`.
   */
  actTimeout?: number
  /** Steps the Agent may never run. The page refuses them with `AGENT_R1047`, and nothing of the step changes. */
  deny?: readonly PageStepRule[]
  /**
   * Steps that run only after the person approves them on the page, through the `allow` of `connectPage()`. A step inside
   * `data-agent-confirm` always needs the person too.
   */
  requireApproval?: readonly PageStepRule[]
}

/** What a page tool returns when the page could not answer, or refused a step, in the shape of a failed ui-sdk step. */
export interface PageCallFailure {
  ok: false
  code: string
  error: string
}

const pageIdPattern = /^[\w-]{8,128}$/

function readPageId(value: unknown): string | undefined {
  const id = typeof value === "string" ? value : value && typeof value === "object" && "id" in value ? value.id : undefined
  return typeof id === "string" && pageIdPattern.test(id) ? id : undefined
}

/**
 * The page of this run: `context.page` on the Invocation input, else the `x-vitehub-page` header of the request that
 * started it, which `connectPage()` and `useChat(agent, { page })` send.
 */
function resolvePageId(context: AgentCapabilityContext): string | undefined {
  const fromInput = readPageId(context.invocation?.input.get().context?.[pageContextKey])
  if (fromInput) return fromInput
  return readPageId(context.runtimeContext?.request?.headers.get(pageHeader) ?? undefined)
}

/**
 * The person whose page the run may ask: the Auth user that `authenticated()` records on the Invoker, or `null`. The
 * page's Realtime room is keyed by the same person, so a run never reaches another person's page.
 */
function runUser(invoker: AgentInvoker | undefined): string | null {
  const meta: unknown = invoker?.meta
  const id = meta && typeof meta === "object" && "authUserId" in meta ? meta.authUserId : undefined
  return typeof id === "string" && id ? id : null
}

/** `agentRealtime` from `@vite-hub/realtime/agent`, which ViteHub passes as `capabilities.realtime`. */
interface PageRealtime {
  available: () => boolean
  request: (definition: string, room: string, body: unknown, options: { signal?: AbortSignal, timeout?: number, user: string | null }) => Promise<
    [error: { code: string, why: string }, data: undefined] | [error: undefined, data: unknown]
  >
}

function isPageRealtime(value: unknown): value is PageRealtime {
  return typeof value === "object" && value !== null
    && "available" in value && typeof value.available === "function"
    && "request" in value && typeof value.request === "function"
}

function requirePageRealtime(context: AgentCapabilityContext): PageRealtime {
  const handle = primitiveHandle(context, "realtime")
  if (!isPageRealtime(handle) || !handle.available()) throw agentDiagnostics.AGENT_R1045()
  return handle
}

function checkRules(name: string, rules: readonly PageStepRule[] | undefined): PageStepRule[] {
  if (rules === undefined) return []
  if (!Array.isArray(rules)) throw agentDiagnostics.AGENT_R1052({ problem: `\`${name}\` must be an array of rules.` })
  return rules.map((rule: unknown, index) => {
    const at = `${name}[${index}]`
    if (!rule || typeof rule !== "object") throw agentDiagnostics.AGENT_R1052({ problem: `${at} must be an object.` })
    const checked: PageStepRule = {}
    for (const [key, value] of Object.entries(rule)) {
      if (key === "label" || key === "component") {
        if (typeof value !== "string" || !value.trim()) throw agentDiagnostics.AGENT_R1052({ problem: `${at}.${key} must be a non-empty string.` })
        checked[key] = value
      }
      else if (key === "confirm") {
        if (typeof value !== "boolean") throw agentDiagnostics.AGENT_R1052({ problem: `${at}.confirm must be true or false.` })
        checked.confirm = value
      }
      else {
        throw agentDiagnostics.AGENT_R1052({ problem: `${at} has "${key}". A rule matches the resolved component with label, component, and confirm only, so a step cannot pass it with another action or argument.` })
      }
    }
    if (!Object.keys(checked).length) throw agentDiagnostics.AGENT_R1052({ problem: `${at} is empty, so it would match every step.` })
    return Object.freeze(checked)
  })
}

interface PageActAnswer {
  rules: typeof pageRulesVersion
  result: unknown
  changes: Array<{ id: string, ref: string, label?: string, key: string, before: unknown, after: unknown, step: number, at: string }>
  approvals: Array<{ id: string, label?: string, component: string, action: string, args: unknown[], confirm: string, approved: boolean, at: string }>
  refused?: { step: number, code: PageRefusalCode }
}

function isActAnswer(value: unknown): value is PageActAnswer {
  return !!value && typeof value === "object" && "rules" in value && value.rules === pageRulesVersion
    && "changes" in value && Array.isArray(value.changes) && "approvals" in value && Array.isArray(value.approvals)
}

/** The model's words for a step: what it asked for, by index. */
function stepWords(input: unknown, index: number): string {
  const steps = input && typeof input === "object" && "steps" in input && Array.isArray(input.steps) ? input.steps : []
  const step: unknown = steps[index]
  if (!step || typeof step !== "object") return `step ${index + 1}`
  const ref = "ref" in step && typeof step.ref === "string" ? step.ref : "?"
  const action = "action" in step && typeof step.action === "string" ? step.action : "?"
  return `step ${index + 1} (${action} on "${ref}")`
}

function refusal(code: PageRefusalCode, step: string) {
  const error = code === "AGENT_R1047" ? agentDiagnostics.AGENT_R1047({ step }) : code === "AGENT_R1048" ? agentDiagnostics.AGENT_R1048({ step }) : agentDiagnostics.AGENT_R1049({ step })
  return { code, error: `${error.why} ${error.fix ?? ""}`.trim() }
}

async function callPage(realtime: PageRealtime, id: string, user: string | null, body: unknown, timeout: number, signal: AbortSignal | undefined): Promise<[failure: PageCallFailure, answer: undefined] | [failure: undefined, answer: unknown]> {
  const [error, answer] = await realtime.request(pageRealtimeDefinition, id, body, { timeout, user, ...(signal ? { signal } : {}) })
  return error ? [{ ok: false, code: error.code, error: error.why }, undefined] : [undefined, answer]
}

/**
 * Lets the Agent work the person's page through ui-sdk's agent bridge: `page_snapshot` reads its components,
 * `page_query` finds components and list items, and `page_act` runs steps through each component's api. Each call goes
 * over Realtime to the page that started the run, and only to a page of the run's own person. `deny` and
 * `requireApproval` rules decide each step on the page, after ui-sdk resolves it: a denied step returns `AGENT_R1047`,
 * and a step that needs approval asks the person through the page's `allow`. Every change, approval, and refusal is in
 * the Invocation journal. A run without a page gets no page tools.
 */
export function page(options: PageCapabilityOptions = {}): AgentCapabilityDefinition {
  const timeout = options.timeout ?? 30_000
  const actTimeout = options.actTimeout ?? 330_000
  const rules: PageStepRules = { deny: checkRules("deny", options.deny), requireApproval: checkRules("requireApproval", options.requireApproval) }
  return defineCapability({
    id: "page",
    metadata: {
      // The page's room only admits its own person, and a run only asks its own person's pages.
      binding: "user",
      realtime: pageRealtimeDefinition,
      rules,
      tools: pageTools.map(tool => tool.name),
    },
    requires: [{ primitive: "realtime" }],
    tools(context): AgentToolSet | undefined {
      const id = resolvePageId(context)
      if (!id) return undefined
      const realtime = requirePageRealtime(context)
      const user = runUser(context.invoker)
      const trace = (event: TraceEvent) => {
        if (!context.runtimeContext) return
        const task = traceAgentEvent({ context: context.context, input: context.invocation?.input.get() ?? {}, invoker: context.invoker, ...(context.run ? { run: context.run } : {}), runtime: context.runtimeContext }, event)
        context.runtimeContext.waitUntil?.(task)
        return task
      }

      async function act(tool: PageToolDefinition, input: unknown, toolCallId: string | undefined, signal: AbortSignal | undefined): Promise<unknown> {
        const [failure, answer] = await callPage(realtime, id!, user, { method: tool.method, input: input ?? {}, rules }, actTimeout, signal)
        if (failure) return failure
        if (!isActAnswer(answer)) {
          const error = agentDiagnostics.AGENT_R1050()
          return { ok: false, code: "AGENT_R1050", error: `${error.why} ${error.fix}` } satisfies PageCallFailure
        }
        const page = { "page.id": id, "page.user": user ?? "anonymous", ...(toolCallId ? { "tool.id": toolCallId } : {}) }
        const events: Array<Promise<void> | undefined> = []
        for (const approval of answer.approvals) {
          const attributes = { ...page, "approval.id": approval.id, "approval.name": "page_act", "approval.reason": approval.confirm }
          events.push(trace({ attributes, name: "agent.approval.request", timestamp: approval.at, type: "run" }))
          events.push(trace({ attributes: { ...attributes, "approval.approved": approval.approved }, name: "agent.approval.decision", timestamp: approval.at, type: "run" }))
        }
        for (const change of answer.changes) {
          events.push(trace({
            attributes: {
              ...page,
              "page.change.id": change.id,
              "page.ref": change.ref,
              ...(change.label === undefined ? {} : { "page.label": change.label }),
              "page.key": change.key,
              "page.step": change.step,
              // The values are what the person typed, so they follow the journal's content policy.
              "page.change.content": { before: change.before, after: change.after },
            },
            name: "agent.page.change",
            timestamp: change.at,
            type: "run",
          }))
        }
        await Promise.all(events)
        // The model sees ui-sdk's result, what changed, and a named code when the page refused a step.
        const result = answer.result && typeof answer.result === "object" ? answer.result : { result: answer.result }
        const changed = answer.changes.map(change => ({ label: change.label ?? change.ref, key: change.key, before: change.before, after: change.after }))
        return {
          ...result,
          ...(changed.length ? { changes: changed } : {}),
          ...(answer.refused ? { ok: false, step: answer.refused.step, ...refusal(answer.refused.code, stepWords(input, answer.refused.step)) } : {}),
        }
      }

      return Object.fromEntries(pageTools.map(tool => [tool.name, defineInternalTool({
        name: tool.name,
        description: tool.description,
        icon: tool.icon,
        inputSchema: tool.inputSchema,
        title: tool.title,
        execute: async (input, toolContext) => {
          const signal = toolContext?.abortSignal ?? context.abortSignal
          if (tool.method === "act") return await act(tool, input, toolContext?.toolCallId, signal)
          const [failure, answer] = await callPage(realtime, id, user, { method: tool.method, input: input ?? {}, rules }, timeout, signal)
          return failure ?? answer
        },
      })]))
    },
  })
}
