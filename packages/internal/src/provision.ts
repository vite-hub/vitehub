export type ProvisionProvider = "cloudflare" | "vercel"

export interface ProvisionLogger {
  log: (message: string) => void
  warn: (message: string) => void
}

export interface ProvisionContext {
  env: Record<string, string | undefined>
  fetch: typeof globalThis.fetch
  logger: ProvisionLogger
}

// Non-secret identifiers produced by an applied action, merged into Provision State.
export interface ProvisionState {
  cloudflare?: Record<string, Record<string, string>>
  vercel?: Record<string, Record<string, string>>
}

export interface ProvisionResult {
  // Non-secret identifiers keyed by provider category, e.g. { d1: { primary: "<uuid>" } }.
  ids?: ProvisionState
}

export interface ProvisionAction {
  kind: string
  name: string
  exists: boolean
  apply: () => Promise<ProvisionResult>
}

export interface ProvisionStep {
  id: string
  provider: ProvisionProvider
  plan: (context: ProvisionContext) => Promise<ProvisionAction[]>
}

export interface CloudflareProvisionConfig {
  accountId: string
  token: string
}

export function resolveCloudflareProvisionConfig(env: Record<string, string | undefined>): CloudflareProvisionConfig | undefined {
  const accountId = trimmedEnv(env.CLOUDFLARE_ACCOUNT_ID)
  const token = trimmedEnv(env.CLOUDFLARE_API_TOKEN)
  if (!accountId || !token) return
  return { accountId, token }
}

export interface VercelProvisionConfig {
  teamId?: string
  token: string
}

export function resolveVercelProvisionConfig(env: Record<string, string | undefined>): VercelProvisionConfig | undefined {
  const token = trimmedEnv(env.VERCEL_TOKEN)
  if (!token) return
  return { token, teamId: trimmedEnv(env.VERCEL_TEAM_ID) ?? trimmedEnv(env.VERCEL_ORG_ID) }
}

export interface CloudflareEnvelope<T> {
  result?: T
  success?: boolean
  errors?: Array<{ message?: string }>
}

interface ProvisionRequestOptions {
  method?: string
  body?: unknown
  query?: Record<string, string>
}

interface ParsedProvisionRequestOptions<T> extends ProvisionRequestOptions {
  parse: (value: unknown) => T
}

export interface ProvisionRequest {
  (path: string, options?: ProvisionRequestOptions): Promise<unknown>
  <T>(path: string, options: ParsedProvisionRequestOptions<T>): Promise<T>
}

export class ProvisionRequestError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = "ProvisionRequestError"
    this.status = status
  }
}

// Minimal JSON REST client for provisioning. Uses the provided fetch; no SDK dependency.
function createJsonClient(baseURL: string, headers: Record<string, string>, fetchImpl: typeof globalThis.fetch, baseQuery?: Record<string, string>): ProvisionRequest {
  return async function request<T>(path: string, options: ProvisionRequestOptions | ParsedProvisionRequestOptions<T> = {}): Promise<unknown> {
    const url = new URL(`${baseURL}${path}`)
    for (const [key, value] of Object.entries({ ...baseQuery, ...options.query })) {
      url.searchParams.set(key, value)
    }
    const init: RequestInit = { method: options.method ?? "GET", headers: { ...headers } }
    if (options.body !== undefined) {
      init.headers = { ...init.headers, "content-type": "application/json" }
      init.body = JSON.stringify(options.body)
    }
    const response = await fetchImpl(url, init)
    if (!response.ok) {
      throw new ProvisionRequestError(`Provision request failed: ${options.method ?? "GET"} ${path} (${response.status}).`, response.status)
    }
    const value: unknown = await response.json()
    return "parse" in options ? options.parse(value) : value
  }
}

export interface CloudflareProvisionRequest {
  (path: string, options?: ProvisionRequestOptions): Promise<CloudflareEnvelope<unknown>>
  <T>(path: string, options: ParsedProvisionRequestOptions<T>): Promise<CloudflareEnvelope<T>>
}

// Keep provisioning HTTP local so the CLI does not grow a public CI abstraction.
export function createCloudflareProvisionClient(config: CloudflareProvisionConfig, fetchImpl: typeof globalThis.fetch = globalThis.fetch): CloudflareProvisionRequest {
  const client = createJsonClient(
    `https://api.cloudflare.com/client/v4/accounts/${config.accountId}`,
    { authorization: `Bearer ${config.token}` },
    fetchImpl,
  )
  return async <T>(path: string, options: ProvisionRequestOptions | ParsedProvisionRequestOptions<T> = {}) => {
    // SAFETY: Without a parser, Cloudflare result data retains the request's unknown response contract.
    const parse = "parse" in options ? options.parse : (value: unknown) => value as T
    return await client(path, {
      ...options,
      parse(value) {
        if (!value || Object(value) !== value) throw new Error("Cloudflare provisioning returned an invalid response.")
        // SAFETY: The object check establishes the optional Cloudflare envelope representation.
        const envelope = value as CloudflareEnvelope<unknown>
        return { ...envelope, result: envelope.result === undefined ? undefined : parse(envelope.result) }
      },
    })
  }
}

// Minimal Vercel REST client for provisioning. teamId is applied to every request as a query param.
export function createVercelProvisionClient(config: VercelProvisionConfig, fetchImpl: typeof globalThis.fetch = globalThis.fetch): ProvisionRequest {
  return createJsonClient(
    "https://api.vercel.com",
    { authorization: `Bearer ${config.token}` },
    fetchImpl,
    config.teamId ? { teamId: config.teamId } : undefined,
  )
}

function trimmedEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}
