import * as v from 'valibot'

const count = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(Number.MAX_SAFE_INTEGER - 1))
const providerBudgetSchema = v.object({
  generation: v.string(), maxRetries: count, nextAttempt: count, succeededThrough: count,
  pending: v.array(count), failures: v.array(count), resetReason: v.optional(v.string()),
})
export interface ProviderBudget {
  generation: string; maxRetries: number; nextAttempt: number; succeededThrough: number
  pending: number[]; failures: number[]; resetReason?: string
}
export function parseProviderBudget(value: unknown): ProviderBudget { return v.parse(providerBudgetSchema, value) }
export type ProviderAttempt = { provider: string; generation: string; attempt: number }
export type ProviderAttemptOutcome = 'success' | 'retryable-failure' | 'other-failure'
const progressBudgetSchema = v.object({
  head: v.string(), count, exhausted: v.boolean(), evidence: v.optional(v.string()),
  creditedEvidence: v.array(v.string()), resetReason: v.optional(v.string()),
})
export interface ProgressBudget { head: string; count: number; exhausted: boolean; evidence?: string; creditedEvidence: string[]; resetReason?: string }
export function parseProgressBudget(value: unknown): ProgressBudget { return v.parse(progressBudgetSchema, value) }
/** The host verifies progress from GitHub/provider state, never from Agent prose. */
export type ProgressOutcome = { kind: 'no-progress' } | { kind: 'verified'; evidence: string }
export interface InboxBudgets { providerRetries?: number; noProgress?: number }
export function validateBudgets(budgets: InboxBudgets): void {
  if (budgets.providerRetries !== undefined) v.parse(count, budgets.providerRetries)
  if (budgets.noProgress !== undefined) v.parse(v.pipe(count, v.minValue(1)), budgets.noProgress)
}
export function requireEvidence(evidence: string): void {
  if (!evidence.trim()) throw new Error('A non-empty verified evidence or reset reason is required')
}
