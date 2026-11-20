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
 * Whether a browser treats `origin` as secure: `https:`, or `http:` on a loopback host (`localhost`, `*.localhost`,
 * `127.0.0.0/8`, or `[::1]`). A route that answers with a secret, or builds a URL that carries one, needs this.
 */
export function isSecureOrigin(origin: string): boolean {
  if (!URL.canParse(origin)) return false
  const { protocol, hostname } = new URL(origin)
  if (protocol === "https:") return true
  if (protocol !== "http:") return false
  const host = hostname.toLowerCase()
  if (host === "localhost" || host.endsWith(".localhost") || host === "[::1]") return true
  const octets = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  return octets !== null && octets.slice(1).every(octet => Number(octet) <= 255)
}
