/**
 * The projects that the Console page opens: the app of an embedded page, or the projects of the team that an `account`
 * Console reads from its server. The page keeps them in memory.
 */

/** The storage key of the project list. */
export const consoleProjectsStorageKey = "vitehub-console:projects"

/** One linked project. `url` is the app origin and its application mount, such as `https://app.example.com/portal`. */
export interface ConsoleLinkedProject {
  id: string
  url: string
  /** The project name that `project.get` returned when the project was linked or last opened. */
  label?: string
}

/** Where the Console sends the requests of a project. */
export interface ConsoleProjectTarget {
  /** The app origin, such as `https://app.example.com`. */
  origin: string
  /** The application mount, such as `/portal`, or an empty string at the root. */
  base: string
  /** `origin` and `base` together, the key of a linked project. */
  url: string
}

/** The members of a storage that the store uses, so tests can pass a map. */
export interface ConsoleProjectStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

interface StoredProjects {
  active?: string
  projects: ConsoleLinkedProject[]
}

const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"])

/**
 * Read a project URL that a person typed. It accepts an origin, such as `https://app.example.com`, or an origin and an
 * application mount, such as `https://app.example.com/portal`. A host without a scheme gets `https://`, or `http://` on
 * a loopback host. A pasted Console URL, such as `.../portal/_vitehub/kv`, keeps only the part before `/_vitehub`.
 */
export function normalizeProjectUrl(input: string): { target: ConsoleProjectTarget } | { error: string } {
  const value = input.trim()
  if (!value) return { error: "Enter the URL of the app, such as https://app.example.com." }
  // The URL parser accepts a space in a host and encodes it, so `my app` would become the host `my%20app`.
  if (/\s/.test(value)) return { error: `“${value}” is not a URL. Enter the URL of the app, such as https://app.example.com.` }
  const host = value.split(/[/?#]/, 1)[0]!.replace(/:\d+$/, "")
  const withScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `${loopbackHosts.has(host) ? "http" : "https"}://${value}`
  let url: URL
  try {
    url = new URL(withScheme)
  }
  catch {
    return { error: `“${value}” is not a URL. Enter the URL of the app, such as https://app.example.com.` }
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { error: "Use an https:// URL, such as https://app.example.com." }
  if (url.username || url.password) return { error: "Remove the user name and password from the URL." }
  // Only a whole `/_vitehub` segment starts the Console, so a mount such as `/_vitehub-app` stays.
  const mount = url.pathname.search(/\/_vitehub(?=\/|$)/)
  const path = mount === -1 ? url.pathname : url.pathname.slice(0, mount)
  const base = path.replace(/\/+$/, "")
  return { target: { origin: url.origin, base, url: `${url.origin}${base}` } }
}

/** The target of a stored project URL. A stored URL is always normalized, so this only splits it. */
export function consoleProjectTarget(project: Pick<ConsoleLinkedProject, "url">): ConsoleProjectTarget {
  const url = new URL(project.url)
  const base = url.pathname.replace(/\/+$/, "")
  return { origin: url.origin, base, url: `${url.origin}${base}` }
}

/** The host and mount that the Console shows for a project, such as `app.example.com/portal`. */
export function consoleProjectHost(project: Pick<ConsoleLinkedProject, "url">): string {
  const { base, origin } = consoleProjectTarget(project)
  return `${new URL(origin).host}${base}`
}

/** The name that the Console shows for a project: its label, or its host when it has none. */
export function consoleProjectName(project: Pick<ConsoleLinkedProject, "label" | "url">): string {
  return project.label || consoleProjectHost(project)
}

const text = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.trim() : undefined

function parseStoredProjects(raw: string | null): StoredProjects {
  let value: unknown
  try {
    value = raw ? JSON.parse(raw) : undefined
  }
  catch {
    return { projects: [] }
  }
  const record = value instanceof Object ? value : undefined
  const entries: unknown = record ? Reflect.get(record, "projects") : undefined
  const projects: ConsoleLinkedProject[] = []
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!(entry instanceof Object)) continue
    const id = text(Reflect.get(entry, "id"))
    const stored = text(Reflect.get(entry, "url"))
    const normalized = stored ? normalizeProjectUrl(stored) : undefined
    if (!id || !normalized || !("target" in normalized) || projects.some(project => project.id === id || project.url === normalized.target.url)) continue
    const label = text(Reflect.get(entry, "label"))
    projects.push({ id, url: normalized.target.url, ...(label ? { label } : {}) })
  }
  const active = record ? text(Reflect.get(record, "active")) : undefined
  return { projects, ...(active && projects.some(project => project.id === active) ? { active } : {}) }
}

function newProjectId(): string {
  // Unlike randomUUID(), getRandomValues() is available on an HTTP page.
  return Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("")
}

/** The project list of one Console origin. Every method reads the storage again, so two tabs see each other's changes. */
export interface ConsoleProjectStore {
  list(): ConsoleLinkedProject[]
  get(id: string): ConsoleLinkedProject | undefined
  /** The project with this URL. `url` must be normalized. */
  find(url: string): ConsoleLinkedProject | undefined
  /** The project that the Console opens. */
  active(): ConsoleLinkedProject | undefined
  /** Add a project, or update the one with the same URL. Returns the saved project. */
  save(input: { url: string, label?: string }): ConsoleLinkedProject
  select(id: string | undefined): void
  /** Remove a project. When it was active, the first other project becomes active. */
  forget(id: string): void
}

export function createConsoleProjectStore(storage: ConsoleProjectStorage): ConsoleProjectStore {
  const read = (): StoredProjects => {
    try {
      return parseStoredProjects(storage.getItem(consoleProjectsStorageKey))
    }
    catch {
      return { projects: [] }
    }
  }
  const write = (stored: StoredProjects): void => {
    storage.setItem(consoleProjectsStorageKey, JSON.stringify(stored))
  }
  return {
    list: () => read().projects,
    get: id => read().projects.find(project => project.id === id),
    find: url => read().projects.find(project => project.url === url),
    active: () => {
      const stored = read()
      return stored.projects.find(project => project.id === stored.active)
    },
    save: (input) => {
      const stored = read()
      const existing = stored.projects.find(project => project.url === input.url)
      const label = text(input.label) ?? existing?.label
      const project: ConsoleLinkedProject = { id: existing?.id ?? newProjectId(), url: input.url, ...(label ? { label } : {}) }
      write({ ...stored, projects: existing ? stored.projects.map(entry => entry.id === existing.id ? project : entry) : [...stored.projects, project] })
      return project
    },
    select: (id) => {
      const stored = read()
      const { active: _previous, ...rest } = stored
      write(id && stored.projects.some(project => project.id === id) ? { ...rest, active: id } : rest)
    },
    forget: (id) => {
      const stored = read()
      const projects = stored.projects.filter(project => project.id !== id)
      const active = stored.active === id ? projects[0]?.id : stored.active
      write({ projects, ...(active ? { active } : {}) })
    },
  }
}

/** A storage that keeps the list in memory. The list ends with the page. */
export function memoryProjectStorage(): ConsoleProjectStorage {
  const values = new Map<string, string>()
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
  }
}
