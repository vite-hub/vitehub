import { hostedConsoleOrigin, hostedConsoleUrl, normalizeConsolePath, normalizeConsoleProjectUrl } from "@vite-hub/runtime"

import { isRuntimeRecord } from "../internal/runtime-type.ts"
const secretKey = /^(?:authorization|cookie|set-cookie|password|secret|token|api[_-]?key|credentials?|prompt|messages|input|output|raw|context|headers|body|pre_context|post_context|context_line|tool[_-]?(?:input|output|arguments?|result)|(?:input|output)[_-]?body)$/i

function sanitizeString(value: string): string {
  return value
    .replace(/https?:\/\/[^\s<>"']+/g, (value) => {
      try {
        const url = new URL(value)
        url.username = ''
        url.password = ''
        url.hash = ''
        if (url.origin === hostedConsoleOrigin && url.pathname === '/open') {
          // Rebuild only validated destinations. Log strings can contain arbitrary outer queries, and even
          // generated links may carry query credentials inside their encoded Console path.
          const project = normalizeConsoleProjectUrl(url.searchParams.get('project') ?? '')
          const path = normalizeConsolePath(url.searchParams.get('path') ?? '')?.split(/[?#]/)[0]
          if (project && path) return hostedConsoleUrl(project, path)
        }
        url.search = ''
        return url.href
      }
      catch { return '[URL]' }
    })
    .replace(/\b(?:ph[cx]_|sk-[A-Za-z0-9-]*|gh[pousr]_)[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[EMAIL]')
}

/** Explicit papercut messages are allowed; runtime inputs and tool payloads are not. */
export function sanitizeAgentLog(properties: Record<string, unknown>, options: { allowContent?: boolean } = {}): Record<string, unknown> {
  const blocked = options.allowContent
    ? /^(?:authorization|cookie|set-cookie|password|secret|token|api[_-]?key|credentials?|raw|headers)$/i
    : secretKey
  const seen = new WeakSet<object>()
  function clean(value: unknown, depth: number): unknown {
    if (typeof value === "string") return sanitizeString(value).slice(0, 4000)
    if (typeof value === "boolean" || value === null) return value
    if (typeof value === "number") return Number.isFinite(value) ? value : undefined
    if (!value || typeof value !== "object" || depth > 8 || seen.has(value)) return undefined
    seen.add(value)
    if (Array.isArray(value)) return value.slice(0, 100).map(entry => clean(entry, depth + 1))
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !blocked.test(key))
      .map(([key, entry]) => [key, clean(key === 'path' && typeof entry === "string" ? entry.split(/[?#]/)[0] : entry, depth + 1)])
      .filter(([, entry]) => entry !== undefined))
  }
  const result = clean(properties, 0)
  return isRuntimeRecord(result) ? result : {}
}
