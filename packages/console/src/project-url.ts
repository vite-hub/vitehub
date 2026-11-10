import { normalizeConsoleProjectUrl } from "@vite-hub/runtime"

/**
 * The Console server fetches the URLs of linked projects. A person who links a project must not make it fetch an
 * address inside the network of the Console, such as a metadata service or a database admin page. So a project URL is
 * public by default, as in Executor. Set `VITEHUB_CONSOLE_ALLOW_PRIVATE=true` on a Console that runs next to its apps.
 *
 * The check reads the host name. A public name that resolves to a private address passes it.
 */
export const allowPrivateVariable = "VITEHUB_CONSOLE_ALLOW_PRIVATE"

const privateNames = [/^localhost$/, /\.localhost$/, /\.local$/, /\.internal$/, /\.home\.arpa$/]

function ipv4(hostname: string): number[] | undefined {
  const parts = hostname.split(".")
  if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part))) return undefined
  const bytes = parts.map(Number)
  return bytes.every(byte => byte <= 255) ? bytes : undefined
}

function isPrivateIpv4([a = 0, b = 0]: number[]): boolean {
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224
}

/** Whether a URL host name is a loopback, link-local, private, or local-only address or name. */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "")
  if (privateNames.some(pattern => pattern.test(host))) return true
  const v4 = ipv4(host)
  if (v4) return isPrivateIpv4(v4)
  if (!host.startsWith("[")) return false
  const v6 = host.slice(1, -1)
  // An IPv4 address inside IPv6, such as ::ffff:127.0.0.1, which the URL parser writes as ::ffff:7f00:1.
  const mapped = /^::ffff:([\da-f]{1,4}):([\da-f]{1,4})$/.exec(v6)
  if (mapped) {
    const high = Number.parseInt(mapped[1]!, 16)
    const low = Number.parseInt(mapped[2]!, 16)
    return isPrivateIpv4([high >> 8, high & 255, low >> 8, low & 255])
  }
  return v6 === "::" || v6 === "::1" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith("::ffff:")
}

/**
 * Read the URL of a project that a person typed: an `https://` origin, with the application mount when there is one,
 * such as `https://app.example.com/portal`. A pasted Console URL keeps only the part before `/_vitehub`.
 */
export function parseProjectUrl(input: string, options: { allowPrivate: boolean }): { url: string } | { error: string } {
  const value = input.trim()
  // A host without a scheme, such as `app.example.com`, means https.
  const url = normalizeConsoleProjectUrl(/^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`)
  if (!url) return { error: `"${value}" is not a project URL. Use the https:// URL of the app, such as https://app.example.com.` }
  const { hostname } = new URL(url)
  if (!options.allowPrivate && isPrivateHost(hostname)) {
    return { error: `${hostname} is a private address. This Console links only public apps. Set ${allowPrivateVariable}=true on a Console that runs next to its apps.` }
  }
  return { url }
}
