import * as v from "valibot"

const thousandths = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(1000))

export const anchorSchema = v.object({
  field: v.optional(v.pipe(v.string(), v.maxLength(512))),
  selector: v.pipe(v.string(), v.maxLength(2048)),
  label: v.pipe(v.string(), v.maxLength(200)),
  x: thousandths,
  y: thousandths,
  page: v.object({ x: thousandths, y: v.pipe(v.number(), v.minValue(0), v.maxValue(1_000_000)) }),
  viewport: v.object({ width: v.pipe(v.number(), v.minValue(0), v.maxValue(100_000)) }),
})

export const bodySchema = v.pipe(v.string(), v.trim(), v.minLength(1, "The comment is empty."), v.maxLength(4000, "Keep a comment under 4,000 characters."))

export const mentionsSchema = v.pipe(
  v.optional(v.array(v.object({ id: v.pipe(v.string(), v.minLength(1), v.maxLength(256)), name: v.pipe(v.string(), v.minLength(1), v.maxLength(256)) })), []),
  v.maxLength(20, "Mention at most 20 people in one comment."),
)

export const authorSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
  name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(256)),
  image: v.optional(v.pipe(v.string(), v.maxLength(2048))),
  guest: v.optional(v.boolean()),
})

export const pageSchema = v.pipe(v.string(), v.startsWith("/", "A page starts with `/`."), v.maxLength(1024))

export const createThreadSchema = v.object({
  page: pageSchema,
  anchor: anchorSchema,
  body: bodySchema,
  author: authorSchema,
  mentions: mentionsSchema,
})

export const replySchema = v.object({ body: bodySchema, author: authorSchema, mentions: mentionsSchema })

/** The first issue as one sentence, for `COMMENTS_INVALID_INPUT`. */
export function describeIssue(issues: readonly v.BaseIssue<unknown>[]): string {
  const issue = issues[0]
  if (!issue) return "unknown issue."
  const path = issue.path?.map(item => String(item.key)).join(".")
  return path ? `${path}: ${issue.message}` : issue.message
}
