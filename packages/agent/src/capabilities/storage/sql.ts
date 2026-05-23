import { assertString } from "./shared.ts"

function hasOnlyTrailingComments(value: string) {
  let index = 0
  while (index < value.length) {
    const char = value[index]
    const next = value[index + 1]

    if (/\s/.test(char || "")) {
      index++
      continue
    }
    if (char === "-" && next === "-") {
      index += 2
      while (index < value.length && value[index] !== "\n" && value[index] !== "\r") index++
      continue
    }
    if (char === "/" && next === "*") {
      index += 2
      while (index < value.length && !(value[index] === "*" && value[index + 1] === "/")) index++
      if (index >= value.length) return false
      index += 2
      continue
    }
    return false
  }
  return true
}

export function splitSingleSqlStatement(statement: string): string | undefined {
  let quote: "\"" | "'" | "`" | undefined
  let bracketIdentifier = false
  for (let index = 0; index < statement.length; index++) {
    const char = statement[index]
    const next = statement[index + 1]

    if (quote) {
      if (char === quote && next === quote) {
        index++
        continue
      }
      if (char === quote) quote = undefined
      continue
    }
    if (bracketIdentifier) {
      if (char === "]") bracketIdentifier = false
      continue
    }
    if (char === "-" && next === "-") {
      index += 2
      while (index < statement.length && statement[index] !== "\n" && statement[index] !== "\r") index++
      continue
    }
    if (char === "/" && next === "*") {
      index += 2
      while (index < statement.length && !(statement[index] === "*" && statement[index + 1] === "/")) index++
      if (index >= statement.length) return
      index++
      continue
    }
    if (char === "\"" || char === "'" || char === "`") {
      quote = char
      continue
    }
    if (char === "[") {
      bracketIdentifier = true
      continue
    }
    if (char === ";") {
      return hasOnlyTrailingComments(statement.slice(index + 1))
        ? statement.slice(0, index).trim()
        : undefined
    }
  }
  const trimmed = statement.trim()
  return quote || bracketIdentifier || !trimmed ? undefined : trimmed
}

function stripSqlComments(statement: string) {
  let output = ""
  let quote: "\"" | "'" | "`" | undefined
  for (let index = 0; index < statement.length; index++) {
    const char = statement[index]
    const next = statement[index + 1]
    if (quote) {
      if (char === quote && next === quote) {
        index++
      }
      else if (char === quote) {
        quote = undefined
      }
      output += " "
      continue
    }
    if (char === "\"" || char === "'" || char === "`") {
      quote = char
      output += " "
      continue
    }
    if (char === "-" && next === "-") {
      index += 2
      while (index < statement.length && statement[index] !== "\n" && statement[index] !== "\r") index++
      output += " "
      continue
    }
    if (char === "/" && next === "*") {
      index += 2
      while (index < statement.length && !(statement[index] === "*" && statement[index + 1] === "/")) index++
      if (index < statement.length) index++
      output += " "
      continue
    }
    output += char
  }
  return output
}

function isReadOnlyPragma(statement: string) {
  const match = /^\s*pragma\s+(?:(?:main|temp)\.)?([a-z_]+)\s*(?:\([^)]*\))?\s*$/i.exec(statement)
  return match ? ["foreign_key_list", "index_list", "table_info"].includes(match[1]!.toLowerCase()) : false
}

export function normalizeReadSql(statement: unknown) {
  const single = splitSingleSqlStatement(assertString(statement, "db_query statement"))
  if (!single) return
  if (isReadOnlyPragma(single)) return single
  const normalized = stripSqlComments(single).trim()
  if (/^select\b/i.test(normalized)) return single
  if (!/^with\b/i.test(normalized)) return
  if (/\b(insert|update|delete|replace|create|drop|alter|vacuum|pragma|begin|commit|rollback|savepoint|release)\b/i.test(normalized)) return
  return /\bselect\b/i.test(normalized) ? single : undefined
}

export function sqlKind(statement: string): "data" | "read" | "schema" | undefined {
  const normalized = stripSqlComments(statement).trim()
  if (/^(select|with)\b/i.test(normalized) || isReadOnlyPragma(normalized)) return "read"
  if (/^(alter|create|drop|reindex|vacuum)\b/i.test(normalized)) return "schema"
  if (/^(insert|update|delete|replace)\b/i.test(normalized)) return "data"
  return
}
