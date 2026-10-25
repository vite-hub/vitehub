/** What the page tells the loader, in the query of its own URL. */
export interface LoaderOptions {
  /** Globs of the pages that get the overlay, relative to the app base. Empty: every page. */
  paths: readonly string[]
  /** Globs of the pages that never get it. */
  exclude: readonly string[]
}

export interface OverlaySession {
  user: { id: string, name?: string, image?: string } | null
  canRead: boolean
  canWrite: boolean
}

/** The module that `overlay.js` is. */
export interface OverlayModule {
  mount: (options: { base: string, session: OverlaySession }) => unknown
}

export interface LoaderEnvironment {
  /** The app base, such as `/` or `/portal/`. */
  base: string
  fetch: typeof fetch
  /** Imports the overlay. The browser's `import()`; tests pass a fake. */
  load: (url: string) => Promise<OverlayModule>
  pathname: string
  /** URL of `overlay.js` with the version of this loader. */
  overlayUrl: string
}

function globPattern(glob: string): RegExp {
  // `/docs/**` is `/docs` and everything below it.
  const tail = glob.endsWith("/**")
  if (tail) glob = glob.slice(0, -3)
  let source = ""
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index]!
    if (char === "*") {
      if (glob[index + 1] === "*") {
        source += ".*"
        index++
        // `/docs/**/` also matches `/docs/`.
        if (glob[index + 1] === "/") index++
      }
      else source += "[^/]*"
    }
    else if (char === "?") source += "[^/]"
    else source += char.replaceAll(/[$()*+.?[\\\]^{|}]/g, "\\$&")
  }
  return new RegExp(`^${source}${tail ? "(?:/.*)?" : ""}$`)
}

/** Whether a page path (`/docs/intro`) is in `paths` and not in `exclude`. `*` is a path segment, `**` any depth. */
export function matchesPath(pathname: string, options: LoaderOptions): boolean {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname
  const matches = (globs: readonly string[]) => globs.some(glob => globPattern(glob.length > 1 ? glob.replace(/\/+$/, "") : glob).test(path))
  if (matches(options.exclude)) return false
  return options.paths.length === 0 || matches(options.paths)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** The answer of `comments.session`, or undefined for anything else: not signed in, no access, or a server without comments. */
async function readSession(environment: LoaderEnvironment): Promise<OverlaySession | undefined> {
  try {
    const response = await environment.fetch(`${environment.base}_vitehub/rpc/__call`, {
      body: JSON.stringify({ input: {}, operation: "comments.session" }),
      cache: "no-store",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "x-vitehub-console": "1" },
      method: "POST",
    })
    if (!response.ok) return undefined
    const body: unknown = await response.json()
    if (!isRecord(body) || body.ok !== true || !isRecord(body.value)) return undefined
    const { canRead, canWrite, user } = body.value
    if (canRead !== true) return undefined
    return { canRead: true, canWrite: canWrite === true, user: isRecord(user) && typeof user.id === "string" ? user as OverlaySession["user"] : null }
  }
  catch {
    return undefined
  }
}

/**
 * Asks the server whether this visitor may read comments, and only then downloads the overlay. A visitor who is not
 * signed in, or may not read, downloads nothing more. It never throws into the page.
 */
export async function runLoader(options: LoaderOptions, environment: LoaderEnvironment): Promise<unknown> {
  if (!matchesPath(environment.pathname, options)) return undefined
  const session = await readSession(environment)
  if (!session) return undefined
  try {
    const overlay = await environment.load(environment.overlayUrl)
    return overlay.mount({ base: environment.base, session })
  }
  catch (error) {
    globalThis.console.warn("[vitehub] The comments overlay did not load.", error)
    return undefined
  }
}

/** Reads the loader options from the `o` query parameter of the loader URL. */
export function readLoaderOptions(search: string): LoaderOptions {
  try {
    const raw = new URLSearchParams(search).get("o")
    const parsed: unknown = raw ? JSON.parse(raw) : {}
    const list = (value: unknown) => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []
    return isRecord(parsed) ? { exclude: list(parsed.exclude), paths: list(parsed.paths) } : { exclude: [], paths: [] }
  }
  catch {
    return { exclude: [], paths: [] }
  }
}
