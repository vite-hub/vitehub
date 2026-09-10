// Recognize established concatenated credential names regardless of case.
const uppercaseCredentialKeys = [
  "APIKEY", "ACCESSKEY", "PRIVATEKEY", "SECRETKEY", "PUBLICKEY",
  "ACCESSTOKEN", "AUTHTOKEN", "REFRESHTOKEN", "CLIENTSECRET", "SESSIONTOKEN",
  "X-API-KEY", "X-ACCESS-TOKEN",
]

function isCredentialKey(key: string): boolean {
  return uppercaseCredentialKeys.includes(key.toUpperCase())
    || /(?:^|[_-])(?:key|secret|token|password)$/i.test(key)
    || /[a-z0-9](?:Key|Secret|Token|Password|KEY|SECRET|TOKEN|PASSWORD)$/.test(key)
}

// Carry mapping syntax across journal chunks without carrying field values.
function credentialMappingContext(value: string): string | undefined {
  let depth = 0
  let quote = ""
  let escaped = false
  let boundary = false
  for (let index = 0; index < value.length; index++) {
    const character = value[index]!
    if (escaped) { escaped = false; continue }
    if (character === "\\") { escaped = true; continue }
    if (quote) {
      if (character === quote) quote = ""
      continue
    }
    if (character === '"' || character === "'") { quote = character; boundary = false; continue }
    if (character === "{") {
      if (!depth && !/(?:^|[\r\n]) *(?:- +)?(?:[^{}:,\r\n]+:[\t ]*)?$/.test(value.slice(0, index))) continue
      if (++depth > 128) return
      boundary = true
    }
    else if (character === "}") { depth = Math.max(0, depth - 1); boundary = false }
    else if (!/\s/.test(character)) boundary = character === "," && depth > 0
  }
  if (!depth) return
  return "{".repeat(depth) + (quote ? quote + (escaped ? "\\" : "") : boundary ? "" : "x ")
}

function isCredentialAssignment(key: string, prefix: string, precedingText: string): boolean {
  if (!isCredentialKey(key)) return false
  const cli = prefix.startsWith("--")
  if (cli && /^key$/i.test(key)) return false
  if (!/[:=]\s*$/.test(prefix)) return cli
  if (!prefix.trimEnd().endsWith(":")) return true
  // Generic token/key fields also describe parser tokens and object identifiers.
  if (/^(?:key|token)$/i.test(key)) return false
  // Quoted fields, mapping separators, and line-start YAML keys establish assignments.
  if (/^(?:password|secret)$/i.test(key)) {
    return /["']\s*:\s*$/.test(prefix) || credentialMappingContext(precedingText)?.endsWith("{") === true || /(?:^|[\r\n]) *(?:- +)?$/.test(precedingText)
  }
  return true
}

function isCredentialScheme(scheme: string, prefix: string): boolean {
  return scheme === "Bearer" || scheme === "Basic"
    || /(?:^|[\r\n])[\t "']*$/.test(prefix)
    || /\b(?:proxy-)?authorization["']?\s*:\s*["']?\s*$/i.test(prefix)
}

export function pendingCredentialScheme(value: string, precedingText = ""): "scheme" | "unquoted" | undefined {
  const match = new RegExp(String.raw`\b(Bearer|Basic)\s+(${unquotedCredentialValue}*)$`, "i").exec(value)
  if (!match || !isCredentialScheme(match[1]!, precedingText + value.slice(0, match.index))) return
  return match[2] ? "unquoted" : "scheme"
}

function pendingAuthorizationHeader(value: string): string | undefined {
  const match = /["']?\b([A-Za-z-]+)["']?\s*:?\s*["']?$/.exec(value.slice(-128))
  if (!match) return
  const name = match[1]!.toUpperCase()
  return ["AUTHORIZATION", "PROXY-AUTHORIZATION"].some(header => header.startsWith(name)) ? match[0] : undefined
}

export function pendingCredentialTextSuffix(value: string): string | undefined {
  const tail = value.slice(-128)
  return /(?<![A-Za-z0-9_-])--[A-Za-z][A-Za-z0-9_-]*["']?\s*$/.exec(tail)?.[0]
    ?? /(?<![A-Za-z0-9_-])--?$/.exec(tail)?.[0]
    ?? /["']?\b(?:proxy-)?authorization["']?\s*:\s*["']?[!#$%&'*+.^_`|~A-Za-z0-9-]*$/i.exec(tail)?.[0]
    ?? pendingAuthorizationHeader(value)
    ?? /(?:--)?["']?\b[A-Za-z][A-Za-z0-9_-]*["']?\s*$/.exec(tail)?.[0]
}

const credentialAssignmentPrefix = String.raw`(?<![A-Za-z0-9_-])((?:--)?["']?((?:[A-Z][A-Z0-9_-]*)?(?:KEY|SECRET|TOKEN|PASSWORD))["']?(?:\s*[:=]\s*|(?<=--["']?[A-Z][A-Z0-9_-]*["']?)\s+))`

const unquotedCredentialValue = String.raw`(?:\\(?:[\s\S]|$)|[^\s"',;&{}<>\\])`

export interface AuthorizationState {
  escaped: boolean
  quote?: string
  outerQuote?: string
}

// Explicit headers can carry multiple comma-separated authentication parameters.
// Keep them together until the header or its enclosing diagnostic value ends.
export function consumeAuthorization(value: string, state: AuthorizationState): number {
  for (let index = 0; index < value.length; index++) {
    const character = value[index]!
    if (state.escaped) state.escaped = false
    else if (character === "\\") state.escaped = true
    else if (state.quote) {
      if (character === state.quote) delete state.quote
    }
    else if (character === state.outerQuote || /[\r\n;&<>}]/.test(character)) return index
    else if (character === '"' || character === "'") state.quote = character
  }
  return value.length
}

function* authorizationValues(value: string) {
  // Only established scheme names may remain visible. An arbitrary first token
  // can itself be a schemeless credential, even when more header text follows.
  const headers = /\b(?:proxy-)?authorization["']?[\t ]*:[\t ]*(["']?)[\t ]*(?:(Bearer|Basic|Digest|Token|ApiKey|Negotiate|AWS4-HMAC-SHA256)[\t ]+)?/gi
  for (const match of value.matchAll(headers)) {
    if (/^(Bearer|Basic)$/i.test(match[2]!)) continue
    const start = match.index + match[0].length
    const state: AuthorizationState = { escaped: false, ...(match[1] ? { outerQuote: match[1] } : {}) }
    const length = consumeAuthorization(value.slice(start), state)
    yield { start, length, state, scheme: match[2] }
  }
}

export function pendingAuthorizationState(value: string): AuthorizationState | undefined {
  for (const entry of authorizationValues(value)) {
    if (entry.start + entry.length !== value.length) continue
    // Retain a bounded possible scheme until its separator arrives. A raw token
    // is redacted on final flush, or enters continuation mode beyond this bound.
    const content = value.slice(entry.start)
    if (!entry.scheme && content.length < 64 && /^[!#$%&'*+.^_`|~A-Za-z0-9-]*$/.test(content)) continue
    return entry.state
  }
}

function redactAuthorizationHeaders(value: string): string {
  let result = ""
  let offset = 0
  for (const entry of authorizationValues(value)) {
    if (entry.start < offset) continue
    result += value.slice(offset, entry.start) + "[REDACTED]"
    offset = entry.start + entry.length
  }
  return result + value.slice(offset)
}

export function redactCredentialText(value: string, precedingText = ""): string {
  const redacted = redactAuthorizationHeaders(value)
    .replace(/\b(Bearer|Basic)\s+("(?:\\[\s\S]|[^"\\])*"?|'(?:\\[\s\S]|[^'\\])*'?)/gi, (match, scheme: string, quoted: string, offset: number, source: string) => {
      if (!isCredentialScheme(scheme, precedingText + source.slice(0, offset))) return match
      const quote = quoted[0]!
      const closed = quoted.length > 1 && quoted.endsWith(quote) && !/(?:^|[^\\])(?:\\\\)*\\["']$/.test(quoted)
      return `${scheme} ${quote}[REDACTED]${closed ? quote : ""}`
    })
    .replace(new RegExp(String.raw`\b(Bearer|Basic)\s+${unquotedCredentialValue}+`, "gi"), (match, scheme: string, offset: number, source: string) =>
      isCredentialScheme(scheme, precedingText + source.slice(0, offset)) ? `${scheme} [REDACTED]` : match)

  return redactCredentialAssignments(redacted, precedingText)
}

export interface CredentialAssignmentState {
  escaped: boolean
  started: boolean
  quote?: string
  yamlIndent?: number
  yamlProperty?: boolean
  yaml?: { header: boolean, modifiers: boolean, indent?: number, line: boolean, spaces: number, whitespace: string }
}

function assignmentState(source: string, offset: number, prefix: string): CredentialAssignmentState {
  const line = source.slice(0, offset).split("\n").at(-1) ?? ""
  const yamlIndent = /^ *(?:- +)?$/.test(line) && prefix.trimEnd().endsWith(":") ? line.length : undefined
  return { escaped: false, started: false, ...(yamlIndent === undefined ? {} : { yamlIndent }) }
}

function redactCredentialAssignments(value: string, precedingText: string): string {
  let result = ""
  let offset = 0
  for (const match of value.matchAll(new RegExp(credentialAssignmentPrefix, "gi"))) {
    if (match.index < offset || !isCredentialAssignment(match[2]!, match[1]!, precedingText + value.slice(0, match.index))) continue
    const start = match.index + match[0].length
    const content = value.slice(start)
    if (!content) continue
    const state = assignmentState(precedingText + value, precedingText.length + match.index, match[1]!)
    const length = consumeCredentialAssignment(content, state)
    if (!length) continue
    const quote = /^["']/.exec(content)?.[0] ?? ""
    result += value.slice(offset, start) + quote + "[REDACTED]" + (quote && !state.quote ? quote : "")
    if (state.yaml && length < content.length) result += state.yaml.whitespace
    offset = start + length
  }
  return result + value.slice(offset)
}

// Shell assignments concatenate adjacent quoted and unquoted segments.
// YAML scalar assignments continue through indented lines until their dedent.
export function consumeCredentialAssignment(value: string, state: CredentialAssignmentState): number {
  for (let index = 0; index < value.length; index++) {
    const character = value[index]!
    // YAML anchors and tags precede the value, including across chunk boundaries.
    if (state.yamlProperty) {
      if (!/\s/.test(character)) continue
      delete state.yamlProperty
    }
    if (!state.started && /\s/.test(character)) continue
    if (!state.started && state.yamlIndent !== undefined && (character === "&" || character === "!")) {
      state.yamlProperty = true
      continue
    }
    if (!state.started && state.yamlIndent !== undefined && (character === "|" || character === ">")) {
      state.yaml = { header: true, modifiers: true, line: false, spaces: 0, whitespace: "" }
    }
    state.started = true
    if (state.yaml) {
      const yaml = state.yaml
      if (yaml.header) {
        if (!/[|>+1-9-]/.test(character)) yaml.modifiers = false
        if (yaml.modifiers && /[1-9]/.test(character)) yaml.indent = state.yamlIndent! + Number(character)
        if (character === "\n") {
          yaml.header = false
          yaml.line = true
          yaml.whitespace = "\n"
        }
      }
      else if (character === "\n") {
        yaml.line = true
        yaml.whitespace = "\n"
        yaml.spaces = 0
      }
      else if (yaml.line) {
        if (character === " ") yaml.spaces++
        else if (character === "\r") continue
        else {
          const indent = yaml.spaces
          if (indent < (yaml.indent ?? state.yamlIndent! + 1)) {
            yaml.whitespace += " ".repeat(indent)
            return index
          }
          yaml.indent ??= indent
          yaml.line = false
          yaml.whitespace = ""
        }
      }
      continue
    }
    if (state.escaped) state.escaped = false
    else if (character === "\\" && state.quote !== "'") state.escaped = true
    else if (state.quote) {
      if (character === state.quote) delete state.quote
    }
    else if (character === '"' || character === "'") state.quote = character
    else if (/[\s,;&{}<>]/.test(character)) return index
  }
  return value.length
}

export function pendingCredentialAssignmentState(value: string, precedingText = ""): CredentialAssignmentState | undefined {
  for (const match of value.matchAll(new RegExp(credentialAssignmentPrefix, "gi"))) {
    if (!isCredentialAssignment(match[2]!, match[1]!, precedingText + value.slice(0, match.index))) continue
    const content = value.slice(match.index + match[0].length)
    const state = assignmentState(precedingText + value, precedingText.length + match.index, match[1]!)
    if (consumeCredentialAssignment(content, state) === content.length) return state
  }
}

export function pendingCredentialAssignment(value: string, precedingText = ""): "assignment" | "unquoted" | undefined {
  const state = pendingCredentialAssignmentState(value, precedingText)
  return state ? state.started ? "unquoted" : "assignment" : undefined
}

export function credentialTextMayContinue(value: string, precedingText = ""): boolean {
  if (pendingAuthorizationState(value)) return true
  if (/\b(?:proxy-)?authorization["']?[\t ]*:[\t ]*["']?[!#$%&'*+.^_`|~A-Za-z0-9-]*$/i.test(value)) return true
  if (/(?<![A-Za-z0-9_-])--?$/.test(value)) return true
  if (pendingAuthorizationHeader(value)) return true
  if (pendingCredentialQuote(value, precedingText)) return true
  if (pendingCredentialScheme(value, precedingText)) return true
  if (pendingCredentialAssignment(value, precedingText)) return true
  const tail = value.slice(-128)
  const trailingWord = /\b([A-Za-z][A-Za-z0-9_-]*)["']?\s*$/.exec(tail)?.[1]
  if (!trailingWord) return false
  const normalized = trailingWord.toUpperCase()
  const finalSegment = trailingWord.split(/[_-]|(?<=[a-z0-9])(?=[A-Z])/).at(-1)?.toUpperCase() ?? ""
  return isCredentialKey(trailingWord)
    || uppercaseCredentialKeys.some(key => key.startsWith(normalized))
    || ["BEARER", "BASIC"].some(marker => marker.startsWith(normalized))
    || ["KEY", "SECRET", "TOKEN", "PASSWORD"].some(marker => marker.startsWith(finalSegment))
}

export function pendingCredentialQuote(value: string, precedingText = ""): string | undefined {
  const scheme = /\b(Bearer|Basic)\s+("(?:\\[\s\S]|[^"\\])*\\?$|'(?:\\[\s\S]|[^'\\])*\\?$)/i.exec(value)
  if (scheme && isCredentialScheme(scheme[1]!, precedingText + value.slice(0, scheme.index))) return scheme[2]?.[0]
  const assignment = new RegExp(`${credentialAssignmentPrefix}("(?:\\\\[\\s\\S]|[^"\\\\])*\\\\?$|'(?:\\\\[\\s\\S]|[^'\\\\])*\\\\?$)`, "i").exec(value)
  return assignment && isCredentialAssignment(assignment[2]!, assignment[1]!, precedingText + value.slice(0, assignment.index)) ? assignment[3]?.[0] : undefined
}

// Preserve assignment context between bounded journal chunks without retaining values.
export function credentialTextLineContext(value: string): string {
  const lastLine = value.split(/[\r\n]/).at(-1) ?? ""
  const authorizationHeader = /\b(?:proxy-)?authorization["']?\s*:\s*["']?\s*$/i.test(lastLine)
  const mappingContext = credentialMappingContext(value)
  if (mappingContext) return mappingContext
  return authorizationHeader ? "Authorization: " : /^(?:[\t "']*| *- +)$/.test(lastLine) ? lastLine : "x "
}
