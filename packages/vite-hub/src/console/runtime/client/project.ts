/**
 * The app that the Console reads and changes. Every Console request goes to this project, so one Console build can
 * reach an app on another origin.
 */
export interface ConsoleProject {
  /** The request origin, such as `https://agents.example.com`. An empty string is the Console page origin. */
  origin: string
  /** The request mount, such as `/portal` or `/p/<project>`, or an empty string at the origin root. */
  base: string
  /** The original app location when requests go through the Console server. Links and served media use it. */
  app?: { origin: string, base: string }
  /**
   * The Console server forwards the requests, such as `/p/<project>` of an `account` Console. The origin is the page's,
   * but the app is elsewhere, so its cookies, frames, and WebSockets do not work.
   */
  remote?: boolean
}

let active: ConsoleProject = { origin: "", base: "" }

/** The project that Console requests go to. Until the Console sets one, it is the app at the root of the page origin. */
export function consoleProject(): ConsoleProject {
  return active
}

export function setConsoleProject(project: ConsoleProject): void {
  active = project
}

function urlOf(project: ConsoleProject, path: string): string {
  return `${project.origin}${project.base}${path}`
}

/** The URL of an app path on the project, such as `/_vitehub/rpc` → `/portal/_vitehub/rpc`. */
export function projectUrl(path: string): string {
  return urlOf(active, path)
}

/** An app link, such as a provider sign-in page or the MCP endpoint, without the Console request forward. */
export function projectAppUrl(path: string): string {
  return urlOf(active.app ?? active, path)
}

/**
 * A URL that the app returned, such as the served URL of a Blob file, on the project origin. A path such as
 * `/api/_vitehub/blob/a.png` gets the project origin. An absolute URL stays as it is.
 */
export function resolveProjectUrl(url: string): string {
  const origin = (active.app ?? active).origin
  return origin && url.startsWith("/") && !url.startsWith("//") ? `${origin}${url}` : url
}

/** The URL of an app path on the project that is active now, and the request headers. */
export function projectRequest(path: string, headers: Record<string, string> = {}): { url: string, headers: Record<string, string> } {
  return { url: urlOf(active, path), headers }
}

/** `fetch()` of an app path on the project. Cookies go only to the origin of the Console page. */
export async function projectFetch(path: string, init: Omit<RequestInit, "credentials" | "headers"> & { headers?: Record<string, string> } = {}): Promise<Response> {
  return await fetch(urlOf(active, path), { ...init, credentials: "same-origin", headers: { ...init.headers } })
}

/**
 * Whether the project is on another origin than the Console page, such as in an `account` Console. Cookies, frames, and
 * WebSockets of the app do not work then, so features that need them show a note instead.
 */
export function isRemoteProject(): boolean {
  // Read the page origin without depending on DOM types in the package's server build.
  const location: unknown = Reflect.get(globalThis, "location")
  const pageOrigin: unknown = location instanceof Object ? Reflect.get(location, "origin") : undefined
  return active.remote === true || (active.origin !== "" && active.origin !== pageOrigin)
}
