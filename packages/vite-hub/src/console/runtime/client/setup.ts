/** The dev Setup endpoints of the Vite dev server, as the Setup section calls them. */

import { resolveProjectUrl } from "./project"
import { ConsoleRequestError } from "./request"

export type SetupLevel = "native" | "explicit" | "unsupported" | "unknown"

export interface SetupSupport {
  level: SetupLevel
  detail: string
  display?: string
  guarantee?: string
  option?: string
}

export interface SetupFeatureState {
  id: string
  enabled: "on" | "off" | "unknown"
  reason: "config" | "default" | "implied"
  support: SetupSupport
  missingPackages: readonly string[]
  fix?: string
}

export interface SetupStatusDocument {
  root: string
  framework: "vite" | "nuxt" | "none"
  config: { file?: string, form?: string, manual?: string }
  host: { name: string, source: "config" | "env" | "default" }
  packageManager: string
  features: readonly SetupFeatureState[]
}

export interface SetupCatalogFeature {
  id: string
  title: string
  summary: string
  docs: string
  hosts: Readonly<Record<string, SetupSupport>>
  definition?: { dir: string }
}

export interface SetupCatalogDocument {
  hosts: readonly string[]
  features: readonly SetupCatalogFeature[]
}

export interface SetupChange {
  path: string
  kind: "create" | "patch" | "delete"
  before?: string
  after: string
  diff: string
}

export interface SetupError {
  code: string
  message: string
  why: string
  fix?: string
  docs?: string
}

export interface SetupMissing {
  field: string
  choices?: readonly (string | { id: string, name?: string })[]
}

/** A plan or applied document of `vitehub add` or `vitehub remove`, or the error document of a failed command. */
export interface SetupPlanDocument {
  status?: "planned" | "applied" | "unchanged"
  features?: readonly string[]
  changes?: readonly SetupChange[]
  install?: { packages: readonly string[], devPackages: readonly string[], command?: string }
  uninstall?: { packages: readonly string[], devPackages: readonly string[], command?: string }
  implied?: readonly string[]
  turnedOff?: readonly string[]
  nextSteps?: readonly string[]
  planId?: string
  command?: string
  restart?: boolean
  error?: SetupError
  missing?: readonly SetupMissing[]
  rerun?: string
}

export interface SetupPlanRequest {
  action: "add" | "remove"
  features: readonly string[]
  options?: readonly string[]
  name?: string
}

export interface SetupClient {
  readonly serverId: string
  catalog: () => Promise<SetupCatalogDocument>
  status: () => Promise<SetupStatusDocument>
  plan: (request: SetupPlanRequest) => Promise<SetupPlanDocument>
  apply: (planId: string) => Promise<SetupPlanDocument>
  /** Reads Server-Sent Events until `signal` aborts or the server closes the stream. */
  events: (onEvent: (event: string, data: unknown) => void, signal: AbortSignal) => Promise<void>
}

/** An answer that is not a setup document, such as a 403 from the guard. */
export class SetupRequestError extends ConsoleRequestError {
  constructor(status: number, message: string) {
    super(status, message)
    this.name = "SetupRequestError"
  }
}

/** The id of the running dev server. It changes when the server restarts. */
export async function readSetupSession(route: string): Promise<{ serverId: string, token: string }> {
  const response = await fetch(`${resolveProjectUrl(route)}/session`, { cache: "no-store", credentials: "same-origin", headers: { accept: "application/json", "x-vitehub-setup": "session" } })
  if (!response.ok) throw new SetupRequestError(response.status, (await response.text()) || `The Setup session answered ${response.status}.`)
  // SAFETY: The Setup session route answers `{ serverId, token }`.
  return await response.json() as { serverId: string, token: string }
}

export async function connectSetup(route: string): Promise<SetupClient> {
  const endpoint = resolveProjectUrl(route)
  const { serverId, token } = await readSetupSession(endpoint)
  const headers = { accept: "application/json", "x-vitehub-dev-token": token }
  const request = async <T>(path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${endpoint}/${path}`, body === undefined
      ? { cache: "no-store", credentials: "same-origin", headers }
      : { body: JSON.stringify(body), cache: "no-store", credentials: "same-origin", headers: { ...headers, "content-type": "application/json" }, method: "POST" })
    const text = await response.text()
    let value: unknown
    try {
      value = JSON.parse(text)
    }
    catch {
      throw new SetupRequestError(response.status, text || `The Setup endpoint answered ${response.status}.`)
    }
    // A failed command still answers its JSON document, with `error`, `missing`, and `rerun`.
    if (!response.ok && !(value && typeof value === "object" && "error" in value)) throw new SetupRequestError(response.status, text)
    // SAFETY: Setup endpoints answer the `--json` document of their command.
    return value as T
  }
  return {
    apply: async planId => await request<SetupPlanDocument>("apply", { planId }),
    catalog: async () => await request<SetupCatalogDocument>("catalog"),
    events: async (onEvent, signal) => {
      const response = await fetch(`${endpoint}/events`, { cache: "no-store", credentials: "same-origin", headers: { ...headers, accept: "text/event-stream" }, signal })
      if (!response.ok || !response.body) throw new SetupRequestError(response.status, "The Setup event stream did not open.")
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
      let buffer = ""
      while (true) {
        const { done, value } = await reader.read()
        if (done) return
        buffer += value
        let end = buffer.indexOf("\n\n")
        while (end !== -1) {
          const block = buffer.slice(0, end)
          buffer = buffer.slice(end + 2)
          const event = /^event: (.*)$/mu.exec(block)?.[1]
          const data = /^data: (.*)$/mu.exec(block)?.[1]
          if (event && data !== undefined) onEvent(event, JSON.parse(data))
          end = buffer.indexOf("\n\n")
        }
      }
    },
    plan: async body => await request<SetupPlanDocument>("plan", body),
    serverId,
    status: async () => await request<SetupStatusDocument>("status"),
  }
}

/**
 * Waits until a dev server with another id answers, as after a restart, and returns its id. Returns undefined after
 * `timeout` milliseconds.
 */
export async function waitForSetupRestart(route: string, serverId: string, timeout = 90_000): Promise<string | undefined> {
  const endpoint = resolveProjectUrl(route)
  const end = Date.now() + timeout
  while (Date.now() < end) {
    await new Promise(done => setTimeout(done, 700))
    try {
      const session = await readSetupSession(endpoint)
      if (session.serverId !== serverId) return session.serverId
    }
    catch {
      // The server is down while it restarts.
    }
  }
  return undefined
}

/** `vitehub add` or `vitehub remove` with the request, as the page shows it before a plan exists. */
export function setupCommand(request: SetupPlanRequest): string {
  const quote = (value: string) => /^[\w@%+=:,./-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`
  return ["vitehub", request.action, ...request.features, ...(request.name ? [`--name=${request.name}`] : []), ...(request.options ?? []).map(option => `--option=${option}`), "--yes"].map(quote).join(" ")
}
