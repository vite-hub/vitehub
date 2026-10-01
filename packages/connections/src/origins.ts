import { connectionError } from "./errors.ts"

// `https://api.example.com`, `https://*.example.com`, or `http://localhost:8787`. No path, query, or credentials.
const originPattern = /^(https?):\/\/(\*\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)*|\[[0-9a-f:.]+\])(?::(\d{1,5}))?$/i

function isLoopback(host: string): boolean {
  return host === "localhost" || host.endsWith(".localhost") || host === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(host)
}

/** Checks provider origins when the provider is created. Plain `http` is allowed only for loopback hosts. */
export function assertConnectionOrigins(origins: unknown, path = "provider.origins"): readonly string[] {
  const valid = (origin: unknown) => {
    const match = originPattern.exec(String(origin))
    return !!match && (match[1]!.toLowerCase() === "https" || (!match[2] && isLoopback(match[3]!.toLowerCase())))
  }
  if (!Array.isArray(origins) || !origins.length || !origins.every(valid)) {
    throw connectionError("invalid", { path })
  }
  return origins.map(origin => normalizeOrigin(String(origin)))
}

/** `URL.port` is empty for a default port, so `:443` and `:80` are removed. */
function normalizeOrigin(origin: string): string {
  return origin.toLowerCase().replace(/^(https?):\/\/([^/]+):(\d+)$/, (_match, protocol: string, host: string, port: string) => {
    const normalizedPort = Number(port)
    return `${protocol}://${host}${normalizedPort === (protocol === "https" ? 443 : 80) ? "" : `:${normalizedPort}`}`
  })
}

/** Whether `url` is one of the origins. `*.` matches one or more subdomain labels, not the bare domain. */
export function matchesConnectionOrigin(origins: readonly string[], url: URL): boolean {
  // Origins from a custom provider object may still carry a default port, so they are normalized here too.
  return origins.some((origin) => {
    const match = originPattern.exec(normalizeOrigin(origin))
    if (!match) return false
    const [, protocol, wildcard, host, port] = match
    if (url.protocol !== `${protocol}:` || url.port !== (port ?? "")) return false
    const hostname = url.hostname.toLowerCase()
    return wildcard ? hostname.endsWith(`.${host}`) : hostname === host
  })
}
