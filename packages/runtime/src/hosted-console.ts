/** The origin of the hosted Console. */
export const hostedConsoleOrigin = "https://console.vitehub.dev"

const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"])
const pathBase = "https://console.invalid"

/**
 * The Console path of a link, such as `/agents/bot/invocations/abc?tab=trace`, or `undefined` when the value is not a
 * Console path. A Console path starts with one `/`. Absolute URLs, protocol-relative URLs, and backslashes are not
 * Console paths, so a link cannot send the browser to another site. A path that starts with `/_vitehub`, as on a
 * Console that the app serves, loses that prefix.
 */
export function normalizeConsolePath(path: string): string | undefined {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return undefined
  let url: URL
  try {
    url = new URL(path, pathBase)
  }
  catch {
    return undefined
  }
  // The URL parser drops tabs and newlines, so `/\t/example.com` becomes a protocol-relative URL here.
  if (url.origin !== pathBase) return undefined
  const pathname = url.pathname.replace(/^\/_vitehub(?=\/|$)/, "") || "/"
  if (pathname.startsWith("//")) return undefined
  return `${pathname}${url.search}${url.hash}`
}

/**
 * The project URL of a link: the app origin and its application mount, such as `https://app.example.com/portal`, or
 * `undefined` when the URL cannot be a project. A project URL is `https:`, or `http:` on a loopback host, and has no
 * user name or password.
 */
export function normalizeConsoleProjectUrl(projectUrl: string): string | undefined {
  let url: URL
  try {
    url = new URL(projectUrl)
  }
  catch {
    return undefined
  }
  if (url.username || url.password) return undefined
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopbackHosts.has(url.hostname))) return undefined
  const mount = url.pathname.search(/\/_vitehub(?=\/|$)/)
  const base = (mount === -1 ? url.pathname : url.pathname.slice(0, mount)).replace(/\/+$/, "")
  return `${url.origin}${base}`
}

/**
 * The hosted Console URL that opens one page of a project, such as
 * `https://console.vitehub.dev/open?project=https%3A%2F%2Fapp.example.com&path=%2Fkv`.
 *
 * `projectUrl` is the app origin with its application mount, such as `https://app.example.com/portal`. `path` is the
 * Console path, such as `/agents/bot/invocations/abc`. The hosted Console switches to the project when this browser
 * linked it, or asks the person to link it first. The URL holds no secret.
 *
 * Throws a `TypeError` when `projectUrl` is not `https:` (or `http:` on a loopback host), or `path` is not a Console path.
 */
export function hostedConsoleUrl(projectUrl: string, path: string, consoleOrigin: string = hostedConsoleOrigin): string {
  const project = normalizeConsoleProjectUrl(projectUrl)
  if (!project) throw new TypeError(`${projectUrl} is not a project URL. Use the https:// origin of the app, with its base path if it has one.`)
  const consolePath = normalizeConsolePath(path)
  if (!consolePath) throw new TypeError(`${path} is not a Console path. Use a path that starts with one /, such as /agents/<agent>.`)
  const url = new URL("/open", consoleOrigin)
  url.search = new URLSearchParams({ project, path: consolePath }).toString()
  return url.href
}
