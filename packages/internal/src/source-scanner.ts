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

type ControlFlowRegexCache = Map<number, boolean | undefined>
type JsxElement = { end: number, expressions: { start: number, end: number }[] }
const jsxElements = new WeakMap<ControlFlowRegexCache, { source: string, results: Map<number, JsxElement | undefined> }>()
const sourceSyntaxes = new WeakMap<ControlFlowRegexCache, "jsx" | "tsx">()

function createControlFlowRegexCache(syntax?: "jsx" | "tsx"): ControlFlowRegexCache {
  const context: ControlFlowRegexCache = new Map()
  if (syntax) sourceSyntaxes.set(context, syntax)
  return context
}

/** Bind file grammar once and retain it while scanning source fragments. */
export function createSourceScanner(file = "") {
  const syntax = /\.(?:c|m)?tsx$/i.test(file) ? "tsx" : /\.(?:c|m)?jsx$/i.test(file) ? "jsx" : undefined
  return {
    stripBoundaryComments: (source: string) => stripBoundaryCommentsWithContext(source, createControlFlowRegexCache(syntax)),
    maskSourceLiterals: (source: string) => maskSourceLiteralsWithContext(source, createControlFlowRegexCache(syntax)),
    findMatching: (source: string, index: number, open: string, close: string) => findMatchingWithContext(source, index, open, close, createControlFlowRegexCache(syntax)),
    splitTopLevel: (source: string, separator = ",") => splitTopLevelWithContext(source, separator, createControlFlowRegexCache(syntax)),
    findIdentifierCalls: (source: string, name: string) => findIdentifierCallsWithContext(source, name, createControlFlowRegexCache(syntax)),
    findDefaultExportCall: (source: string, names: string[], options: { positionalOptionsIndex?: number } = {}) => findDefaultExportCallWithContext(source, names, options, createControlFlowRegexCache(syntax)),
    readObjectPropertyNames: (source: string) => readObjectPropertyNamesWithContext(source, createControlFlowRegexCache(syntax)),
    readObjectProperty: (source: string, property: string) => readObjectPropertyWithContext(source, property, createControlFlowRegexCache(syntax)),
  }
}

export const {
  stripBoundaryComments,
  maskSourceLiterals,
  findMatching,
  splitTopLevel,
  findIdentifierCalls,
  findDefaultExportCall,
  readObjectPropertyNames,
  readObjectProperty,
} = createSourceScanner()

function skipQuoted(source: string, index: number, controlFlowRegexes = new Map<number, boolean | undefined>()) {
  const quote = source[index]
  if (quote === "`") return skipTemplateLiteral(source, index, controlFlowRegexes)
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

function skipTemplateLiteral(source: string, index: number, controlFlowRegexes: ControlFlowRegexCache): number {
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
    const jsxEnd = skipJsxLiteral(source, index, previousSignificant, controlFlowRegexes)
    if (jsxEnd !== undefined) {
      index = jsxEnd
      previousSignificant = "literal"
      continue
    }
    if (char === "\"" || char === "'") {
      index = skipQuoted(source, index, controlFlowRegexes)
      previousSignificant = "literal"
      continue
    }
    if (char === "`") {
      index = skipTemplateLiteral(source, index, controlFlowRegexes)
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
    if (char === "/" && (isRegexLiteralStart(source, index, previousSignificant, controlFlowRegexes) || isControlFlowRegexStart(source, index, controlFlowRegexes))) {
      index = skipRegexLiteral(source, index)
      previousSignificant = "literal"
      continue
    }
    if (char === "{") expressionDepth += 1
    if (char === "}") expressionDepth -= 1
    previousSignificant = trackSignificant(previousSignificant, char)
    index += 1
  }
  return index
}

function isLineTerminator(char: string | undefined) {
  return char === "\n" || char === "\r" || char === "\u2028" || char === "\u2029"
}

function skipLineComment(source: string, index: number) {
  for (let current = index + 2; current < source.length; current++) {
    if (isLineTerminator(source[current])) return current + 1
  }
  return source.length
}

function skipBlockComment(source: string, index: number) {
  const end = source.indexOf("*/", index + 2)
  return end === -1 ? source.length : end + 2
}

function isIdentifierChar(char: string | undefined) {
  return !!char && /[\p{ID_Continue}$]/u.test(char)
}

function isIdentifierStart(char: string | undefined) {
  return !!char && /[\p{ID_Start}_$]/u.test(char)
}

function decodeIdentifier(identifier: string) {
  return identifier.replace(/\\u\{([\da-f]{1,6})\}|\\u([\da-f]{4})/gi, (escape, braced, plain) => {
    const codePoint = Number.parseInt(braced ?? plain, 16)
    return Number.isInteger(codePoint) && codePoint <= 0x10FFFF ? String.fromCodePoint(codePoint) : escape
  })
}

function identifierCodePoint(source: string, index: number) {
  const char = source[index]
  const next = source[index + 1]
  const previous = source[index - 1]
  if (char && /[\uDC00-\uDFFF]/.test(char) && previous && /[\uD800-\uDBFF]/.test(previous)) return previous + char
  return char && next && /[\uD800-\uDBFF]/.test(char) && /[\uDC00-\uDFFF]/.test(next) ? char + next : char
}

function isIdentifierCharAt(source: string, index: number) {
  return isIdentifierChar(identifierCodePoint(source, index))
}

function previousIdentifierIndex(source: string, index: number) {
  // Escapes occupy up to ten source characters but form one identifier code point.
  const escape = /\\u(?:\{[\da-f]{1,6}\}|[\da-f]{4})$/iu.exec(source.slice(Math.max(0, index - 9), index + 1))
  if (escape) return index - escape[0].length
  return isIdentifierCharAt(source, index) ? index - (identifierCodePoint(source, index)?.length ?? 1) : undefined
}

function isRegexLiteralStart(source: string, index: number, previousSignificant: string, controlFlowRegexes: ControlFlowRegexCache = new Map()): boolean {
  const token = previousSignificant.trimEnd()
  if (/^\.[\w$]+$/.test(token)) return false
  if (token === "+" || token === "-" || token === "of") {
    const cached = controlFlowRegexes.get(index)
    if (cached !== undefined) return cached
    if (controlFlowRegexes.has(index)) return true
    controlFlowRegexes.set(index, undefined)
    try {
      const previous = previousCodeIndex(source, index - 1, controlFlowRegexes)
      const result = token === "of"
        ? isLabeledStatementRegexStart(source, index, previous, controlFlowRegexes) || isForOfRegexStart(source, index, controlFlowRegexes)
        : !endsWithPostfixUpdate(source, previous, token, controlFlowRegexes)
      controlFlowRegexes.set(index, result)
      return result
    }
    catch (error) {
      controlFlowRegexes.delete(index)
      throw error
    }
  }
  if (!token || token === "/" || /[({[=,:!&|?;<>+\-*%^~]/.test(token)) return true
  if (token === ".") {
    const end = previousCodeIndex(source, index - 1, controlFlowRegexes)
    return source.slice(end - 2, end + 1) === "..."
  }
  const keyword = /\b(?:await|break|case|continue|debugger|delete|do|else|extends|in|instanceof|new|return|throw|typeof|void|yield)$/.exec(token)?.[0]
  if (!keyword) return false
  const end = previousCodeIndex(source, index - 1, controlFlowRegexes)
  const start = end - keyword.length + 1
  return source.slice(start, end + 1) === keyword
    && !/[$\p{ID_Continue}\u200C\u200D]$/u.test(source.slice(0, start))
    && !/[.#]/.test(source[previousCodeIndex(source, start - 1, controlFlowRegexes)] ?? "")
}

function endsWithPostfixUpdate(source: string, index: number, sign: string, controlFlowRegexes: ControlFlowRegexCache) {
  let count = 0
  while (source[index - count] === sign) count += 1
  // Update operators consume pairs; an odd trailing sign starts a new expression.
  if (count === 0 || count % 2 !== 0) return false
  const start = index - count + 1
  let contextStart = start
  let previous = previousCodeIndex(source, start - 1, controlFlowRegexes)
  // Non-null assertions retain the context of their operand.
  while (source[previous] === "!") {
    contextStart = previous
    previous = previousCodeIndex(source, previous - 1, controlFlowRegexes)
  }
  if (/[\r\n\u2028\u2029]/.test(source.slice(previous + 1, start))) return false
  const token = /[$\p{ID_Continue}\u200C\u200D]+$/u.exec(source.slice(0, previous + 1))?.[0] ?? source[previous] ?? ""
  return !isRegexLiteralStart(source, contextStart, token, controlFlowRegexes)
    && !isControlFlowRegexStart(source, contextStart, controlFlowRegexes)
}

function isForOfRegexStart(source: string, index: number, controlFlowRegexes: ControlFlowRegexCache): boolean {
  const operatorEnd = previousCodeIndex(source, index - 1, controlFlowRegexes)
  if (!/(?:^|[^$\p{ID_Continue}\u200C\u200D])of$/u.test(source.slice(0, operatorEnd + 1))) return false
  let current = previousCodeIndex(source, operatorEnd - 2, controlFlowRegexes)
  if (!/(?:[$\p{ID_Continue}\])}]|\u200C|\u200D)$/u.test(source.slice(0, current + 1))) return false
  const word = /[$\p{ID_Continue}\u200C\u200D]+$/u.exec(source.slice(0, current + 1))?.[0]
  if (word && /^(?:as|satisfies|const|let|var|in|instanceof|typeof|void|delete|await|yield|new)$/.test(word)
    && source[previousCodeIndex(source, current - word.length, controlFlowRegexes)] !== ".") return false

  while (current >= 0) {
    const char = source[current]
    if (char === ";" || char === "{") return false
    if (char === "(") {
      let headEnd = previousCodeIndex(source, current - 1, controlFlowRegexes)
      if (/\bawait$/.test(source.slice(0, headEnd + 1))) {
        headEnd = previousCodeIndex(source, headEnd - 5, controlFlowRegexes)
      }
      return /(?:^|[^$\p{ID_Continue}\u200C\u200D])for$/u.test(source.slice(0, headEnd + 1))
    }
    const open = char === ")" ? "(" : char === "]" ? "[" : char === "}" ? "{" : undefined
    if (open) {
      let start = current - 1
      while (start >= 0 && (source[start] !== open || findMatchingWithContext(source, start, open, char, controlFlowRegexes) !== current)) start -= 1
      if (start < 0) return false
      current = start
    }
    current = previousCodeIndex(source, current - 1, controlFlowRegexes)
  }
  return false
}

function findLineCommentStart(source: string, start: number, end: number, controlFlowRegexes: ControlFlowRegexCache) {
  for (let index = start; index <= end;) {
    const char = source[index]
    const next = source[index + 1]
    if (isQuote(char)) {
      index = skipQuoted(source, index, controlFlowRegexes)
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

function previousCodeIndex(source: string, index: number, controlFlowRegexes: ControlFlowRegexCache) {
  let current = index
  while (current >= 0) {
    while (/\s/.test(source[current] ?? "")) current--
    if (source[current] === "/" && source[current - 1] === "*") {
      const start = source.lastIndexOf("/*", current - 2)
      if (start === -1) return current
      current = start - 1
      continue
    }
    let lineStart = current
    while (lineStart > 0 && !isLineTerminator(source[lineStart - 1])) lineStart -= 1
    const lineComment = findLineCommentStart(source, lineStart, current, controlFlowRegexes)
    if (lineComment !== -1 && lineComment <= current) {
      current = lineComment - 1
      continue
    }
    return current
  }
  return current
}

function isControlFlowRegexStart(source: string, index: number, controlFlowRegexes = new Map<number, boolean | undefined>()) {
  const cached = controlFlowRegexes.get(index)
  if (cached !== undefined) return cached
  // A template rescan can revisit the slash whose classification initiated it; treating that candidate as a regex breaks the cycle while completed classifications prevent repeated rescans.
  if (controlFlowRegexes.has(index)) return true
  controlFlowRegexes.set(index, undefined)
  try {
    const closeParen = previousCodeIndex(source, index - 1, controlFlowRegexes)
    if (isLabeledStatementRegexStart(source, index, closeParen, controlFlowRegexes)) {
      controlFlowRegexes.set(index, true)
      return true
    }
    if (isModuleDeclarationRegexStart(source, index, closeParen, controlFlowRegexes)) {
      controlFlowRegexes.set(index, true)
      return true
    }
    if (source[closeParen] === "}") {
      const result = isStatementBlockRegexStart(source, closeParen, controlFlowRegexes)
      controlFlowRegexes.set(index, result)
      return result
    }
    if (source[closeParen] !== ")") {
      controlFlowRegexes.set(index, false)
      return false
    }

    for (let current = closeParen; current >= 0; current--) {
      if (source[current] !== "(") continue
      if (findMatchingWithContext(source, current, "(", ")", controlFlowRegexes) !== closeParen) continue
      const head = source.slice(0, current).replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n\u2028\u2029]*/g, " ")
      const keywordEnd = previousCodeIndex(source, current - 1, controlFlowRegexes)
      const keyword = /(?:^|[^$\p{ID_Continue}\u200C\u200D])(catch|for|if|while|with|switch)$/u.exec(source.slice(0, keywordEnd + 1))?.[1]
      const controlHead = keyword && !/[.#]/.test(source[previousCodeIndex(source, keywordEnd - keyword.length, controlFlowRegexes)] ?? "")
      const result = !!controlHead && (keyword !== "switch" || source[index] === "{")
        || source[index] === "{" && /(?:^|[;{}])\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s*\*?\s*(?:[$_\p{ID_Start}][$\p{ID_Continue}\u200C\u200D]*)?\s*$/u.test(head)
      controlFlowRegexes.set(index, result)
      return result
    }

    controlFlowRegexes.set(index, false)
    return false
  }
  catch (error) {
    controlFlowRegexes.delete(index)
    throw error
  }
}

function isModuleDeclarationRegexStart(source: string, index: number, previous: number, controlFlowRegexes: ControlFlowRegexCache) {
  if (!/[\r\n\u2028\u2029]/.test(source.slice(previous + 1, index))) return false
  if (source[previous] !== "}" && source[previous] !== "\"" && source[previous] !== "'") return false
  const head = maskSourceLiteralsWithContext(source.slice(0, previous + 1), controlFlowRegexes)
  const module = /(?:^|[;{}\r\n\u2028\u2029])\s*(?:import(?![$\p{ID_Continue}\u200C\u200D])(?:\s*(?:type(?![$\p{ID_Continue}\u200C\u200D])\s*)?(?:[$_\p{ID_Start}][$\p{ID_Continue}\u200C\u200D]*(?:\s*,\s*(?:\{[^{}]*\}|\*\s*as\s+[$_\p{ID_Start}][$\p{ID_Continue}\u200C\u200D]*))?|\{[^{}]*\}|\*\s*as\s+[$_\p{ID_Start}][$\p{ID_Continue}\u200C\u200D]*)\s*(?<![$\p{ID_Continue}\u200C\u200D])from)?|export(?![$\p{ID_Continue}\u200C\u200D])\s*(?:type(?![$\p{ID_Continue}\u200C\u200D])\s*)?(?:\*(?:\s*as\s+[$_\p{ID_Start}][$\p{ID_Continue}\u200C\u200D]*)?|\{[^{}]*\})\s*(?<![$\p{ID_Continue}\u200C\u200D])from)\s*(?:\b(?:with|assert)\s*\{[^{}]*\})?\s*$/u.exec(head)
  const declaration = module ?? /(?:^|[;{}\r\n\u2028\u2029])\s*export(?![$\p{ID_Continue}\u200C\u200D])\s*(?:type(?![$\p{ID_Continue}\u200C\u200D])\s*)?\{[^{}]*\}\s*$/u.exec(head)
  if (!declaration) return false
  const start = declaration.index + declaration[0].search(/import|export/)
  if (source[previousCodeIndex(source, start - 1, controlFlowRegexes)] === ".") return false
  let depth = 0
  let specifiers = 0
  let specifierEnd = start
  for (let current = start; current <= previous; current++) {
    const char = source[current]
    if (isQuote(char)) {
      const end = skipQuoted(source, current, controlFlowRegexes)
      if (depth === 0) {
        if (char === "`") return false
        specifiers += 1
        if (specifiers > 1) return false
        specifierEnd = end
      }
      current = end - 1
    }
    else if (char === "/" && source[current + 1] === "/") current = skipLineComment(source, current) - 1
    else if (char === "/" && source[current + 1] === "*") current = skipBlockComment(source, current) - 1
    else if (char === "/") return false
    else if (char === "{") depth += 1
    else if (char === "}") depth -= 1
  }
  return module
    ? specifiers === 1 && /^\s*(?:(?:with|assert)\s*\{[^{}]*\})?\s*$/.test(head.slice(specifierEnd))
    : specifiers === 0
}

function isStatementBlockRegexStart(source: string, closeBrace: number, controlFlowRegexes: ControlFlowRegexCache): boolean {
  for (let openBrace = closeBrace - 1; openBrace >= 0; openBrace--) {
    if (source[openBrace] !== "{" || findMatchingWithContext(source, openBrace, "{", "}", controlFlowRegexes) !== closeBrace) continue
    const previous = previousCodeIndex(source, openBrace - 1, controlFlowRegexes)
    if (source[previous] === "{" && source[previous - 1] === "$") return false
    if (previous < 0 || /[;{}]/.test(source[previous] ?? "")) return true
    const head = source.slice(0, previous + 1)
    if (/(?:^|[^$\p{ID_Continue}\u200C\u200D])(?:do|else|finally|try)$/u.test(head)) return true
    if (isDeclarationBlockStart(source, openBrace, controlFlowRegexes)) return true
    return isControlFlowRegexStart(source, openBrace, controlFlowRegexes)
  }
  return false
}

function maskDeclarationTypeParameters(source: string, head: string, controlFlowRegexes: ControlFlowRegexCache) {
  let start: number | undefined
  let end: number | undefined
  let masked: string | undefined
  for (const generic of head.matchAll(/(?<![$\p{ID_Continue}\u200C\u200D])(?:function\s*\*?\s*(?:[$_\p{ID_Start}][$\p{ID_Continue}\u200C\u200D]*)?|class(?:\s+[$_\p{ID_Start}][$\p{ID_Continue}\u200C\u200D]*)?|(?:interface|type)\s+[$_\p{ID_Start}][$\p{ID_Continue}\u200C\u200D]*)\s*</gu)) {
    const next = generic.index + generic[0].length - 1
    // Ignore candidate keywords inside type parameters that were already read.
    if (end !== undefined && next <= end) continue
    if (isMemberAccessName(head, generic.index)) continue
    masked ??= maskSourceLiteralsWithContext(head, controlFlowRegexes)
    if (masked[generic.index] !== head[generic.index]) continue
    const close = findMatchingWithContext(source, next, "<", ">", controlFlowRegexes)
    if (close === undefined || close >= head.length) continue
    start = next
    end = close
  }
  if (start === undefined || end === undefined) return head
  return head.slice(0, start) + head.slice(start, end + 1).replace(/[^\r\n\u2028\u2029]/g, " ") + head.slice(end + 1)
}

function isDeclarationBlockStart(source: string, openBrace: number, controlFlowRegexes: ControlFlowRegexCache) {
  let head = source.slice(0, openBrace).replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n\u2028\u2029]*/g, comment => comment.replace(/[^\r\n\u2028\u2029]/g, " "))
  head = maskDeclarationTypeParameters(source, head, controlFlowRegexes)
  const declaration = /(?<![$\p{ID_Continue}\u200C\u200D])(?:(?:async\s+)?function\s*\*?\s*(?:[$_\p{ID_Start}][$\p{ID_Continue}\u200C\u200D]*)?\s*\([^{}]*\)(?:\s*:[^;{}]+)?|class(?:\s+[$_\p{ID_Start}][$\p{ID_Continue}\u200C\u200D]*)?(?:\s+extends\s+[^;{}]+)?|interface\s+[$_\p{ID_Start}][$\p{ID_Continue}\u200C\u200D]*(?:\s+extends\s+[^;{}]+)?|(?:const\s+)?enum\s+[$_\p{ID_Start}][$\p{ID_Continue}\u200C\u200D]*|(?:namespace|module)\s+[$_\p{ID_Start}][$\p{ID_Continue}\u200C\u200D]*(?:\s*\.\s*[$_\p{ID_Start}][$\p{ID_Continue}\u200C\u200D]*)*|type\s+[$_\p{ID_Start}][$\p{ID_Continue}\u200C\u200D]*\s*=)\s*$/u.exec(head)
  if (!declaration) return false
  const { before, end } = declarationPrefix(source, head, declaration.index, controlFlowRegexes)
  if (/[=([,:?!&|+\-*/%^~<>.]$/.test(before)) return false
  if (/(?:^|[^.$\p{ID_Continue}\u200C\u200D])(?:await|delete|in|instanceof|new|typeof|void)$/u.test(before)) return false
  if (before && !/[;{}]$/.test(before) && !/[\r\n\u2028\u2029]/.test(head.slice(end, declaration.index))) return false
  const keyword = /\b(?:class|function|interface|enum|namespace|module|type)\b/.exec(declaration[0])
  if (!keyword) return false
  const keywordStart = declaration.index + keyword.index
  return maskSourceLiteralsWithContext(source.slice(0, keywordStart + keyword[0].length), controlFlowRegexes).slice(keywordStart) === keyword[0]
}

function declarationPrefix(source: string, head: string, offset: number, controlFlowRegexes: ControlFlowRegexCache) {
  let end = previousCodeIndex(source, offset - 1, controlFlowRegexes) + 1
  while (end > 0) {
    const decorator = findDecoratorStart(source, head, end - 1, controlFlowRegexes)
    if (decorator !== undefined) {
      end = previousCodeIndex(source, decorator - 1, controlFlowRegexes) + 1
      continue
    }
    const modifier = /(?:^|[^.$\p{ID_Continue}\u200C\u200D])(export(?:\s+default)?|declare|abstract)$/u.exec(head.slice(0, end))?.[1]
    if (!modifier || source[previousCodeIndex(source, end - modifier.length - 1, controlFlowRegexes)] === ".") break
    end = previousCodeIndex(source, end - modifier.length - 1, controlFlowRegexes) + 1
  }
  return { before: head.slice(0, end).trimEnd(), end }
}

function findDecoratorStart(source: string, head: string, end: number, controlFlowRegexes: ControlFlowRegexCache): number | undefined {
  let current = end
  while (current >= 0) {
    if (source[current] === ")" || source[current] === ">") {
      const close = source[current]
      const open = close === ")" ? "(" : "<"
      let start = current - 1
      while (start >= 0 && (source[start] !== open || findMatchingWithContext(source, start, open, close, controlFlowRegexes) !== current)) start -= 1
      if (start < 0) return
      current = previousCodeIndex(source, start - 1, controlFlowRegexes)
      if (source[current] === "@") return current
      continue
    }
    else {
      const identifier = /[$_\p{ID_Start}][$\p{ID_Continue}\u200C\u200D]*$/u.exec(head.slice(0, current + 1))?.[0]
      if (!identifier) return
      current = previousCodeIndex(source, current - identifier.length, controlFlowRegexes)
    }
    if (source[current] === "@") return current
    if (source[current] === ".") current = previousCodeIndex(source, current - 1, controlFlowRegexes)
    else if (source[current] !== ")") return
  }
}

function isLabeledStatementRegexStart(source: string, index: number, labelEnd: number, controlFlowRegexes: ControlFlowRegexCache) {
  if (!/[\r\n\u2028\u2029]/.test(source.slice(labelEnd + 1, index))) return false
  const label = /[$\p{ID_Continue}\u200C\u200D]+$/u.exec(source.slice(0, labelEnd + 1))?.[0]
  if (!label) return false
  const labelStart = labelEnd - label.length + 1
  const statementEnd = previousCodeIndex(source, labelStart - 1, controlFlowRegexes)
  if (/[\r\n\u2028\u2029]/.test(source.slice(statementEnd + 1, labelStart))) return false
  return /(?:^|[^$\p{ID_Continue}\u200C\u200D])(?:break|continue)$/u.test(source.slice(0, statementEnd + 1))
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

function skipJsxLiteral(source: string, index: number, previousSignificant: string, controlFlowRegexes: ControlFlowRegexCache): number | undefined {
  if (source[index] !== "<") return
  const syntax = sourceSyntaxes.get(controlFlowRegexes)
  if (!syntax) return
  if (!isRegexLiteralStart(source, index, previousSignificant, controlFlowRegexes) && !isControlFlowRegexStart(source, index, controlFlowRegexes)) return
  if (syntax === "tsx" && isTypeParameterHead(source, index)) return
  return skipJsxElement(source, index, controlFlowRegexes)
}

function isTypeParameterHead(source: string, index: number): boolean {
  let start = index + 1
  if (/^const(?![$\p{ID_Continue}\u200C\u200D])/u.test(source.slice(start))) start = skipWhitespaceAndComments(source, start + "const".length)
  const name = /^[$_\p{ID_Start}][$\p{ID_Continue}\u200C\u200D]*/u.exec(source.slice(start))
  if (!name) return false
  const next = skipWhitespaceAndComments(source, start + name[0].length)
  if (source[next] === "=" || source[next] === ",") return true
  if (!/^extends(?![$\p{ID_Continue}\u200C\u200D])/u.test(source.slice(next))) return false
  const constraint = skipWhitespaceAndComments(source, next + "extends".length)
  return constraint < source.length && source[constraint] !== "=" && source[constraint] !== ">" && source[constraint] !== "/"
}

function skipJsxElement(source: string, index: number, controlFlowRegexes: ControlFlowRegexCache): number | undefined {
  let cached = jsxElements.get(controlFlowRegexes)
  // Prefix rescans share the context, but JSX offsets belong to one source.
  if (!cached || cached.source !== source) {
    cached = { source, results: new Map() }
    jsxElements.set(controlFlowRegexes, cached)
  }
  if (cached.results.has(index)) return cached.results.get(index)?.end
  const element = readJsxElement(source, index, controlFlowRegexes)
  cached.results.set(index, element)
  jsxElements.set(controlFlowRegexes, cached)
  return element?.end
}

function readJsxElement(source: string, index: number, controlFlowRegexes: ControlFlowRegexCache): JsxElement | undefined {
  const tag = /^<([$_\p{ID_Start}][-$.:\p{ID_Continue}\u200C\u200D]*)?(?=[\s/<>])/u.exec(source.slice(index))
  if (!tag) return
  const name = tag[1] ?? ""
  const expressions: JsxElement["expressions"] = []
  let current = index + tag[0].length
  if (name && sourceSyntaxes.get(controlFlowRegexes) === "tsx") {
    const typeArguments = skipWhitespaceAndComments(source, current)
    if (source[typeArguments] === "<") {
      const end = findMatchingWithContext(source, typeArguments, "<", ">", controlFlowRegexes)
      if (end === undefined) return
      current = end + 1
    }
  }
  if (!name && source[skipWhitespaceAndComments(source, current)] !== ">") return
  while (current < source.length && source[current] !== ">") {
    current = skipWhitespaceAndComments(source, current)
    if (source[current] === ">") break
    if (source[current] === "\"" || source[current] === "'") {
      const end = source.indexOf(source[current], current + 1)
      if (end === -1) return
      current = end + 1
    }
    else if (source[current] === "{") {
      const end = findMatchingWithContext(source, current, "{", "}", controlFlowRegexes)
      if (end === undefined) return
      expressions.push({ start: current, end })
      current = end + 1
    }
    else if (source[current] === "/") {
      const end = skipWhitespaceAndComments(source, current + 1)
      return source[end] === ">" ? { end: end + 1, expressions } : undefined
    }
    else if (source[current] === "<") {
      const end = skipJsxElement(source, current, controlFlowRegexes)
      if (end === undefined) return
      const child = jsxElements.get(controlFlowRegexes)
      if (child?.source === source) expressions.push(...child.results.get(current)?.expressions ?? [])
      current = end
    }
    else current += 1
  }
  if (source[current] !== ">") return
  current += 1
  if (!source.includes(`</${name}`, current)) return
  while (current < source.length) {
    if (source.startsWith("</", current)) {
      const closing = /^<\/([$_\p{ID_Start}][-$.:\p{ID_Continue}\u200C\u200D]*)?(?=[\s/>])/u.exec(source.slice(current))
      if (!closing || (closing[1] ?? "") !== name) return
      const end = skipWhitespaceAndComments(source, current + closing[0].length)
      return source[end] === ">" ? { end: end + 1, expressions } : undefined
    }
    if (source[current] === "<") {
      const end = skipJsxElement(source, current, controlFlowRegexes)
      if (end === undefined) return
      const child = jsxElements.get(controlFlowRegexes)
      if (child?.source === source) expressions.push(...child.results.get(current)?.expressions ?? [])
      current = end
    }
    else if (source[current] === "{") {
      const end = findMatchingWithContext(source, current, "{", "}", controlFlowRegexes)
      if (end === undefined) return
      expressions.push({ start: current, end })
      current = end + 1
    }
    else current += 1
  }
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

function stripBoundaryCommentsWithContext(source: string, controlFlowRegexes: ControlFlowRegexCache): string {
  const start = skipWhitespaceAndComments(source, 0)
  let end = start
  let previousSignificant = ""
  for (let index = start; index < source.length;) {
    const char = source[index]
    const next = source[index + 1]
    if (/\s/.test(char ?? "")) {
      previousSignificant = trackSignificant(previousSignificant, char)
      index += 1
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
    const jsxEnd = skipJsxLiteral(source, index, previousSignificant, controlFlowRegexes)
    if (jsxEnd !== undefined) {
      index = jsxEnd
      previousSignificant = "literal"
    }
    else if (isQuote(char)) {
      index = skipQuoted(source, index, controlFlowRegexes)
      previousSignificant = "literal"
    }
    else if (char === "/" && (isRegexLiteralStart(source, index, previousSignificant, controlFlowRegexes) || isControlFlowRegexStart(source, index, controlFlowRegexes))) {
      index = skipRegexLiteral(source, index)
      previousSignificant = "literal"
    }
    else {
      previousSignificant = trackSignificant(previousSignificant, char)
      index += 1
    }
    end = index
  }
  return source.slice(start, end)
}

function maskSourceLiteralsWithContext(source: string, controlFlowRegexes: ControlFlowRegexCache): string {
  const output = source.split("")
  let previousSignificant = ""
  const mask = (start: number, end: number) => {
    for (let index = start; index < end; index++) {
      if (!isLineTerminator(output[index])) output[index] = " "
    }
  }

  for (let index = 0; index < source.length;) {
    const char = source[index]
    const next = source[index + 1]
    let end = skipJsxLiteral(source, index, previousSignificant, controlFlowRegexes)
    if (end !== undefined) previousSignificant = "literal"
    else if (isQuote(char)) {
      end = skipQuoted(source, index, controlFlowRegexes)
      previousSignificant = "literal"
    }
    else if (char === "/" && next === "/") end = skipLineComment(source, index)
    else if (char === "/" && next === "*") end = skipBlockComment(source, index)
    else if (char === "/" && (isRegexLiteralStart(source, index, previousSignificant, controlFlowRegexes) || isControlFlowRegexStart(source, index, controlFlowRegexes))) {
      end = skipRegexLiteral(source, index)
      previousSignificant = "literal"
    }
    if (end !== undefined) {
      if (sourceSyntaxes.has(controlFlowRegexes) && source[index] === "<") maskJsxElement(source, index, end, output, controlFlowRegexes)
      else mask(index, end)
      index = end
      continue
    }
    previousSignificant = trackSignificant(previousSignificant, char)
    index += 1
  }
  return output.join("")
}

function maskJsxElement(source: string, start: number, end: number, output: string[], controlFlowRegexes: ControlFlowRegexCache) {
  const cached = jsxElements.get(controlFlowRegexes)
  const element = cached?.source === source ? cached.results.get(start) : undefined
  if (!element) return
  for (let index = start; index < end; index++) {
    if (!isLineTerminator(source[index])) output[index] = " "
  }
  for (const expression of element.expressions) {
    output[expression.start] = "{"
    const masked = maskSourceLiteralsWithContext(source.slice(expression.start + 1, expression.end), createControlFlowRegexCache(sourceSyntaxes.get(controlFlowRegexes)))
    for (let offset = 0; offset < masked.length; offset++) output[expression.start + 1 + offset] = masked[offset]
    output[expression.end] = "}"
  }
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

function findMatchingWithContext(source: string, index: number, open: string, close: string, controlFlowRegexes: ControlFlowRegexCache): number | undefined {
  let depth = 0
  let previousSignificant = ""
  for (let current = index; current < source.length; current++) {
    const char = source[current]
    const next = source[current + 1]
    const jsxEnd = open === "<" ? undefined : skipJsxLiteral(source, current, previousSignificant, controlFlowRegexes)
    if (jsxEnd !== undefined) {
      current = jsxEnd - 1
      previousSignificant = "literal"
      continue
    }
    if (isQuote(char)) {
      current = skipQuoted(source, current, controlFlowRegexes) - 1
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
    if (char === "/" && (isRegexLiteralStart(source, current, previousSignificant, controlFlowRegexes) || isControlFlowRegexStart(source, current, controlFlowRegexes))) {
      current = skipRegexLiteral(source, current) - 1
      previousSignificant = "literal"
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

function isAssertionTypeArguments(source: string, index: number, assertionSuffix = false) {
  // A relational expression whose left operand is a bigint literal can look
  // like a named generic (`1n < T, U >`). Reject it before backward scanning
  // reaches the trailing `n` identifier.
  if (/\d+n\s*$/u.test(source.slice(0, index))) return false
  // A conditional type constraint may be qualified (and may use a type
  // operator), for example `T extends Types.Promise<A, B>`. Keep the fast
  // path broad enough to mask its generic arguments before call splitting.
  const prefix = source.slice(0, index).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, " ")
  // A generic call signature has no name before its type parameters. Confirm
  // the parameter list and arrow before masking it as an assertion type.
  if (assertionSuffix && /\b(?:as|satisfies)\s+(?:\(\s*)*(?:new\s+)?$/.test(prefix)) {
    const typeParametersEnd = findMatching(source, index, "<", ">")
    if (typeParametersEnd !== undefined) {
      const parameters = skipWhitespaceAndComments(source, typeParametersEnd + 1)
      const parametersEnd = source[parameters] === "(" ? findMatching(source, parameters, "(", ")") : undefined
      if (parametersEnd !== undefined && source.startsWith("=>", skipWhitespaceAndComments(source, parametersEnd + 1))) return true
    }
  }
  // Once a return type continues past a completed generic, the preceding
  // arguments are masked before checking the next union/intersection member.
  // Check only the return after the last arrow so parameter annotations
  // do not interrupt predicate union/intersection continuation.
  if (/=>/.test(prefix) && /\b(?:as|satisfies)\b/.test(prefix)
    && hasAssertionTypePrefix(prefix.replace(/[\s\S]*=>/, "as "))) return true
  // Function and constructor assertion types place their return reference
  // after `=>`, so the generic is not directly adjacent to the assertion
  // keyword. Treat that return type as part of the assertion as well.
  if (/=>\s*(?:(?:asserts\s+)?[A-Za-z_$][\w$]*\s+is\s+)?(?:(?:keyof|readonly|typeof)\s+)*(?:[A-Za-z_$][\w$]*\s*\.\s*)*[A-Za-z_$][\w$]*\s*$/.test(prefix)
    && /\b(?:as|satisfies)\b/.test(prefix)) return true
  if (/\b(?:extends|implements)\s+(?:(?:keyof|readonly|typeof)\s+)*(?:[\p{ID_Start}_$][\p{ID_Continue}$]*\s*\.\s*)*[\p{ID_Start}_$][\p{ID_Continue}$]*$/u.test(prefix)
    && /\b(?:as|satisfies)\b/.test(source.slice(0, index))) return true
  const controlFlowRegexes: ControlFlowRegexCache = new Map()
  let current = previousCodeIndex(source, index - 1, controlFlowRegexes)
  let qualified = false
  let typeName = ""
  while (current >= 0) {
    const end = current + 1
    while (current >= 0) {
      const previous = previousIdentifierIndex(source, current)
      if (previous === undefined) break
      current = previous
    }
    const identifier = source.slice(current + 1, end)
    const decodedIdentifier = decodeIdentifier(identifier)
    if (!isIdentifierStart([...decodedIdentifier][0]) || [...decodedIdentifier].slice(1).some(char => !isIdentifierChar(char))) {
      // Import types qualify named references through import("module").Type.
      if (!qualified || source[current] !== ")") return false
      return assertionSuffix || hasAssertionTypePrefix(source.slice(0, index))
    }
    typeName = identifier
    current = previousCodeIndex(source, current, controlFlowRegexes)
    if (source[current] !== ".") break
    qualified = true
    current = previousCodeIndex(source, current - 1, controlFlowRegexes)
  }
  // Primitive type keywords end an assertion before a comparison, rather than
  // accepting type arguments like a named type reference does.
  if (!qualified && /^(?:any|bigint|boolean|const|false|never|null|number|object|string|symbol|this|true|undefined|unknown|void)$/.test(typeName)) return false
  // Assertion validation already knows the type boundary. Named references
  // can occur inside object, parenthesized, tuple, and import types there.
  if (assertionSuffix) return true
  if (source[current] === "&" || source[current] === "|") {
    return hasAssertionTypePrefix(source.slice(0, index))
  }
  if (source[current] === "(" && /\bis\s*$/u.test(source.slice(0, current))) {
    return hasAssertionTypePrefix(source.slice(0, current))
  }
  // Type operators can precede the generic reference. Walk back to
  // the assertion boundary with the same comment-aware token handling.
  let keyword: string
  do {
    const end = current + 1
    while (current >= 0 && isIdentifierCharAt(source, current)) current -= identifierCodePoint(source, current)?.length ?? 1
    keyword = source.slice(current + 1, end)
    if (keyword !== "keyof" && keyword !== "readonly" && keyword !== "typeof") break
    current = previousCodeIndex(source, current, controlFlowRegexes)
  } while (current >= 0)
  // Qualified names and unary operators have now been consumed. Both
  // conditional branches can start here; suffix validation checks that the
  // delimiters belong to a conditional type rather than a runtime ternary.
  if (source[current] === "?" || source[current] === ":") {
    return /\b(?:as|satisfies)\b/.test(source.slice(0, current))
  }
  return (keyword === "as" || keyword === "satisfies")
    && source[previousCodeIndex(source, current, controlFlowRegexes)] !== "."
}

function isNamedAssertionComparison(source: string, index: number, genericEnd: number) {
  const contents = source.slice(index + 1, genericEnd)
  // `as Foo < lower, upper > 0` is a relational expression. The spaces
  // around the apparent type arguments are a useful signal, while real type
  // continuations begin with punctuation such as `|`, `&`, or `[`.
  if (!/^\s/.test(contents) || !/\s$/.test(contents)) return false
  const prefix = source.slice(0, index)
  if (!/\b(?:as|satisfies)\s+[\p{ID_Start}_$][\p{ID_Continue}$]*(?:\s*\.\s*[\p{ID_Start}_$][\p{ID_Continue}$]*)*\s*$/u.test(prefix)) return false
  const suffix = source.slice(genericEnd + 1).replace(/^(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*\n)*/, "")
  return !/^(?:as|satisfies)\s+\S/u.test(suffix) && /^[\p{ID_Start}_$\d"'`]/u.test(suffix)
}

function hasAssertionTypePrefix(source: string) {
  // Mask completed type regions, including import arguments and comments,
  // before recognizing the continuation of a union or intersection.
  const prefix = decodeIdentifier(maskAssertionTypeArguments(source))
  return /(?:^|[^\p{ID_Continue}$.])(?:as|satisfies)\s+(?:[\p{ID_Start}_$][\p{ID_Continue}$]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(?:-\s*)?(?:0[xX][\da-fA-F_]+n?|0[bB][01_]+n?|0[oO][0-7_]+n?|\d[\d_]*n|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?)|[.\s()[\]{}&|?:])+$/u.test(prefix)
}

function maskAssertionTypeArguments(source: string) {
  const output = source.split("")
  for (let index = 0; index < source.length; index++) {
    if (isQuote(source[index])) {
      const end = skipQuoted(source, index)
      // Template-literal types can contain commas in `${...}` expressions.
      // Mask them only when they begin at a type delimiter; a template after
      // a complete assertion remains a runtime suffix and must stay visible.
      if (source[index] === "`" && /(?:\b(?:as|satisfies|extends|keyof|readonly)|=>|[?:|&])\s*$/.test(output.slice(0, index).join(""))) {
        output.fill(" ", index, end)
        // Keep a completed operand visible to runtime-suffix validation.
        output[index] = "T"
      }
      index = end - 1
      continue
    }
    if (source.startsWith("import", index) && !isIdentifierCharAt(source, index - 1)) {
      const open = skipWhitespaceAndComments(source, index + 6)
      if (source[open] === "(") {
        const argument = skipWhitespaceAndComments(source, open + 1)
        if (source[argument] === '"' || source[argument] === "'") {
          let close = skipWhitespaceAndComments(source, skipQuoted(source, argument))
          // Import types can carry an optional attributes object after the module.
          if (source[close] === ",") {
            const attributes = skipWhitespaceAndComments(source, close + 1)
            if (source[attributes] === "{") {
              const attributesEnd = findMatching(source, attributes, "{", "}")
              if (attributesEnd !== undefined) close = skipWhitespaceAndComments(source, attributesEnd + 1)
            }
          }
          if (source[close] === ")") {
            output.fill(" ", index + 6, close + 1)
            index = close
            continue
          }
        }
      }
    }
    let end: number | undefined
    if (source[index] === "/" && source[index + 1] === "/") end = skipLineComment(source, index)
    else if (source[index] === "/" && source[index + 1] === "*") end = skipBlockComment(source, index)
    else if (source[index] === "<" && isAssertionTypeArguments(source, index, true)) {
      const close = findMatching(source, index, "<", ">")
      if (close !== undefined) end = close + 1
    }
    if (end === undefined) continue
    output.fill(" ", index, end)
    index = end - 1
  }
  // Nested type syntax may contain commas, property separators, or function
  // signatures. Preserve its boundaries so runtime suffixes stay visible.
  const masked = output.join("")
  for (let index = 0; index < masked.length; index++) {
    // Parentheses can group runtime expressions as well as types. Inspect
    // their contents; function parameters are masked separately below.
    const close = masked[index] === "{" ? "}" : masked[index] === "[" ? "]" : undefined
    if (!close) continue
    const prefix = masked.slice(0, index).trimEnd()
    // Function and constructor return types can start with a structural
    // region. Keep runtime suffixes outside that region visible.
    if (!/(?:\b(?:as|satisfies|extends|keyof|readonly)|[&|?:(]|=>)$/.test(prefix)) continue
    const end = findMatching(masked, index, masked[index]!, close)
    if (end === undefined) continue
    output.fill(" ", index + 1, end)
    index = end
  }
  return output.join("")
}

function splitTopLevelWithContext(source: string, separator: string, controlFlowRegexes: ControlFlowRegexCache) {
  const parts: string[] = []
  let depth = 0
  let previousSignificant = ""
  let start = 0
  for (let index = 0; index < source.length; index++) {
    const char = source[index]
    const next = source[index + 1]
    const jsxEnd = skipJsxLiteral(source, index, previousSignificant, controlFlowRegexes)
    if (jsxEnd !== undefined) {
      index = jsxEnd - 1
      previousSignificant = "literal"
      continue
    }
    if (isQuote(char)) {
      index = skipQuoted(source, index, controlFlowRegexes) - 1
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
    if (char === "/" && (isRegexLiteralStart(source, index, previousSignificant, controlFlowRegexes) || isControlFlowRegexStart(source, index, controlFlowRegexes))) {
      index = skipRegexLiteral(source, index) - 1
      previousSignificant = "literal"
      continue
    }
    if (char === "<") {
      const genericEnd = findMatchingWithContext(source, index, "<", ">", controlFlowRegexes)
      if (genericEnd !== undefined && !isNamedAssertionComparison(source, index, genericEnd)
        && (nextNonWhitespace(source, genericEnd + 1) === "(" || isAssertionTypeArguments(source, index))) {
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

function findIdentifierCallsWithContext(source: string, name: string, controlFlowRegexes: ControlFlowRegexCache): IdentifierCall[] {
  const calls: IdentifierCall[] = []
  let previousSignificant = ""
  for (let index = 0; index < source.length; index++) {
    const char = source[index]
    const next = source[index + 1]
    const jsxEnd = skipJsxLiteral(source, index, previousSignificant, controlFlowRegexes)
    if (jsxEnd !== undefined) {
      index = jsxEnd - 1
      previousSignificant = "literal"
      continue
    }
    if (isQuote(char)) {
      index = skipQuoted(source, index, controlFlowRegexes) - 1
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
    if (char === "/" && (isRegexLiteralStart(source, index, previousSignificant, controlFlowRegexes) || isControlFlowRegexStart(source, index, controlFlowRegexes))) {
      index = skipRegexLiteral(source, index) - 1
      previousSignificant = "literal"
      continue
    }
    if (
      !source.startsWith(name, index)
      || isIdentifierCharAt(source, index - 1)
      || isIdentifierCharAt(source, index + name.length)
      || isFunctionDeclarationName(source, index)
      || isMemberAccessName(source, index)
    ) {
      previousSignificant = trackSignificant(previousSignificant, char)
      continue
    }

    let openParen = skipWhitespaceAndComments(source, index + name.length)
    if (source[openParen] === "<") {
      const genericEnd = findMatchingWithContext(source, openParen, "<", ">", controlFlowRegexes)
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

    const closeParen = findMatchingWithContext(source, openParen, "(", ")", controlFlowRegexes)
    if (closeParen === undefined) {
      previousSignificant = trackSignificant(previousSignificant, char)
      continue
    }
    if (isMethodDeclarationName(source, index, closeParen)) {
      previousSignificant = trackSignificant(previousSignificant, char)
      continue
    }
    calls.push({
      arguments: splitTopLevelWithContext(source.slice(openParen + 1, closeParen), ",", createControlFlowRegexCache(sourceSyntaxes.get(controlFlowRegexes))),
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

function hasAssertionSubtraction(source: string) {
  if (!source.includes("-")) return false
  let expectsOperand = true
  for (let index = 0; index < source.length; index++) {
    if (isQuote(source[index])) {
      index = skipQuoted(source, index) - 1
      expectsOperand = false
      continue
    }
    const number = /^(?:0[xX][\da-fA-F_]+n?|0[bB][01_]+n?|0[oO][0-7_]+n?|\d[\d_]*n|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?)/.exec(source.slice(index))
    if (number) {
      index += number[0].length - 1
      expectsOperand = false
      continue
    }
    const identifier = /^(?:(?:\\u\{[\da-f]{1,6}\}|\\u[\da-f]{4})|[\p{ID_Start}_$])(?:(?:\\u\{[\da-f]{1,6}\}|\\u[\da-f]{4})|[\p{ID_Continue}$])*/iu.exec(source.slice(index))
    if (identifier) {
      const word = decodeIdentifier(identifier[0])
      if ((index === 0 || !expectsOperand) && /^(?:as|satisfies|extends|is)$/.test(word)) expectsOperand = true
      else if (!expectsOperand || !/^(?:keyof|readonly|typeof|new|infer|asserts)$/.test(word)) expectsOperand = false
      index += identifier[0].length - 1
      continue
    }
    if (source[index] === "-") {
      // Only negative numeric literal types use a unary minus. Contextual
      // keywords also act as type names once an operand is expected.
      if (!expectsOperand || !/^(?:\d|\.\d)/.test(source.slice(index + 1).trimStart())) return true
    }
    else if (/[([|&?:]/.test(source[index] || "")) expectsOperand = true
    else if (/[)\]}]/.test(source[index] || "")) expectsOperand = false
  }
  return false
}

function findDefaultExportCallWithContext(source: string, names: string[], options: { positionalOptionsIndex?: number }, controlFlowRegexes: ControlFlowRegexCache): DefaultExportCall | undefined {
  const masked = maskSourceLiteralsWithContext(source, controlFlowRegexes)
  const calls = names
    .flatMap(name => findIdentifierCallsWithContext(source, name, controlFlowRegexes))
    .sort((left, right) => left.start - right.start)

  for (const call of calls) {
    // Validate the assertion boundary while leaving TypeScript's type grammar
    // unrestricted (generic, union, indexed-access, `typeof`, etc.). Runtime
    // expression operators after the assertion remain unsupported.
    const isCompleteAssertion = (value: string) => {
      value = maskAssertionTypeArguments(value)
      const assertion = /^(?:as|satisfies)\b\s+.+$/is.test(value)
      // Reject runtime operators that can follow an assertion, while allowing
      // punctuation that is valid inside TypeScript type expressions (for
      // example generic arguments and tuple types).
      if (!assertion) return false
      // Function and constructor signatures contain an arrow and parameter
      // syntax that are valid in types. Mask only that signature so the return
      // type and any runtime suffix still pass through every validation below.
      // Find the closing parenthesis structurally so callback parameters can
      // contain their own function signatures. Mask through each signature
      // arrow, leaving the return type and any runtime suffix visible.
      const signatureOutput = value.split("")
      for (let index = 0; index < value.length; index++) {
        if (value[index] !== "(") continue
        const close = findMatching(value, index, "(", ")")
        if (close === undefined) continue
        const arrow = skipWhitespaceAndComments(value, close + 1)
        if (!value.startsWith("=>", arrow)) continue
        signatureOutput.fill(" ", index, arrow + 2)
        index = close
      }
      value = signatureOutput.join("")
      // Each conditional type question mark must follow an `extends` clause.
      // Track nested true branches until their colon; a further question mark
      // in a completed false branch is a runtime ternary.
      const conditionalBranches: boolean[] = []
      const controlFlowRegexes: ControlFlowRegexCache = new Map()
      for (let index = 0; index < value.length; index++) {
        if (isQuote(value[index])) {
          // A template literal immediately following a completed type is a
          // tagged-template runtime suffix. Keep it visible to suffix
          // validation instead of treating it as a template-literal type.
          if (value[index] === "`") {
            const previous = previousCodeIndex(value, index - 1, controlFlowRegexes)
            if (isIdentifierCharAt(value, previous) || isQuote(value[previous]) || /[>\])}]/.test(value[previous] || "")) return false
          }
          index = skipQuoted(value, index) - 1
          continue
        }
        if (isIdentifierCharAt(value, index)) {
          const start = index
          let end = index
          while (end < value.length && isIdentifierCharAt(value, end)) end += identifierCodePoint(value, end)?.length ?? 1
          index = end - 1
          const previous = previousCodeIndex(value, start - 1, controlFlowRegexes)
          if (value.slice(start, end) === "extends" && value[previous] !== ".") {
            // `infer R extends Constraint` constrains the inferred name; it
            // does not begin another conditional branch.
            // Escaped Unicode identifier names are valid after `infer` too.
            // Keep their constraint's `extends` from opening a conditional
            // branch just like ordinary inferred names.
            if (/\binfer\s+(?:(?:\\u\{[\da-f]{1,6}\}|\\u[\da-f]{4})|[\p{ID_Start}_$])(?:(?:\\u\{[\da-f]{1,6}\}|\\u[\da-f]{4})|[\p{ID_Continue}$])*\s*$/iu.test(value.slice(0, start))) continue
            conditionalBranches.push(false)
          }
        }
        else if (value[index] === "?") {
          if (conditionalBranches.at(-1) !== false) return false
          conditionalBranches[conditionalBranches.length - 1] = true
        }
        else if (value[index] === ":") {
          if (conditionalBranches.pop() !== true) return false
        }
        // Generic arguments and signature arrows have already been masked.
        // Any remaining angle bracket is a runtime operator, even without
        // whitespace between it and the asserted type.
        else if (value[index] === "<" || value[index] === ">") return false
      }
      if (conditionalBranches.length) return false
      // `const` is a complete assertion type by itself. Any operator after it
      // therefore belongs to the runtime expression (including operators whose
      // right-hand side is an identifier rather than a literal).
      if (/^(?:as\s+const|satisfies\s+const)\b/i.test(value)) {
        const afterConst = value.slice(value.indexOf("const") + 5).trim()
        // `as const satisfies T` is the only suffix permitted after a
        // const assertion; everything else is runtime expression material.
        if (afterConst && !/^satisfies\s+\S[\s\S]*$/i.test(afterConst)) return false
        // A const assertion may only be followed by a complete `satisfies`
        // clause. Any arithmetic (including subtraction with an identifier)
        // changes the runtime value and must remain unsupported.
        if (/(?:&&|\|\||\?\?|=>|\?\.|[+*/?;%=<>-]|,|\||&|\^|\b(?:instanceof|in)\b)/.test(afterConst)) return false
      }
      // Operators and call syntax after an assertion change the runtime value;
      // reject them while retaining union/intersection punctuation in types.
      if (/(?:&&|\|\||\?\?|\?\.|[+*/;%=^]|,)/.test(value)) return false
      if (hasAssertionSubtraction(value)) return false
      if (/\b(?:instanceof|in)\b/.test(value)) return false
      // Bitwise operators are runtime expressions; retain type unions and
      // intersections whose right side is a type name, but reject literals.
      if (/(?:\||&|\^)\s*(?:true|false|null|undefined|\d+(?:\.\d+)?|["'`])/.test(value)) return false
      if (/\b(?!(?:as|satisfies|extends|is|keyof|readonly|typeof)\b)[A-Za-z_$][\w$]*\s*\(|[)}\]]\s*\(/.test(value)) return false
      return true
    }
    const firstArgument = stripBoundaryCommentsWithContext(call.arguments[0] || "", createControlFlowRegexCache(sourceSyntaxes.get(controlFlowRegexes)))
    let callArgument = !firstArgument.startsWith("{") && options.positionalOptionsIndex !== undefined
      ? stripBoundaryCommentsWithContext(call.arguments[options.positionalOptionsIndex] || "{}", createControlFlowRegexCache(sourceSyntaxes.get(controlFlowRegexes)))
      : firstArgument
    // Positional options are often wrapped in parentheses (and may contain a
    // trailing type assertion). Unwrap only complete boundary parentheses so
    // nested expressions remain intact for object matching below.
    while (callArgument.startsWith("(")) {
      const boundaryEnd = findMatchingWithContext(callArgument, 0, "(", ")", createControlFlowRegexCache(sourceSyntaxes.get(controlFlowRegexes)))
      if (boundaryEnd === undefined) break
      const trailing = stripBoundaryCommentsWithContext(callArgument.slice(boundaryEnd + 1), createControlFlowRegexCache(sourceSyntaxes.get(controlFlowRegexes)))
      if (trailing && !isCompleteAssertion(trailing)) break
      callArgument = stripBoundaryCommentsWithContext(callArgument.slice(1, boundaryEnd), createControlFlowRegexCache(sourceSyntaxes.get(controlFlowRegexes)))
    }
    if (!callArgument.startsWith("{")) continue
    const objectEnd = findMatchingWithContext(callArgument, 0, "{", "}", createControlFlowRegexCache(sourceSyntaxes.get(controlFlowRegexes)))
    if (objectEnd === undefined) continue
    const suffix = stripBoundaryCommentsWithContext(callArgument.slice(objectEnd + 1), createControlFlowRegexCache(sourceSyntaxes.get(controlFlowRegexes)))
    if (suffix && !isCompleteAssertion(suffix)) continue
    const argument = callArgument.slice(0, objectEnd + 1)
    if (/\bexport\s+default\s*(?:\(\s*)*$/.test(masked.slice(0, call.start))) {
      return { ...call, argument }
    }
  }
}

function readObjectMemberKey(source: string, offset: number) {
  let start = skipWhitespaceAndComments(source, offset)
  if (source[start] === "*") start = skipWhitespaceAndComments(source, start + 1)
  if (source[start] === "'" || source[start] === "\"") {
    const end = skipQuoted(source, start)
    const name = source.slice(start + 1, end - 1)
    return { name: name.includes("\\") ? undefined : name, end }
  }
  if (source[start] === "[") return { name: undefined, end: start }
  const name = /^[$_\p{ID_Start}][$\p{ID_Continue}\u200C\u200D]*/u.exec(source.slice(start))?.[0]
  if (name) {
    const end = start + name.length
    return { name: source[end] === "\\" ? undefined : name, end }
  }
  const numeric = /^(?:0[xX][\da-fA-F](?:_?[\da-fA-F])*n?|0[bB][01](?:_?[01])*n?|0[oO][0-7](?:_?[0-7])*n?|(?:0|[1-9](?:_?\d)*)n|(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:[eE][+-]?\d(?:_?\d)*)?)/.exec(source.slice(start))?.[0]
  if (numeric) {
    const end = start + numeric.length
    const next = source[skipWhitespaceAndComments(source, end)]
    return { name: next === ":" || next === "(" ? numeric : undefined, end }
  }
}

function* readObjectMembers(objectSource: string, controlFlowRegexes: ControlFlowRegexCache) {
  const normalized = stripBoundaryCommentsWithContext(objectSource, controlFlowRegexes)
  if (!normalized.startsWith("{") || !normalized.endsWith("}")) return
  for (const source of splitTopLevelWithContext(normalized.slice(1, -1), ",", createControlFlowRegexCache(sourceSyntaxes.get(controlFlowRegexes)))) {
    if (skipWhitespaceAndComments(source, 0) === source.length) continue
    let key = readObjectMemberKey(source, 0)
    if (key?.name === "get" || key?.name === "set" || key?.name === "async") {
      key = readObjectMemberKey(source, key.end) ?? key
    }
    yield { name: key?.name, end: key?.end ?? 0, source }
  }
}

/** Names are undefined for spread, computed, or escaped keys. */
function readObjectPropertyNamesWithContext(objectSource: string, controlFlowRegexes: ControlFlowRegexCache): (string | undefined)[] {
  return Array.from(readObjectMembers(objectSource, controlFlowRegexes), member => member.name)
}

function readObjectPropertyWithContext(objectSource: string, propertyName: string, controlFlowRegexes: ControlFlowRegexCache): string | undefined {
  for (const member of readObjectMembers(objectSource, controlFlowRegexes)) {
    if (member.name !== propertyName) continue
    const colon = skipWhitespaceAndComments(member.source, member.end)
    if (member.source[colon] === ":") return stripBoundaryCommentsWithContext(member.source.slice(colon + 1), createControlFlowRegexCache(sourceSyntaxes.get(controlFlowRegexes)))
  }
}
