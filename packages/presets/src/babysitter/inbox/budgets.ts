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
  head: v.string(), limit: v.pipe(count, v.minValue(1)), count, exhausted: v.boolean(), evidence: v.optional(v.string()),
  creditedEvidence: v.array(v.string()), resetReason: v.optional(v.string()),
  grants: v.optional(v.array(v.picklist(['conflict', 'bot-feedback']))),
})
/** New evidence that gives an exhausted head one more pass, once per head. */
export type ProgressGrant = 'conflict' | 'bot-feedback'
export interface ProgressBudget { head: string; limit: number; count: number; exhausted: boolean; evidence?: string; creditedEvidence: string[]; resetReason?: string; grants?: ProgressGrant[] }
export function parseProgressBudget(value: unknown): ProgressBudget { return v.parse(progressBudgetSchema, value) }
/**
 * The host verifies progress from GitHub/provider state, never from Agent prose. `reviewDriven` marks a
 * push whose pass had no merge conflict and no failing check outside the review checks; the host
 * decides it from the claimed snapshot.
 */
export type ProgressOutcome = { kind: 'no-progress' } | { kind: 'verified'; evidence: string; reviewDriven?: boolean }
const reviewPushBudgetSchema = v.object({ count, heads: v.array(v.string()) })
/**
 * Review-driven pushes on one PR, over its whole life. `heads` lists the heads that this worker pushed
 * and, once the budget is spent, the heads that already got a model pass. A head outside it was moved
 * by someone else.
 */
export interface ReviewPushBudget { count: number; heads: string[] }
export function parseReviewPushBudget(value: unknown): ReviewPushBudget { return v.parse(reviewPushBudgetSchema, value) }
/** Heads kept per PR. Older heads cannot return, so they need no record. */
const reviewPushHeads = 20
/**
 * The review push record after a pass. A push receipt adds its head once and counts it when it is
 * review-driven. Once the budget is spent, a model pass adds the head it ran on, so that head is no
 * longer new.
 */
export function nextReviewPushBudget(budget: ReviewPushBudget | undefined, limit: number, progress: ProgressOutcome, claimedHead: string | undefined): ReviewPushBudget {
  const heads = new Set(budget?.heads ?? [])
  let pushes = budget?.count ?? 0
  const spent = pushes >= limit
  const pushed = progress.kind === 'verified' && progress.evidence.startsWith('push:') ? progress.evidence.slice('push:'.length) : undefined
  if (pushed && !heads.has(pushed)) {
    heads.add(pushed)
    if (progress.kind === 'verified' && progress.reviewDriven) pushes++
  }
  if (spent && claimedHead) heads.add(claimedHead)
  return { count: pushes, heads: [...heads].slice(-reviewPushHeads) }
}
const dailyPassBudgetSchema = v.object({ passes: v.array(count), human: v.optional(count), exemptions: v.array(v.string()) })
/**
 * Model passes on one PR in the last 24 hours. `passes` holds the time each pass started the model.
 * `human` is the generation of the last person's feedback that a pass saw. `exemptions` lists the
 * exemptions already used, so each applies once.
 */
export interface DailyPassBudget { passes: number[]; human?: number; exemptions: string[] }
export function parseDailyPassBudget(value: unknown): DailyPassBudget { return v.parse(dailyPassBudgetSchema, value) }
const day = 24 * 60 * 60_000
/** Exemption keys kept per PR. Each names a head, so older keys cannot match again. */
const dailyPassExemptions = 20
/** The record after a pass starts the model at `now`. Passes older than 24 hours leave the window. */
export function nextDailyPassBudget(budget: DailyPassBudget | undefined, now: number, human: number | undefined, exemption?: string): DailyPassBudget {
  const exemptions = [...budget?.exemptions ?? []]
  if (exemption && !exemptions.includes(exemption)) exemptions.push(exemption)
  const seen = Math.max(budget?.human ?? 0, human ?? 0)
  return { passes: [...(budget?.passes ?? []).filter(at => at > now - day), now], ...seen ? { human: seen } : {}, exemptions: exemptions.slice(-dailyPassExemptions) }
}
/** When the next pass may start, or undefined while fewer than `limit` passes started in the last 24 hours. */
export function dailyPassResumeAt(budget: DailyPassBudget | undefined, limit: number, now: number): number | undefined {
  const passes = (budget?.passes ?? []).filter(at => at > now - day).sort((left, right) => left - right)
  return passes.length < limit ? undefined : passes[passes.length - limit]! + day
}
export interface InboxBudgets { providerRetries?: number; noProgress?: number; reviewPushes?: number; dailyPasses?: number }
export function validateBudgets(budgets: InboxBudgets): void {
  if (budgets.providerRetries !== undefined) v.parse(count, budgets.providerRetries)
  if (budgets.noProgress !== undefined) v.parse(v.pipe(count, v.minValue(1)), budgets.noProgress)
  if (budgets.reviewPushes !== undefined) v.parse(v.pipe(count, v.minValue(1)), budgets.reviewPushes)
  if (budgets.dailyPasses !== undefined) v.parse(v.pipe(count, v.minValue(1)), budgets.dailyPasses)
}
export function requireEvidence(evidence: string): void {
  if (!evidence.trim()) throw new Error('A non-empty verified evidence or reset reason is required')
}
