/**
 * Accounts a reader can connect to a WebContainer app: deploy targets, a source host, and model providers.
 *
 * This entry only describes providers. It runs no OAuth flow yet. A connected credential stays in the
 * browser tab and reaches the app only as an environment variable of one `container.run()` call.
 */

export type ConnectProviderName = "anthropic" | "cloudflare" | "github" | "netlify" | "openai" | "vercel"

/** `deploy` targets a host. `source` reads and writes repositories. `model` calls an AI model. */
export type ConnectProviderKind = "deploy" | "model" | "source"

/**
 * `browser`: the provider API accepts requests from a StackBlitz origin (CORS).
 * `relay`: the provider API has no CORS, so calls need a relay that the reader deploys.
 */
export type ConnectReach = "browser" | "relay"

/** `oauth`: the reader signs in through the configured app. `token`: the reader pastes a token or key. */
export type ConnectAuth = "oauth" | "token"

export interface ConnectProvider {
  name: ConnectProviderName
  kind: ConnectProviderKind
  reach: ConnectReach
  auth: ConnectAuth
  /** The environment variable that receives the credential. */
  env: string
  /** OAuth client ID (Vercel). */
  clientId?: string
  /** GitHub App slug. */
  app?: string
  /** Who deploys the relay. Only `reader` exists today. */
  relay?: "reader"
}

export interface ConnectConfig {
  /** Without `clientId` the reader pastes a Vercel token. */
  vercel?: true | { clientId?: string }
  /** Without `app` the reader pastes a fine-grained token. */
  github?: true | { app?: string }
  netlify?: true
  openai?: true
  anthropic?: true
  /** The Cloudflare API has no CORS, so the reader deploys a relay. */
  cloudflare?: { relay: "reader" }
}

export interface Connect {
  providers: readonly ConnectProvider[]
}

/** Connected credentials, keyed by provider name. */
export type ConnectCredentials = Partial<Record<ConnectProviderName, string>>

const defaults: Record<ConnectProviderName, Omit<ConnectProvider, "auth">> = {
  anthropic: { name: "anthropic", kind: "model", reach: "browser", env: "ANTHROPIC_API_KEY" },
  cloudflare: { name: "cloudflare", kind: "deploy", reach: "relay", env: "CLOUDFLARE_API_TOKEN" },
  github: { name: "github", kind: "source", reach: "browser", env: "GITHUB_TOKEN" },
  netlify: { name: "netlify", kind: "deploy", reach: "browser", env: "NETLIFY_AUTH_TOKEN" },
  openai: { name: "openai", kind: "model", reach: "browser", env: "OPENAI_API_KEY" },
  vercel: { name: "vercel", kind: "deploy", reach: "browser", env: "VERCEL_TOKEN" },
}

function isProviderName(name: string): name is ConnectProviderName {
  return Object.hasOwn(defaults, name)
}

/** Describes the providers a page offers, in a fixed order. */
export function defineConnect(config: ConnectConfig): Connect {
  for (const name of Object.keys(config)) {
    if (!isProviderName(name)) throw new TypeError(`Unknown connect provider "${name}". Use one of: ${Object.keys(defaults).sort().join(", ")}.`)
  }
  const providers: ConnectProvider[] = []
  for (const name of Object.keys(defaults).sort()) {
    if (!isProviderName(name)) continue
    const options = config[name]
    if (!options) continue
    const base = defaults[name]
    if (name === "vercel" && options !== true && "clientId" in options && options.clientId) {
      providers.push({ ...base, auth: "oauth", clientId: options.clientId })
    }
    else if (name === "github" && options !== true && "app" in options && options.app) {
      providers.push({ ...base, auth: "oauth", app: options.app })
    }
    else if (name === "cloudflare") {
      providers.push({ ...base, auth: "token", relay: "reader" })
    }
    else {
      providers.push({ ...base, auth: "token" })
    }
  }
  return { providers }
}

/**
 * Maps connected credentials to the `env` of one `container.run()` call.
 * Providers that are not configured, or have no credential, are left out.
 */
export function connectEnv(connect: Connect, credentials: ConnectCredentials): Record<string, string> {
  const env: Record<string, string> = {}
  for (const provider of connect.providers) {
    const credential = credentials[provider.name]
    if (credential) env[provider.env] = credential
  }
  return env
}
