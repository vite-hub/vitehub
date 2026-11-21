function firstHeaderValue(headers: Headers, name: string): string | undefined {
  return headers.get(name)?.split(",", 1)[0]?.trim() || undefined
}

/**
 * The origin that the client used for `request`. A TLS-terminating proxy sends the client scheme in
 * `X-Forwarded-Proto` and the client host in `X-Forwarded-Host`. Each proxy appends its value, so the first value wins.
 * Without these headers, or with values that are not valid, the result is the origin of `request.url`.
 */
export function forwardedRequestOrigin(request: Pick<Request, "headers" | "url">): string {
  const url = new URL(request.url)
  const forwardedProtocol = firstHeaderValue(request.headers, "x-forwarded-proto")?.toLowerCase()
  const protocol = forwardedProtocol === "http" || forwardedProtocol === "https" ? forwardedProtocol : url.protocol.slice(0, -1)
  const host = firstHeaderValue(request.headers, "x-forwarded-host") ?? url.host
  // Reject controls before URL parsing can silently strip them.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\s/\\?#@]/.test(host)) return url.origin
  try {
    return new URL(`${protocol}://${host}`).origin
  }
  catch {
    return url.origin
  }
}

/**
 * Whether a request came in on one of the public `origins` of the app, such as the origin of `vitehub({ publicUrl })`.
 * It compares the host that the client used, so a proxy that does not forward the scheme still matches. A loopback
 * host, such as `localhost:3000` for a preview or a proxy that does not forward the host, also matches: it cannot be a
 * second public hostname. Every request matches when `origins` is empty.
 */
export function matchesPublicOrigin(request: Pick<Request, "headers" | "url">, origins: readonly string[]): boolean {
  if (origins.length === 0) return true
  const { host, hostname } = new URL(forwardedRequestOrigin(request))
  return isLoopbackHostname(hostname) || origins.some(origin => new URL(origin).host === host)
}

/** `localhost`, `[::1]`, or an IPv4 address in `127.0.0.0/8`. URL parsing writes IPv4 addresses as four decimal parts. */
function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(hostname)
}
