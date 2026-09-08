export function redactCredentialText(value: string): string {
  return value
    .replace(/\b((?:[A-Z][A-Z0-9_]*)?(?:KEY|SECRET|TOKEN|PASSWORD))=("(?:\\[\s\S]|[^"\\])*"?|'(?:\\[\s\S]|[^'\\])*'?)/gi, (_match, key: string, quoted: string) => {
      const quote = quoted[0]!
      const closed = quoted.length > 1 && quoted.endsWith(quote) && !/(?:^|[^\\])(?:\\\\)*\\["']$/.test(quoted)
      return `${key}=${quote}[REDACTED]${closed ? quote : ""}`
    })
    .replace(/\b(Bearer|Basic)\s+[^\s"',;&{}<>]+/gi, "$1 [REDACTED]")
    .replace(/\b((?:[A-Z][A-Z0-9_]*)?(?:KEY|SECRET|TOKEN|PASSWORD))=(["']?)([^\s"',;&{}<>]+)/gi, "$1=$2[REDACTED]")
}

export function credentialTextMayContinue(value: string): boolean {
  if (pendingCredentialQuote(value)) return true
  if (/\b(?:Bearer|Basic)\s+[^\s"',;&{}<>]*$/i.test(value)) return true
  if (/\b(?:[A-Z][A-Z0-9_]*)?(?:KEY|SECRET|TOKEN|PASSWORD)=["']?[^\s"',;&{}<>]*$/i.test(value)) return true
  const tail = value.slice(-128)
  const trailingWord = /\b([A-Za-z][A-Za-z0-9_]*)$/.exec(tail)?.[1]
  if (!trailingWord) return false
  const normalized = trailingWord.toUpperCase()
  const finalSegment = normalized.split("_").at(-1) ?? ""
  return ["BEARER", "BASIC"].some(marker => marker.startsWith(normalized))
    || ["KEY", "SECRET", "TOKEN", "PASSWORD"].some(marker => marker.startsWith(finalSegment))
}

export function pendingCredentialQuote(value: string): string | undefined {
  return /\b(?:[A-Z][A-Z0-9_]*)?(?:KEY|SECRET|TOKEN|PASSWORD)=("(?:\\[\s\S]|[^"\\])*\\?$|'(?:\\[\s\S]|[^'\\])*\\?$)/i.exec(value)?.[1]?.[0]
}
