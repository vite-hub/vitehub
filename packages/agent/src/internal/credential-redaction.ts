// Recognize established concatenated credential names regardless of case.
const uppercaseCredentialKeys = [
  "APIKEY", "ACCESSKEY", "PRIVATEKEY", "SECRETKEY", "PUBLICKEY",
  "ACCESSTOKEN", "AUTHTOKEN", "REFRESHTOKEN", "CLIENTSECRET", "SESSIONTOKEN",
  "X-API-KEY", "X-ACCESS-TOKEN", "CREDENTIAL", "CREDENTIALS", "AUTHORIZATION",
]

function isCredentialKey(key: string): boolean {
  return uppercaseCredentialKeys.includes(key.toUpperCase())
    || /(?:^|[_-])(?:key|secret|token|password)$/i.test(key)
    || /[a-z0-9](?:Key|Secret|Token|Password|KEY|SECRET|TOKEN|PASSWORD)$/.test(key)
}

function isCredentialAssignment(key: string, prefix: string, precedingText: string): boolean {
  if (!isCredentialKey(key)) return false
  const cli = prefix.startsWith("--")
  if (cli && /^key$/i.test(key)) return false
  if (!/[:=]\s*$/.test(prefix)) return cli
  if (!prefix.trimEnd().endsWith(":")) return true
  // Authorization headers have already been redacted with their scheme preserved.
  if (/^(?:proxy-)?authorization$/i.test(key)) return false
  // Generic token/key fields also describe parser tokens and object identifiers.
  if (/^(?:key|token)$/i.test(key)) return false
  // Quoted fields, YAML line starts, and flow mapping boundaries establish assignments.
  if (/^(?:password|secret)$/i.test(key)) {
    return /["']\s*:\s*$/.test(prefix) || /(?:^|[\r\n]) *(?:- +)?$/.test(precedingText) || /[{,[]\s*$/.test(precedingText)
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
  return ["AUTHORIZATION", "PROXY-AUTHORIZATION", "COOKIE", "SET-COOKIE"].some(header => header.startsWith(name)) ? match[0] : undefined
}

// An unfinished authority may still turn out to contain userinfo. Once the
// journal exhausts its buffer, omit that authority until its boundary arrives.
export function pendingCredentialUri(value: string): { start: number, prefix: string } | undefined {
  const match = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/\\?#@"<>]*$/i.exec(value)
  return match ? { start: match.index, prefix: match[1]! } : undefined
}

export function pendingCredentialTextSuffix(value: string): string | undefined {
  const tail = value.slice(-128)
  return /\b[a-z][a-z0-9+.-]*:\/?$/i.exec(tail)?.[0]
    ?? /(?<![A-Za-z0-9_-])--[A-Za-z][A-Za-z0-9_-]*["']?\s*$/.exec(tail)?.[0]
    ?? /(?<![A-Za-z0-9_-])--?$/.exec(tail)?.[0]
    ?? /["']?\b(?:proxy-)?authorization["']?\s*:\s*["']?[!#$%&'*+.^_`|~A-Za-z0-9-]*$/i.exec(tail)?.[0]
    ?? pendingAuthorizationHeader(value)
    ?? /(?:--)?["']?\b[A-Za-z][A-Za-z0-9_-]*["']?\s*$/.exec(tail)?.[0]
}

const credentialAssignmentPrefix = String.raw`(?<![A-Za-z0-9_-])((?:--)?["']?((?:[A-Z][A-Z0-9_-]*)?(?:KEY|SECRET|TOKEN|PASSWORD|CREDENTIALS?|AUTHORIZATION))["']?(?:\s*[:=]\s*|(?<=--["']?[A-Z][A-Z0-9_-]*["']?)\s+))`

const unquotedCredentialValue = String.raw`(?:\\(?:[\s\S]|$)|[^\s"',;&{}<>\\])`

export interface AuthorizationState {
  escaped: boolean
  quote?: string
  outerQuote?: string
  cookie?: boolean
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
    else if (character === state.outerQuote || (state.cookie ? /[\r\n<>}]/ : /[\r\n;&<>}]/).test(character)) return index
    else if (character === '"' || character === "'") state.quote = character
  }
  return value.length
}

function* authorizationValues(value: string) {
  // Only established scheme names may remain visible. An arbitrary first token
  // can itself be a schemeless credential, even when more header text follows.
  const headers = /\b(?:proxy-)?authorization["']?[\t ]*:[\t ]*(["']?)[\t ]*(?:(Bearer|Basic|Digest|Token|ApiKey|Negotiate|AWS4-HMAC-SHA256)[\t ]+)?/gi
  const cookies = /\b(?:set-)?cookie["']?[\t ]*:[\t ]*(["']?)/gi
  const matches = [...value.matchAll(headers), ...value.matchAll(cookies)].sort((left, right) => left.index - right.index)
  for (const match of matches) {
    if (/^(Bearer|Basic)$/i.test(match[2]!)) continue
    const start = match.index + match[0].length
    const state: AuthorizationState = { escaped: false, ...(/^(?:set-)?cookie/i.test(match[0]) ? { cookie: true } : {}), ...(match[1] ? { outerQuote: match[1] } : {}) }
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
    if (!entry.state.cookie && !entry.scheme && content.length < 64 && /^[!#$%&'*+.^_`|~A-Za-z0-9-]*$/.test(content)) continue
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
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/\\?#@"<>]+@/gi, "$1[REDACTED]@")
    .replace(/\bph[cx]_[A-Za-z0-9_-]+\b/g, "[REDACTED]")
    .replace(/(\bproject\b[^\r\n]{0,160}?\btoken["']?\s*:\s*)("(?:\\[\s\S]|[^"\\])*"?|'(?:\\[\s\S]|[^'\\])*'?|[^\s"',;&{}<>()]+)/gi, (_match, prefix: string, token: string) => {
      const quote = /^["']/.test(token) ? token[0]! : ""
      const closed = quote && token.length > 1 && token.endsWith(quote) && !/(?:^|[^\\])(?:\\\\)*\\["']$/.test(token)
      return `${prefix}${quote}[REDACTED]${closed ? quote : ""}`
    })
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
  yamlFlow?: boolean
  yamlFlowDepth?: number
  yamlFlowQuote?: string
  yamlFlowEscaped?: boolean
  yamlIndent?: number
  yamlPlain?: { whitespace: boolean, line?: boolean, spaces?: number, pending?: string }
  yamlProperty?: boolean
  yaml?: { header: boolean, modifiers: boolean, indent?: number, line: boolean, spaces: number, whitespace: string }
}

function assignmentState(source: string, offset: number, prefix: string): CredentialAssignmentState {
  const line = source.slice(0, offset).split(/\r\n|[\r\n]/).at(-1) ?? ""
  const yamlIndent = /^ *(?:- +)?$/.test(line) && prefix.trimEnd().endsWith(":") ? line.length : undefined
  const yamlFlow = /[{,[]\s*$/.test(source.slice(0, offset)) && prefix.trimEnd().endsWith(":")
  return { escaped: false, started: false, ...(yamlFlow ? { yamlFlow } : {}), ...(yamlIndent === undefined ? {} : { yamlIndent }) }
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
    if (state.yamlPlain && content[length] === "#") result += " "
    if (state.yamlPlain && length < content.length) result += state.yamlPlain.pending ?? ""
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
    if (!state.started && (state.yamlIndent !== undefined || state.yamlFlow) && !state.yaml && character !== '"' && character !== "'") {
      state.yamlPlain = { whitespace: false }
    }
    state.started = true
    if (state.yamlPlain) {
      const plain = state.yamlPlain
      // Delay whitespace until indentation identifies a continuation or a safe suffix.
      // Keep this state across journal chunks without retaining credential text.
      if (!state.yamlFlow && plain.line) {
        if (character === " " || character === "\r" || character === "\n") {
          // Excess blank-line formatting may be dropped, but retain the safe suffix.
          plain.pending = ((plain.pending ?? "") + character).slice(-4096)
          plain.spaces = /[\r\n]/.test(character) ? 0 : Math.min(state.yamlIndent! + 1, (plain.spaces ?? 0) + (character === " " ? 1 : 0))
          continue
        }
        if ((plain.spaces ?? 0) <= state.yamlIndent!) return index
        plain.line = false
        plain.pending = ""
      }
      if (!state.yamlFlow && /[\r\n]/.test(character)) {
        plain.line = true
        plain.spaces = 0
        plain.pending = character
        continue
      }
      if (state.yamlFlow) {
        if (state.yamlFlowQuote) {
          if (state.yamlFlowEscaped) state.yamlFlowEscaped = false
          else if (character === "\\" && state.yamlFlowQuote === '"') state.yamlFlowEscaped = true
          else if (character === state.yamlFlowQuote) delete state.yamlFlowQuote
          continue
        }
        if ((state.yamlFlowDepth ?? 0) > 0 && (character === '"' || character === "'")) {
          state.yamlFlowQuote = character
          continue
        }
        if (character === "[" || character === "{") {
          state.yamlFlowDepth = (state.yamlFlowDepth ?? 0) + 1
          continue
        }
        if ((state.yamlFlowDepth ?? 0) > 0) {
          if (character === "]" || character === "}") state.yamlFlowDepth!--
          continue
        }
      }
      if ((state.yamlFlow && /[,}\]]/.test(character)) || /[\r\n]/.test(character) || (character === "#" && state.yamlPlain.whitespace)) return index
      state.yamlPlain.whitespace = /[\t ]/.test(character)
      continue
    }
    if (state.yaml) {
      const yaml = state.yaml
      if (yaml.header) {
        if (!/[|>+1-9-]/.test(character)) yaml.modifiers = false
        if (yaml.modifiers && /[1-9]/.test(character)) yaml.indent = state.yamlIndent! + Number(character)
        if (/[\r\n]/.test(character)) {
          yaml.header = false
          yaml.line = true
          yaml.whitespace = character
        }
      }
      else if (/[\r\n]/.test(character)) {
        yaml.line = true
        yaml.whitespace = character === "\n" && yaml.whitespace === "\r" ? "\r\n" : character
        yaml.spaces = 0
      }
      else if (yaml.line) {
        if (character === " ") yaml.spaces++
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
  if (pendingCredentialUri(value) || /\b[a-z][a-z0-9+.-]*:\/?$/i.test(value)) return true
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
  if (/[{,[]\s*$/.test(lastLine)) return lastLine.trimEnd().slice(-1) + " "
  return authorizationHeader ? "Authorization: " : /^(?:[\t "']*| *- +)$/.test(lastLine) ? lastLine : "x "
}
