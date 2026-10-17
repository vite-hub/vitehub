import * as v from 'valibot'

const nonempty = v.pipe(v.string(), v.minLength(1))
const repository = v.pipe(v.string(), v.regex(/^[\w.-]+\/[\w.-]+$/))
const commitSha = v.pipe(v.string(), v.regex(/^[a-f0-9]{40,64}$/))
export type PullRequestWake = { kind: 'checks'; repository: string; headSha: string } | { kind: 'pull-request'; repository: string; number: number }
export const wakeSchema: v.GenericSchema<unknown, PullRequestWake> = v.variant('kind', [
  v.object({ kind: v.literal('checks'), repository, headSha: commitSha }),
  v.object({ kind: v.literal('pull-request'), repository, number: v.pipe(v.number(), v.integer(), v.minValue(1)) }),
])
const waitSchema = v.object({ headSha: nonempty, reason: nonempty, evidenceKey: nonempty, retryAt: v.optional(v.number()), knownFailures: v.optional(v.array(v.string())), kind: v.optional(v.picklist(['checks', 'external'])), defer: v.optional(v.picklist(['checks'])), wake: v.optional(wakeSchema) })

/**
 * Caller-selected structured evidence that must change before another Agent pass.
 * `retryAt` schedules host reevaluation after transient gates.
 * `knownFailures` lists failing checks that the parked pass already saw.
 * An external wait without `wake` resumes on feedback, head or base changes after the named manual action.
 * `defer: 'checks'` postpones a pass while gates run; it records no assessment and ends when they stop.
 */
export type PullRequestWait = { headSha: string; reason: string; evidenceKey: string; retryAt?: number; knownFailures?: string[]; kind?: 'checks' | 'external'; defer?: 'checks'; wake?: PullRequestWake }
export const parseWait = (value: unknown): PullRequestWait => v.parse(waitSchema, value)
