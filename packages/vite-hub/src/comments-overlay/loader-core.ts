/** What the page tells the loader, in the query of its own URL. */
export interface LoaderOptions {
  /** The app has the Content cms preset, so the overlay may look for the document of a page. */
  edit: boolean
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

/** What the loader hands to `overlay.js`. */
export interface MountOptions {
  /** The overlay shows only while this is true: the page is one that the options allow. */
  active: boolean
  /** Look for the document of each page, for the Edit button. Only an app with Content has `content.resolve`. */
  edit: boolean
  /** The app base, such as `/` or `/portal/`. */
  base: string
  /** The script nonce of the loader, for the styles the overlay adds itself. */
  nonce?: string
  /** The page path below the app base, without a trailing slash. */
  path: () => string
  session: OverlaySession
  /** Calls the listener after each client-side navigation. Returns a function that stops it. */
  subscribe: (listener: () => void) => () => void
}

export interface OverlayControl {
  /** Shows or hides the overlay and its hotkey, for a page that the options allow or leave out. */
  setActive: (active: boolean) => void
}

/** The module that `overlay.js` is. */
export interface OverlayModule {
  mount: (options: MountOptions) => OverlayControl
}

export interface LoaderEnvironment {
  /** The app base, such as `/` or `/portal/`. */
  base: string
  fetch: typeof fetch
  /** Imports the overlay. The browser's `import()`; tests pass a fake. */
  load: (url: string) => Promise<OverlayModule>
  nonce?: string
  /** URL of the overlay file that the loader tag names. */
  overlayUrl: string
  /** The page path below the app base, without a trailing slash. */
  path: () => string
  subscribe: (listener: () => void) => () => void
}

/** The path of a page below the app base: `/portal/pricing/` under `/portal/` is `/pricing`, and `/portal` is `/`. */
export function appPathname(pathname: string, base: string): string {
  const prefix = base.replace(/\/+$/, "")
  const below = prefix && (pathname === prefix || pathname.startsWith(`${prefix}/`)) ? pathname.slice(prefix.length) : pathname
  return below.length > 1 ? below.replace(/\/+$/, "") || "/" : below || "/"
}

/**
 * Calls `listener` after each client-side navigation: `history.pushState`, `history.replaceState`, and `popstate`.
 * The returned function stops it. It restores the history methods only when they are still ours. When another library
 * wrapped them since, restoring would undo its wrapper, so ours stays and does nothing.
 */
export function trackNavigation(listener: () => void): () => void {
  const { history } = globalThis
  const push = history.pushState
  const replace = history.replaceState
  let active = true
  const onPush = function pushState(this: History, ...args: Parameters<History["pushState"]>) {
    push.apply(this, args)
    if (active) listener()
  }
  const onReplace = function replaceState(this: History, ...args: Parameters<History["replaceState"]>) {
    replace.apply(this, args)
    if (active) listener()
  }
  const onPop = () => {
    if (active) listener()
  }
  history.pushState = onPush
  history.replaceState = onReplace
  globalThis.addEventListener("popstate", onPop)
  return () => {
    active = false
    globalThis.removeEventListener("popstate", onPop)
    if (history.pushState === onPush) history.pushState = push
    if (history.replaceState === onReplace) history.replaceState = replace
  }
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
 * signed in, or may not read, downloads nothing more. The loader follows client-side navigation: a page that the
 * options leave out hides the overlay, and a first allowed page mounts it. It never throws into the page.
 */
export function runLoader(options: LoaderOptions, environment: LoaderEnvironment): { ready: Promise<void>, stop: () => void } {
  const allowed = () => matchesPath(environment.path(), options)
  let started: Promise<void> | undefined
  let control: OverlayControl | undefined

  async function start(): Promise<void> {
    const session = await readSession(environment)
    if (!session) return
    try {
      const overlay = await environment.load(environment.overlayUrl)
      control = overlay.mount({
        active: allowed(),
        base: environment.base,
        edit: options.edit,
        path: environment.path,
        session,
        subscribe: environment.subscribe,
        ...(environment.nonce ? { nonce: environment.nonce } : {}),
      })
    }
    catch (error) {
      globalThis.console.warn("[vitehub] The comments overlay did not load.", error)
    }
  }

  const check = (): Promise<void> => {
    if (control) control.setActive(allowed())
    // One session request per page load, also when the answer is no.
    else if (!started && allowed()) started = start()
    return started ?? Promise.resolve()
  }
  const stop = environment.subscribe(() => void check())
  return { ready: check(), stop }
}

/** Reads the loader options from the query of the loader URL: `e=1` for Edit, and `o` for the page filter. */
export function readLoaderOptions(search: string): LoaderOptions {
  const query = new URLSearchParams(search)
  const none: LoaderOptions = { edit: query.get("e") === "1", exclude: [], paths: [] }
  try {
    const raw = query.get("o")
    const parsed: unknown = raw ? JSON.parse(raw) : {}
    const list = (value: unknown) => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []
    return isRecord(parsed) ? { ...none, exclude: list(parsed.exclude), paths: list(parsed.paths) } : none
  }
  catch {
    return none
  }
}
