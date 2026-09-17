import * as v from 'valibot'

const nonempty = v.pipe(v.string(), v.minLength(1))
const waitSchema = v.object({ headSha: nonempty, reason: nonempty, evidenceKey: nonempty })

/** Caller-selected structured evidence that must change before another Agent pass. */
export type PullRequestWait = { headSha: string; reason: string; evidenceKey: string }
export const parseWait = (value: unknown): PullRequestWait => v.parse(waitSchema, value)
