import * as v from 'valibot'

const nonempty = v.pipe(v.string(), v.minLength(1))
const waitSchema = v.object({ headSha: nonempty, reason: nonempty, evidenceKey: nonempty, knownFailures: v.optional(v.array(v.string())) })

/**
 * Caller-selected structured evidence that must change before another Agent pass.
 * `knownFailures` lists failing checks that the parked pass already saw.
 */
export type PullRequestWait = { headSha: string; reason: string; evidenceKey: string; knownFailures?: string[] }
export const parseWait = (value: unknown): PullRequestWait => v.parse(waitSchema, value)
