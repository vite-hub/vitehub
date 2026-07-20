export interface IdentifierCall {
  arguments: string[]
  closeParen: number
  name: string
  openParen: number
  start: number
}

export interface DefaultExportCall extends IdentifierCall {
  argument: string
}

function isQuote(char: string | undefined) {
  return char === "\"" || char === "'" || char === "`"
}

function skipQuoted(source: string, index: number, activeControlFlowRegexes = new Set<number>()) {
  const quote = source[index]
  if (quote === "`") return skipTemplateLiteral(source, index, activeControlFlowRegexes)
  index += 1
  while (index < source.length) {
    if (source[index] === "\\") {
      index += 2
      continue
    }
    if (source[index] === quote) {
      return index + 1
    }
    index += 1
  }
  return index
}

function skipTemplateLiteral(source: string, index: number, activeControlFlowRegexes: Set<number>): number {
  index += 1
  let expressionDepth = 0
  let previousSignificant = ""
  while (index < source.length) {
    const char = source[index]
    const next = source[index + 1]
    if (char === "\\") {
      index += 2
      continue
    }
    if (expressionDepth === 0) {
      if (char === "`") return index + 1
      if (char === "$" && next === "{") {
        expressionDepth = 1
        previousSignificant = "{"
        index += 2
        continue
      }
      index += 1
      continue
    }
    if (char === "\"" || char === "'") {
      index = skipQuoted(source, index, activeControlFlowRegexes)
      previousSignificant = "literal"
      continue
    }
    if (char === "`") {
      index = skipTemplateLiteral(source, index, activeControlFlowRegexes)
      previousSignificant = "literal"
      continue
    }
    if (char === "/" && next === "/") {
      index = skipLineComment(source, index)
      continue
    }
    if (char === "/" && next === "*") {
      index = skipBlockComment(source, index)
      continue
    }
    if (char === "/" && (isRegexLiteralStart(previousSignificant) || isControlFlowRegexStart(source, index, activeControlFlowRegexes))) {
      index = skipRegexLiteral(source, index)
      previousSignificant = "/"
      continue
    }
    if (char === "{") expressionDepth += 1
    if (char === "}") expressionDepth -= 1
    previousSignificant = trackSignificant(previousSignificant, char)
    index += 1
  }
  return index
}

function skipLineComment(source: string, index: number) {
  const end = source.indexOf("\n", index + 2)
  return end === -1 ? source.length : end + 1
}

function skipBlockComment(source: string, index: number) {
  const end = source.indexOf("*/", index + 2)
  return end === -1 ? source.length : end + 2
}

function isIdentifierChar(char: string | undefined) {
  return !!char && /[\w$]/.test(char)
}

function isRegexLiteralStart(previousSignificant: string) {
  const token = previousSignificant.trimEnd()
  if (/^\.[\w$]+$/.test(token)) return false
  return !token || /[({[=,:!&|?;>+\-*%^~]/.test(token) || /\b(?:await|case|delete|do|else|in|instanceof|return|throw|typeof|void|yield)$/.test(token)
}

function findLineCommentStart(source: string, start: number, end: number, activeControlFlowRegexes: Set<number>) {
  for (let index = start; index <= end;) {
    const char = source[index]
    const next = source[index + 1]
    if (isQuote(char)) {
      index = skipQuoted(source, index, activeControlFlowRegexes)
      continue
    }
    if (char === "/" && next === "*") {
      index = skipBlockComment(source, index)
      continue
    }
    if (char === "/" && next === "/") return index
    index += 1
  }
  return -1
}

function previousCodeIndex(source: string, index: number, activeControlFlowRegexes: Set<number>) {
  let current = index
  while (current >= 0) {
    while (/\s/.test(source[current] ?? "")) current--
    if (source[current] === "/" && source[current - 1] === "*") {
      const start = source.lastIndexOf("/*", current - 2)
      if (start === -1) return current
      current = start - 1
      continue
    }
    const lineStart = source.lastIndexOf("\n", current) + 1
    const lineComment = findLineCommentStart(source, lineStart, current, activeControlFlowRegexes)
    if (lineComment !== -1 && lineComment <= current) {
      current = lineStart - 1
      continue
    }
    return current
  }
  return current
}

function isControlFlowRegexStart(source: string, index: number, activeControlFlowRegexes = new Set<number>()) {
  // A template rescan can revisit the slash whose classification initiated it; treating that candidate as a regex breaks the cycle without changing the outer classification.
  if (activeControlFlowRegexes.has(index)) return true
  activeControlFlowRegexes.add(index)
  try {
    const closeParen = previousCodeIndex(source, index - 1, activeControlFlowRegexes)
    if (source[closeParen] !== ")") return false

    for (let current = closeParen; current >= 0; current--) {
      if (source[current] !== "(") continue
      if (findMatching(source, current, "(", ")") !== closeParen) continue
      const head = source.slice(0, current).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, " ")
      return /(?:^|[^\w$])(?:catch|for|if|while|with)\s*$/.test(head)
    }

    return false
  }
  finally {
    activeControlFlowRegexes.delete(index)
  }
}

function skipRegexLiteral(source: string, index: number) {
  index += 1
  while (index < source.length) {
    const char = source[index]
    if (char === "\\") {
      index += 2
      continue
    }
    if (char === "[") {
      index += 1
      while (index < source.length) {
        if (source[index] === "\\") {
          index += 2
          continue
        }
        if (source[index] === "]") break
        index += 1
      }
    }
    if (char === "/") {
      index += 1
      while (/[a-z]/i.test(source[index] ?? "")) index += 1
      return index
    }
    index += 1
  }
  return index
}

function trackSignificant(previousSignificant: string, char: string | undefined) {
  if (/[a-z$]/i.test(char ?? "")) {
    return /[\w$]$/.test(previousSignificant) || previousSignificant === "."
      ? previousSignificant + char
      : char ?? ""
  }
  if (/\s/.test(char ?? "")) {
    return /[\w$]$/.test(previousSignificant) ? `${previousSignificant} ` : previousSignificant
  }
  if (!/\s/.test(char ?? "")) {
    return char ?? ""
  }
  return previousSignificant
}

function isFunctionDeclarationName(source: string, index: number) {
  return /(?:^|[^\w$])(?:async\s+)?function\s*\*?\s*$/.test(source.slice(0, index))
}

function previousNonWhitespace(source: string, index: number) {
  let current = index - 1
  while (/\s/.test(source[current] ?? "")) current -= 1
  return source[current]
}

function nextNonWhitespace(source: string, index: number) {
  return source[skipWhitespaceAndComments(source, index)]
}

function skipWhitespaceAndComments(source: string, index: number) {
  while (index < source.length) {
    if (/\s/.test(source[index] ?? "")) {
      index += 1
      continue
    }
    if (source[index] === "/" && source[index + 1] === "/") {
      index = skipLineComment(source, index)
      continue
    }
    if (source[index] === "/" && source[index + 1] === "*") {
      index = skipBlockComment(source, index)
      continue
    }
    return index
  }
  return index
}

export function stripBoundaryComments(source: string): string {
  return source
    .replace(/^(?:\s|\/\/[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/, "")
    .replace(/(?:\s|\/\/[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+$/, "")
}

export function maskSourceLiterals(source: string): string {
  const output = source.split("")
  let previousSignificant = ""
  const mask = (start: number, end: number) => {
    for (let index = start; index < end; index++) {
      if (output[index] !== "\n" && output[index] !== "\r") output[index] = " "
    }
  }

  for (let index = 0; index < source.length;) {
    const char = source[index]
    const next = source[index + 1]
    let end: number | undefined
    if (isQuote(char)) {
      end = skipQuoted(source, index)
      previousSignificant = "literal"
    }
    else if (char === "/" && next === "/") end = skipLineComment(source, index)
    else if (char === "/" && next === "*") end = skipBlockComment(source, index)
    else if (char === "/" && (isRegexLiteralStart(previousSignificant) || isControlFlowRegexStart(source, index))) {
      end = skipRegexLiteral(source, index)
      previousSignificant = "/"
    }
    if (end !== undefined) {
      mask(index, end)
      index = end
      continue
    }
    previousSignificant = trackSignificant(previousSignificant, char)
    index += 1
  }
  return output.join("")
}

function isMethodDeclarationName(source: string, index: number, closeParen: number) {
  const previous = previousNonWhitespace(source, index)
  return source[skipWhitespaceAndComments(source, closeParen + 1)] === "{"
    && previous !== "("
    && previous !== "="
    && previous !== ","
    && previous !== ":"
}

function isMemberAccessName(source: string, index: number) {
  return previousNonWhitespace(source, index) === "."
}

export function findMatching(source: string, index: number, open: string, close: string): number | undefined {
  let depth = 0
  let previousSignificant = ""
  for (let current = index; current < source.length; current++) {
    const char = source[current]
    const next = source[current + 1]
    if (isQuote(char)) {
      current = skipQuoted(source, current) - 1
      previousSignificant = "literal"
      continue
    }
    if (char === "/" && next === "/") {
      current = skipLineComment(source, current) - 1
      continue
    }
    if (char === "/" && next === "*") {
      current = skipBlockComment(source, current) - 1
      continue
    }
    if (char === "/" && (isRegexLiteralStart(previousSignificant) || isControlFlowRegexStart(source, current))) {
      current = skipRegexLiteral(source, current) - 1
      previousSignificant = "/"
      continue
    }
    if (char === open) {
      depth += 1
      previousSignificant = char
      continue
    }
    if (char === close && !(open === "<" && close === ">" && source[current - 1] === "=")) {
      depth -= 1
      if (depth === 0) return current
      previousSignificant = char
      continue
    }
    previousSignificant = trackSignificant(previousSignificant, char)
  }
}

export function splitTopLevel(source: string, separator = ",") {
  const parts: string[] = []
  let depth = 0
  let previousSignificant = ""
  let start = 0
  for (let index = 0; index < source.length; index++) {
    const char = source[index]
    const next = source[index + 1]
    if (isQuote(char)) {
      index = skipQuoted(source, index) - 1
      previousSignificant = "literal"
      continue
    }
    if (char === "/" && next === "/") {
      index = skipLineComment(source, index) - 1
      continue
    }
    if (char === "/" && next === "*") {
      index = skipBlockComment(source, index) - 1
      continue
    }
    if (char === "/" && (isRegexLiteralStart(previousSignificant) || isControlFlowRegexStart(source, index))) {
      index = skipRegexLiteral(source, index) - 1
      previousSignificant = "/"
      continue
    }
    if (char === "<") {
      const genericEnd = findMatching(source, index, "<", ">")
      if (genericEnd !== undefined && nextNonWhitespace(source, genericEnd + 1) === "(") {
        index = genericEnd
        previousSignificant = ">"
        continue
      }
    }
    if (char === "(" || char === "{" || char === "[") {
      depth += 1
      previousSignificant = char
      continue
    }
    if (char === ")" || char === "}" || char === "]") {
      depth -= 1
      previousSignificant = char
      continue
    }
    if (char === separator && depth === 0) {
      parts.push(source.slice(start, index).trim())
      start = index + 1
      continue
    }
    previousSignificant = trackSignificant(previousSignificant, char)
  }
  parts.push(source.slice(start).trim())
  return parts
}

export function findIdentifierCalls(source: string, name: string): IdentifierCall[] {
  const calls: IdentifierCall[] = []
  let previousSignificant = ""
  for (let index = 0; index < source.length; index++) {
    const char = source[index]
    const next = source[index + 1]
    if (isQuote(char)) {
      index = skipQuoted(source, index) - 1
      previousSignificant = "literal"
      continue
    }
    if (char === "/" && next === "/") {
      index = skipLineComment(source, index) - 1
      continue
    }
    if (char === "/" && next === "*") {
      index = skipBlockComment(source, index) - 1
      continue
    }
    if (char === "/" && (isRegexLiteralStart(previousSignificant) || isControlFlowRegexStart(source, index))) {
      index = skipRegexLiteral(source, index) - 1
      previousSignificant = "/"
      continue
    }
    if (
      !source.startsWith(name, index)
      || isIdentifierChar(source[index - 1])
      || isIdentifierChar(source[index + name.length])
      || isFunctionDeclarationName(source, index)
      || isMemberAccessName(source, index)
    ) {
      previousSignificant = trackSignificant(previousSignificant, char)
      continue
    }

    let openParen = skipWhitespaceAndComments(source, index + name.length)
    if (source[openParen] === "<") {
      const genericEnd = findMatching(source, openParen, "<", ">")
      if (genericEnd === undefined) {
        previousSignificant = trackSignificant(previousSignificant, char)
        continue
      }
      openParen = skipWhitespaceAndComments(source, genericEnd + 1)
    }
    if (source[openParen] !== "(") {
      previousSignificant = trackSignificant(previousSignificant, char)
      continue
    }

    const closeParen = findMatching(source, openParen, "(", ")")
    if (closeParen === undefined) {
      previousSignificant = trackSignificant(previousSignificant, char)
      continue
    }
    if (isMethodDeclarationName(source, index, closeParen)) {
      previousSignificant = trackSignificant(previousSignificant, char)
      continue
    }
    calls.push({
      arguments: splitTopLevel(source.slice(openParen + 1, closeParen)),
      closeParen,
      name,
      openParen,
      start: index,
    })
    previousSignificant = ")"
    index = closeParen
  }
  return calls
}

export function findDefaultExportCall(source: string, names: string[]): DefaultExportCall | undefined {
  const masked = maskSourceLiterals(source)
  const calls = names
    .flatMap(name => findIdentifierCalls(source, name))
    .sort((left, right) => left.start - right.start)

  for (const call of calls) {
    const callArgument = stripBoundaryComments(call.arguments[0] || "")
    if (!callArgument.startsWith("{")) continue
    const objectEnd = findMatching(callArgument, 0, "{", "}")
    if (objectEnd === undefined) continue
    const suffix = stripBoundaryComments(callArgument.slice(objectEnd + 1))
    if (suffix && !/^(?:as|satisfies)\b/.test(suffix)) continue
    const argument = callArgument.slice(0, objectEnd + 1)
    if (/\bexport\s+default\s*(?:\(\s*)*$/.test(masked.slice(0, call.start))) {
      return { ...call, argument }
    }
  }
}

export function readObjectProperty(objectSource: string, propertyName: string): string | undefined {
  const normalized = stripBoundaryComments(objectSource)
  if (!normalized.startsWith("{") || !normalized.endsWith("}")) return
  for (const property of splitTopLevel(normalized.slice(1, -1))) {
    const parts = splitTopLevel(property, ":")
    if (parts.length < 2) continue
    const key = stripBoundaryComments(parts.shift()!).replace(/^["'`](.*)["'`]$/s, "$1")
    if (key === propertyName) return stripBoundaryComments(parts.join(":"))
  }
}
