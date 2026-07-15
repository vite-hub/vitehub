type ConditionOperator = "!" | "!=" | "!==" | "&&" | "(" | ")" | "==" | "===" | "||"
type ConditionToken =
  | { type: "literal", value: unknown }
  | { type: "op", value: ConditionOperator }
  | { path: string, type: "path" }

const templatePathSource = String.raw`[A-Za-z_$][\w$-]*(?:\.[A-Za-z_$][\w$-]*)*`

export function evaluateCondition(
  expression: string,
  data: Record<string, unknown>,
): boolean {
  const parser = createConditionParser(tokenizeCondition(expression), expression, data)
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
    const path = rest.match(new RegExp(`^${templatePathSource}`))
    if (path) {
      if (/^\s*\(/.test(rest.slice(path[0].length))) throw unsafeConditionError(expression)
      tokens.push({ path: path[0], type: "path" })
      index += path[0].length
      continue
    }
    throw unsafeConditionError(expression)
  }
  return tokens
}

function createConditionParser(
  tokens: ConditionToken[],
  expression: string,
  data: Record<string, unknown>,
) {
  let index = 0
  const error = () => new Error(`[vitehub] Invalid Markdown template condition "${expression}".`)
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
    if (token.type === "path") return templatePathValue(data, token.path)
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
      return !parseUnary()
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
      const right = parseEquality()
      value = Boolean(value) && Boolean(right)
    }
    return value
  }

  function parseOr(): unknown {
    let value = parseAnd()
    while (peek()?.type === "op" && (peek() as { value: string }).value === "||") {
      take("||")
      const right = parseAnd()
      value = Boolean(value) || Boolean(right)
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

export function templatePathValue(data: Record<string, unknown>, path: string): unknown {
  return nestedPathValue(data, path.split("."))
}

function nestedPathValue(value: unknown, segments: string[]): unknown {
  if (!segments.length) return value
  if (!value || typeof value !== "object") return

  for (let count = segments.length; count > 0; count -= 1) {
    const key = segments.slice(0, count).join(".")
    if (Object.hasOwn(value, key)) {
      return nestedPathValue((value as Record<string, unknown>)[key], segments.slice(count))
    }
  }
}

function unsafeConditionError(expression: string): Error {
  return new Error(`[vitehub] Unsafe Markdown template condition "${expression}". Conditions can only read data paths and use literals, ===, !==, &&, ||, !, and parentheses.`)
}
