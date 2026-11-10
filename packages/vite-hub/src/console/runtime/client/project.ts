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
   * page, so a project on another origin needs it. It can wait, such as for an OAuth refresh before the token expires.
   */
  authorization?: () => string | undefined | Promise<string | undefined>
  /**
   * Called once when the project answers `401` to a request that sent `sent`. Returns the `authorization` header to send
   * the request again with, such as after an OAuth refresh, or `undefined` to keep the `401`.
   */
  renew?: (response: Response, sent: string) => Promise<string | undefined>
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

/** The URL of an app path on the project, such as `/_vitehub/rpc/__call` → `/portal/_vitehub/rpc/__call`. */
export function projectUrl(path: string): string {
  return urlOf(active, path)
}

/**
 * A URL that the app returned, such as the served URL of a Blob file, on the project origin. A path such as
 * `/api/_vitehub/blob/a.png` gets the project origin. An absolute URL stays as it is.
 */
export function resolveProjectUrl(url: string): string {
  return active.origin && url.startsWith("/") && !url.startsWith("//") ? `${active.origin}${url}` : url
}

/**
 * The URL of an app path and the request headers with the `authorization` header, both from the project that is active
 * now. The authorization can wait for a refresh, and the active project can change meanwhile, so the URL never comes
 * from a later project than the token.
 */
export async function projectRequest(path: string, headers: Record<string, string> = {}): Promise<{
  url: string
  headers: Record<string, string>
  /**
   * After a `401` with this challenge, the headers to send the request once more with, such as after an OAuth refresh
   * of the same project, or `undefined` to keep the `401`.
   */
  renew: (challenge: string | null) => Promise<Record<string, string> | undefined>
}> {
  const project = active
  const authorization = await project.authorization?.()
  return {
    url: urlOf(project, path),
    headers: authorization ? { ...headers, authorization } : headers,
    renew: async (challenge) => {
      if (!authorization || !project.renew) return undefined
      const renewed = await project.renew(new Response(null, { status: 401, headers: challenge ? { "www-authenticate": challenge } : {} }), authorization)
      return renewed ? { ...headers, authorization: renewed } : undefined
    },
  }
}

/**
 * `fetch()` of an app path on the project. Cookies go only to the origin of the Console page, and the `authorization`
 * header of the project goes with every request. A `401` to a request with an `authorization` header gets one more try
 * when the project can renew it. The body must be a value that can be sent twice, such as a string.
 */
export async function projectFetch(path: string, init: Omit<RequestInit, "credentials" | "headers"> & { headers?: Record<string, string> } = {}): Promise<Response> {
  // The URL, the token, and its renewal all come from one project, also when another project opens meanwhile.
  const project = active
  const url = urlOf(project, path)
  const send = (authorization: string | undefined) => fetch(url, {
    ...init,
    credentials: "same-origin",
    headers: authorization ? { ...init.headers, authorization } : { ...init.headers },
  })
  const authorization = await project.authorization?.()
  const response = await send(authorization)
  if (response.status !== 401 || !authorization || !project.renew) return response
  const renewed = await project.renew(response, authorization)
  return renewed ? send(renewed) : response
}

/**
 * Whether the project is on another origin than the Console page, such as in a hosted Console. Cookies, frames, and
 * WebSockets of the app do not work then, so features that need them show a note instead.
 */
export function isRemoteProject(): boolean {
  // Read the page origin without depending on DOM types in the package's server build.
  const location: unknown = Reflect.get(globalThis, "location")
  const pageOrigin: unknown = location instanceof Object ? Reflect.get(location, "origin") : undefined
  return active.remote === true || (active.origin !== "" && active.origin !== pageOrigin)
}

/**
 * The URL of a page of the Console that the app serves, such as `/kv` → `https://app.example.com/portal/_vitehub/kv`.
 * Features that need the app origin link there.
 */
export function projectConsoleUrl(path = "/"): string {
  return projectUrl(`/_vitehub${path}`)
}
