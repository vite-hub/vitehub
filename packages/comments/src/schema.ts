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

const short = (max: number) => v.pipe(v.string(), v.maxLength(max))
const size = v.pipe(v.number(), v.minValue(0), v.maxValue(100_000))

export const componentSchema = v.object({
  name: short(128),
  files: v.optional(v.pipe(v.array(short(512)), v.maxLength(8))),
})

export const contextSchema = v.object({
  url: short(2048),
  title: v.optional(short(256)),
  route: v.optional(short(256)),
  element: v.optional(v.object({
    tag: short(64),
    id: v.optional(short(128)),
    testId: v.optional(short(128)),
    role: v.optional(short(64)),
    name: v.optional(short(120)),
    classes: v.optional(v.pipe(v.array(short(64)), v.maxLength(8))),
  })),
  components: v.optional(v.pipe(v.array(componentSchema), v.maxLength(12))),
  environment: v.optional(v.object({
    viewport: v.object({ width: size, height: size }),
    devicePixelRatio: v.pipe(v.number(), v.minValue(0), v.maxValue(16)),
    userAgent: short(512),
    language: v.optional(short(64)),
    colorScheme: v.optional(v.picklist(["light", "dark"])),
    timeZone: v.optional(short(64)),
  })),
  build: v.optional(v.object({
    commit: v.optional(short(64)),
    branch: v.optional(short(256)),
    repository: v.optional(short(256)),
    pullRequest: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  })),
})

const metadataValue = v.union([v.pipe(v.string(), v.maxLength(4000)), v.number(), v.boolean(), v.null()])

export const metadataSchema = v.pipe(
  v.record(v.pipe(v.string(), v.minLength(1), v.maxLength(64)), metadataValue),
  v.check(value => Object.keys(value).length <= 50, "Keep at most 50 metadata fields."),
)

export const scopeSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(256))

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
  scope: v.optional(scopeSchema, "pages"),
  page: pageSchema,
  anchor: v.optional(anchorSchema),
  metadata: v.optional(metadataSchema),
  context: v.optional(contextSchema),
  body: bodySchema,
  author: authorSchema,
  mentions: mentionsSchema,
})

export const editSchema = v.object({ body: bodySchema, mentions: mentionsSchema })

export const replySchema = v.object({ body: bodySchema, author: authorSchema, mentions: mentionsSchema })

/** The first issue as one sentence, for `COMMENTS_INVALID_INPUT`. */
export function describeIssue(issues: readonly v.BaseIssue<unknown>[]): string {
  const issue = issues[0]
  if (!issue) return "unknown issue."
  const path = issue.path?.map(item => String(item.key)).join(".")
  return path ? `${path}: ${issue.message}` : issue.message
}
