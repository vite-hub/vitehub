export function redactCredentialText(value: string): string {
  return value
    .replace(/\b(Bearer|Basic)\s+[^\s]+/gi, "$1 [REDACTED]")
    .replace(/\b([A-Z][A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD))=([^\s]+)/g, "$1=[REDACTED]")
}

export function credentialTextMayContinue(value: string): boolean {
  if (/\b(?:Bearer|Basic)\s+\S*$/i.test(value)) return true
  if (/\b[A-Z][A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD)=\S*$/.test(value)) return true
  const tail = value.slice(-128)
  const trailingWord = /\b([A-Za-z][A-Za-z0-9_]*)$/.exec(tail)?.[1]
  if (!trailingWord) return false
  const normalized = trailingWord.toUpperCase()
  return ["BEARER", "BASIC"].some(marker => marker.startsWith(normalized))
    || /^[A-Z][A-Z0-9_]*$/.test(trailingWord)
}
