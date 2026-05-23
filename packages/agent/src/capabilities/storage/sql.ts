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
  let bracketIdentifier = false
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
    if (bracketIdentifier) {
      if (char === "]") bracketIdentifier = false
      output += " "
      continue
    }
    if (char === "\"" || char === "'" || char === "`") {
      quote = char
      output += " "
      continue
    }
    if (char === "[") {
      bracketIdentifier = true
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
  return match
    ? [
        "foreign_key_check",
        "foreign_key_list",
        "index_info",
        "index_list",
        "index_xinfo",
        "table_info",
        "table_list",
        "table_xinfo",
      ].includes(match[1]!.toLowerCase())
    : false
}

const statementKeywords = ["alter", "create", "delete", "drop", "insert", "reindex", "replace", "select", "update", "vacuum"] as const

function topLevelTokens(normalized: string) {
  let depth = 0
  const tokens: string[] = []
  for (const match of normalized.matchAll(/[A-Za-z_]+|[(),]/g)) {
    const token = match[0].toLowerCase()
    if (token === "(") {
      depth++
      continue
    }
    if (token === ")") {
      depth = Math.max(0, depth - 1)
      continue
    }
    if (depth === 0) tokens.push(token)
  }
  return tokens
}

function terminalWithStatementToken(tokens: string[]) {
  if (tokens[0] !== "with") return tokens.find(token => statementKeywords.includes(token as typeof statementKeywords[number]))
  let index = tokens[1] === "recursive" ? 2 : 1
  while (index < tokens.length) {
    const name = tokens[index]
    const asToken = tokens[index + 1]
    if (!name || asToken !== "as") return tokens.find((token, tokenIndex) => tokenIndex >= index && statementKeywords.includes(token as typeof statementKeywords[number]))
    index += 2
    while (index < tokens.length && tokens[index] !== "," && !statementKeywords.includes(tokens[index] as typeof statementKeywords[number])) index++
    if (tokens[index] === ",") {
      index++
      continue
    }
    return tokens[index]
  }
}

function topLevelSqlKind(normalized: string): "data" | "read" | "schema" | undefined {
  const firstStatementToken = terminalWithStatementToken(topLevelTokens(normalized))
  if (!firstStatementToken) return
  if (["select"].includes(firstStatementToken)) return "read"
  if (["alter", "create", "drop", "reindex", "vacuum"].includes(firstStatementToken)) return "schema"
  return "data"
}

export function normalizeReadSql(statement: unknown) {
  const single = splitSingleSqlStatement(assertString(statement, "db_query statement"))
  if (!single) return
  if (isReadOnlyPragma(single)) return single
  const normalized = stripSqlComments(single).trim()
  if (/^select\b/i.test(normalized)) return single
  if (!/^with\b/i.test(normalized)) return
  return topLevelSqlKind(normalized) === "read" ? single : undefined
}

export function sqlKind(statement: string): "data" | "read" | "schema" | undefined {
  const normalized = stripSqlComments(statement).trim()
  if (/^with\b/i.test(normalized)) return topLevelSqlKind(normalized)
  if (/^select\b/i.test(normalized) || isReadOnlyPragma(normalized)) return "read"
  if (/^(alter|create|drop|reindex|vacuum)\b/i.test(normalized)) return "schema"
  if (/^(insert|update|delete|replace)\b/i.test(normalized)) return "data"
  return
}
