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
  if (!prefix.trimEnd().endsWith(":")) return true
  // Generic token/key fields also describe parser tokens and object identifiers.
  if (/^(?:key|token)$/i.test(key)) return false
  // A prose label alone does not establish a password/secret assignment.
  if (/^(?:password|secret)$/i.test(key)) return /["']\s*:\s*$/.test(prefix)
  return true
}

function isCredentialScheme(scheme: string, prefix: string): boolean {
  return scheme.toLowerCase() === "bearer" || scheme === "Basic"
    || /\b(?:proxy-)?authorization["']?\s*:\s*["']?\s*$/i.test(prefix)
}

export function pendingCredentialScheme(value: string): "scheme" | "unquoted" | undefined {
  const match = /\b(Bearer|Basic)\s+([^\s"',;&{}<>]*)$/i.exec(value)
  if (!match || !isCredentialScheme(match[1]!, value.slice(0, match.index))) return
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
  return pendingAuthorizationHeader(value)
    ?? /["']?\b(?:proxy-)?authorization["']?\s*:\s*["']?[A-Za-z]*$/i.exec(tail)?.[0]
    ?? /["']?\b[A-Za-z][A-Za-z0-9_-]*["']?\s*$/.exec(tail)?.[0]
}

const credentialAssignmentPrefix = String.raw`(?<![A-Za-z0-9_-])(["']?((?:[A-Z][A-Z0-9_-]*)?(?:KEY|SECRET|TOKEN|PASSWORD))["']?\s*[:=]\s*)`

export function redactCredentialText(value: string): string {
  return value
    .replace(new RegExp(`${credentialAssignmentPrefix}("(?:\\\\[\\s\\S]|[^"\\\\])*"?|'(?:\\\\[\\s\\S]|[^'\\\\])*'?)`, "gi"), (match, prefix: string, key: string, quoted: string) => {
      if (!isCredentialAssignment(key, prefix)) return match
      const quote = quoted[0]!
      const closed = quoted.length > 1 && quoted.endsWith(quote) && !/(?:^|[^\\])(?:\\\\)*\\["']$/.test(quoted)
      return `${prefix}${quote}[REDACTED]${closed ? quote : ""}`
    })
    .replace(/\b(Bearer|Basic)\s+[^\s"',;&{}<>]+/gi, (match, scheme: string, offset: number, source: string) =>
      isCredentialScheme(scheme, source.slice(0, offset)) ? `${scheme} [REDACTED]` : match)
    .replace(new RegExp(`${credentialAssignmentPrefix}([^\\s"',;&{}<>]+)`, "gi"), (match, prefix: string, key: string) => isCredentialAssignment(key, prefix) ? `${prefix}[REDACTED]` : match)
}

export function pendingCredentialAssignment(value: string): "assignment" | "unquoted" | undefined {
  const assignment = new RegExp(`${credentialAssignmentPrefix}([^\\s"',;&{}<>]*)$`, "i").exec(value)
  if (!assignment || !isCredentialAssignment(assignment[2]!, assignment[1]!)) return
  return assignment[3] ? "unquoted" : "assignment"
}

export function credentialTextMayContinue(value: string): boolean {
  if (pendingAuthorizationHeader(value)) return true
  if (pendingCredentialQuote(value)) return true
  if (pendingCredentialScheme(value)) return true
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

export function pendingCredentialQuote(value: string): string | undefined {
  const assignment = new RegExp(`${credentialAssignmentPrefix}("(?:\\\\[\\s\\S]|[^"\\\\])*\\\\?$|'(?:\\\\[\\s\\S]|[^'\\\\])*\\\\?$)`, "i").exec(value)
  return assignment && isCredentialAssignment(assignment[2]!, assignment[1]!) ? assignment[3]?.[0] : undefined
}
