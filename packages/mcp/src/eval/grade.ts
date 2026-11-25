export type McpEvalCaseKind = "bad" | "guard" | "control"

export interface McpEvalExpectedCall {
  tool: string
  args?: Record<string, unknown>
}

export interface McpEvalExpect {
  calls?: McpEvalExpectedCall[]
  notCalls?: string[]
  maxCalls?: number
  finalTextMust?: string[]
  finalTextMustNot?: string[]
}

export interface McpEvalCase {
  id: string
  kind: McpEvalCaseKind
  origin: Record<string, unknown>
  prompt: string
  expect: McpEvalExpect
  maxSteps?: number
  notes?: string
}

export interface McpEvalCall {
  tool: string
  args: unknown
  executed: boolean
  resultChars?: number
}

export interface McpEvalCheck {
  name: string
  pass: boolean
  reason: string
}

export type McpEvalCaseStatus = "pass" | "fail" | "error" | "incomplete"

export function readPath(value: unknown, path: string): unknown {
  let current = value
  for (const key of path.split(".")) {
    if (typeof current !== "object" || current === null) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value) ?? ""
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) return false
  if (Array.isArray(left) !== Array.isArray(right)) return false
  const leftKeys = Object.keys(left)
  if (leftKeys.length !== Object.keys(right).length) return false
  return leftKeys.every(key => deepEqual((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]))
}

export function matchText(pattern: string, actual: string): boolean {
  if (pattern.startsWith("re:")) return new RegExp(pattern.slice(3)).test(actual)
  const needle = pattern.startsWith("~") ? pattern.slice(1) : pattern
  return actual.toLowerCase().includes(needle.toLowerCase())
}

export function matchValue(expected: unknown, actual: unknown): boolean {
  if (typeof expected === "string" && (expected.startsWith("~") || expected.startsWith("re:"))) {
    return actual !== undefined && matchText(expected, textOf(actual))
  }
  return deepEqual(expected, actual)
}

export function matchArgs(expected: Record<string, unknown> | undefined, actual: unknown): boolean {
  return Object.entries(expected ?? {}).every(([path, value]) => matchValue(value, readPath(actual, path)))
}

export function gradeSample(expect: McpEvalExpect, calls: McpEvalCall[], finalText: string): McpEvalCheck[] {
  const checks: McpEvalCheck[] = []
  for (const call of expect.calls ?? []) {
    const named = calls.filter(made => made.tool === call.tool)
    const pass = named.some(made => matchArgs(call.args, made.args))
    const reason = pass
      ? `${call.tool} was called with the expected arguments.`
      : named.length
        ? `${call.tool} was called ${named.length} time(s), but never with ${JSON.stringify(call.args)}.`
        : `${call.tool} was not called.`
    checks.push({ name: `calls:${call.tool}`, pass, reason })
  }
  for (const tool of expect.notCalls ?? []) {
    const count = calls.filter(made => made.tool === tool).length
    checks.push({ name: `notCalls:${tool}`, pass: count === 0, reason: count ? `${tool} was called ${count} time(s).` : `${tool} was not called.` })
  }
  if (expect.maxCalls !== undefined) {
    const pass = calls.length <= expect.maxCalls
    checks.push({ name: "maxCalls", pass, reason: `${calls.length} call(s), the limit is ${expect.maxCalls}.` })
  }
  for (const pattern of expect.finalTextMust ?? []) {
    const pass = matchText(pattern, finalText)
    checks.push({ name: `finalTextMust:${pattern}`, pass, reason: pass ? "The final text matches." : "The final text does not match." })
  }
  for (const pattern of expect.finalTextMustNot ?? []) {
    const pass = !matchText(pattern, finalText)
    checks.push({ name: `finalTextMustNot:${pattern}`, pass, reason: pass ? "The final text does not match." : "The final text matches." })
  }
  return checks
}

export interface McpEvalSampleOutcome {
  pass: boolean
  error?: string
}

export function needsAnotherSample(samples: McpEvalSampleOutcome[], fixed: number | undefined): boolean {
  if (fixed !== undefined) return samples.length < fixed
  if (samples.length < 2) return true
  if (samples.length > 2) return false
  const [first, second] = samples.map(sample => sample.error ? "error" : String(sample.pass))
  return first !== second
}

export function caseVerdict(samples: McpEvalSampleOutcome[]): { passRate: number | undefined, status: McpEvalCaseStatus } {
  const graded = samples.filter(sample => !sample.error)
  if (!graded.length) return { passRate: undefined, status: "error" }
  const passRate = graded.filter(sample => sample.pass).length / graded.length
  return { passRate, status: passRate > 0.5 ? "pass" : "fail" }
}
