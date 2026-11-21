import { webhooksErrors } from "./errors.ts"

import type { Result } from "@vite-hub/runtime"
import type { LookupAddress } from "node:dns"

/** Options of `checkWebhookUrl()`. */
export interface CheckWebhookUrlOptions {
  /**
   * The hosts that the URL may use, such as `["relay.t3.codes"]`. A host matches itself only, not its subdomains.
   * Without it, any public host passes.
   */
  hosts?: readonly string[]
}

type RefusedError = ReturnType<typeof webhooksErrors.WEBHOOKS_URL_REFUSED>

function refuse(reason: string): [RefusedError, undefined] {
  return [webhooksErrors.WEBHOOKS_URL_REFUSED({ reason }), undefined]
}

/** Why the host of `url` is outside `hosts`, or `undefined` when `hosts` lists it. A host does not match its subdomains. */
export function outsideHosts(url: URL, hosts: readonly string[]): string | undefined {
  const host = url.hostname.toLowerCase().replace(/\.$/, "")
  return hosts.some(allowed => allowed.toLowerCase() === host) ? undefined : `its host is not ${hosts.join(" or ") || "allowed"}`
}

type IPv4 = readonly [number, number, number, number]

function parseIPv4(host: string): IPv4 | undefined {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!match) return undefined
  const bytes = [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])] as const
  return bytes.every(byte => byte <= 255) ? bytes : undefined
}

/** The 8 groups of an IPv6 address, or `undefined` when it is not one. Accepts a dotted IPv4 tail, as in `::ffff:1.2.3.4`. */
function parseIPv6(input: string): number[] | undefined {
  let text = input.toLowerCase()
  const dotted = /^(?<head>.*:)(?<tail>\d+\.\d+\.\d+\.\d+)$/.exec(text)?.groups
  if (dotted?.head !== undefined && dotted.tail !== undefined) {
    const v4 = parseIPv4(dotted.tail)
    if (!v4) return undefined
    text = `${dotted.head}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`
  }
  const [before = "", after, ...more] = text.split("::")
  if (more.length) return undefined
  const read = (part: string) => part === "" ? [] : part.split(":")
  const head = read(before)
  const rest = after === undefined ? [] : read(after)
  if (![...head, ...rest].every(group => /^[0-9a-f]{1,4}$/.test(group))) return undefined
  const missing = 8 - head.length - rest.length
  if (after === undefined ? missing !== 0 : missing < 1) return undefined
  const zeros = Array.from({ length: after === undefined ? 0 : missing }, () => "0")
  return [...head, ...zeros, ...rest].map(group => Number.parseInt(group, 16))
}

/** Why an IPv4 address is not public: loopback, private, link-local, cloud metadata, or another range that no receiver uses. */
function privateIPv4([a, b, c]: IPv4): string | undefined {
  if (a === 127) return "a loopback address"
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "a private address"
  if (a === 169 && b === 254) return "a link-local or cloud metadata address"
  // 100.64.0.0/10 is carrier-grade NAT. Alibaba Cloud serves its metadata on 100.100.100.200.
  if (a === 100 && b >= 64 && b <= 127) return "a shared or cloud metadata address"
  if (a === 0) return "an unspecified address"
  if (a === 192 && b === 0 && c === 0) return "a reserved address"
  if (a === 198 && (b === 18 || b === 19)) return "a reserved address"
  if (a >= 224) return "a multicast or reserved address"
  return undefined
}

const embeddedIPv4 = (high: number, low: number): IPv4 => [high >> 8, high & 0xFF, low >> 8, low & 0xFF]

function privateIPv6(groups: readonly number[]): string | undefined {
  const [first = 0, second = 0, third = 0, , , sixth = 0, seventh = 0, eighth = 0] = groups
  const zeroUntil = (end: number) => groups.slice(0, end).every(group => group === 0)
  if (zeroUntil(8)) return "an unspecified address"
  if (zeroUntil(7) && eighth === 1) return "a loopback address"
  // ::ffff:0:0/96 is an IPv4 address written as IPv6, and ::/96 is the deprecated IPv4-compatible form of it.
  // 64:ff9b::/96 reaches IPv4 through NAT64.
  const mapped = zeroUntil(5) && sixth === 0xFFFF
  const compatible = zeroUntil(6)
  const nat64 = first === 0x64 && second === 0xFF9B && groups.slice(2, 6).every(group => group === 0)
  if (mapped || nat64) return privateIPv4(embeddedIPv4(seventh, eighth))
  if (compatible) return privateIPv4(embeddedIPv4(seventh, eighth)) ?? "a deprecated IPv4-compatible address"
  // 64:ff9b:1::/48 is NAT64 for local networks, so it can reach any address behind the translator.
  if (first === 0x64 && second === 0xFF9B && third === 1) return "a local-use NAT64 address"
  // 2002::/16 is 6to4: the next 32 bits are the IPv4 address of the tunnel.
  if (first === 0x2002) {
    const reason = privateIPv4(embeddedIPv4(second, third))
    if (reason) return `a 6to4 address of ${reason}`
  }
  if ((first & 0xFE00) === 0xFC00) return "a private address"
  if ((first & 0xFFC0) === 0xFE80) return "a link-local address"
  if ((first & 0xFF00) === 0xFF00) return "a multicast address"
  return undefined
}

/** Why an IP address is not public, or `undefined` for a public address and for a value that is not an IP address. */
function privateAddress(address: string): string | undefined {
  const v4 = parseIPv4(address)
  if (v4) return privateIPv4(v4)
  const v6 = parseIPv6(address.replace(/^\[|\]$/g, ""))
  return v6 ? privateIPv6(v6) : undefined
}

export interface ResolvedWebhookUrl {
  url: URL
  addresses?: LookupAddress[]
}

/**
 * Checks that `url` is safe to post a signed body to, and returns it parsed as `[error, url]`. It refuses a URL that:
 *
 * - is not `https`, or holds a user name or a password;
 * - uses a host outside `hosts`, when you pass `hosts`;
 * - names a loopback, private, link-local, or cloud metadata address, such as `127.0.0.1`, `10.0.0.1`,
 *   `169.254.169.254`, or `[::1]`;
 * - on Node, Bun, and Deno, has a name that resolves to such an address, or does not resolve.
 *
 * Cloudflare Workers cannot resolve names, so there a name passes on the host allowlist alone. Webhooks checks the URL
 * again before each delivery.
 *
 * ```ts
 * import { checkWebhookUrl } from "@vite-hub/webhooks"
 *
 * const [error] = await checkWebhookUrl("https://relay.t3.codes/hooks/abc", { hosts: ["relay.t3.codes"] })
 * ```
 */
export async function checkWebhookUrl(url: string, options: CheckWebhookUrlOptions = {}): Promise<Result<URL, "WEBHOOKS_URL_REFUSED">> {
  const [error, resolved] = await resolveWebhookUrl(url, options)
  return error ? [error, undefined] : [undefined, resolved.url]
}

export async function resolveWebhookUrl(url: string, options: CheckWebhookUrlOptions = {}): Promise<Result<ResolvedWebhookUrl, "WEBHOOKS_URL_REFUSED">> {
  if (typeof url !== "string" || !URL.canParse(url)) return refuse("it is not a URL")
  const parsed = new URL(url)
  if (parsed.protocol !== "https:") return refuse("it does not use https")
  if (parsed.username || parsed.password) return refuse("it holds a user name or a password")
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "")
  const outside = options.hosts && outsideHosts(parsed, options.hosts)
  if (outside) return refuse(outside)
  if (host === "localhost" || host.endsWith(".localhost")) return refuse("it names a loopback address")
  const literal = privateAddress(host)
  if (literal) return refuse(`it names ${literal}`)
  if (parseIPv4(host) || host.startsWith("[")) return [undefined, { url: parsed }]
  if (globalThis.navigator?.userAgent === "Cloudflare-Workers" || typeof process !== "object" || !process?.versions?.node) {
    return [undefined, { url: parsed }]
  }
  let addresses: LookupAddress[]
  try {
    const { lookup } = await import("node:dns/promises")
    addresses = await lookup(host, { all: true, verbatim: true })
  }
  catch {
    return refuse("its host does not resolve")
  }
  if (!addresses.length) return refuse("its host does not resolve")
  for (const { address } of addresses) {
    const reason = privateAddress(address)
    if (reason) return refuse(`its host resolves to ${reason}`)
  }
  return [undefined, { url: parsed, addresses }]
}
