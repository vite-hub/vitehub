// Concatenated uppercase names have no case boundary; recognize established credential names.
const uppercaseCredentialKeys = [
  "APIKEY", "ACCESSKEY", "PRIVATEKEY", "SECRETKEY", "PUBLICKEY",
  "ACCESSTOKEN", "AUTHTOKEN", "REFRESHTOKEN", "CLIENTSECRET", "SESSIONTOKEN",
]

function isCredentialKey(key: string): boolean {
  return uppercaseCredentialKeys.includes(key)
    || /(?:^|_)(?:key|secret|token|password)$/i.test(key)
    || /[a-z0-9](?:Key|Secret|Token|Password|KEY|SECRET|TOKEN|PASSWORD)$/.test(key)
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

export function pendingCredentialTextSuffix(value: string): string | undefined {
  const tail = value.slice(-128)
  return /["']?\b(?:proxy-)?authorization["']?\s*:\s*["']?[A-Za-z]*$/i.exec(tail)?.[0]
    ?? /[A-Za-z][A-Za-z0-9_]*$/.exec(tail)?.[0]
}

export function redactCredentialText(value: string): string {
  return value
    .replace(/\b((?:[A-Z][A-Z0-9_]*)?(?:KEY|SECRET|TOKEN|PASSWORD))=("(?:\\[\s\S]|[^"\\])*"?|'(?:\\[\s\S]|[^'\\])*'?)/gi, (match, key: string, quoted: string) => {
      if (!isCredentialKey(key)) return match
      const quote = quoted[0]!
      const closed = quoted.length > 1 && quoted.endsWith(quote) && !/(?:^|[^\\])(?:\\\\)*\\["']$/.test(quoted)
      return `${key}=${quote}[REDACTED]${closed ? quote : ""}`
    })
    .replace(/\b(Bearer|Basic)\s+[^\s"',;&{}<>]+/gi, (match, scheme: string, offset: number, source: string) =>
      isCredentialScheme(scheme, source.slice(0, offset)) ? `${scheme} [REDACTED]` : match)
    .replace(/\b((?:[A-Z][A-Z0-9_]*)?(?:KEY|SECRET|TOKEN|PASSWORD))=(["']?)([^\s"',;&{}<>]+)/gi, (match, key: string, quote: string) => isCredentialKey(key) ? `${key}=${quote}[REDACTED]` : match)
}

export function credentialTextMayContinue(value: string): boolean {
  if (pendingCredentialQuote(value)) return true
  if (pendingCredentialScheme(value)) return true
  const assignment = /\b((?:[A-Z][A-Z0-9_]*)?(?:KEY|SECRET|TOKEN|PASSWORD))=["']?[^\s"',;&{}<>]*$/i.exec(value)
  if (assignment && isCredentialKey(assignment[1]!)) return true
  const tail = value.slice(-128)
  const trailingWord = /\b([A-Za-z][A-Za-z0-9_]*)$/.exec(tail)?.[1]
  if (!trailingWord) return false
  const normalized = trailingWord.toUpperCase()
  const finalSegment = trailingWord.split(/_|(?<=[a-z0-9])(?=[A-Z])/).at(-1)?.toUpperCase() ?? ""
  return uppercaseCredentialKeys.some(key => key.startsWith(trailingWord))
    || ["BEARER", "BASIC"].some(marker => marker.startsWith(normalized))
    || ["KEY", "SECRET", "TOKEN", "PASSWORD"].some(marker => marker.startsWith(finalSegment))
}

export function pendingCredentialQuote(value: string): string | undefined {
  const assignment = /\b((?:[A-Z][A-Z0-9_]*)?(?:KEY|SECRET|TOKEN|PASSWORD))=("(?:\\[\s\S]|[^"\\])*\\?$|'(?:\\[\s\S]|[^'\\])*\\?$)/i.exec(value)
  return assignment && isCredentialKey(assignment[1]!) ? assignment[2]?.[0] : undefined
}
