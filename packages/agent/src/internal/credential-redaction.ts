export function redactCredentialText(value: string): string {
  return value
    .replace(/\b(Bearer|Basic)\s+[^\s]+/gi, "$1 [REDACTED]")
    .replace(/\b([A-Z][A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD))=([^\s]+)/g, "$1=[REDACTED]")
}
