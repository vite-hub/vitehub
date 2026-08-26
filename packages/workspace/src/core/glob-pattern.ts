const defaultModelGlobPatternLimits = {
  maxBytes: 2_048,
  maxComplexity: 1_024,
  maxPatterns: 16,
} as const

export interface WorkspaceGlobPatternLimits {
  maxBytes: number
  maxComplexity: number
  maxPatterns: number
}

export const modelWorkspaceGlobPatternLimits: Readonly<WorkspaceGlobPatternLimits> = Object.freeze(defaultModelGlobPatternLimits)

function boundedAdd(left: number, right: number, limit: number): number {
  if (left > limit - right) return limit + 1
  return left + right
}

function boundedMultiply(left: number, right: number, limit: number): number {
  if (left && right > Math.floor(limit / left)) return limit + 1
  return left * right
}

function boundedUtf8Bytes(value: string, limit: number): number {
  let bytes = 0
  for (let index = 0; index < value.length; index++) {
    const codePoint = value.codePointAt(index)!
    if (codePoint > 0xFFFF) index++
    bytes += codePoint <= 0x7F ? 1 : codePoint <= 0x7FF ? 2 : codePoint <= 0xFFFF ? 3 : 4
    if (bytes > limit) return limit + 1
  }
  return bytes
}

function findClosingBrace(pattern: string, opening: number): number {
  let depth = 0
  for (let index = opening; index < pattern.length; index++) {
    if (pattern[index] === "\\") {
      index++
      continue
    }
    if (pattern[index] === "{") depth++
    else if (pattern[index] === "}" && --depth === 0) return index
  }
  return -1
}

function splitBraceParts(content: string, separator: "," | ".."): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let index = 0; index < content.length; index++) {
    if (content[index] === "\\") {
      index++
      continue
    }
    if (content[index] === "{") depth++
    else if (content[index] === "}") depth--
    else if (depth === 0 && content.startsWith(separator, index)) {
      parts.push(content.slice(start, index))
      index += separator.length - 1
      start = index + 1
    }
  }
  parts.push(content.slice(start))
  return parts
}

function sequenceComplexity(content: string, limit: number): number | undefined {
  const parts = splitBraceParts(content, "..")
  if (parts.length < 2 || parts.length > 3) return undefined

  const [rawStart, rawEnd, rawStep] = parts
  const numeric = /^-?\d+$/
  let start: number
  let end: number
  if (numeric.test(rawStart!) && numeric.test(rawEnd!)) {
    start = Number(rawStart)
    end = Number(rawEnd)
  }
  else if (rawStart?.length === 1 && rawEnd?.length === 1) {
    start = rawStart.codePointAt(0)!
    end = rawEnd.codePointAt(0)!
  }
  else {
    return undefined
  }

  const step = rawStep === undefined ? 1 : Math.abs(Number(rawStep))
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || !Number.isSafeInteger(step) || step === 0) return limit + 1
  return Math.floor(Math.abs(end - start) / step) + 1
}

function patternComplexity(pattern: string, limit: number): number {
  let complexity = 1
  for (let index = 0; index < pattern.length; index++) {
    if (pattern[index] === "\\") {
      index++
      continue
    }
    if (pattern[index] === "}") {
      return limit + 1
    }
    if (pattern[index] !== "{") continue

    const closing = findClosingBrace(pattern, index)
    if (closing === -1) return limit + 1
    const content = pattern.slice(index + 1, closing)
    // brace-expansion reparses nested results, so their eventual sequence width
    // cannot be bounded from each brace group independently.
    if (content.includes("{") || content.includes("}")) return limit + 1
    const alternatives = splitBraceParts(content, ",")
    let braceComplexity: number
    if (alternatives.length > 1) {
      braceComplexity = 0
      for (const alternative of alternatives) {
        braceComplexity = boundedAdd(braceComplexity, patternComplexity(alternative, limit), limit)
        if (braceComplexity > limit) break
      }
    }
    else {
      braceComplexity = sequenceComplexity(content, limit) ?? patternComplexity(content, limit)
    }
    complexity = boundedMultiply(complexity, braceComplexity, limit)
    if (complexity > limit) return complexity
    index = closing
  }
  return complexity
}

export function assertModelWorkspaceGlobPattern(
  pattern: string | readonly string[],
  limits: Readonly<WorkspaceGlobPatternLimits> = modelWorkspaceGlobPatternLimits,
): void {
  const patterns = Array.isArray(pattern) ? pattern : [pattern]
  if (patterns.length > limits.maxPatterns) {
    throw new TypeError(`[vitehub] Workspace glob accepts at most ${limits.maxPatterns} model-facing patterns.`)
  }

  let bytes = 0
  for (const item of patterns) {
    bytes = boundedAdd(bytes, boundedUtf8Bytes(item, limits.maxBytes), limits.maxBytes)
    if (bytes > limits.maxBytes) break
  }
  if (bytes > limits.maxBytes) {
    throw new TypeError(`[vitehub] Workspace glob pattern input exceeds the model-facing limit of ${limits.maxBytes} bytes.`)
  }

  let complexity = 0
  for (const item of patterns) {
    const normalized = item.replace(/\\/g, "/")
    complexity = boundedAdd(complexity, patternComplexity(normalized, limits.maxComplexity), limits.maxComplexity)
    if (complexity > limits.maxComplexity) {
      throw new TypeError(`[vitehub] Workspace glob pattern complexity exceeds the model-facing limit of ${limits.maxComplexity} expansions.`)
    }
  }
}
