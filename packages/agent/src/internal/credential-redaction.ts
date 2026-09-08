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

function isCredentialAssignment(key: string, prefix: string, precedingText: string): boolean {
  if (!isCredentialKey(key)) return false
  const cli = prefix.startsWith("--")
  if (cli && /^key$/i.test(key)) return false
  if (!/(?:[:=]|\?=|\+=)\s*$/.test(prefix)) {
    if (/^password$/i.test(key) && /(?:^|\s)machine\s+\S+(?:\s+\S+)*\s+login\s+\S+\s*$/i.test(precedingText)) return true
    return cli
  }
  if (!prefix.trimEnd().endsWith(":")) return true
  if (yamlBlockContext(precedingText).inside) return false
  // Generic token/key fields also describe parser tokens and object identifiers.
  if (/^(?:key|token)$/i.test(key)) return false
  // Quoted fields and YAML mapping boundaries establish assignments; inline prose labels do not.
  if (/^(?:password|secret)$/i.test(key)) {
    return /["']\s*:\s*$/.test(prefix) || /(?:^|[\r\n]) *(?:- +)?$/.test(precedingText) || /[{,]\s*$/.test(precedingText)
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

const credentialAssignmentPrefix = String.raw`(?<![A-Za-z0-9_-])((?:--)?["']?((?:[A-Z][A-Z0-9_-]*)?(?:KEY|SECRET|TOKEN|PASSWORD))["']?(?:\s*(?:\?=|\+=|:=|[:=])[\t ]*|(?:(?<=--["']?[A-Z][A-Z0-9_-]*["']?)|(?<=\bPASSWORD))\s+))`

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
    else if (state.outerQuote) {
      if (character === state.outerQuote) return index
    }
    else if (state.quote) {
      if (character === state.quote) delete state.quote
    }
    else if (/[\r\n;&<>}]/.test(character)) return index
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
  structureClosers?: string[]
  shellDollar?: boolean
  shellProcess?: boolean
  shellSubstitutions?: { closer: string, quote?: string }[]
  yamlIndent?: number
  yamlProperty?: boolean
  yaml?: { header: boolean, modifiers: boolean, plain?: boolean, indent?: number, line: boolean, spaces: number, whitespace: string }
}

// Retain ordinary separators without letting whitespace-only stream deltas
// grow the redaction state without bound.
const maxYamlSeparatorLength = 1024

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
    if (state.structureClosers?.length === 0) return index
    // YAML anchors and tags precede the value, including across chunk boundaries.
    if (state.yamlProperty) {
      if (!/\s/.test(character)) continue
      delete state.yamlProperty
    }
    // An empty YAML credential field has no value to redact. Stop at its
    // line break or comment so ordinary configuration evidence remains intact.
    if (!state.started && state.yamlIndent !== undefined && /[\r\n#]/.test(character)) return index
    if (!state.started && /\s/.test(character)) continue
    if (!state.started && state.yamlIndent !== undefined && (character === "&" || character === "!")) {
      state.yamlProperty = true
      continue
    }
    if (!state.started && state.yamlIndent !== undefined && (character === "|" || character === ">")) {
      state.yaml = { header: true, modifiers: true, line: false, spaces: 0, whitespace: "" }
    }
    else if (!state.started && state.yamlIndent !== undefined && !/["'{[]/.test(character)) {
      state.yaml = { header: false, modifiers: false, plain: true, line: false, spaces: 0, whitespace: "" }
    }
    if (!state.started && (character === "{" || character === "[")) {
      state.structureClosers = [character === "{" ? "}" : "]"]
      state.started = true
      continue
    }
    state.started = true
    if (state.yaml) {
      const yaml = state.yaml
      // Plain YAML scalars include spaces and shell punctuation. Only a
      // separated comment or a dedented line ends the credential value.
      if (yaml.plain && character === "#" && (yaml.line || yaml.whitespace)) {
        if (yaml.line) yaml.whitespace += " ".repeat(Math.min(yaml.spaces, maxYamlSeparatorLength - yaml.whitespace.length))
        return index
      }
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
            yaml.whitespace += " ".repeat(Math.min(indent, maxYamlSeparatorLength - yaml.whitespace.length))
            return index
          }
          if (!yaml.plain) yaml.indent ??= indent
          yaml.line = false
          yaml.whitespace = ""
        }
      }
      else if (yaml.plain) {
        if (!/[\t \r]/.test(character)) yaml.whitespace = ""
        else if (yaml.whitespace.length < maxYamlSeparatorLength) yaml.whitespace += character
      }
      continue
    }
    const shell = !state.structureClosers && state.yamlIndent === undefined
    const substitution = state.shellSubstitutions?.at(-1)
    const dollar = state.shellDollar
    const process = state.shellProcess
    delete state.shellDollar
    delete state.shellProcess
    if (state.escaped) state.escaped = false
    else if (character === "\\" && state.quote !== "'") state.escaped = true
    else if (shell && ((dollar && (character === "(" || character === "{")) || (process && character === "("))) {
      (state.shellSubstitutions ??= []).push({ closer: character === "{" ? "}" : ")", quote: state.quote })
      delete state.quote
    }
    else if (shell && !state.quote && (character === "<" || character === ">") && (value[index + 1] === "(" || index + 1 === value.length)) state.shellProcess = true
    else if (shell && character === "$" && state.quote !== "'") state.shellDollar = true
    else if (shell && character === "`" && state.quote !== "'") {
      if (substitution?.closer === "`" && !state.quote) {
        state.quote = state.shellSubstitutions!.pop()!.quote
      }
      else {
        (state.shellSubstitutions ??= []).push({ closer: "`", quote: state.quote })
        delete state.quote
      }
    }
    else if (state.quote) {
      if (character === state.quote) delete state.quote
    }
    else if (character === '"' || character === "'") state.quote = character
    else if (substitution) {
      if ((character === "(" && substitution.closer === ")") || (character === "{" && substitution.closer === "}")) state.shellSubstitutions!.push({ closer: substitution.closer })
      else if (character === substitution.closer) state.quote = state.shellSubstitutions!.pop()!.quote
    }
    else if (state.structureClosers) {
      if (character === "{") state.structureClosers.push("}")
      else if (character === "[") state.structureClosers.push("]")
      else if (character === state.structureClosers.at(-1)) state.structureClosers.pop()
    }
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
function yamlBlockContext(value: string): { inside: boolean, header?: string, line: string } {
  const lines = value.split(/\r\n|[\r\n]/)
  let parentIndent: number | undefined
  let contentIndent: number | undefined
  let header: string | undefined
  for (const [index, line] of lines.entries()) {
    const indent = line.match(/^ */)![0].length
    if (parentIndent !== undefined && line.trim()) {
      if (indent < (contentIndent ?? parentIndent + 1)) {
        parentIndent = undefined
        contentIndent = undefined
        header = undefined
      }
      else {
        contentIndent ??= indent
      }
    }
    if (parentIndent === undefined && index < lines.length - 1) {
      const match = /^( *)(- +)?[^:\r\n]+:[\t ]*[|>]([1-9+-]*)[\t ]*(?:#.*)?$/.exec(line)
      if (match) {
        parentIndent = match[1]!.length + (match[2]?.length ?? 0)
        const explicitIndent = /[1-9]/.exec(match[3]!)?.[0]
        contentIndent = explicitIndent ? parentIndent + Number(explicitIndent) : undefined
        header = `${" ".repeat(parentIndent)}x: |${match[3]}\n`
      }
    }
  }
  const line = lines.at(-1) ?? ""
  const indent = line.match(/^ */)![0].length
  // A synthetic content line retains inferred indentation without scalar text.
  if (header && contentIndent !== undefined) header += `${" ".repeat(contentIndent)}x\n`
  return { inside: parentIndent !== undefined && indent >= (contentIndent ?? parentIndent + 1), header, line }
}

export function credentialTextLineContext(value: string): string {
  const block = yamlBlockContext(value)
  if (block.header) {
    return block.header + block.line.match(/^ */)![0] + (block.line.trim() ? "x" : "")
  }
  const lastLine = block.line
  if (/^ *- *$/.test(lastLine)) return lastLine
  const flowBoundary = /[{,][\t ]*$/.exec(lastLine)?.[0]
  if (flowBoundary) return flowBoundary
  const authorizationHeader = /\b(?:proxy-)?authorization["']?\s*:\s*["']?\s*$/i.test(lastLine)
  if (authorizationHeader) return "Authorization: "
  // Retain a possible block header across chunks, without retaining its key.
  const header = /^( *(?:- +)?)([^:\r\n]+)(:[\t ]*(?:[|>][1-9+-]*[\t ]*(?:#.*)?)?)?$/.exec(block.line)
  if (header && !/["']/.test(block.line) && !/^(?:[\t ]*| *- +)$/.test(block.line)) {
    // A synthetic key must preserve the word boundary before a retained header.
    // Otherwise punctuation followed by Authorization becomes xAuthorization.
    const separator = /\s+$/.exec(block.line)?.[0] ?? (/\w$/.test(block.line) ? "" : " ")
    return `${header[1]}x${header[3]?.replace(/#.*$/, "#") ?? separator}`
  }
  return /^(?:[\t "']*| *- +)$/.test(lastLine) ? lastLine : "x "
}
