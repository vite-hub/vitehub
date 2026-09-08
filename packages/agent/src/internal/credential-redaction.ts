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

function isCredentialAssignment(key: string, prefix: string): boolean {
  if (!isCredentialKey(key)) return false
  const cli = prefix.startsWith("--")
  if (cli && /^key$/i.test(key)) return false
  if (!/[:=]\s*$/.test(prefix)) return cli
  if (!prefix.trimEnd().endsWith(":")) return true
  // Generic token/key fields also describe parser tokens and object identifiers.
  if (/^(?:key|token)$/i.test(key)) return false
  // A prose label alone does not establish a password/secret assignment.
  if (/^(?:password|secret)$/i.test(key)) return /["']\s*:\s*$/.test(prefix)
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
  const headers = /\b(?:proxy-)?authorization["']?[\t ]*:[\t ]*(["']?)[\t ]*([!#$%&'*+.^_`|~A-Za-z0-9-]+)[\t ]+/gi
  for (const match of value.matchAll(headers)) {
    if (/^(Bearer|Basic)$/i.test(match[2]!)) continue
    const start = match.index + match[0].length
    const state: AuthorizationState = { escaped: false, ...(match[1] ? { outerQuote: match[1] } : {}) }
    const length = consumeAuthorization(value.slice(start), state)
    yield { start, length, state }
  }
}

export function pendingAuthorizationState(value: string): AuthorizationState | undefined {
  for (const entry of authorizationValues(value)) {
    if (entry.start + entry.length === value.length) return entry.state
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
  return redactAuthorizationHeaders(value)
    .replace(/\b(Bearer|Basic)\s+("(?:\\[\s\S]|[^"\\])*"?|'(?:\\[\s\S]|[^'\\])*'?)/gi, (match, scheme: string, quoted: string, offset: number, source: string) => {
      if (!isCredentialScheme(scheme, precedingText + source.slice(0, offset))) return match
      const quote = quoted[0]!
      const closed = quoted.length > 1 && quoted.endsWith(quote) && !/(?:^|[^\\])(?:\\\\)*\\["']$/.test(quoted)
      return `${scheme} ${quote}[REDACTED]${closed ? quote : ""}`
    })
    .replace(new RegExp(String.raw`\b(Bearer|Basic)\s+${unquotedCredentialValue}+`, "gi"), (match, scheme: string, offset: number, source: string) =>
      isCredentialScheme(scheme, precedingText + source.slice(0, offset)) ? `${scheme} [REDACTED]` : match)
    .replace(new RegExp(`${credentialAssignmentPrefix}(${shellCredentialValue}+)`, "gi"), (match, prefix: string, key: string, content: string) => {
      if (!isCredentialAssignment(key, prefix)) return match
      const quote = /^["']/.exec(content)?.[0] ?? ""
      const state: CredentialAssignmentState = { escaped: false, started: false }
      consumeCredentialAssignment(content, state)
      return `${prefix}${quote}[REDACTED]${quote && !state.quote ? quote : ""}`
    })
}

export interface CredentialAssignmentState {
  escaped: boolean
  started: boolean
  quote?: string
}

// Shell assignments concatenate adjacent quoted and unquoted segments.
const shellCredentialValue = String.raw`(?:"(?:\\[\s\S]|[^"\\])*"?|'(?:\\[\s\S]|[^'\\])*'?|${unquotedCredentialValue})`

export function consumeCredentialAssignment(value: string, state: CredentialAssignmentState): number {
  for (let index = 0; index < value.length; index++) {
    const character = value[index]!
    if (!state.started && /\s/.test(character)) continue
    state.started = true
    if (state.escaped) state.escaped = false
    else if (character === "\\") state.escaped = true
    else if (state.quote) {
      if (character === state.quote) delete state.quote
    }
    else if (character === '"' || character === "'") state.quote = character
    else if (/[\s,;&{}<>]/.test(character)) return index
  }
  return value.length
}

export function pendingCredentialAssignmentState(value: string): CredentialAssignmentState | undefined {
  for (const match of value.matchAll(new RegExp(credentialAssignmentPrefix, "gi"))) {
    if (!isCredentialAssignment(match[2]!, match[1]!)) continue
    const content = value.slice(match.index + match[0].length)
    const state: CredentialAssignmentState = { escaped: false, started: false }
    if (consumeCredentialAssignment(content, state) === content.length) return state
  }
}

export function pendingCredentialAssignment(value: string): "assignment" | "unquoted" | undefined {
  const state = pendingCredentialAssignmentState(value)
  return state ? state.started ? "unquoted" : "assignment" : undefined
}

export function credentialTextMayContinue(value: string, precedingText = ""): boolean {
  if (pendingAuthorizationState(value)) return true
  if (/\b(?:proxy-)?authorization["']?[\t ]*:[\t ]*["']?[!#$%&'*+.^_`|~A-Za-z0-9-]*$/i.test(value)) return true
  if (/(?<![A-Za-z0-9_-])--?$/.test(value)) return true
  if (pendingAuthorizationHeader(value)) return true
  if (pendingCredentialQuote(value, precedingText)) return true
  if (pendingCredentialScheme(value, precedingText)) return true
  if (pendingCredentialAssignment(value)) return true
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
  return assignment && isCredentialAssignment(assignment[2]!, assignment[1]!) ? assignment[3]?.[0] : undefined
}
