import { defineCapability, eagerFinishExtensionSymbol } from "../capability-runtime.ts"
import { enrichAgentUsageCost, modelsDevPricing } from "../internal/usage-pricing.ts"
import { ViteHubError } from "@vite-hub/runtime"

import type {
  AgentBudgetExceeded,
  AgentBudgetOptions,
  AgentBudgetSnapshot,
  AgentBudgetTokenLimits,
  AgentCapabilityDefinition,
  AgentUsage,
  AgentUsageRecord,
} from "../types.ts"

export type { AgentBudgetExceeded, AgentBudgetOptions, AgentBudgetSnapshot, AgentBudgetTokenLimits }

declare global {
  interface ViteHubAgentFinishExtensions {
    budget: AgentBudgetSnapshot
  }
}

function assertFiniteLimit(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
    throw new TypeError(`[vitehub] budget ${name} must be a finite, non-negative number.`)
  }
}

function normalizeTokens(value: AgentBudgetOptions["tokens"]): AgentBudgetTokenLimits {
  if (value === undefined) return {}
  if (typeof value === "number") {
    assertFiniteLimit(value, "tokens")
    return { total: value }
  }
  const limits = {
    input: value.input,
    output: value.output,
    total: value.total,
  }
  assertFiniteLimit(limits.input, "tokens.input")
  assertFiniteLimit(limits.output, "tokens.output")
  assertFiniteLimit(limits.total, "tokens.total")
  if (limits.input === undefined && limits.output === undefined && limits.total === undefined) return {}
  return limits
}

function decimalParts(value: number | string): { scale: bigint, units: bigint } {
  const raw = String(value).trim()
  const scientific = raw.match(/^(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/)
  let text = raw
  if (scientific) {
    const [, whole, fraction = "", exponentText] = scientific
    const digits = whole + fraction
    const decimalIndex = whole.length + Number(exponentText)
    text = decimalIndex <= 0
      ? `0.${"0".repeat(-decimalIndex)}${digits}`
      : decimalIndex >= digits.length
        ? `${digits}${"0".repeat(decimalIndex - digits.length)}`
        : `${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`
  }
  if (!/^\d+(?:\.\d+)?$/.test(text)) throw new TypeError("[vitehub] budget usd must be a non-negative decimal.")
  const [whole, fraction = ""] = text.split(".")
  return { scale: 10n ** BigInt(fraction.length), units: BigInt(`${whole}${fraction}`) }
}

function decimalExceeds(actual: string, limit: number | string): boolean {
  const left = decimalParts(actual)
  const right = decimalParts(limit)
  return left.units * right.scale > right.units * left.scale
}

function validateOptions(options: AgentBudgetOptions): { tokens: AgentBudgetTokenLimits, usd?: number | string } {
  const tokens = normalizeTokens(options.tokens)
  let usd: number | string | undefined
  if (options.usd !== undefined) {
    if (typeof options.usd === "number") assertFiniteLimit(options.usd, "usd")
    decimalParts(options.usd)
    usd = options.usd
  }
  if (!Object.keys(tokens).length && usd === undefined) {
    throw new TypeError("[vitehub] budget requires tokens or usd.")
  }
  return { tokens, ...(usd === undefined ? {} : { usd }) }
}

function budgetExceeded(usage: AgentUsage | undefined, cost: AgentUsageRecord["cost"], limits: ReturnType<typeof validateOptions>): AgentBudgetExceeded[] {
  if (!usage && !cost) return []
  const exceeded: AgentBudgetExceeded[] = []
  const checks: Array<[AgentBudgetExceeded["metric"], number | undefined, number | undefined]> = [
    ["inputTokens", usage?.inputTokens, limits.tokens.input],
    ["outputTokens", usage?.outputTokens, limits.tokens.output],
    ["totalTokens", usage?.totalTokens, limits.tokens.total],
  ]
  for (const [metric, actual, limit] of checks) {
    if (actual !== undefined && limit !== undefined && actual > limit) exceeded.push({ actual, limit, metric })
  }
  if (cost?.usd !== undefined && limits.usd !== undefined && decimalExceeds(cost.usd, limits.usd)) {
    exceeded.push({ actual: cost.usd, limit: limits.usd, metric: "usd" })
  }
  return exceeded
}

function outputTokenLimit(tokens: AgentBudgetTokenLimits): number | undefined {
  return tokens.output === undefined ? undefined : Math.max(0, Math.floor(tokens.output))
}

export function budget(options: AgentBudgetOptions): AgentCapabilityDefinition {
  const id = options.id || "budget"
  const limits = validateOptions(options)
  const pricing = options.pricing === false ? undefined : options.pricing || modelsDevPricing()
  const mode = options.mode || "observe"

  return Object.assign(defineCapability({
    id,
    instructionCoverage: false,
    metadata: {
      kind: "budget",
      mode,
      ...(limits.usd === undefined ? {} : { usd: limits.usd }),
      tokens: limits.tokens,
    },
    configure(context) {
      const maxOutputTokens = outputTokenLimit(limits.tokens)
      if (maxOutputTokens === undefined) return
      context.modelExecution.instrument({
        callSettings: ({ callSettings }) => {
          const current = callSettings.maxOutputTokens
          if (typeof current === "number" && current <= maxOutputTokens) return
          return { maxOutputTokens }
        },
      })
    },
    async finish(event) {
      let usage = event.invocation.usage
      if (usage && pricing) {
        try {
          usage = await enrichAgentUsageCost(usage, pricing, event.invocation.run)
          if (event.invocation.usage && usage !== event.invocation.usage) Object.assign(event.invocation.usage, usage)
        }
        catch {
          // Pricing is best effort. Provider-reported costs remain available.
        }
      }
      const exceeded = budgetExceeded(usage?.usage, usage?.cost, limits)
      const snapshot: AgentBudgetSnapshot = {
        exceeded,
        limits: options,
        ...(usage ? { usage } : {}),
      }
      if (mode === "enforce" && exceeded.length) {
        throw new ViteHubError("AGENT_BUDGET_EXCEEDED", "Agent budget exceeded.", {
          details: {
            exceeded: exceeded.map(({ actual, limit, metric }) => ({ actual, limit, metric })),
            limits: {
              tokens: limits.tokens,
              ...(limits.usd === undefined ? {} : { usd: limits.usd }),
            },
          },
        })
      }
      return snapshot
    },
  }), {
    [eagerFinishExtensionSymbol]: true,
  })
}
