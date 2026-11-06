/**
 * The app that the Console reads and changes. Every Console request goes to this project, so one Console build can
 * reach an app on another origin.
 */
export interface ConsoleProject {
  /** The app origin, such as `https://agents.example.com`. An empty string is the origin of the Console page. */
  origin: string
  /** The application mount, such as `/portal`, or an empty string when the app is at the root. */
  base: string
  /**
   * The `authorization` header of each request, such as `Bearer <token>`. Cookies go only to the origin of the Console
   * page, so a project on another origin needs it.
   */
  authorization?: () => string | undefined
}

let active: ConsoleProject = { origin: "", base: "" }

/** The project that Console requests go to. Until the Console sets one, it is the app at the root of the page origin. */
export function consoleProject(): ConsoleProject {
  return active
}

export function setConsoleProject(project: ConsoleProject): void {
  active = project
}

/** The URL of an app path on the project, such as `/_vitehub/rpc/__call` → `/portal/_vitehub/rpc/__call`. */
export function projectUrl(path: string): string {
  return `${active.origin}${active.base}${path}`
}

/**
 * A URL that the app returned, such as the served URL of a Blob file, on the project origin. A path such as
 * `/api/_vitehub/blob/a.png` gets the project origin. An absolute URL stays as it is.
 */
export function resolveProjectUrl(url: string): string {
  return active.origin && url.startsWith("/") && !url.startsWith("//") ? `${active.origin}${url}` : url
}

/** Request headers with the `authorization` header of the project, when it has one. */
export function projectHeaders(headers: Record<string, string> = {}): Record<string, string> {
  const authorization = active.authorization?.()
  return authorization ? { ...headers, authorization } : headers
}

/**
 * `fetch()` of an app path on the project. Cookies go only to the origin of the Console page, and the `authorization`
 * header of the project goes with every request.
 */
export function projectFetch(path: string, init: Omit<RequestInit, "credentials" | "headers"> & { headers?: Record<string, string> } = {}): Promise<Response> {
  return fetch(projectUrl(path), { ...init, credentials: "same-origin", headers: projectHeaders(init.headers) })
}

/**
 * Whether the project is on another origin than the Console page, such as in a hosted Console. Cookies, frames, and
 * WebSockets of the app do not work then, so features that need them show a note instead.
 */
export function isRemoteProject(): boolean {
  return active.origin !== ""
}

/**
 * The URL of a page of the Console that the app serves, such as `/kv` → `https://app.example.com/portal/_vitehub/kv`.
 * Features that need the app origin link there.
 */
export function projectConsoleUrl(path = "/"): string {
  return projectUrl(`/_vitehub${path}`)
}
