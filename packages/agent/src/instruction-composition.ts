export interface InstructionImportResolution {
  content: string
  file: string
}

export interface ResolveInstructionImportsOptions {
  file: string
  maxDepth?: number
  read: (specifier: string, importer: string) => InstructionImportResolution
}

export interface ComposeInstructionDocumentOptions {
  context?: Record<string, unknown>
}

type ConditionOperator = "!" | "!=" | "!==" | "&&" | "(" | ")" | "==" | "===" | "||"
type ConditionToken =
  | { type: "literal", value: unknown }
  | { type: "op", value: ConditionOperator }
  | { path: string, type: "path" }

const defaultImportDepth = 4
const contextPathPattern = /context(?:\.[A-Za-z_$][\w$]*)+/
const tripleBindingPattern = /\{\{\{\s*(context(?:\.[A-Za-z_$][\w$]*)+)\s*\}\}\}/g
const scalarBindingPattern = /\{\{(?!\{)\s*(context(?:\.[A-Za-z_$][\w$]*)+)\s*\}\}/g

export function resolveInstructionImports(content: string, options: ResolveInstructionImportsOptions): string {
  return expandInstructionImports(content, {
    ...options,
    maxDepth: options.maxDepth ?? defaultImportDepth,
    seen: new Set([options.file]),
  })
}

export function composeInstructionDocument(content: string, options: ComposeInstructionDocumentOptions = {}): string {
  const context = options.context || {}
  return renderContextBindings(renderConditionals(content, context), context).trim().replace(/\n{3,}/g, "\n\n")
}

function expandInstructionImports(
  content: string,
  options: ResolveInstructionImportsOptions & { maxDepth: number, seen: Set<string> },
  depth = 0,
): string {
  let fenced = false
  return content.split(/\r?\n/).map((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced
      return line
    }
    return fenced ? line : replaceImportsInLine(line, options, depth)
  }).join("\n")
}

function replaceImportsInLine(
  line: string,
  options: ResolveInstructionImportsOptions & { maxDepth: number, seen: Set<string> },
  depth: number,
): string {
  let rendered = ""
  let inlineCode: string | undefined
  for (let index = 0; index < line.length;) {
    const char = line[index]
    if (char === "`") {
      const fence = line.slice(index).match(/^`+/)![0]
      if (!inlineCode) inlineCode = fence
      else if (fence === inlineCode) inlineCode = undefined
      rendered += fence
      index += fence.length
      continue
    }
    if (char !== "@" || inlineCode) {
      rendered += char
      index += 1
      continue
    }

    const end = importTokenEnd(line, index)
    const token = line.slice(index, end)
    const replacement = importReplacement(token, options, depth)
    if (replacement === undefined) {
      rendered += token
    }
    else {
      rendered += replacement
    }
    index = end
  }
  return rendered
}

function importTokenEnd(line: string, start: number): number {
  let index = start
  while (index < line.length && !/\s|[<>{}\[\]]/.test(line[index]!)) index += 1
  return index
}

function importReplacement(
  token: string,
  options: ResolveInstructionImportsOptions & { maxDepth: number, seen: Set<string> },
  depth: number,
): string | undefined {
  if (/^@(?:https?:)?\/\//.test(token) || token.startsWith("@/")) {
    throw new Error(`[vitehub] Instruction import "${token}" must be a relative file path.`)
  }
  if (!token.startsWith("@./") && !token.startsWith("@../")) return undefined

  const trailing = token.match(/[.,;:!?)]*$/)?.[0] || ""
  const specifier = token.slice(1, token.length - trailing.length)
  if (/[*?]/.test(specifier)) {
    throw new Error(`[vitehub] Instruction import "${specifier}" cannot use globs.`)
  }
  if (depth >= options.maxDepth) {
    throw new Error(`[vitehub] Instruction import depth exceeded ${options.maxDepth}.`)
  }

  const resolved = options.read(specifier, options.file)
  if (options.seen.has(resolved.file)) {
    throw new Error(`[vitehub] Circular instruction import: ${specifier}.`)
  }
  options.seen.add(resolved.file)
  try {
    return `${expandInstructionImports(resolved.content, { ...options, file: resolved.file }, depth + 1)}${trailing}`
  }
  finally {
    options.seen.delete(resolved.file)
  }
}

function renderConditionals(content: string, context: Record<string, unknown>): string {
  const lines = content.split(/\r?\n/)
  const rendered: string[] = []
  for (let index = 0; index < lines.length;) {
    const line = lines[index]!
    const directive = directiveLine(line)
    if (directive?.kind === "if") {
      const result = renderIfChain(lines, index, directive.expression, context)
      rendered.push(result.content)
      index = result.next
      continue
    }
    if (directive?.kind === "else" || directive?.kind === "else-if") {
      throw new Error(`[vitehub] Instruction ${directive.kind} block must follow an if block.`)
    }
    rendered.push(line)
    index += 1
  }
  return rendered.join("\n")
}

function renderIfChain(
  lines: string[],
  start: number,
  expression: string | undefined,
  context: Record<string, unknown>,
): { content: string, next: number } {
  const branches: Array<{ expression?: string, lines: string[] }> = [{ expression, lines: [] }]
  let depth = 0
  let sawElse = false

  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]!
    const directive = directiveLine(line)

    if (directive?.kind === "if") {
      depth += 1
      branches.at(-1)!.lines.push(line)
      continue
    }
    if (isDirectiveClose(line)) {
      if (depth > 0) {
        depth -= 1
        branches.at(-1)!.lines.push(line)
        continue
      }
      const selected = branches.find(branch =>
        branch.expression === undefined || evaluateCondition(branch.expression, context))
      return {
        content: selected ? renderConditionals(selected.lines.join("\n"), context) : "",
        next: index + 1,
      }
    }
    if (depth === 0 && directive?.kind === "else-if") {
      if (sawElse) throw new Error("[vitehub] Instruction else-if block cannot follow else.")
      branches.push({ expression: directive.expression, lines: [] })
      continue
    }
    if (depth === 0 && directive?.kind === "else") {
      if (sawElse) throw new Error("[vitehub] Instruction if chain cannot contain more than one else block.")
      sawElse = true
      branches.push({ lines: [] })
      continue
    }
    branches.at(-1)!.lines.push(line)
  }

  throw new Error("[vitehub] Instruction if block is missing a closing :: line.")
}

function directiveLine(line: string): { expression?: string, kind: "else" | "else-if" | "if" } | undefined {
  const match = line.match(/^\s*::(if|else-if|else)(?:\{(.+)\})?\s*$/)
  if (!match) return
  const kind = match[1] as "else" | "else-if" | "if"
  if (kind === "else") {
    if (match[2]?.trim()) throw new Error("[vitehub] Instruction else block does not accept a condition.")
    return { kind }
  }
  const expression = conditionExpression(match[2])
  if (!expression) throw new Error(`[vitehub] Instruction ${kind} block requires a condition.`)
  return { expression, kind }
}

function isDirectiveClose(line: string): boolean {
  return /^\s*::\s*$/.test(line)
}

function conditionExpression(raw: string | undefined): string | undefined {
  const value = raw?.trim()
  if (!value) return
  const attr = value.match(/^(?:if|condition)\s*=\s*(["'])([\s\S]*)\1$/)
  return (attr ? attr[2] : value).trim()
}

function evaluateCondition(expression: string, context: Record<string, unknown>): boolean {
  const parser = createConditionParser(tokenizeCondition(expression), expression, context)
  const value = parser.parseOr()
  parser.done()
  return Boolean(value)
}

function tokenizeCondition(expression: string): ConditionToken[] {
  const tokens: ConditionToken[] = []
  for (let index = 0; index < expression.length;) {
    const rest = expression.slice(index)
    if (/^\s/.test(rest)) {
      index += 1
      continue
    }
    const op = rest.match(/^(===|!==|==|!=|&&|\|\||[!()])/)
    if (op) {
      tokens.push({ type: "op", value: op[1] as ConditionOperator })
      index += op[1]!.length
      continue
    }
    const path = rest.match(new RegExp(`^${contextPathPattern.source}`))
    if (path) {
      tokens.push({ path: path[0], type: "path" })
      index += path[0].length
      continue
    }
    const string = rest.match(/^(['"])((?:\\.|(?!\1)[^\\])*)\1/)
    if (string) {
      tokens.push({ type: "literal", value: string[2]!.replace(/\\(['"\\])/g, "$1") })
      index += string[0].length
      continue
    }
    const number = rest.match(/^-?\d+(?:\.\d+)?/)
    if (number) {
      tokens.push({ type: "literal", value: Number(number[0]) })
      index += number[0].length
      continue
    }
    const literal = rest.match(/^(true|false|null)\b/)
    if (literal) {
      tokens.push({ type: "literal", value: literal[1] === "true" ? true : literal[1] === "false" ? false : null })
      index += literal[0].length
      continue
    }
    throw new Error(`[vitehub] Unsafe instruction condition "${expression}". Conditions can only read context.* paths and use literals, ===, !==, &&, ||, !, and parentheses.`)
  }
  return tokens
}

function createConditionParser(tokens: ConditionToken[], expression: string, context: Record<string, unknown>) {
  let index = 0
  const error = () => new Error(`[vitehub] Invalid instruction condition "${expression}".`)
  const peek = () => tokens[index]
  const take = (value?: string) => {
    const token = tokens[index]
    if (value && (token?.type !== "op" || token.value !== value)) throw error()
    index += 1
    return token
  }

  function parsePrimary(): unknown {
    const token = take()
    if (!token) throw error()
    if (token.type === "literal") return token.value
    if (token.type === "path") return contextPathValue(context, token.path)
    if (token.type === "op" && token.value === "(") {
      const value = parseOr()
      take(")")
      return value
    }
    throw error()
  }

  function parseUnary(): unknown {
    const token = peek()
    if (token?.type === "op" && token.value === "!") {
      take("!")
      return !Boolean(parseUnary())
    }
    return parsePrimary()
  }

  function parseEquality(): unknown {
    let value = parseUnary()
    const token = peek()
    if (token?.type === "op" && ["==", "===", "!=", "!=="].includes(token.value)) {
      take()
      const right = parseUnary()
      value = token.value === "!=" || token.value === "!==" ? value !== right : value === right
    }
    return value
  }

  function parseAnd(): unknown {
    let value = parseEquality()
    while (peek()?.type === "op" && (peek() as { value: string }).value === "&&") {
      take("&&")
      value = Boolean(value) && Boolean(parseEquality())
    }
    return value
  }

  function parseOr(): unknown {
    let value = parseAnd()
    while (peek()?.type === "op" && (peek() as { value: string }).value === "||") {
      take("||")
      value = Boolean(value) || Boolean(parseAnd())
    }
    return value
  }

  return {
    done() {
      if (index !== tokens.length) throw error()
    },
    parseOr,
  }
}

function contextPathValue(context: Record<string, unknown>, path: string): unknown {
  let current: unknown = context
  for (const segment of path.split(".").slice(1)) {
    if (!current || typeof current !== "object" || !Object.hasOwn(current, segment)) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

function renderContextBindings(content: string, context: Record<string, unknown>): string {
  return content
    .replace(tripleBindingPattern, (_match, path: string) => {
      const value = contextPathValue(context, path)
      if (value === null || value === undefined) return ""
      if (typeof value !== "string") {
        throw new TypeError(`[vitehub] Instruction markdown binding "{{{ ${path} }}}" must resolve to a string.`)
      }
      return value
    })
    .replace(scalarBindingPattern, (_match, path: string) => {
      const value = contextPathValue(context, path)
      if (value === null || value === undefined) return ""
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value)
      throw new TypeError(`[vitehub] Instruction binding "{{ ${path} }}" must resolve to a scalar value.`)
    })
}
