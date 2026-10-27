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
